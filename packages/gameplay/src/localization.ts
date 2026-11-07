import type { LocalizationMessage, LocalizationService, LocalizationVariables } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type Message = LocalizationMessage;
type Catalog = Map<string, Message>;
type Snapshot = { format: "pelican.i18n"; version: 1; locale: string | null; fallback: string | null;
  catalogs: { locale: string; entries: { key: string; message: Message }[] }[] };
const MAX_LOCALES = 32, MAX_PER_LOCALE = 4096, MAX_ENTRIES = 65536, MAX_CHARS = 4_194_304, MAX_TEMPLATE = 4096, MAX_OUTPUT = 65536;
const categories = ["zero", "one", "two", "few", "many", "other"] as const;
const fail = (code: string, message: string): never => { throw new Error(`TC_I18N_${code}: ${message}`); };
const validKey = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const variableName = (value: string) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value);
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function localeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) return fail("LOCALE", "Expected a BCP 47 locale of at most 128 characters.");
  if (typeof Intl === "undefined" || typeof Intl.getCanonicalLocales !== "function")
    return fail("INTL_UNAVAILABLE", "Locale canonicalization is unavailable on this player; use a runtime with Intl support.");
  try { return Intl.getCanonicalLocales(value)[0] ?? fail("LOCALE", `Invalid locale '${value}'.`); }
  catch { return fail("LOCALE", `Invalid locale '${value}'; use a valid BCP 47 language tag.`); }
}
/** Single-brace variables; doubled braces are literal braces. */
function render(template: string, values?: LocalizationVariables): string {
  let output = "";
  for (let index = 0; index < template.length;) {
    const char = template[index];
    if (char === "{" && template[index + 1] === "{") { output += "{"; index += 2; }
    else if (char === "}" && template[index + 1] === "}") { output += "}"; index += 2; }
    else if (char === "{") {
      const end = template.indexOf("}", index + 1);
      const name = end < 0 ? "" : template.slice(index + 1, end);
      if (!variableName(name)) return fail("TEMPLATE", "Placeholders must use {name}; escape literal braces with {{ or }}.");
      if (values !== undefined) {
        if (!Object.hasOwn(values, name)) return fail("VARIABLE", `Missing template variable '${name}'.`);
        output += String(values[name]);
      }
      index = end + 1;
    } else if (char === "}") return fail("TEMPLATE", "Unmatched closing brace; use }} for a literal brace.");
    else { output += char; index++; }
    if (output.length > MAX_OUTPUT) return fail("OUTPUT", `Localized output exceeds ${MAX_OUTPUT} characters.`);
  }
  return output;
}
function message(value: unknown): Message {
  if (typeof value === "string") {
    if (value.length > MAX_TEMPLATE) return fail("MESSAGE", `Message exceeds ${MAX_TEMPLATE} characters.`);
    render(value);
    return value;
  }
  if (!fields(value, categories) || typeof value.other !== "string")
    return fail("MESSAGE", "Plural messages require an 'other' string and only CLDR plural category fields.");
  const result: Record<string, string> = {};
  for (const category of categories) if (Object.hasOwn(value, category)) {
    const text = value[category];
    if (typeof text !== "string" || text.length > MAX_TEMPLATE) return fail("MESSAGE", `Plural '${category}' must be a string of at most ${MAX_TEMPLATE} characters.`);
    render(text); result[category] = text;
  }
  return result as unknown as Message;
}
function variables(input: LocalizationVariables | undefined): LocalizationVariables {
  if (input === undefined) return {};
  const value = cloneSerializable(input);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32)
    return fail("VARIABLE", "Variables must be an object with at most 32 fields.");
  for (const [key, entry] of Object.entries(value)) {
    if (!variableName(key) || !(typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) ||
        (typeof entry === "string" && entry.length > MAX_TEMPLATE))
      return fail("VARIABLE", `Invalid variable '${key}'; use finite numbers, booleans or strings up to ${MAX_TEMPLATE} characters.`);
  }
  return value;
}
function budgets(catalogs: ReadonlyMap<string, Catalog>): void {
  let entries = 0, chars = 0;
  for (const catalog of catalogs.values()) for (const item of catalog.values()) {
    entries++;
    if (typeof item === "string") chars += item.length;
    else for (const text of Object.values(item)) if (typeof text === "string") chars += text.length;
    if (entries > MAX_ENTRIES || chars > MAX_CHARS) return fail("CAPACITY", "Localization exceeds total message or text budget.");
  }
}
function parse(value: unknown): { catalogs: Map<string, Catalog>; locale: string | null; fallback: string | null } {
  const data = cloneSerializable(value) as Snapshot;
  if (!fields(data, ["format", "version", "locale", "fallback", "catalogs"]) || data.format !== "pelican.i18n" || data.version !== 1 ||
      !Array.isArray(data.catalogs) || data.catalogs.length > MAX_LOCALES)
    return fail("SNAPSHOT", "Expected a bounded version 1 localization snapshot.");
  const catalogs = new Map<string, Catalog>();
  for (const raw of data.catalogs) {
    if (!fields(raw, ["locale", "entries"]) || !Array.isArray(raw.entries) || raw.entries.length > MAX_PER_LOCALE)
      return fail("SNAPSHOT", "Invalid localization catalog.");
    const id = localeName(raw.locale);
    if (catalogs.has(id)) return fail("SNAPSHOT", `Duplicate locale '${id}'.`);
    const entries: Catalog = new Map();
    for (const item of raw.entries) {
      if (!fields(item, ["key", "message"]) || !validKey(item.key) || entries.has(item.key)) return fail("SNAPSHOT", `Invalid or duplicate key in '${id}'.`);
      entries.set(item.key, message(item.message));
    }
    catalogs.set(id, entries);
  }
  budgets(catalogs);
  const active = data.locale === null ? null : localeName(data.locale);
  const fallback = data.fallback === null ? null : localeName(data.fallback);
  if ((active !== null && !catalogs.has(active)) || (fallback !== null && !catalogs.has(fallback)))
    return fail("SNAPSHOT", "Active and fallback locales must have registered catalogs.");
  return { catalogs, locale: active, fallback };
}
export const createLocalizationPlugin: RuntimePluginFactory = () => {
  let catalogs = new Map<string, Catalog>(), locale: string | null = null, fallback: string | null = null, disposed = false;
  const pluralCache = new Map<string, Intl.PluralRules>(), numberCache = new Map<string, Intl.NumberFormat>();
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using localization."); };
  const existing = (input: string) => {
    alive();
    const id = localeName(input);
    if (!catalogs.has(id)) return fail("MISSING_LOCALE", `Define locale '${id}' first.`);
    return id;
  };
  function pluralRule(id: string): Intl.PluralRules {
    const cached = pluralCache.get(id);
    if (cached) return cached;
    if (typeof Intl === "undefined" || typeof Intl.PluralRules !== "function" || typeof Intl.PluralRules.supportedLocalesOf !== "function" || !Intl.PluralRules.supportedLocalesOf([id]).length)
      return fail("PLURAL_UNAVAILABLE", `Plural rules for '${id}' are unavailable on this player.`);
    const rule = new Intl.PluralRules(id); pluralCache.set(id, rule); return rule;
  }
  function numberFormat(id: string): Intl.NumberFormat {
    const cached = numberCache.get(id);
    if (cached) return cached;
    if (typeof Intl === "undefined" || typeof Intl.NumberFormat !== "function" || typeof Intl.NumberFormat.supportedLocalesOf !== "function" || !Intl.NumberFormat.supportedLocalesOf([id]).length)
      return fail("NUMBER_UNAVAILABLE", `Number formatting for '${id}' is unavailable on this player.`);
    const format = new Intl.NumberFormat(id); numberCache.set(id, format); return format;
  }
  const service: LocalizationService = {
    define(input, definitions) {
      alive();
      const id = localeName(input), data = cloneSerializable(definitions);
      if (catalogs.has(id)) return fail("DUPLICATE", `Locale '${id}' is already defined.`);
      if (catalogs.size >= MAX_LOCALES) return fail("CAPACITY", `At most ${MAX_LOCALES} locales may be defined.`);
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length > MAX_PER_LOCALE)
        return fail("CATALOG", `A locale needs an object of at most ${MAX_PER_LOCALE} messages.`);
      const entries: Catalog = new Map();
      for (const [key, value] of Object.entries(data)) {
        if (!validKey(key)) return fail("KEY", "Message keys must be nonempty printable strings up to 128 characters.");
        entries.set(key, message(value));
      }
      const candidate = new Map(catalogs); candidate.set(id, entries); budgets(candidate);
      catalogs.set(id, entries);
    },
    remove(input) {
      const id = existing(input);
      if (locale === id || fallback === id) return fail("IN_USE", `Clear or change the active/fallback locale before removing '${id}'.`);
      catalogs.delete(id); pluralCache.delete(id); numberCache.delete(id);
    },
    setLocale(input) { alive(); locale = input === null ? null : existing(input); },
    setFallback(input) { alive(); fallback = input === null ? null : existing(input); },
    text(key, input) {
      alive();
      if (!validKey(key)) return fail("KEY", "Message key must be a nonempty printable string up to 128 characters.");
      if (!locale) return fail("NO_LOCALE", "Select a locale before requesting text.");
      const params = variables(input);
      let source = locale, selected = catalogs.get(locale)!.get(key);
      if (selected === undefined && fallback !== null) { source = fallback; selected = catalogs.get(fallback)!.get(key); }
      if (selected === undefined) return fail("MISSING_KEY", `Message '${key}' is missing in '${locale}' and its fallback.`);
      if (typeof selected === "string") return render(selected, params);
      const count = params.count;
      if (typeof count !== "number" || !Number.isFinite(count)) return fail("PLURAL_COUNT", `Plural message '${key}' requires a finite numeric count variable.`);
      const category = pluralRule(source).select(count) as keyof typeof selected;
      return render(selected[category] ?? selected.other, params);
    },
    number(value) {
      alive();
      if (!locale) return fail("NO_LOCALE", "Select a locale before formatting numbers.");
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("NUMBER", "Number must be finite.");
      return numberFormat(locale).format(value);
    },
    inspect() { alive(); return { locale, fallback, available: [...catalogs.keys()].sort() }; },
  };
  const empty = (): Snapshot => ({ format: "pelican.i18n", version: 1, locale: null, fallback: null, catalogs: [] });
  return {
    id: "$engine.i18n", version: "1", services: { i18n: service },
    snapshot() {
      alive();
      return cloneSerializable({ format: "pelican.i18n", version: 1, locale, fallback,
        catalogs: [...catalogs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, entries]) => ({ locale: id,
          entries: [...entries.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, message: value })) })) });
    },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    restore(value) { alive(); const next = parse(value); catalogs = next.catalogs; locale = next.locale; fallback = next.fallback; pluralCache.clear(); numberCache.clear(); },
    dispose() { disposed = true; catalogs.clear(); pluralCache.clear(); numberCache.clear(); },
  };
};

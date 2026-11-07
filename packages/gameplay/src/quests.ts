import type { QuestDefinition, QuestService, QuestState } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type Objective = { id: string; label: string; target: number };
type Definition = { id: string; title: string; objectives: Objective[]; prerequisites: string[]; autoComplete: boolean };
type Quest = { definition: Definition; status: QuestState["status"]; progress: number[] };
type Snapshot = { format: "pelican.quests"; version: 1; quests: Quest[] };
const MAX_QUESTS = 1024, MAX_OBJECTIVES = 64, MAX_PREREQUISITES = 16, MAX_TARGET = 1_000_000_000;
const fail = (code: string, message: string): never => { throw new Error(`TC_QUEST_${code}: ${message}`); };
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function definition(input: QuestDefinition): Definition {
  if (!fields(input, ["id", "title", "objectives", "prerequisites", "autoComplete"]) || !validName(input.id))
    return fail("DEFINITION", "Quest needs a nonempty printable id of at most 64 characters.");
  const title = input.title === undefined ? input.id : input.title;
  const prerequisites = input.prerequisites === undefined ? [] : input.prerequisites;
  const autoComplete = input.autoComplete === undefined ? true : input.autoComplete;
  if (typeof title !== "string" || title.length > 256 || !Array.isArray(input.objectives) || input.objectives.length < 1 || input.objectives.length > MAX_OBJECTIVES ||
      !Array.isArray(prerequisites) || prerequisites.length > MAX_PREREQUISITES || prerequisites.some(id => !validName(id)) ||
      new Set(prerequisites).size !== prerequisites.length || prerequisites.includes(input.id) || typeof autoComplete !== "boolean")
    return fail("DEFINITION", `Quest '${input.id}' needs 1..${MAX_OBJECTIVES} objectives, at most ${MAX_PREREQUISITES} distinct prerequisites, a title of at most 256 characters and a boolean autoComplete.`);
  const ids = new Set<string>();
  const objectives = input.objectives.map(value => {
    if (!fields(value, ["id", "target", "label"]) || !validName(value.id) || ids.has(value.id) ||
        typeof value.target !== "number" || !Number.isSafeInteger(value.target) || value.target < 1 || value.target > MAX_TARGET ||
        (value.label !== undefined && (typeof value.label !== "string" || value.label.length > 256)))
      return fail("OBJECTIVE", `Objectives of '${input.id}' need unique printable ids, targets in 1..${MAX_TARGET} and labels of at most 256 characters.`);
    ids.add(value.id);
    return { id: value.id, target: value.target, label: value.label === undefined ? value.id : value.label };
  });
  return { id: input.id, title, objectives, prerequisites: [...prerequisites], autoComplete };
}
function assertAcyclic(quests: ReadonlyMap<string, Quest>): void {
  const colors = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    const color = colors.get(id);
    if (color === 1) return fail("CYCLE", `Quest prerequisites contain a cycle at '${id}'.`);
    if (color === 2) return;
    const quest = quests.get(id);
    if (!quest) return; // Forward references are resolved when starting.
    colors.set(id, 1);
    for (const dependency of quest.definition.prerequisites) visit(dependency);
    colors.set(id, 2);
  };
  for (const id of quests.keys()) visit(id);
}
function view(quest: Quest): QuestState {
  return cloneSerializable({ id: quest.definition.id, title: quest.definition.title, status: quest.status,
    prerequisites: quest.definition.prerequisites, autoComplete: quest.definition.autoComplete,
    objectives: quest.definition.objectives.map((item, i) => ({ ...item, progress: quest.progress[i] })) });
}
function parse(input: unknown): Map<string, Quest> {
  const snapshot = cloneSerializable(input) as Snapshot;
  if (!fields(snapshot, ["format", "version", "quests"]) || snapshot.format !== "pelican.quests" || snapshot.version !== 1 ||
      !Array.isArray(snapshot.quests) || snapshot.quests.length > MAX_QUESTS)
    return fail("SNAPSHOT", "Expected a bounded version 1 quest snapshot.");
  const result = new Map<string, Quest>();
  for (const raw of snapshot.quests) {
    if (!fields(raw, ["definition", "status", "progress"]) || !["inactive", "active", "completed", "failed"].includes(raw.status) || !Array.isArray(raw.progress))
      return fail("SNAPSHOT", "Invalid quest record.");
    const normalized = definition(raw.definition);
    if (result.has(normalized.id) || raw.progress.length !== normalized.objectives.length)
      return fail("SNAPSHOT", `Duplicate quest or objective count mismatch for '${normalized.id}'.`);
    for (let i = 0; i < raw.progress.length; i++) {
      const value = raw.progress[i];
      if (!Number.isSafeInteger(value) || value < 0 || value > normalized.objectives[i].target)
        return fail("SNAPSHOT", `Invalid objective progress for '${normalized.id}'.`);
    }
    const done = raw.progress.every((value, i) => value === normalized.objectives[i].target);
    if ((raw.status === "inactive" && raw.progress.some(value => value !== 0)) ||
        (raw.status === "completed" && !done) || (raw.status === "active" && normalized.autoComplete && done))
      return fail("SNAPSHOT", `Status and objective progress disagree for '${normalized.id}'.`);
    result.set(normalized.id, { definition: normalized, status: raw.status, progress: [...raw.progress] });
  }
  assertAcyclic(result);
  for (const quest of result.values()) if (quest.status !== "inactive")
    for (const dependency of quest.definition.prerequisites)
      if (!result.has(dependency)) return fail("SNAPSHOT", `Started quest '${quest.definition.id}' has an undefined prerequisite '${dependency}'.`);
  return result;
}
export const createQuestPlugin: RuntimePluginFactory = () => {
  let quests = new Map<string, Quest>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using quests."); };
  const get = (id: string): Quest => {
    alive();
    if (!validName(id)) return fail("DEFINITION", "Expected a nonempty quest id.");
    return quests.get(id) ?? fail("MISSING", `Quest '${id}' is not defined.`);
  };
  const service: QuestService = {
    define(input) {
      alive();
      const normalized = definition(cloneSerializable(input));
      if (quests.has(normalized.id)) return fail("DUPLICATE", `Quest '${normalized.id}' is already defined.`);
      if (quests.size >= MAX_QUESTS) return fail("CAPACITY", `At most ${MAX_QUESTS} quests may be defined.`);
      const item: Quest = { definition: normalized, status: "inactive", progress: normalized.objectives.map(() => 0) };
      const candidate = new Map(quests); candidate.set(normalized.id, item); assertAcyclic(candidate);
      quests.set(normalized.id, item);
    },
    start(id) {
      const quest = get(id);
      if (quest.status !== "inactive") return fail("STATE", `Quest '${id}' must be inactive before starting.`);
      for (const dependency of quest.definition.prerequisites) {
        const previous = quests.get(dependency);
        if (!previous) return fail("PREREQUISITE", `Define prerequisite '${dependency}' before starting '${id}'.`);
        if (previous.status !== "completed") return fail("PREREQUISITE", `Complete prerequisite '${dependency}' before starting '${id}'.`);
      }
      quest.status = "active";
    },
    advance(id, objective, amount = 1) { service.advanceBatch(id, [{ objective, amount }]); },
    advanceBatch(id, input) {
      const quest = get(id);
      if (quest.status !== "active") return fail("STATE", `Quest '${id}' must be active before updating progress.`);
      const updates = cloneSerializable(input);
      if (!Array.isArray(updates) || updates.length > MAX_OBJECTIVES) return fail("PROGRESS", `Expected at most ${MAX_OBJECTIVES} updates.`);
      const changes = new Map<number, number>();
      for (const update of updates) {
        if (!fields(update, ["objective", "amount"]) || !validName(update.objective) || typeof update.amount !== "number" || !Number.isSafeInteger(update.amount) || update.amount < 1)
          return fail("PROGRESS", "Each update needs an objective id and positive safe integer amount.");
        const index = quest.definition.objectives.findIndex(item => item.id === update.objective);
        if (index < 0) return fail("OBJECTIVE_MISSING", `Quest '${id}' has no objective '${update.objective}'.`);
        if (changes.has(index)) return fail("PROGRESS", `Objective '${update.objective}' is repeated in the batch.`);
        const remaining = quest.definition.objectives[index].target - quest.progress[index];
        changes.set(index, quest.progress[index] + Math.min(remaining, update.amount));
      }
      for (const [index, value] of changes) quest.progress[index] = value;
      if (quest.definition.autoComplete && quest.progress.every((value, i) => value === quest.definition.objectives[i].target)) quest.status = "completed";
    },
    complete(id) {
      const quest = get(id);
      if (quest.status !== "active") return fail("STATE", `Quest '${id}' must be active before completion.`);
      if (!quest.progress.every((value, i) => value === quest.definition.objectives[i].target))
        return fail("INCOMPLETE", `Finish all objectives before completing '${id}'.`);
      quest.status = "completed";
    },
    fail(id) {
      const quest = get(id);
      if (quest.status !== "active") return fail("STATE", `Quest '${id}' must be active before failure.`);
      quest.status = "failed";
    },
    reset(id) { const quest = get(id); quest.status = "inactive"; quest.progress = quest.definition.objectives.map(() => 0); },
    inspect(id) { return view(get(id)); },
    list() { alive(); return [...quests.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0).map(view); },
  };
  const empty = (): Snapshot => ({ format: "pelican.quests", version: 1, quests: [] });
  return {
    id: "$engine.quests", version: "1", services: { quests: service },
    snapshot() { alive(); return cloneSerializable({ format: "pelican.quests", version: 1,
      quests: [...quests.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0) }); },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    restore(value) { alive(); quests = parse(value); },
    dispose() { disposed = true; quests.clear(); },
  };
};

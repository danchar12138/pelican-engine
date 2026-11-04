/** Engine-internal resources. A public SDK facade must never expose get() values. */
export type ResourceJSON =
  | null
  | boolean
  | number
  | string
  | ResourceJSON[]
  | { [key: string]: ResourceJSON };
export interface ResourceDefinition {
  descriptor: unknown;
  value: unknown;
}
type ResourceSchema<S> = { [K in keyof S]: ResourceDefinition };
type ResourceType<S> = Extract<keyof S, string>;
type Awaitable<T> = T | PromiseLike<T>;
export interface ResourceHandle<T extends string = string> {
  readonly manager: number;
  readonly index: number;
  readonly generation: number;
  readonly type: T;
}
export interface ResourceLease<T extends string = string> {
  readonly handle: ResourceHandle<T>;
  readonly released: boolean;
  release(): Promise<void>;
}
export interface ResourceScope {
  readonly manager: number;
  readonly id: number;
  readonly released: boolean;
  release(): Promise<void>;
}
export interface ResourceLoader<D, V> {
  load(descriptor: D, signal: AbortSignal): Awaitable<V>;
  dispose(value: V): Awaitable<void>;
  /** Owned payload estimate only; not process/driver memory accounting. */
  estimateBytes?(value: V): number | undefined;
}
export type ResourceMode =
  | "register"
  | "acquire"
  | "load"
  | "cancel"
  | "release"
  | "dispose"
  | "get"
  | "snapshot"
  | "restore"
  | "observe";
export interface ResourceDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** Sanitized logical identity, never a descriptor or underlying exception. */
  readonly key: string | null;
  readonly type: string | null;
  readonly mode: ResourceMode;
}
export interface ResourceEvent {
  readonly sequence: number;
  readonly code: string;
  readonly key: string | null;
  readonly type: string | null;
  readonly mode: ResourceMode;
  readonly handle: ResourceHandle | null;
}
export class ResourceError extends Error {
  readonly code: string;
  constructor(readonly diagnostic: ResourceDiagnostic) {
    super(diagnostic.message);
    this.name = "ResourceError";
    this.code = diagnostic.code;
  }
}
export interface ResourceSnapshot {
  format: "threecat.resources";
  version: 1;
  /** Unique identities, not leases/refcounts, runtime handles, or GPU objects. */
  resources: {
    type: string;
    key: string;
    descriptor: ResourceJSON;
    state: "pending" | "loaded";
  }[];
}
export type ResourceBytes =
  | { status: "known"; value: number }
  | { status: "unknown" };
export interface ResourceCounters {
  loadsStarted: number;
  loadsCompleted: number;
  loadsFailed: number;
  loadsAborted: number;
  disposalsStarted: number;
  disposalsCompleted: number;
  disposalsFailed: number;
  staleResultsDisposed: number;
  consumerCancellations: number;
  peakEntries: number;
}
export interface ResourceInspection {
  disposed: boolean;
  owned: {
    entries: number;
    pending: number;
    loaded: number;
    references: number;
    scopes: number;
    inFlightLoads: number;
    inFlightDisposals: number;
  };
  bytes: ResourceBytes & { knownBytes: number; unknownEntries: number };
  entries: {
    handle: ResourceHandle;
    key: string;
    type: string;
    state: "pending" | "loaded";
    refCount: number;
    bytes: ResourceBytes;
  }[];
  counters: ResourceCounters;
}
interface Loader {
  load(descriptor: unknown, signal: AbortSignal): Awaitable<unknown>;
  dispose(value: unknown): Awaitable<void>;
  estimateBytes?(value: unknown): number | undefined;
}
interface ScopeState {
  token: ResourceScope;
  closed: boolean;
  consumers: Set<Consumer>;
  children: Set<ScopeState>;
  parent?: ScopeState;
  releasePromise?: Promise<void>;
}
interface Consumer {
  entry: Entry;
  scope: ScopeState;
  active: boolean;
  waiting: boolean;
  resolve: (lease: ResourceLease) => void;
  reject: (error: ResourceError) => void;
  detach?: () => void;
  releasePromise?: Promise<void>;
}
interface Entry {
  key: string;
  type: string;
  canonical: string;
  descriptor: ResourceJSON;
  handle: ResourceHandle;
  loader: Loader;
  controller: AbortController;
  state: "pending" | "loaded";
  current: boolean;
  consumers: Set<Consumer>;
  value?: unknown;
  bytes: ResourceBytes;
}
let managerSequence = 0;
const messages: Record<string, string> = {
  TC_RESOURCE_INVALID_IDENTITY:
    "Resource type and key must be non-empty strings.",
  TC_RESOURCE_INVALID_LOADER: "A loader requires load and dispose functions.",
  TC_RESOURCE_LOADER_EXISTS:
    "A loader is already registered for this resource type.",
  TC_RESOURCE_LOADER_MISSING:
    "Register a loader for this resource type before acquiring it.",
  TC_RESOURCE_INVALID_DESCRIPTOR:
    "Descriptors must be finite, acyclic JSON data without accessors or custom prototypes.",
  TC_RESOURCE_DESCRIPTOR_CONFLICT:
    "This type/key already has a different descriptor; release the old identity before replacing it.",
  TC_RESOURCE_INVALID_SCOPE:
    "Use an open scope created by this resource manager.",
  TC_RESOURCE_DISPOSED: "The resource manager has been disposed.",
  TC_RESOURCE_CANCELLED:
    "This consumer was cancelled or its ownership was released.",
  TC_RESOURCE_LOAD_FAILED:
    "Resource loading failed; the identity can be acquired again to retry.",
  TC_RESOURCE_DISPOSE_FAILED:
    "Resource disposal failed; other owned resources will still be released.",
  TC_RESOURCE_STALE_HANDLE:
    "Resource handle is stale, foreign, or has an incorrect type.",
  TC_RESOURCE_NOT_READY: "The resource is still loading.",
  TC_RESOURCE_INVALID_SNAPSHOT:
    "Resource snapshot format, uniqueness, state, or descriptor validation failed.",
  TC_RESOURCE_ESTIMATE_FAILED:
    "Resource byte estimate is unavailable or invalid; bytes remain unknown.",
  TC_RESOURCE_OBSERVER_FAILED:
    "A resource event observer failed and was detached.",
};
/** Descriptors/exceptions never enter diagnostics. URL credentials/query/fragment are removed. */
function safeIdentity(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1[redacted]@")
    .split(/[?#]/, 1)[0]!
    .replace(/[\r\n\x00-\x1f]/g, "_")
    .slice(0, 160);
}
/** Stricter than JSON.stringify: never silently lose identity data or invoke getters/toJSON. */
function jsonData(input: unknown, seen = new Set<object>()): ResourceJSON {
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return input;
  if (typeof input === "number" && Number.isFinite(input))
    return Object.is(input, -0) ? 0 : input;
  if (typeof input !== "object" || input === null || seen.has(input))
    throw new Error("invalid JSON");
  const proto = Object.getPrototypeOf(input);
  if (!Array.isArray(input) && proto !== Object.prototype && proto !== null)
    throw new Error("invalid prototype");
  if (Object.getOwnPropertySymbols(input).length)
    throw new Error("symbol property");
  seen.add(input);
  try {
    const properties = Object.getOwnPropertyDescriptors(input);
    if (Array.isArray(input)) {
      if (Object.keys(properties).length !== input.length + 1)
        throw new Error("sparse/extended array");
      const result: ResourceJSON[] = [];
      for (let i = 0; i < input.length; i++) {
        const property = properties[String(i)];
        if (!property || !("value" in property) || !property.enumerable)
          throw new Error("invalid array member");
        result.push(jsonData(property.value, seen));
      }
      return result;
    }
    const result: { [key: string]: ResourceJSON } = {};
    for (const key of Object.keys(properties).sort()) {
      const property = properties[key]!;
      if (!("value" in property) || !property.enumerable)
        throw new Error("accessor/non-enumerable");
      Object.defineProperty(result, key, {
        value: jsonData(property.value, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    seen.delete(input);
  }
}
function freezeData<T extends ResourceJSON>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
export class ResourceManager<
  S extends ResourceSchema<S> = Record<string, ResourceDefinition>,
> {
  readonly id = ++managerSequence;
  private loaders = new Map<string, Loader>();
  private identities = new Map<string, Map<string, Entry>>();
  private slots = new Map<number, Entry>();
  private generations: number[] = [];
  private free: number[] = [];
  private scopes = new Map<ResourceScope, ScopeState>();
  private scopeSequence = 0;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private loads = new Set<Promise<void>>();
  private disposals = new Set<Promise<void>>();
  private observers = new Set<(event: ResourceEvent) => void>();
  private diagnostics: ResourceDiagnostic[] = [];
  private events: ResourceEvent[] = [];
  private sequence = 0;
  private historyLimit: number;
  private counters: ResourceCounters = {
    loadsStarted: 0,
    loadsCompleted: 0,
    loadsFailed: 0,
    loadsAborted: 0,
    disposalsStarted: 0,
    disposalsCompleted: 0,
    disposalsFailed: 0,
    staleResultsDisposed: 0,
    consumerCancellations: 0,
    peakEntries: 0,
  };
  constructor(options: { historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 256;
    if (!Number.isSafeInteger(this.historyLimit) || this.historyLimit < 0)
      throw new RangeError("historyLimit must be a nonnegative safe integer");
  }
  registerLoader<K extends ResourceType<S>>(
    type: K,
    loader: ResourceLoader<S[K]["descriptor"], S[K]["value"]>,
  ): void {
    this.assertOpen("register");
    this.identity(type, "_", "register");
    if (
      !loader ||
      typeof loader.load !== "function" ||
      typeof loader.dispose !== "function" ||
      (loader.estimateBytes !== undefined &&
        typeof loader.estimateBytes !== "function")
    )
      throw this.error("TC_RESOURCE_INVALID_LOADER", "register", { type });
    if (this.loaders.has(type))
      throw this.error("TC_RESOURCE_LOADER_EXISTS", "register", { type });
    this.loaders.set(type, {
      load: loader.load.bind(loader),
      dispose: loader.dispose.bind(loader),
      estimateBytes: loader.estimateBytes?.bind(loader),
    } as Loader);
  }
  createScope(name?: string, parent?: ResourceScope): ResourceScope;
  createScope(parent?: ResourceScope): ResourceScope;
  createScope(
    nameOrParent?: string | ResourceScope,
    parent?: ResourceScope,
  ): ResourceScope {
    this.assertOpen("acquire");
    const parentToken =
      typeof nameOrParent === "string" ? parent : (nameOrParent ?? parent);
    const parentState =
      parentToken === undefined
        ? undefined
        : this.scope(parentToken, "acquire");
    const state: ScopeState = {
      token: undefined!,
      closed: false,
      consumers: new Set(),
      children: new Set(),
      parent: parentState,
    };
    const token: ResourceScope = Object.freeze({
      manager: this.id,
      id: ++this.scopeSequence,
      get released() {
        return state.closed;
      },
      release: () => this.releaseScope(state),
    });
    state.token = token;
    this.scopes.set(token, state);
    parentState?.children.add(state);
    return token;
  }
  async acquire<K extends ResourceType<S>>(
    type: K,
    key: string,
    descriptor: S[K]["descriptor"],
    scope: ResourceScope,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResourceLease<K>> {
    this.assertOpen("acquire");
    this.identity(type, key, "acquire");
    const owner = this.scope(scope, "acquire");
    const normalized = this.descriptor(descriptor, "acquire", { type, key });
    const canonical = JSON.stringify(normalized);
    const loader = this.loaders.get(type);
    if (!loader)
      throw this.error("TC_RESOURCE_LOADER_MISSING", "acquire", { type, key });
    if (options.signal?.aborted)
      throw this.error("TC_RESOURCE_CANCELLED", "cancel", { type, key });
    let entry = this.identities.get(type)?.get(key);
    if (entry && entry.canonical !== canonical)
      throw this.error("TC_RESOURCE_DESCRIPTOR_CONFLICT", "acquire", {
        type,
        key,
      });
    const fresh = entry === undefined;
    if (!entry) {
      const index = this.free.pop() ?? this.generations.length;
      const generation = (this.generations[index] ?? 0) + 1;
      this.generations[index] = generation;
      entry = {
        type,
        key,
        canonical,
        descriptor: freezeData(normalized),
        loader,
        handle: Object.freeze({ manager: this.id, index, generation, type }),
        controller: new AbortController(),
        state: "pending",
        current: true,
        consumers: new Set(),
        bytes: { status: "unknown" },
      };
      let byKey = this.identities.get(type);
      if (!byKey) this.identities.set(type, (byKey = new Map()));
      byKey.set(key, entry);
      this.slots.set(index, entry);
      this.counters.peakEntries = Math.max(
        this.counters.peakEntries,
        this.slots.size,
      );
    }
    const target = entry;
    const promise = new Promise<ResourceLease<K>>((resolve, reject) => {
      const consumer: Consumer = {
        entry: target,
        scope: owner,
        active: true,
        waiting: true,
        resolve: resolve as (lease: ResourceLease) => void,
        reject,
      };
      target.consumers.add(consumer);
      owner.consumers.add(consumer);
      if (options.signal) {
        const abort = () => {
          void this.releaseConsumer(consumer, "cancel");
        };
        options.signal.addEventListener("abort", abort, { once: true });
        consumer.detach = () =>
          options.signal!.removeEventListener("abort", abort);
      }
      if (target.state === "loaded") this.deliver(consumer);
    });
    if (fresh) this.startLoad(target);
    return promise;
  }
  get<K extends ResourceType<S>>(handle: ResourceHandle<K>): S[K]["value"] {
    const entry = this.entryFor(handle, "get");
    if (entry.state !== "loaded")
      throw this.error("TC_RESOURCE_NOT_READY", "get", entry);
    return entry.value as S[K]["value"];
  }
  /** Own references only for a specified scope; deduplicates multiple leases. */
  snapshot(scope?: ResourceScope): ResourceSnapshot {
    this.assertOpen("snapshot");
    const entries =
      scope === undefined
        ? [...this.slots.values()]
        : [
            ...new Set(
              [...this.scope(scope, "snapshot").consumers].map((c) => c.entry),
            ),
          ];
    entries.sort((a, b) =>
      a.type < b.type
        ? -1
        : a.type > b.type
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    );
    return {
      format: "threecat.resources",
      version: 1,
      resources: entries.map((e) => ({
        type: e.type,
        key: e.key,
        descriptor: jsonData(e.descriptor),
        state: e.state,
      })),
    };
  }
  /** Additively rebuild identities into scope. Rollback releases only this transaction's references. */
  async restore(
    snapshot: unknown,
    scope: ResourceScope,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResourceLease<ResourceType<S>>[]> {
    this.assertOpen("restore");
    const owner = this.scope(scope, "restore");
    const validated = this.validateSnapshot(snapshot);
    // Validate every conflict and loader before changing a single live reference.
    for (const resource of validated.resources) {
      if (!this.loaders.has(resource.type))
        throw this.error("TC_RESOURCE_LOADER_MISSING", "restore", resource);
      const live = this.identities.get(resource.type)?.get(resource.key);
      if (live && live.canonical !== JSON.stringify(resource.descriptor))
        throw this.error(
          "TC_RESOURCE_DESCRIPTOR_CONFLICT",
          "restore",
          resource,
        );
    }
    if (options.signal?.aborted)
      throw this.error("TC_RESOURCE_CANCELLED", "restore");
    const transaction = this.createScope(scope);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const pending = validated.resources.map((resource) =>
        this.acquire(
          resource.type as ResourceType<S>,
          resource.key,
          resource.descriptor,
          transaction,
          { signal: controller.signal },
        ),
      );
      const leases = await Promise.all(pending);
      if (owner.closed || this.disposed || options.signal?.aborted)
        throw this.error("TC_RESOURCE_CANCELLED", "restore");
      const temporary = this.scope(transaction, "restore");
      for (const consumer of temporary.consumers) {
        consumer.scope = owner;
        owner.consumers.add(consumer);
      }
      temporary.consumers.clear();
      await transaction.release();
      this.emit("TC_RESOURCE_RESTORED", "restore");
      return leases;
    } catch (error) {
      controller.abort();
      await transaction.release();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  inspect(): ResourceInspection {
    const entries = [...this.slots.values()].map((e) => ({
      handle: e.handle,
      key: safeIdentity(e.key)!,
      type: safeIdentity(e.type)!,
      state: e.state,
      refCount: e.consumers.size,
      bytes: { ...e.bytes },
    }));
    const knownBytes = entries.reduce(
      (sum, e) => sum + (e.bytes.status === "known" ? e.bytes.value : 0),
      0,
    );
    const unknownEntries = entries.filter(
      (e) => e.bytes.status === "unknown",
    ).length;
    const pending = entries.filter((e) => e.state === "pending").length;
    return {
      disposed: this.disposed,
      owned: {
        entries: entries.length,
        pending,
        loaded: entries.length - pending,
        references: entries.reduce((sum, e) => sum + e.refCount, 0),
        scopes: this.scopes.size,
        inFlightLoads: this.loads.size,
        inFlightDisposals: this.disposals.size,
      },
      bytes: unknownEntries
        ? { status: "unknown", knownBytes, unknownEntries }
        : { status: "known", value: knownBytes, knownBytes, unknownEntries },
      entries,
      counters: { ...this.counters },
    };
  }
  getDiagnostics(): ResourceDiagnostic[] {
    return this.diagnostics.map((d) => ({ ...d }));
  }
  getEvents(): ResourceEvent[] {
    return this.events.map((e) => ({ ...e }));
  }
  subscribe(observer: (event: ResourceEvent) => void): () => void {
    this.assertOpen("observe");
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  /** Includes ignored-abort loaders; callers must bound this wait for untrusted providers. */
  async whenIdle(): Promise<void> {
    while (this.loads.size || this.disposals.size)
      await Promise.all([...this.loads, ...this.disposals]);
  }
  /** Invalidates ownership immediately; does not wait for a loader ignoring abort. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    let complete!: () => void;
    this.disposePromise = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const closing = [...this.scopes.values()].map((scope) =>
      this.releaseScope(scope),
    );
    void Promise.all([...closing, ...this.disposals]).then(complete);
    this.observers.clear();
    return this.disposePromise;
  }
  private startLoad(entry: Entry): void {
    this.counters.loadsStarted++;
    const task = Promise.resolve().then(async () => {
      if (!entry.current) return;
      this.emit("TC_RESOURCE_LOAD_STARTED", "load", entry);
      try {
        const value = await entry.loader.load(
          entry.descriptor,
          entry.controller.signal,
        );
        this.counters.loadsCompleted++;
        if (!entry.current || this.disposed) {
          this.counters.staleResultsDisposed++;
          await this.disposeValue(entry, value);
          return;
        }
        entry.value = value;
        entry.state = "loaded";
        if (entry.loader.estimateBytes) {
          try {
            const bytes = entry.loader.estimateBytes(value);
            if (
              typeof bytes === "number" &&
              Number.isSafeInteger(bytes) &&
              bytes >= 0
            )
              entry.bytes = { status: "known", value: bytes };
            else if (bytes !== undefined)
              this.error(
                "TC_RESOURCE_ESTIMATE_FAILED",
                "load",
                entry,
                "warning",
              );
          } catch {
            this.error("TC_RESOURCE_ESTIMATE_FAILED", "load", entry, "warning");
          }
        }
        for (const consumer of [...entry.consumers]) this.deliver(consumer);
        this.emit("TC_RESOURCE_LOADED", "load", entry);
      } catch {
        this.counters.loadsFailed++;
        if (!entry.current) return;
        const failure = this.error("TC_RESOURCE_LOAD_FAILED", "load", entry);
        this.invalidate(entry);
        for (const consumer of [...entry.consumers])
          this.finishConsumer(consumer, failure);
        this.emit("TC_RESOURCE_LOAD_FAILED", "load", entry);
      }
    });
    this.loads.add(task);
    void task.then(() => {
      this.loads.delete(task);
    });
  }
  private deliver(consumer: Consumer): void {
    if (!consumer.active || !consumer.waiting) return;
    consumer.waiting = false;
    consumer.detach?.();
    const lease: ResourceLease = Object.freeze({
      handle: consumer.entry.handle,
      get released() {
        return !consumer.active;
      },
      release: () => this.releaseConsumer(consumer, "release"),
    });
    consumer.resolve(lease);
  }
  private finishConsumer(consumer: Consumer, failure?: ResourceError): void {
    consumer.active = false;
    consumer.detach?.();
    consumer.entry.consumers.delete(consumer);
    consumer.scope.consumers.delete(consumer);
    if (consumer.waiting && failure) {
      consumer.waiting = false;
      consumer.reject(failure);
    }
  }
  private releaseConsumer(
    consumer: Consumer,
    mode: "cancel" | "release",
  ): Promise<void> {
    if (consumer.releasePromise) return consumer.releasePromise;
    if (!consumer.active) return Promise.resolve();
    const entry = consumer.entry;
    const failure = consumer.waiting
      ? this.error("TC_RESOURCE_CANCELLED", mode, entry)
      : undefined;
    this.finishConsumer(consumer, failure);
    if (mode === "cancel") this.counters.consumerCancellations++;
    const last = entry.current && entry.consumers.size === 0;
    if (last) {
      this.invalidate(entry);
      if (entry.state === "pending") {
        this.counters.loadsAborted++;
        entry.controller.abort();
        this.emit("TC_RESOURCE_LOAD_ABORTED", "cancel", entry);
      }
    }
    consumer.releasePromise =
      last && entry.state === "loaded"
        ? this.disposeValue(entry, entry.value)
        : Promise.resolve();
    this.emit("TC_RESOURCE_RELEASED", mode, entry);
    return consumer.releasePromise;
  }
  private releaseScope(scope: ScopeState): Promise<void> {
    if (scope.releasePromise) return scope.releasePromise;
    scope.closed = true;
    this.scopes.delete(scope.token);
    scope.parent?.children.delete(scope);
    let complete!: () => void;
    scope.releasePromise = new Promise<void>((resolve) => {
      complete = resolve;
    });
    void Promise.all([
      ...[...scope.children].map((child) => this.releaseScope(child)),
      ...[...scope.consumers].map((consumer) =>
        this.releaseConsumer(consumer, "release"),
      ),
    ]).then(complete);
    return scope.releasePromise;
  }
  private disposeValue(entry: Entry, value: unknown): Promise<void> {
    this.counters.disposalsStarted++;
    const task = Promise.resolve().then(async () => {
      try {
        await entry.loader.dispose(value);
        this.counters.disposalsCompleted++;
        this.emit("TC_RESOURCE_DISPOSED", "dispose", entry);
      } catch {
        this.counters.disposalsFailed++;
        this.error("TC_RESOURCE_DISPOSE_FAILED", "dispose", entry);
        this.emit("TC_RESOURCE_DISPOSE_FAILED", "dispose", entry);
      } finally {
        entry.value = undefined;
      }
    });
    this.disposals.add(task);
    void task.then(() => {
      this.disposals.delete(task);
    });
    return task;
  }
  private invalidate(entry: Entry): void {
    if (!entry.current) return;
    entry.current = false;
    this.slots.delete(entry.handle.index);
    const byKey = this.identities.get(entry.type)!;
    if (byKey.get(entry.key) === entry) byKey.delete(entry.key);
    if (!byKey.size) this.identities.delete(entry.type);
    this.free.push(entry.handle.index);
  }
  private entryFor(handle: ResourceHandle, mode: ResourceMode): Entry {
    const entry = handle && this.slots.get(handle.index);
    if (
      !entry ||
      handle.manager !== this.id ||
      handle.generation !== entry.handle.generation ||
      handle.type !== entry.type
    )
      throw this.error("TC_RESOURCE_STALE_HANDLE", mode);
    return entry;
  }
  private scope(token: ResourceScope, mode: ResourceMode): ScopeState {
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw this.error("TC_RESOURCE_INVALID_SCOPE", mode);
    return scope;
  }
  private identity(type: unknown, key: unknown, mode: ResourceMode): void {
    if (
      typeof type !== "string" ||
      !type.length ||
      typeof key !== "string" ||
      !key.length
    )
      throw this.error("TC_RESOURCE_INVALID_IDENTITY", mode);
  }
  private descriptor(
    value: unknown,
    mode: ResourceMode,
    identity?: { key?: string; type?: string },
  ): ResourceJSON {
    try {
      return jsonData(value);
    } catch {
      throw this.error("TC_RESOURCE_INVALID_DESCRIPTOR", mode, identity);
    }
  }
  private assertOpen(mode: ResourceMode): void {
    if (this.disposed) throw this.error("TC_RESOURCE_DISPOSED", mode);
  }
  private validateSnapshot(input: unknown): ResourceSnapshot {
    let snapshot: ResourceJSON;
    try {
      snapshot = jsonData(input);
    } catch {
      throw this.error("TC_RESOURCE_INVALID_SNAPSHOT", "restore");
    }
    const invalid = () => this.error("TC_RESOURCE_INVALID_SNAPSHOT", "restore");
    if (
      !snapshot ||
      Array.isArray(snapshot) ||
      typeof snapshot !== "object" ||
      snapshot.format !== "threecat.resources" ||
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.resources) ||
      Object.keys(snapshot).sort().join() !== "format,resources,version"
    )
      throw invalid();
    const identities = new Map<string, Set<string>>();
    for (const item of snapshot.resources) {
      if (
        !item ||
        Array.isArray(item) ||
        typeof item !== "object" ||
        Object.keys(item).sort().join() !== "descriptor,key,state,type" ||
        typeof item.type !== "string" ||
        !item.type.length ||
        typeof item.key !== "string" ||
        !item.key.length ||
        (item.state !== "pending" && item.state !== "loaded")
      )
        throw invalid();
      let keys = identities.get(item.type);
      if (!keys) identities.set(item.type, (keys = new Set()));
      if (keys.has(item.key)) throw invalid();
      keys.add(item.key);
    }
    return snapshot as unknown as ResourceSnapshot;
  }
  private error(
    code: string,
    mode: ResourceMode,
    identity?: { key?: string; type?: string },
    severity: "error" | "warning" = "error",
  ): ResourceError {
    const diagnostic: ResourceDiagnostic = Object.freeze({
      code,
      mode,
      severity,
      key: safeIdentity(identity?.key),
      type: safeIdentity(identity?.type),
      message: messages[code] ?? "Resource operation failed.",
    });
    this.retain(this.diagnostics, diagnostic);
    return new ResourceError(diagnostic);
  }
  private emit(code: string, mode: ResourceMode, entry?: Entry): void {
    const event: ResourceEvent = Object.freeze({
      sequence: ++this.sequence,
      code,
      mode,
      key: safeIdentity(entry?.key),
      type: safeIdentity(entry?.type),
      handle: entry
        ? Object.freeze({ ...entry.handle, type: safeIdentity(entry.type)! })
        : null,
    });
    this.retain(this.events, event);
    for (const observer of [...this.observers]) {
      try {
        observer(event);
      } catch {
        this.observers.delete(observer);
        this.error("TC_RESOURCE_OBSERVER_FAILED", "observe", entry, "warning");
      }
    }
  }
  private retain<T>(history: T[], item: T): void {
    if (!this.historyLimit) return;
    history.push(item);
    if (history.length > this.historyLimit) history.shift();
  }
}

export function createResourceManager<
  S extends ResourceSchema<S> = Record<string, ResourceDefinition>,
>(options?: { historyLimit?: number }): ResourceManager<S> {
  return new ResourceManager<S>(options);
}

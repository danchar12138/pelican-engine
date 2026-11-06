import type {
  ComponentData,
  ComponentSchema,
  Transform,
} from "../../sdk/src/index.ts";
import type {
  EntityHandle,
  EntityRecord,
  EntityRef,
  RuntimeComponentDefinition,
  RuntimeEntityInput,
  RuntimeWorld,
  WorldAccess,
  WorldCommand,
  WorldOptions,
  WorldSnapshot,
} from "./contracts.ts";
import {
  ComponentStorage,
  cloneSchema,
  fail,
  identifier,
  record,
  values,
} from "./storage.ts";

const TRANSFORM: ComponentSchema = {
  position: { type: "vec3", default: [0, 0, 0] },
  rotation: { type: "vec3", default: [0, 0, 0] },
  scale: { type: "vec3", default: [1, 1, 1] },
};
let worldSerial = 0;
interface State {
  capacity: number;
  count: number;
  length: number;
  free: number[];
  ids: (string | undefined)[];
  prefabs: Map<number, string>;
  byId: Map<string, number>;
  alive: Uint8Array;
  generations: Float64Array;
  parents: Int32Array;
  children: Set<number>[];
  definitions: Map<string, RuntimeComponentDefinition>;
  stores: Map<string, ComponentStorage>;
  transforms: ComponentStorage;
}
interface Queued {
  command: WorldCommand;
  access?: WorldAccess;
}

function capacityValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)
    fail("CAPACITY", "Capacity must be a positive int32.");
  return value;
}

function empty(capacity: number): State {
  return {
    capacity,
    count: 0,
    length: 0,
    free: [],
    ids: new Array(capacity),
    prefabs: new Map(),
    byId: new Map(),
    alive: new Uint8Array(capacity),
    generations: new Float64Array(capacity),
    parents: new Int32Array(capacity).fill(-1),
    children: new Array(capacity),
    definitions: new Map(),
    stores: new Map(),
    transforms: new ComponentStorage(TRANSFORM, capacity),
  };
}

function grow(state: State): void {
  const capacity = capacityValue(Math.min(0x7fffffff, state.capacity * 2));
  if (capacity === state.capacity)
    fail("CAPACITY", "Entity index capacity is exhausted.");
  const alive = new Uint8Array(capacity);
  alive.set(state.alive);
  const generations = new Float64Array(capacity);
  generations.set(state.generations);
  const parents = new Int32Array(capacity).fill(-1);
  parents.set(state.parents);
  state.transforms.grow(capacity);
  for (const storage of state.stores.values()) storage.grow(capacity);
  state.alive = alive;
  state.generations = generations;
  state.parents = parents;
  state.ids.length = capacity;
  state.children.length = capacity;
  state.capacity = capacity;
}

function copyState(source: State): State {
  return {
    ...source,
    free: [...source.free],
    ids: [...source.ids],
    prefabs: new Map(source.prefabs),
    byId: new Map(source.byId),
    alive: source.alive.slice(),
    generations: source.generations.slice(),
    parents: source.parents.slice(),
    children: source.children.map((set) => set && new Set(set)),
    definitions: new Map(source.definitions),
    stores: new Map(
      [...source.stores].map(([id, store]) => [id, store.clone()]),
    ),
    transforms: source.transforms.clone(),
  };
}

function register(state: State, input: RuntimeComponentDefinition): void {
  record(input, "Component definition");
  identifier(input.id, "Component id");
  if (input.id === "Transform")
    fail("RESERVED", "Transform is built in and cannot be registered.");
  if (state.definitions.has(input.id))
    fail("DUPLICATE", `Component ${input.id} is already registered.`);
  if (
    input.version !== undefined &&
    (!Number.isSafeInteger(input.version) || input.version < 1)
  ) {
    fail(
      "VERSION",
      `Component ${input.id} version must be a positive safe integer.`,
    );
  }
  const schema = cloneSchema(input.schema);
  state.definitions.set(input.id, {
    id: input.id,
    schema,
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  state.stores.set(input.id, new ComponentStorage(schema, state.capacity));
}

function store(state: State, id: string): ComponentStorage {
  identifier(id, "Component id");
  if (id === "Transform") return state.transforms;
  return (
    state.stores.get(id) ??
    fail("COMPONENT", `Component ${id} is not registered.`)
  );
}

function normalize(
  state: State,
  input: RuntimeEntityInput,
  strict = false,
): EntityRecord {
  record(input, "Entity");
  identifier(input.id, "Entity id");
  if (input.prefab !== undefined) identifier(input.prefab, "Prefab id");
  if (input.parent !== undefined) identifier(input.parent, "Parent id");
  if (
    strict &&
    (input.transform === undefined || input.components === undefined)
  )
    fail("SNAPSHOT", "Entity records require transform and components.");
  const transform = values(
    TRANSFORM,
    (input.transform === undefined ? {} : input.transform) as ComponentData,
    true,
    strict,
  ) as unknown as Transform;
  const components = input.components === undefined ? {} : input.components;
  record(components, `Entity ${input.id} components`);
  const entries = Object.entries(components).map(([id, data]) => {
    if (id === "Transform")
      fail(
        "RESERVED",
        "Use the entity transform property, not a Transform component entry.",
      );
    return [id, values(store(state, id).schema, data, true, strict)];
  });
  return {
    id: input.id,
    ...(input.prefab === undefined ? {} : { prefab: input.prefab }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    transform,
    components: Object.fromEntries(entries),
  };
}

function put(
  state: State,
  entity: EntityRecord,
  generation: number,
  parent = -1,
): number {
  if (state.byId.has(entity.id))
    fail("DUPLICATE", `Entity ${entity.id} already exists.`);
  if (state.free.length === 0 && state.length === state.capacity) grow(state);
  const index = state.free.pop() ?? state.length++;
  state.ids[index] = entity.id;
  if (entity.prefab !== undefined) state.prefabs.set(index, entity.prefab);
  state.byId.set(entity.id, index);
  state.alive[index] = 1;
  state.generations[index] = generation;
  state.parents[index] = parent;
  state.children[index] = new Set();
  if (parent !== -1) state.children[parent].add(index);
  state.transforms.write(index, entity.transform as unknown as ComponentData);
  for (const [id, data] of Object.entries(entity.components))
    state.stores.get(id)!.write(index, data);
  state.count++;
  return index;
}

/** Child deletion is intentionally cascading, including descendants without components. */
function subtree(state: State, root: number): number[] {
  const result: number[] = [];
  const pending = [root];
  while (pending.length) {
    const index = pending.pop()!;
    result.push(index);
    for (const child of state.children[index]) pending.push(child);
  }
  return result;
}

function erase(state: State, indices: number[]): void {
  for (let n = indices.length - 1; n >= 0; n--) {
    const index = indices[n],
      parent = state.parents[index];
    if (parent !== -1) state.children[parent].delete(index);
    state.byId.delete(state.ids[index]!);
    state.ids[index] = undefined;
    state.prefabs.delete(index);
    state.alive[index] = 0;
    state.parents[index] = -1;
    state.children[index].clear();
    state.transforms.remove(index);
    for (const storage of state.stores.values()) storage.remove(index);
    state.free.push(index);
    state.count--;
  }
}

export function createWorld(options: WorldOptions = {}): RuntimeWorld {
  record(options as unknown, "World options");
  const world = ++worldSerial;
  if (!Number.isSafeInteger(world))
    fail("GENERATION", "World identity space is exhausted.");
  const initialCapacity = capacityValue(options.initialCapacity ?? 64);
  let generation = 0,
    revision = 0,
    disposed = false;
  let active: WorldAccess | undefined;
  let running = false;
  let pending: Queued[] = [];
  const freshGeneration = () => {
    if (generation >= Number.MAX_SAFE_INTEGER)
      fail("GENERATION", "Handle generation space is exhausted.");
    return ++generation;
  };
  const ensure = () => {
    if (disposed) fail("DISPOSED", "World has been disposed.");
  };
  const outsideSystem = () => {
    ensure();
    if (running)
      fail(
        "STRUCTURAL",
        "Systems must queue structural changes; lifecycle operations run outside systems.",
      );
  };
  // Omitted individual access lists retain legacy behavior. An explicit [] grants nothing;
  // only an explicitly listed write grants read access to that component.
  const read = (component: string, access = active) => {
    if (
      access?.reads !== undefined &&
      !access.reads.includes(component) &&
      !access.writes?.includes(component)
    ) {
      fail("ACCESS_READ", `System has no read access to ${component}.`);
    }
  };
  const write = (component: string, access = active) => {
    if (access?.writes !== undefined && !access.writes.includes(component))
      fail("ACCESS_WRITE", `System has no write access to ${component}.`);
  };
  const structural = (access = active) => {
    if (access?.structural === false)
      fail("ACCESS_STRUCTURAL", "System has no structural access.");
  };
  const lookup = (state: State, ref: EntityRef): number => {
    if (typeof ref === "string")
      return (
        state.byId.get(ref) ?? fail("ENTITY", `Entity ${ref} does not exist.`)
      );
    if (
      !ref ||
      ref.world !== world ||
      !Number.isSafeInteger(ref.index) ||
      ref.index < 0 ||
      ref.index >= state.length ||
      state.alive[ref.index] !== 1 ||
      state.generations[ref.index] !== ref.generation
    ) {
      fail("HANDLE", "Entity handle is stale or belongs to another world.");
    }
    return ref.index;
  };
  const handle = (state: State, index: number): EntityHandle =>
    Object.freeze({ world, index, generation: state.generations[index] });

  // Validate all entities (including forward parents and cycles) before allocating live state.
  const build = (
    definitions: readonly RuntimeComponentDefinition[],
    inputs: readonly RuntimeEntityInput[],
    strict: boolean,
    capacity: number,
  ): State => {
    if (!Array.isArray(definitions) || !Array.isArray(inputs))
      fail("SNAPSHOT", "Components and entities must be arrays.");
    const result = empty(capacity);
    for (const definition of definitions) register(result, definition);
    const entities = Array.from(inputs, (input) =>
      normalize(result, input, strict),
    );
    const indices = new Map<string, number>();
    entities.forEach((entity, index) => {
      if (indices.has(entity.id))
        fail("DUPLICATE", `Duplicate entity ${entity.id}.`);
      indices.set(entity.id, index);
    });
    const parents = entities.map((entity) =>
      entity.parent === undefined
        ? -1
        : (indices.get(entity.parent) ??
          fail("PARENT", `Missing parent ${entity.parent}.`)),
    );
    const colors = new Uint8Array(entities.length);
    for (let index = 0; index < entities.length; index++) {
      if (colors[index] === 2) continue;
      let current = index;
      const path: number[] = [];
      while (current !== -1 && colors[current] !== 2) {
        if (colors[current] === 1)
          fail("PARENT_CYCLE", `Parent cycle at ${entities[current].id}.`);
        colors[current] = 1;
        path.push(current);
        current = parents[current];
      }
      for (const visited of path) colors[visited] = 2;
    }
    if (generation > Number.MAX_SAFE_INTEGER - entities.length)
      fail("GENERATION", "Handle generation space is exhausted.");
    for (const entity of entities) put(result, entity, freshGeneration());
    for (let index = 0; index < parents.length; index++) {
      result.parents[index] = parents[index];
      if (parents[index] !== -1) result.children[parents[index]].add(index);
    }
    return result;
  };
  let state = build(
    options.components ?? [],
    options.entities ?? [],
    false,
    initialCapacity,
  );

  const spawn = (
    target: State,
    input: RuntimeEntityInput,
    access?: WorldAccess,
  ): number => {
    const normalized = normalize(target, input);
    if (target.byId.has(normalized.id))
      fail("DUPLICATE", `Entity ${normalized.id} already exists.`);
    const parent =
      normalized.parent === undefined
        ? -1
        : (target.byId.get(normalized.parent) ??
          fail("PARENT", `Missing parent ${normalized.parent}.`));
    write("Transform", access);
    for (const name of Object.keys(normalized.components)) write(name, access);
    return put(target, normalized, freshGeneration(), parent);
  };
  const add = (
    target: State,
    ref: EntityRef,
    component: string,
    data: ComponentData,
    access?: WorldAccess,
  ) => {
    if (component === "Transform")
      fail("RESERVED", "Transform cannot be added or removed.");
    write(component, access);
    const index = lookup(target, ref),
      storage = store(target, component);
    if (storage.presence[index])
      fail("DUPLICATE", `Entity already has ${component}.`);
    const normalized = values(storage.schema, data, true);
    storage.write(index, normalized);
  };
  const remove = (
    target: State,
    ref: EntityRef,
    component: string,
    access?: WorldAccess,
  ) => {
    if (component === "Transform")
      fail("RESERVED", "Transform cannot be added or removed.");
    write(component, access);
    const index = lookup(target, ref),
      storage = store(target, component);
    if (!storage.presence[index])
      fail("MISSING_COMPONENT", `Entity does not have ${component}.`);
    storage.remove(index);
  };
  const destroy = (target: State, ref: EntityRef, access?: WorldAccess) => {
    const indices = subtree(target, lookup(target, ref));
    write("Transform", access);
    for (const [name, storage] of target.stores) {
      if (indices.some((index) => storage.presence[index])) write(name, access);
    }
    erase(target, indices);
  };
  const readAll = () => {
    read("Transform");
    for (const name of state.stores.keys()) read(name);
  };
  const records = (): EntityRecord[] => {
    const result: EntityRecord[] = [];
    for (let index = 0; index < state.length; index++) {
      if (!state.alive[index]) continue;
      const parent = state.parents[index];
      result.push({
        id: state.ids[index]!,
        ...(state.prefabs.has(index)
          ? { prefab: state.prefabs.get(index)! }
          : {}),
        ...(parent === -1 ? {} : { parent: state.ids[parent]! }),
        transform: state.transforms.read(index) as unknown as Transform,
        components: Object.fromEntries(
          [...state.stores]
            .filter(([, storage]) => storage.presence[index])
            .map(([name, storage]) => [name, storage.read(index)]),
        ),
      });
    }
    return result;
  };
  const api: RuntimeWorld = {
    registerComponent(definition) {
      outsideSystem();
      register(state, definition);
      revision++;
    },
    spawn(input) {
      outsideSystem();
      const index = spawn(state, input);
      revision++;
      return handle(state, index);
    },
    destroy(entity) {
      outsideSystem();
      destroy(state, entity);
      revision++;
    },
    resolve(id) {
      ensure();
      identifier(id, "Entity id");
      return handle(state, lookup(state, id));
    },
    id(entity) {
      ensure();
      return state.ids[lookup(state, entity)]!;
    },
    isAlive(entity) {
      ensure();
      if (typeof entity === "string") return state.byId.has(entity);
      return (
        !!entity &&
        entity.world === world &&
        Number.isSafeInteger(entity.index) &&
        entity.index >= 0 &&
        entity.index < state.length &&
        state.alive[entity.index] === 1 &&
        state.generations[entity.index] === entity.generation
      );
    },
    getTransform(entity) {
      ensure();
      read("Transform");
      return state.transforms.read(
        lookup(state, entity),
      ) as unknown as Transform;
    },
    setTransform(entity, patch) {
      ensure();
      write("Transform");
      const index = lookup(state, entity);
      const data = values(TRANSFORM, patch as ComponentData, false);
      state.transforms.write(index, data);
      revision++;
    },
    getComponent(entity, component) {
      ensure();
      read(component);
      const index = lookup(state, entity),
        storage = store(state, component);
      if (!storage.presence[index])
        fail("MISSING_COMPONENT", `Entity does not have ${component}.`);
      return storage.read(index);
    },
    setComponent(entity, component, patch) {
      ensure();
      write(component);
      const index = lookup(state, entity),
        storage = store(state, component);
      if (!storage.presence[index])
        fail("MISSING_COMPONENT", `Entity does not have ${component}.`);
      const data = values(storage.schema, patch, false);
      storage.write(index, data);
      revision++;
    },
    addComponent(entity, component, data = {}) {
      outsideSystem();
      add(state, entity, component, data);
      revision++;
    },
    removeComponent(entity, component) {
      outsideSystem();
      remove(state, entity, component);
      revision++;
    },
    query(...components) {
      ensure();
      const columns = [...new Set(components)].map((name) => {
        read(name);
        return store(state, name).presence;
      });
      const result: string[] = [];
      for (let index = 0; index < state.length; index++) {
        if (
          state.alive[index] &&
          columns.every((column) => column[index] === 1)
        )
          result.push(state.ids[index]!);
      }
      return result;
    },
    records() {
      ensure();
      readAll();
      return records();
    },
    queue(command) {
      ensure();
      structural();
      record(command, "World command");
      if (
        !["spawn", "destroy", "addComponent", "removeComponent"].includes(
          command.type,
        )
      )
        fail("COMMAND", "Unknown structural command.");
      // Capture payload and permissions now, not mutable caller-owned references at flush time.
      let captured: WorldCommand;
      try {
        captured = structuredClone(command);
      } catch {
        return fail("COMMAND", "Command payload must be cloneable data.");
      }
      if (command.type === "spawn") {
        write("Transform");
        record(command.entity, "Spawn entity");
        for (const name of Object.keys(command.entity.components ?? {}))
          write(name);
      } else if (
        command.type === "addComponent" ||
        command.type === "removeComponent"
      )
        write(command.component);
      pending.push({
        command: captured,
        access: active && {
          ...(active.reads === undefined ? {} : { reads: [...active.reads] }),
          ...(active.writes === undefined
            ? {}
            : { writes: [...active.writes] }),
          structural: active.structural,
        },
      });
    },
    flush() {
      outsideSystem();
      if (pending.length === 0) return;
      const candidate = copyState(state);
      const previousGeneration = generation;
      try {
        for (const { command, access } of pending) {
          structural(access);
          switch (command.type) {
            case "spawn":
              spawn(candidate, command.entity, access);
              break;
            case "destroy":
              destroy(candidate, command.entity, access);
              break;
            case "addComponent":
              add(
                candidate,
                command.entity,
                command.component,
                command.data === undefined ? {} : command.data,
                access,
              );
              break;
            case "removeComponent":
              remove(candidate, command.entity, command.component, access);
              break;
          }
        }
      } catch (error) {
        generation = previousGeneration;
        // Failed batches are discarded; retaining an invalid queue would poison future frames.
        pending = [];
        throw error;
      }
      state = candidate;
      pending = [];
      revision++;
    },
    runSystem(id, access, operation) {
      ensure();
      identifier(id, "System id");
      if (running) fail("SYSTEM_NESTED", "Nested systems are not supported.");
      if (
        typeof operation !== "function" ||
        operation.constructor.name === "AsyncFunction"
      )
        fail("SYSTEM_ASYNC", "Systems must be synchronous functions.");
      if (access !== undefined) {
        record(access as unknown, "System access");
        for (const list of [access.reads, access.writes]) {
          if (
            list !== undefined &&
            (!Array.isArray(list) ||
              Array.from(list).some(
                (name) => typeof name !== "string" || name.trim().length === 0,
              ))
          )
            fail(
              "ACCESS",
              "Access lists must contain nonempty component names.",
            );
        }
        if (
          access.structural !== undefined &&
          typeof access.structural !== "boolean"
        )
          fail("ACCESS", "structural must be boolean.");
      }
      active = access && {
        ...access,
        reads: access.reads && [...access.reads],
        writes: access.writes && [...access.writes],
      };
      running = true;
      try {
        const result = operation();
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          // Consume a rejected native promise so rejecting asynchronous systems does not
          // produce an unrelated unhandled-rejection failure in the host process.
          if (result instanceof Promise) void result.catch(() => {});
          fail("SYSTEM_ASYNC", "Systems cannot return asynchronous work.");
        }
        return result;
      } finally {
        running = false;
        active = undefined;
      }
    },
    snapshot() {
      ensure();
      readAll();
      return {
        format: "pelican.world",
        version: 1,
        components: [...state.definitions.values()].map((definition) => ({
          ...definition,
          schema: cloneSchema(definition.schema),
        })),
        entities: records(),
      };
    },
    restore(snapshot) {
      outsideSystem();
      record(snapshot, "World snapshot");
      if (snapshot.format !== "pelican.world" || snapshot.version !== 1)
        fail("VERSION", "Unsupported world snapshot format/version.");
      const candidate = build(
        snapshot.components,
        snapshot.entities,
        true,
        initialCapacity,
      );
      state = candidate;
      pending = [];
      revision++;
    },
    inspect() {
      return {
        entities: state.count,
        capacity: state.capacity,
        components: state.stores.size,
        pendingCommands: pending.length,
        revision,
        disposed,
      };
    },
    dispose() {
      if (disposed) return;
      outsideSystem();
      state = empty(0);
      pending = [];
      disposed = true;
      revision++;
    },
  };
  return api;
}

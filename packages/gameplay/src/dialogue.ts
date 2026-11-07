import type { DialogueDefinition, DialogueService, DialogueSessionState } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type Choice = { id: string; text: string; next: string | null };
type Node = { id: string; speaker: string; text: string; next: string | null; choices: Choice[] };
type Graph = { id: string; start: string; nodes: Node[] };
type Session = { id: string; dialogue: string; status: DialogueSessionState["status"]; node: string | null; steps: number };
type Snapshot = { format: "pelican.dialogue"; version: 1; definitions: Graph[]; sessions: Session[] };
const MAX_GRAPHS = 512, MAX_NODES_PER_GRAPH = 256, MAX_CHOICES_PER_NODE = 16, MAX_SESSIONS = 128;
const MAX_TOTAL_NODES = 65536, MAX_TOTAL_CHOICES = 262144, MAX_TOTAL_CHARS = 4_194_304;
const fail = (code: string, message: string): never => { throw new Error(`TC_DIALOGUE_${code}: ${message}`); };
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function graph(input: DialogueDefinition): Graph {
  if (!fields(input, ["id", "start", "nodes"]) || !validName(input.id) || !validName(input.start) ||
      !Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_NODES_PER_GRAPH)
    return fail("DEFINITION", `Dialogue needs printable id/start and 1..${MAX_NODES_PER_GRAPH} nodes.`);
  const ids = new Set<string>();
  const nodes: Node[] = input.nodes.map(value => {
    if (!fields(value, ["id", "speaker", "text", "next", "choices"]) || !validName(value.id) || ids.has(value.id) ||
        typeof value.text !== "string" || value.text.length > 4096 ||
        (value.speaker !== undefined && (typeof value.speaker !== "string" || value.speaker.length > 256)) ||
        (value.next !== undefined && value.next !== null && !validName(value.next)) ||
        (value.choices !== undefined && (!Array.isArray(value.choices) || value.choices.length > MAX_CHOICES_PER_NODE)))
      return fail("NODE", `Nodes of '${input.id}' need unique ids, text up to 4096 characters, speaker up to 256 characters and at most ${MAX_CHOICES_PER_NODE} choices.`);
    ids.add(value.id);
    const choicesInput = (value.choices ?? []) as unknown[];
    const choiceIds = new Set<string>();
    const choices: Choice[] = choicesInput.map(choice => {
      if (!fields(choice, ["id", "text", "next"]) || !validName(choice.id) || choiceIds.has(choice.id) ||
          typeof choice.text !== "string" || !choice.text.length || choice.text.length > 1024 ||
          (choice.next !== undefined && choice.next !== null && !validName(choice.next)))
        return fail("CHOICE", `Node '${value.id}' needs distinct choice ids, nonempty text up to 1024 characters and a valid next node or null.`);
      choiceIds.add(choice.id);
      return { id: choice.id, text: choice.text, next: (choice.next ?? null) as string | null };
    });
    if (choices.length && value.next !== undefined && value.next !== null)
      return fail("NODE", `Node '${value.id}' cannot have both a linear successor and choices.`);
    return { id: value.id, speaker: value.speaker === undefined ? "" : value.speaker as string,
      text: value.text, next: (value.next ?? null) as string | null, choices };
  });
  if (!ids.has(input.start)) return fail("NODE", `Start node '${input.start}' does not exist in '${input.id}'.`);
  for (const node of nodes) for (const next of [node.next, ...node.choices.map(choice => choice.next)])
    if (next !== null && !ids.has(next)) return fail("NODE", `Node '${node.id}' refers to missing node '${next}'.`);
  return { id: input.id, start: input.start, nodes };
}
function budgets(graphs: Iterable<Graph>): void {
  let nodes = 0, choices = 0, chars = 0;
  for (const item of graphs) for (const node of item.nodes) {
    nodes++; choices += node.choices.length; chars += node.speaker.length + node.text.length;
    for (const choice of node.choices) chars += choice.text.length;
    if (nodes > MAX_TOTAL_NODES || choices > MAX_TOTAL_CHOICES || chars > MAX_TOTAL_CHARS)
      return fail("CAPACITY", "Dialogue definitions exceed the total node, choice or text budget.");
  }
}
function parse(value: unknown): { graphs: Map<string, Graph>; sessions: Map<string, Session> } {
  const snapshot = cloneSerializable(value) as Snapshot;
  if (!fields(snapshot, ["format", "version", "definitions", "sessions"]) || snapshot.format !== "pelican.dialogue" || snapshot.version !== 1 ||
      !Array.isArray(snapshot.definitions) || snapshot.definitions.length > MAX_GRAPHS || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > MAX_SESSIONS)
    return fail("SNAPSHOT", "Expected a bounded version 1 dialogue snapshot.");
  const graphs = new Map<string, Graph>();
  for (const raw of snapshot.definitions) {
    const item = graph(raw);
    if (graphs.has(item.id)) return fail("SNAPSHOT", `Duplicate dialogue '${item.id}'.`);
    graphs.set(item.id, item);
  }
  budgets(graphs.values());
  const sessions = new Map<string, Session>();
  for (const raw of snapshot.sessions) {
    if (!fields(raw, ["id", "dialogue", "status", "node", "steps"]) || !validName(raw.id) || !validName(raw.dialogue) ||
        sessions.has(raw.id) || !["active", "completed", "cancelled"].includes(raw.status) ||
        !Number.isSafeInteger(raw.steps) || raw.steps < 0)
      return fail("SNAPSHOT", "Invalid or duplicate session.");
    const definition = graphs.get(raw.dialogue);
    if (!definition || (raw.status === "active" && (!validName(raw.node) || !definition.nodes.some(node => node.id === raw.node))) ||
        (raw.status !== "active" && raw.node !== null) || (raw.status === "completed" && raw.steps < 1))
      return fail("SNAPSHOT", `Session '${raw.id}' does not match its dialogue or node.`);
    sessions.set(raw.id, { id: raw.id, dialogue: raw.dialogue, status: raw.status, node: raw.node, steps: raw.steps });
  }
  return { graphs, sessions };
}
export const createDialoguePlugin: RuntimePluginFactory = () => {
  let graphs = new Map<string, Graph>(), sessions = new Map<string, Session>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using dialogue."); };
  const getGraph = (id: string): Graph => {
    alive();
    if (!validName(id)) return fail("DEFINITION", "Expected a nonempty dialogue id.");
    return graphs.get(id) ?? fail("MISSING", `Dialogue '${id}' is not defined.`);
  };
  const getSession = (id: string): Session => {
    alive();
    if (!validName(id)) return fail("SESSION", "Expected a nonempty session id.");
    return sessions.get(id) ?? fail("SESSION_MISSING", `Dialogue session '${id}' does not exist.`);
  };
  const current = (session: Session): Node => {
    if (session.status !== "active" || session.node === null) return fail("STATE", `Dialogue session '${session.id}' is not active.`);
    return getGraph(session.dialogue).nodes.find(item => item.id === session.node) ?? fail("NODE", `Current node '${session.node}' does not exist.`);
  };
  const state = (session: Session): DialogueSessionState => cloneSerializable({ id: session.id, dialogue: session.dialogue,
    status: session.status, steps: session.steps, node: session.status === "active" ? current(session) : null });
  const move = (session: Session, next: string | null) => {
    if (session.steps >= Number.MAX_SAFE_INTEGER) return fail("STEPS", `Session '${session.id}' exhausted its step counter.`);
    session.steps++;
    session.node = next;
    if (next === null) session.status = "completed";
  };
  const service: DialogueService = {
    define(input) {
      alive();
      const item = graph(cloneSerializable(input));
      if (graphs.has(item.id)) return fail("DUPLICATE", `Dialogue '${item.id}' is already defined.`);
      if (graphs.size >= MAX_GRAPHS) return fail("CAPACITY", `At most ${MAX_GRAPHS} dialogues may be defined.`);
      budgets([...graphs.values(), item]);
      graphs.set(item.id, item);
    },
    undefine(id) {
      getGraph(id);
      for (const session of sessions.values()) if (session.dialogue === id)
        return fail("IN_USE", `Close dialogue session '${session.id}' before removing '${id}'.`);
      graphs.delete(id);
    },
    start(id, dialogue) {
      alive();
      if (!validName(id)) return fail("SESSION", "Session id must be a nonempty printable name.");
      const definition = getGraph(dialogue);
      if (sessions.has(id)) return fail("SESSION_DUPLICATE", `Session '${id}' already exists; close it before restarting.`);
      if (sessions.size >= MAX_SESSIONS) return fail("CAPACITY", `At most ${MAX_SESSIONS} sessions may exist.`);
      sessions.set(id, { id, dialogue, status: "active", node: definition.start, steps: 0 });
    },
    advance(id) {
      const session = getSession(id), node = current(session);
      if (node.choices.length) return fail("CHOICE_REQUIRED", `Choose an option on node '${node.id}'.`);
      move(session, node.next);
    },
    choose(id, choiceId) {
      const session = getSession(id), node = current(session);
      if (!validName(choiceId)) return fail("CHOICE", "Choice id must be nonempty.");
      const choice = node.choices.find(item => item.id === choiceId);
      if (!choice) return fail("CHOICE_MISSING", `Node '${node.id}' has no choice '${choiceId}'.`);
      move(session, choice.next);
    },
    cancel(id) {
      const session = getSession(id); current(session);
      session.status = "cancelled"; session.node = null;
    },
    close(id) { getSession(id); sessions.delete(id); },
    inspect(id) { return state(getSession(id)); },
    list() { alive(); return [...sessions.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(state); },
  };
  const empty = (): Snapshot => ({ format: "pelican.dialogue", version: 1, definitions: [], sessions: [] });
  return {
    id: "$engine.dialogue", version: "1", services: { dialogue: service },
    snapshot() { alive(); return cloneSerializable({ format: "pelican.dialogue", version: 1,
      definitions: [...graphs.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      sessions: [...sessions.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }); },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    restore(value) { alive(); const next = parse(value); graphs = next.graphs; sessions = next.sessions; },
    dispose() { disposed = true; graphs.clear(); sessions.clear(); },
  };
};

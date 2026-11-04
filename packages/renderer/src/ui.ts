/** Private DOM backend. Games only receive the public typed UI API. */
export interface UiElement {
  id: string;
  kind: "text" | "bar" | "button" | "input";
  text: string;
  value: number;
  visible: boolean;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  x: number;
  y: number;
  width: number;
  color: string;
  world?: {
    entity: string;
    offset: readonly [number, number, number];
    occlude: boolean;
  };
}

export interface UiPosition {
  x: number;
  y: number;
  visible: boolean;
  occluded: boolean;
}
type Selection = { start: number; end: number; direction: string };
type Trace = {
  sequence: number;
  type: string;
  id: string | null;
  value: string | null;
  composing: boolean;
  selection: Selection | null;
  data: string | null;
  inputType: string | null;
  trusted: boolean;
};
export interface UiInspection {
  mounted: boolean;
  disposed: boolean;
  focus: string | null;
  composing: boolean;
  inputValue: string | null;
  selection: Selection | null;
  elements: {
    id: string;
    kind: UiElement["kind"];
    visible: boolean;
    composing: boolean;
    inputValue: string | null;
    selection: Selection | null;
    pendingCommit: string | null;
  }[];
  trace: Trace[];
  gamepad: {
    source: "none" | "virtual" | "physical";
    hardwareVerified: false;
    index: number | null;
    connected: number;
  };
}
export interface UIRenderer {
  mount(): void;
  present(
    elements: readonly UiElement[],
    positions?: ReadonlyMap<string, UiPosition>,
  ): void;
  consumesKeyboard(event: KeyboardEvent): boolean;
  inspect(): UiInspection;
  dispose(): void;
}
type Row = {
  definition: UiElement;
  node: HTMLElement;
  input: HTMLInputElement | null;
  shown: boolean;
  composing: boolean;
  authoredText: string;
  emittedText: string | null;
  pendingCommit: string | null;
};

export function createUIRenderer(
  definitions: readonly UiElement[],
  callbacks: {
    input: (key: string, pressed: boolean) => void;
    emit: (type: string, payload: unknown) => void;
  },
): UIRenderer {
  const root = document.createElement("div");
  root.dataset.threecatUi = "";
  Object.assign(root.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "3",
    fontFamily: "system-ui",
    color: "white",
  });
  const rows = new Map<string, Row>();
  let order: string[] = [];
  let mounted = false;
  let disposed = false;
  let sequence = 0;
  let reportedFocus: string | null = null;
  const traces: Trace[] = [];
  const listeners: { type: string; listener: EventListener }[] = [];
  let previousPads = new Map<number, boolean[]>();
  let gamepad: UiInspection["gamepad"] = {
    source: "none",
    hardwareVerified: false,
    index: null,
    connected: 0,
  };
  function selection(row: Row): Selection | null {
    const node = row.input;
    return node
      ? {
          start: node.selectionStart ?? 0,
          end: node.selectionEnd ?? 0,
          direction: node.selectionDirection ?? "none",
        }
      : null;
  }
  function trace(type: string, row?: Row, event?: Event) {
    const source = event as InputEvent | CompositionEvent | undefined;
    traces.push({
      sequence: ++sequence,
      type,
      id: row?.definition.id ?? null,
      value: row?.input?.value ?? null,
      composing: row?.composing ?? false,
      selection: row ? selection(row) : null,
      data: typeof source?.data === "string" ? source.data : null,
      inputType: source && "inputType" in source ? source.inputType : null,
      trusted: event?.isTrusted ?? false,
    });
    if (traces.length > 128) traces.splice(0, traces.length - 128);
  }
  function focused() {
    return [...rows.values()].find(
      (row) => row.node === document.activeElement,
    );
  }
  function interactive(row: Row) {
    return (
      mounted &&
      !disposed &&
      row.shown &&
      root.isConnected &&
      (row.definition.kind === "button" || row.definition.kind === "input")
    );
  }
  function targetRow(event: Event) {
    return [...rows.values()].find((row) => row.node === event.target);
  }
  function emitText(row: Row) {
    if (!row.input || row.composing || !interactive(row)) return;
    const text = row.input.value;
    if (row.emittedText === text) return;
    row.emittedText = text;
    row.pendingCommit = text;
    callbacks.emit("ui.text", {
      id: row.definition.id,
      text,
      composing: false,
    });
  }
  function listen(type: string, action: (event: Event, row: Row) => void) {
    const listener = (event: Event) => {
      const row = targetRow(event);
      if (row && !disposed) action(event, row);
    };
    listeners.push({ type, listener });
    root.addEventListener(type, listener);
  }
  function reportFocus(id: string | null) {
    if (reportedFocus === id) return;
    reportedFocus = id;
    callbacks.emit("ui.focus", { id });
  }
  listen("focusin", (event, row) => {
    trace("focusin", row, event);
    reportFocus(row.definition.id);
  });
  listen("focusout", (event, row) => {
    trace("focusout", row, event);
    reportFocus(null);
  });
  listen("compositionstart", (event, row) => {
    if (!row.input || !interactive(row)) return;
    row.composing = true;
    trace(event.type, row, event);
  });
  listen("compositionupdate", (event, row) => trace(event.type, row, event));
  listen("compositionend", (event, row) => {
    row.composing = false;
    trace(event.type, row, event);
    emitText(row);
  });
  for (const type of ["beforeinput", "paste", "select"])
    listen(type, (event, row) => trace(type, row, event));
  listen("input", (event, row) => {
    trace("input", row, event);
    if (!(event as InputEvent).isComposing) emitText(row);
  });
  listen("keydown", (event, row) => {
    const key = event as KeyboardEvent;
    if (!row.input || !interactive(row)) return;
    trace("keydown", row, event);
    if (
      key.key === "Enter" &&
      !key.isComposing &&
      !row.composing &&
      key.keyCode !== 229
    ) {
      key.preventDefault();
      if (!key.repeat)
        callbacks.emit("ui.submit", {
          id: row.definition.id,
          text: row.input.value,
        });
    }
  });
  listen("click", (event, row) => {
    if (row.definition.kind !== "button" || !interactive(row)) return;
    trace("activate", row, event);
    callbacks.input("ui:" + row.definition.id, true);
    callbacks.input("ui:" + row.definition.id, false);
    callbacks.emit("ui.activate", { id: row.definition.id });
  });
  function retire(row: Row) {
    row.shown = false;
    row.composing = false;
    if (row.node === document.activeElement) row.node.blur();
    row.node.remove();
  }
  function render(
    elements: readonly UiElement[],
    positions?: ReadonlyMap<string, UiPosition>,
  ) {
    const ids = new Set<string>();
    for (const definition of elements) {
      if (ids.has(definition.id))
        throw new Error("TC_UI_DUPLICATE_ID: " + definition.id);
      ids.add(definition.id);
    }
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        retire(row);
        rows.delete(id);
      }
    }
    order = elements.map((element) => element.id);
    for (const definition of elements) {
      let row = rows.get(definition.id);
      if (row && row.definition.kind !== definition.kind) {
        retire(row);
        rows.delete(definition.id);
        row = undefined;
      }
      if (!row) {
        const node = document.createElement(
          definition.kind === "button"
            ? "button"
            : definition.kind === "bar"
              ? "progress"
              : definition.kind === "input"
                ? "input"
                : "div",
        );
        node.dataset.threecatElement = definition.id;
        Object.assign(node.style, {
          position: "absolute",
          padding: "8px 12px",
          borderRadius: "8px",
          background: "rgba(12,20,31,0.82)",
          fontSize: "16px",
          boxSizing: "border-box",
          maxWidth: "90%",
        });
        const input =
          definition.kind === "input" ? (node as HTMLInputElement) : null;
        if (input) {
          input.type = "text";
          input.autocomplete = "off";
          input.value = definition.text;
        }
        if (definition.kind === "button")
          (node as HTMLButtonElement).type = "button";
        if (definition.kind === "bar") (node as HTMLProgressElement).max = 1;
        row = {
          definition,
          node,
          input,
          shown: false,
          composing: false,
          authoredText: definition.text,
          emittedText: null,
          pendingCommit: null,
        };
        rows.set(definition.id, row);
        root.appendChild(node);
      }
      row.definition = {
        ...definition,
        world: definition.world
          ? {
              ...definition.world,
              offset: [...definition.world.offset],
            }
          : undefined,
      };
      const { node, input } = row;
      // Per-element keys allow distinct offsets on the same world entity.
      const position = definition.world
        ? positions?.get(definition.id)
        : undefined;
      row.shown =
        definition.visible &&
        (!definition.world ||
          (!!position &&
            position.visible &&
            Number.isFinite(position.x) &&
            Number.isFinite(position.y) &&
            (!definition.world.occlude || !position.occluded)));
      if (!row.shown) {
        // No hidden control can emit a blur commit or retain keyboard/gamepad focus.
        row.composing = false;
        if (node === document.activeElement) node.blur();
      }
      node.hidden = !row.shown;
      node.style.display = row.shown ? "" : "none";
      const control =
        definition.kind === "input" || definition.kind === "button";
      if (control)
        (node as HTMLInputElement | HTMLButtonElement).disabled = !row.shown;
      node.tabIndex = control && row.shown ? 0 : -1;
      node.style.pointerEvents = control && row.shown ? "auto" : "none";
      node.style.width = definition.width + "px";
      node.style.color = definition.color;
      const style = node.style;
      style.left =
        style.right =
        style.top =
        style.bottom =
        style.transform =
          "";
      if (definition.world) {
        style.left = (position?.x ?? 0) + "px";
        style.top = (position?.y ?? 0) + "px";
      } else if (definition.anchor === "center") {
        Object.assign(style, {
          left: "50%",
          top: "50%",
          transform: "translate(-50%,-50%)",
        });
      } else {
        style[definition.anchor.endsWith("right") ? "right" : "left"] =
          definition.x + "px";
        style[definition.anchor.startsWith("bottom") ? "bottom" : "top"] =
          definition.y + "px";
      }
      if (input) {
        const active = document.activeElement === input;
        const pending = row.pendingCommit !== null;
        const echo = pending && definition.text === row.pendingCommit;
        const allowWrite = !row.composing && !(active && pending);
        // A game tick may still contain the pre-commit value. Wait for its exact echo while focused.
        if (
          allowWrite &&
          (row.authoredText !== definition.text || pending) &&
          input.value !== definition.text
        ) {
          const saved = selection(row)!;
          input.value = definition.text;
          input.setSelectionRange(
            Math.min(saved.start, input.value.length),
            Math.min(saved.end, input.value.length),
            saved.direction as "forward" | "backward" | "none",
          );
          row.emittedText = definition.text;
        }
        if (echo || (!active && !row.composing)) row.pendingCommit = null;
        row.authoredText = definition.text;
      } else if (definition.kind === "bar") {
        (node as HTMLProgressElement).value = definition.value;
      } else if (node.textContent !== definition.text)
        node.textContent = definition.text;
    }
  }
  function moveFocus(direction: number) {
    const candidates = order.map((id) => rows.get(id)!).filter(interactive);
    if (!candidates.length) return;
    const index = candidates.indexOf(focused()!);
    const next =
      index < 0
        ? direction > 0
          ? 0
          : candidates.length - 1
        : (index + direction + candidates.length) % candidates.length;
    candidates[next].node.focus({ preventScroll: true });
    trace("gamepad.focus", candidates[next]);
  }
  function pollGamepads() {
    const samples =
      typeof navigator.getGamepads === "function"
        ? navigator.getGamepads()
        : [];
    const nextPads = new Map<number, boolean[]>();
    gamepad = {
      source: "none",
      hardwareVerified: false,
      index: null,
      connected: 0,
    };
    for (const pad of samples) {
      if (!pad?.connected || pad.mapping !== "standard") continue;
      gamepad.connected++;
      if (gamepad.index === null) {
        gamepad.index = pad.index;
        gamepad.source =
          typeof Gamepad !== "undefined" && pad instanceof Gamepad
            ? "physical"
            : "virtual";
      }
      const pressed = (index: number) =>
        pad.buttons[index]?.pressed === true ||
        (pad.buttons[index]?.value ?? 0) > 0.5;
      const state = [
        pressed(12) || (pad.axes[1] ?? 0) < -0.5,
        pressed(14) || (pad.axes[0] ?? 0) < -0.5,
        pressed(13) || (pad.axes[1] ?? 0) > 0.5,
        pressed(15) || (pad.axes[0] ?? 0) > 0.5,
        pressed(0),
      ];
      const previous = previousPads.get(pad.index) ?? [
        false,
        false,
        false,
        false,
        false,
      ];
      nextPads.set(pad.index, state);
      // Consume edges during IME without moving focus or activating another control.
      if ([...rows.values()].some((row) => row.composing)) continue;
      const direction = state.findIndex(
        (value, index) => index < 4 && value && !previous[index],
      );
      if (direction >= 0) moveFocus(direction < 2 ? -1 : 1);
      if (state[4] && !previous[4]) {
        const row = focused();
        if (!row || !interactive(row)) moveFocus(1);
        else if (row.definition.kind === "button") row.node.click();
      }
    }
    previousPads = nextPads;
  }
  render(definitions);
  return {
    mount() {
      if (disposed || mounted) return;
      document.body.appendChild(root);
      mounted = true;
      trace("mount");
    },
    present(elements, positions) {
      if (disposed) return;
      render(elements, positions);
      if (mounted) pollGamepads();
    },
    consumesKeyboard(event) {
      if (disposed || !mounted) return false;
      return (
        event.isComposing ||
        [...rows.values()].some((row) => row.composing) ||
        !!focused()?.input ||
        !!targetRow(event)?.input
      );
    },
    inspect() {
      const focus = focused();
      return {
        mounted,
        disposed,
        focus: focus?.definition.id ?? null,
        composing: [...rows.values()].some((row) => row.composing),
        inputValue: focus?.input?.value ?? null,
        selection: focus ? selection(focus) : null,
        elements: order.map((id) => {
          const row = rows.get(id)!;
          return {
            id,
            kind: row.definition.kind,
            visible: row.shown,
            composing: row.composing,
            inputValue: row.input?.value ?? null,
            selection: selection(row),
            pendingCommit: row.pendingCommit,
          };
        }),
        trace: traces.map((entry) => ({
          ...entry,
          selection: entry.selection ? { ...entry.selection } : null,
        })),
        gamepad: { ...gamepad },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mounted = false;
      reportFocus(null);
      for (const { type, listener } of listeners)
        root.removeEventListener(type, listener);
      listeners.length = 0;
      for (const row of rows.values()) retire(row);
      rows.clear();
      order = [];
      previousPads.clear();
      gamepad = {
        source: "none",
        hardwareVerified: false,
        index: null,
        connected: 0,
      };
      root.remove();
      trace("dispose");
    },
  };
}

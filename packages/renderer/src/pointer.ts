import type { PointerContact, PointerState } from "../../sdk/src/index.ts";
import { neutralPointer } from "../../runtime/src/pointer.ts";

/** Owns browser input only; gameplay receives immutable tick samples. */
export function createPointerInput(canvas: HTMLCanvasElement, lockRequested: () => boolean, fault: (code: string) => void, additional: readonly HTMLCanvasElement[] = []) {
  const surfaces = [canvas, ...additional];
  let state = neutralPointer(), dirty = false, disposed = false;
  const contacts = new Map<number, PointerContact>();
  const listeners: { target: EventTarget; type: string; listener: EventListener }[] = [];
  const listen = (target: EventTarget, type: string, listener: EventListener) => {
    listeners.push({ target, type, listener }); target.addEventListener(type, listener, { passive: false });
  };
  const locked = () => surfaces.includes(document.pointerLockElement as HTMLCanvasElement);
  const sample = (event: PointerEvent) => {
    const surface = event.currentTarget as HTMLCanvasElement;
    const rect = surface.getBoundingClientRect(), previous = state.buttons;
    const position: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
    const buttons = event.type === "pointercancel" ? 0 : event.buttons & 31;
    const kind = event.pointerType === "touch" || event.pointerType === "pen" ? event.pointerType : "mouse";
    if (event.type === "pointerdown" && contacts.size < 16 || contacts.has(event.pointerId)) {
      if (event.type === "pointerup" || event.type === "pointercancel") contacts.delete(event.pointerId);
      else contacts.set(event.pointerId, { id: event.pointerId, position, pressure: event.pressure, kind });
    }
    state = { ...state, position, ndc: [2 * position[0] / Math.max(1, rect.width) - 1, 1 - 2 * position[1] / Math.max(1, rect.height)],
      delta: [state.delta[0] + event.movementX, state.delta[1] + event.movementY], buttons,
      pressed: state.pressed | (buttons & ~previous), released: state.released | (previous & ~buttons),
      inside: event.type !== "pointerleave" && event.type !== "pointercancel" && position[0] >= 0 && position[1] >= 0 && position[0] <= rect.width && position[1] <= rect.height,
      locked: locked(), contacts: [...contacts.values()].sort((a, b) => a.id - b.id) };
    dirty = true;
    if (event.type === "pointerdown") {
      surface.setPointerCapture?.(event.pointerId);
      if (lockRequested() && !locked()) {
        try { void surface.requestPointerLock()?.catch(() => fault("TC_POINTER_LOCK_DENIED")); } catch { fault("TC_POINTER_LOCK_DENIED"); }
      }
    }
    if (kind === "touch") event.preventDefault();
  };
  for (const surface of surfaces) {
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerenter", "pointerleave"]) listen(surface, type, event => sample(event as PointerEvent));
  listen(surface, "wheel", event => {
    const wheel = event as WheelEvent, unit = wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? surface.clientHeight : 1;
    state.wheel = [state.wheel[0] + wheel.deltaX * unit, state.wheel[1] + wheel.deltaY * unit]; dirty = true; event.preventDefault();
  });
  surface.style.touchAction = "none";
  }
  const clear = () => { const released = state.released | state.buttons; contacts.clear(); state = { ...neutralPointer(), position: state.position, ndc: state.ndc, released }; dirty = true; };
  listen(window, "blur", clear);
  listen(document, "visibilitychange", () => { if (document.hidden) clear(); });
  listen(document, "pointerlockchange", () => { state.locked = locked(); if (!locked()) clear(); dirty = true; });
  return {
    drain(): PointerState | undefined {
      if (disposed) return;
      if (!lockRequested() && locked()) document.exitPointerLock();
      if (!dirty) return;
      const result = { ...state }; state = { ...state, delta: [0, 0], wheel: [0, 0], pressed: 0, released: 0 }; dirty = false;
      return result;
    },
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { target, type, listener } of listeners) target.removeEventListener(type, listener);
      listeners.length = 0; contacts.clear(); if (locked()) document.exitPointerLock();
    },
  };
}

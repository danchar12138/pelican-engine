import type { GamepadState } from "../../sdk/src/index.ts";

export const GAMEPAD_MAX_AXES = 8;
export const GAMEPAD_MAX_BUTTONS = 32;
export function neutralGamepad(available = false, suppressed = false): GamepadState {
  return { available, connected: false, index: null, axes: [], buttons: [], suppressed };
}
export function parseGamepad(value: unknown, code: string): GamepadState {
  const fail = (message: string): never => { throw new Error(`${code}: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== ["available", "connected", "index", "axes", "buttons", "suppressed"].sort().join("\0"))
    return fail("Expected an explicit gamepad state object.");
  const data = value as GamepadState;
  if (typeof data.available !== "boolean" || typeof data.connected !== "boolean" || typeof data.suppressed !== "boolean" ||
      !Array.isArray(data.axes) || data.axes.length > GAMEPAD_MAX_AXES || !Array.isArray(data.buttons) || data.buttons.length > GAMEPAD_MAX_BUTTONS ||
      data.axes.some(n => typeof n !== "number" || !Number.isFinite(n) || n < -1 || n > 1) ||
      data.buttons.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1))
    return fail("Gamepad axes/buttons must be bounded finite values.");
  if (data.connected) {
    if (!data.available || data.suppressed || !Number.isSafeInteger(data.index) || data.index! < 0 || data.index! > 255)
      return fail("A connected gamepad needs an available, unsuppressed index in 0..255.");
  } else if (data.index !== null || data.axes.length || data.buttons.length)
    return fail("A disconnected gamepad must have no index, axes or buttons.");
  return { available: data.available, connected: data.connected, index: data.index, axes: [...data.axes], buttons: [...data.buttons], suppressed: data.suppressed };
}

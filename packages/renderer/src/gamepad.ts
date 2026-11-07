import type { GamepadState } from "../../sdk/src/index.ts";
import { GAMEPAD_MAX_AXES, GAMEPAD_MAX_BUTTONS, neutralGamepad } from "../../runtime/src/gamepad.ts";

/** Read only standard-mapped gamepads; no device identifiers leave the browser adapter. */
export function sampleGameplayGamepad(suppressed: boolean): GamepadState {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return neutralGamepad(false, suppressed);
  if (suppressed) return neutralGamepad(true, true);
  try {
    const pad = Array.from(navigator.getGamepads()).filter((value): value is Gamepad => !!value && value.connected && value.mapping === "standard" &&
      Number.isSafeInteger(value.index) && value.index >= 0 && value.index <= 255).sort((a, b) => a.index - b.index)[0];
    if (!pad) return neutralGamepad(true, false);
    const quantize = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0)) * 1000) / 1000;
    const axes = Array.from(pad.axes).slice(0, GAMEPAD_MAX_AXES).map(value => quantize(value, -1, 1));
    const buttons = Array.from(pad.buttons).slice(0, GAMEPAD_MAX_BUTTONS).map(button => {
      const value = Number.isFinite(button.value) ? button.value : 0;
      return quantize(button.pressed && value === 0 ? 1 : value, 0, 1);
    });
    return { available: true, connected: true, index: pad.index, axes, buttons, suppressed: false };
  } catch { return neutralGamepad(false, false); }
}

import type { CinematicPresentation } from "../../sdk/src/index.ts";

/** Presentation only; time and ownership remain in the deterministic director. */
export function createCinematicOverlay() {
  const root = document.createElement("div"), fade = document.createElement("div"), subtitles = document.createElement("div");
  root.dataset.pelicanCinematics = "";
  Object.assign(root.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "40" });
  Object.assign(fade.style, { position: "absolute", inset: "0", opacity: "0", background: "#000000" });
  Object.assign(subtitles.style, { position: "absolute", bottom: "max(24px, env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)", maxWidth: "calc(100% - 32px)", width: "max-content", maxHeight: "40%", overflowY: "auto", overflowWrap: "anywhere", whiteSpace: "pre-wrap", boxSizing: "border-box", color: "#ffffff", background: "rgba(0,0,0,0.6)", fontFamily: "system-ui, sans-serif", fontSize: "18px", lineHeight: "1.5", letterSpacing: "0", textAlign: "center", padding: "8px 12px", borderRadius: "4px", display: "none", pointerEvents: "auto" });
  subtitles.setAttribute("role", "status"); subtitles.setAttribute("aria-live", "polite"); subtitles.setAttribute("aria-atomic", "true");
  root.append(fade, subtitles); document.body.append(root);
  let disposed = false, previous = "";
  return {
    sync(state: CinematicPresentation) {
      if (disposed) throw new Error("TC_CINEMATIC_OVERLAY_DISPOSED: Create a new presentation owner.");
      fade.style.backgroundColor = state.transition.color; fade.style.opacity = String(state.transition.opacity);
      const text = state.subtitles.map(cue => cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text).join("\n");
      if (text !== previous) { subtitles.textContent = text; previous = text; }
      subtitles.style.display = text ? "block" : "none";
    },
    clear() { if (disposed) return; fade.style.opacity = "0"; subtitles.textContent = ""; subtitles.style.display = "none"; previous = ""; },
    dispose() { if (disposed) return; disposed = true; root.remove(); },
  };
}

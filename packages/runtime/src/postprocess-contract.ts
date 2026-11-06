import type { PostProcessState } from "../../sdk/src/index.ts";

/** Renderer-private data view. Gameplay receives only PostProcessService. */
export interface PostProcessOwnerView {
  states(): readonly PostProcessState[];
  historyRevisions(): Readonly<Record<string, number>>;
}

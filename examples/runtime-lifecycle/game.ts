import { defineGame, defineScene, defineSystem } from "pelican-engine";

// Copy these two files into an npm game project, npm install fflate,
// set content: "typescript" in pelican.project.json, then pelican build.
export default defineGame({
  id: "runtime-lifecycle",
  ui: [{id:"save",kind:"button",text:"Save",x:16,y:16,width:100},{id:"load",kind:"button",text:"Load",x:132,y:16,width:100}],
  scene: defineScene({ id: "main", entities: [{ id: "counter" }] }),
  systems: [defineSystem({ id: "counter", writes: ["Transform"], structural: false })],
  runtime: {
    version: "counter-v1",
    async create(scope) {
      // This module reads document at import time and imports a real npm library.
      // Construction only serializes metadata; it must never initialize this dependency.
      const { createCounterView } = await import("./browser-counter.ts");
      scope.signal.throwIfAborted();
      const view = scope.own(createCounterView());
      let ticks = 0;
      const validate = (value: unknown): void => {
        if (!value || typeof value !== "object" || !("ticks" in value) ||
            !Number.isSafeInteger(value.ticks) || Number(value.ticks) < 0)
          throw new Error("TC_COUNTER_SNAPSHOT: Expected non-negative integer ticks; restore an intact counter-v1 checkpoint.");
      };
      return {
        systems: {
          counter(ctx) {
            ticks++;
            for(const event of ctx.events("ui.activate")){const id=(event.payload as {id:string}).id;if(id==="save")ctx.storage.save("counter");if(id==="load")ctx.storage.load("counter");}
            ctx.setTransform("counter", { position: [ticks / 60, 0, 0] });
            view.show(ticks);
          },
        },
        snapshot: () => ({ ticks }),
        validateSnapshot: validate,
        restore(value) {
          validate(value);
          ticks = (value as { ticks: number }).ticks;
          view.show(ticks);
        },
      };
    },
  },
});

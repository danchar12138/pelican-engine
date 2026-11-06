import assert from "node:assert/strict";
import test from "node:test";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import { createRenderSettingsDriver } from "../packages/runtime/src/render-settings.ts";
import type { PostProcessIR } from "../packages/compiler/src/types.ts";
const effect: PostProcessIR = { id: "same", enabled: true,
  buffers: [{ name: "data", type: "float", count: 1, buffer: "a" }],
  source: { file: "fixture.ts", line: 1, column: 1, length: 1 },
  graph: { output: "color", outputType: "vec4", nodeTypes: { color: "vec4" }, nodes: [{ id: "color", op: "vec4", value: [1, 1, 1, 1] }] },
};
function setup() {
  const compute = createComputeDriver({ kernels: [], capabilities: () => ({ backend: "webgpu", compute: true, availableModes: ["raster"] }),
    buffers: [{ id: "a", type: "float", count: 1, data: [1] }, { id: "b", type: "float", count: 1, data: [2] }] });
  let reject = false;
  const render = createRenderSettingsDriver({}, [{ id: "same", buffers: [{ name: "data", type: "float", count: 1, buffer: "a" }] }], undefined, [effect], {
    describe(handle) { const d = compute.service.describeBuffer(handle); return { id: d.id, type: d.type, count: d.count }; },
    resource: id => compute.resource(id),
    setPins(ids) { compute.setRenderPins(ids); if (reject) { reject = false; throw Error("injected publication failure"); } },
  });
  const plugin = render.factory({} as never), a = compute.service.resolve("a"), b = compute.service.resolve("b");
  return { compute, render, plugin, a, b, reject: () => { reject = true; }, dispose() { render.dispose(); compute.dispose(); } };
}
test("fragment slots: material and post IDs are independent and jointly pin sources", t => {
  const f = setup(); t.after(() => f.dispose());
  f.render.service.buffers.bind("same", "data", f.b);
  assert.equal(f.render.service.effects.buffers.state("same").data.id, "a");
  assert.equal(f.render.service.buffers.state("same").data.id, "b");
  assert.throws(() => f.compute.service.releaseBuffer(f.a), /TC_COMPUTE_BUFFER_IN_USE/);
  assert.throws(() => f.compute.service.releaseBuffer(f.b), /TC_COMPUTE_BUFFER_IN_USE/);
  f.render.service.buffers.unbind("same", "data"); f.compute.service.releaseBuffer(f.b);
  assert.throws(() => f.compute.service.releaseBuffer(f.a), /TC_COMPUTE_BUFFER_IN_USE/);
  f.render.service.effects.buffers.unbind("same", "data"); f.compute.service.releaseBuffer(f.a);
});
test("fragment slots: restore preflights both namespaces and failed pin publication leaves both states intact", t => {
  const f = setup(); t.after(() => f.dispose()); const saved = f.plugin.snapshot();
  f.render.service.buffers.bind("same", "data", f.b); f.render.service.effects.buffers.bind("same", "data", f.b);
  f.render.service.configure({ exposure: 2 }); const before = f.plugin.snapshot();
  const bad = structuredClone(saved) as any; bad.effectBufferBindings.bindings.same.data.count = 9;
  assert.throws(() => f.plugin.restore(bad), /TC_RENDER_BUFFER_SNAPSHOT/); assert.deepEqual(f.plugin.snapshot(), before);
  f.reject(); assert.throws(() => f.plugin.restore(saved), /TC_RENDER_BUFFER_PROVIDER/);
  assert.deepEqual(f.plugin.snapshot(), before); assert.throws(() => f.compute.service.releaseBuffer(f.b), /TC_COMPUTE_BUFFER_IN_USE/);
  f.plugin.restore(saved); assert.deepEqual(f.plugin.snapshot(), saved);
  assert.throws(() => f.compute.service.releaseBuffer(f.a), /TC_COMPUTE_BUFFER_IN_USE/);
  f.compute.service.releaseBuffer(f.b);
});
test("fragment slots: postprocess references participate in peer preflight and reacquire source generations", t => {
  const f = setup(); t.after(() => f.dispose()); const checkpoint = f.plugin.snapshot();
  const peer = f.compute.factory({} as never), computeSaved = peer.snapshot();
  const bad = structuredClone(computeSaved) as any; bad.buffers = bad.buffers.filter((b: any) => b.id !== "a");
  assert.throws(() => f.plugin.validatePeers(checkpoint, { "$engine.compute": { payload: bad } }), /TC_RENDER_BUFFER_PEER_SNAPSHOT/);
  const old = f.render.effectBuffers.resources("same").data.key;
  f.plugin.validatePeers(checkpoint, { "$engine.compute": { payload: computeSaved } }); f.plugin.restore(checkpoint); peer.restore(computeSaved);
  assert.notEqual(f.render.effectBuffers.resources("same").data.key, old);
  assert.throws(() => f.render.service.effects.buffers.bind("same", "data", f.a), /TC_RENDER_BUFFER_PROVIDER/);
});
test("fragment slots: postprocess parameter/history restore retains its buffer declarations", t => {
  const f = setup(); t.after(() => f.dispose());
  const checkpoint = f.plugin.snapshot() as any;
  assert.equal(checkpoint.effectBufferBindings.definitions[0].id, "same");
  assert.equal(checkpoint.postProcesses.definitions[0].buffers[0].buffer, "a");
  f.render.service.effects.configure("same", { enabled: false }); f.plugin.restore(checkpoint);
  assert.equal(f.render.service.effects.state("same").enabled, true);
});

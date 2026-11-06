import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { evaluateTypedGraph } from "../packages/renderer/src/graph-expressions.ts";
import { evaluateVertexGraphs } from "../packages/renderer/src/vertex-graphs.ts";
import { createVertexBoundsOwner } from "../packages/renderer/src/vertex-bounds.ts";
import type { MaterialGraphBinding } from "../packages/renderer/src/material-graphs.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";

function binding(): MaterialGraphBinding {
  const graph = compileGraphDeclaration({ parameters: [{ name: "shift", type: "vec3", default: [2, 0, 0] }], nodes: [
    { id: "p", op: "input", name: "positionLocal" }, { id: "s", op: "parameter", name: "shift" }, { id: "out", op: "add", inputs: ["p", "s"] },
  ], output: "out" }, "vec3", { domain: "vertex", inputs: ["positionLocal"] });
  assert.deepEqual(graph.issues, []);
  return { id: "shift", graphs: {}, vertex: { position: graph.graph }, time: 0, parameters: { shift: [2, 0, 0] }, textures: new Map() };
}

test("vertex CPU mirrors use explicit per-node f32 without changing the legacy f64 oracle", () => {
  const result = compileGraphDeclaration({ nodes: [{ id: "a", op: "float", value: 16777216 }, { id: "b", op: "float", value: 1 }, { id: "sum", op: "add", inputs: ["a", "b"] }, { id: "out", op: "subtract", inputs: ["sum", "a"] }], output: "out" }, "float");
  assert.equal(evaluateTypedGraph(result.graph), 1);
  assert.equal(evaluateTypedGraph(result.graph, { precision: "f32" }), 0);
  assert.throws(() => evaluateTypedGraph(result.graph, { precision: "invalid" as never }), /TC_GRAPH_CONTEXT/);
});

test("vertex graphs preserve a shared input snapshot, f32 output and zero-normal fallback", () => {
  const source = binding();
  const normal = compileGraphDeclaration({ nodes: [{ id: "zero", op: "vec3", value: [0, 0, 0] }], output: "zero" }, "vec3", { domain: "vertex" }).graph;
  source.vertex!.normal = normal;
  const input = { positionLocal: [0, 1, 0] as const, normalLocal: [0, 0, 1] as const, vertexIndex: 0, instanceIndex: 0 };
  const output = evaluateVertexGraphs(source, input, () => { throw Error("unexpected texture"); });
  assert.deepEqual(output, { position: [2, 1, 0], normal: [0, 0, 1] });
  assert.deepEqual(input.positionLocal, [0, 1, 0]);
});

test("derived bounds retain culling and CPU render raycasts follow parameter changes, then restore ownership", () => {
  const scene = new THREE.Scene(), material = new THREE.MeshStandardNodeMaterial(), mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  scene.add(mesh);
  const originalRaycast = mesh.raycast, bounds = createVertexBoundsOwner(), source = binding(), graphs = new Map([[material, source]]);
  material.positionNode = {} as never; // Engine-known override identity; CPU capture does not execute TSL.
  const sampler = new THREE.Raycaster(new THREE.Vector3(2, 0, 4), new THREE.Vector3(0, 0, -1));
  try {
    bounds.update(scene, graphs);
    assert.equal(mesh.frustumCulled, true);
    assert.equal((mesh as any).boundingSphere.center.x, 2);
    assert.ok(sampler.intersectObject(mesh).length > 0);
    const first = bounds.inspect();
    bounds.update(scene, graphs);
    assert.ok(bounds.inspect().capture.meshes.hits > first.capture.meshes.hits);
    source.parameters = { shift: [-2, 0, 0] };
    bounds.update(scene, graphs);
    assert.equal((mesh as any).boundingSphere.center.x, -2);
    assert.equal(sampler.intersectObject(mesh).length, 0);
    sampler.ray.origin.x = -2;
    assert.ok(sampler.intersectObject(mesh).length > 0);
    assert.ok(bounds.inspect().accelerations[0].refits > 0);
    mesh.rotation.y = Math.PI / 2;
    bounds.update(scene, graphs);
    sampler.ray.origin.set(0, 0, 6);
    const rotated = sampler.intersectObject(mesh)[0];
    assert.ok(rotated.face!.normal.x < -0.99 && Math.abs(rotated.face!.normal.z) < 1e-6, "Native render-ray faces remain in deformed object-local space.");
  } finally { bounds.dispose(); mesh.geometry.dispose(); material.dispose(); }
  assert.equal(mesh.raycast, originalRaycast);
  assert.equal(Object.hasOwn(mesh, "boundingSphere"), false);
});

test("vertex-aware capture rejects unregistered position hooks and accepts only engine bindings", () => {
  const scene = new THREE.Scene(), material = new THREE.MeshStandardNodeMaterial(), mesh = new THREE.Mesh(new THREE.BoxGeometry(), material), capture = createSurfaceCapture();
  scene.add(mesh); material.positionNode = { isNode: true } as never;
  assert.throws(() => capture.capture(scene), /TC_TRACE_NODE_GRAPH/);
  const source = binding();
  const captured = capture.capture(scene, new Set([material]), new Map([[material, source]]));
  assert.ok(captured.surface.triangles.every(triangle => triangle.vertices.every(vertex => vertex.position[0] >= 1.5)));
  capture.dispose(); mesh.geometry.dispose(); material.dispose();
});

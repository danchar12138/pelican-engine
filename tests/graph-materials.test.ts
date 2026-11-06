import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { float, uniform, vec3 } from "three/tsl";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import type { GraphIR } from "../packages/compiler/src/types.ts";
import type { GraphType } from "../packages/sdk/src/index.ts";
import {
  typedGraphToTSL,
  materialGraphNormalToTSL,
} from "../packages/renderer/src/graph-tsl.ts";
import { evaluateTypedGraph } from "../packages/renderer/src/graph-expressions.ts";
import {
  compileSurfaceGraphs,
  graphEmissiveProposal,
  type MaterialGraphBinding,
} from "../packages/renderer/src/material-graphs.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import { appendEmissiveLights } from "../packages/renderer/src/emissive-lights.ts";

function graph(nodes: unknown[], output: string, type: GraphType): GraphIR {
  const result = compileGraphDeclaration({ nodes, output }, type);
  assert.deepEqual(result.issues, []);
  return result.graph;
}
const constant = (type: GraphType, value: unknown) =>
  graph([{ id: "value", op: type, value }], "value", type);
const binding = (
  graphs: MaterialGraphBinding["graphs"],
): MaterialGraphBinding => ({
  id: "test",
  graphs,
  time: 0,
  parameters: {},
  textures: new Map(),
});

for (const type of ["float", "bool", "vec2", "vec3", "vec4"] as const)
  for (const condition of [false, true]) {
    test(
      "TSL select " +
        type +
        " condition " +
        condition +
        " matches CPU false-a/true-b",
      () => {
        const a =
          type === "float"
            ? 2
            : type === "bool"
              ? false
              : Array(Number(type.slice(3))).fill(2);
        const b =
          type === "float"
            ? 9
            : type === "bool"
              ? true
              : Array(Number(type.slice(3))).fill(9);
        const g = graph(
          [
            { id: "a", op: type, value: a },
            { id: "b", op: type, value: b },
            { id: "c", op: "bool", value: condition },
            { id: "out", op: "select", inputs: ["a", "b", "c"] },
          ],
          "out",
          type,
        );
        const node = typedGraphToTSL(g, float(0), new Map(), new Map());
        assert.equal(node.condNode.value, condition);
        const arm = condition ? node.ifNode : node.elseNode;
        const actual = type.startsWith("vec") ? arm.value.toArray() : arm.value;
        assert.deepEqual(actual, evaluateTypedGraph(g));
      },
    );
  }

test("TSL graph texture reads explicitly select base LOD with unchanged UV and texture", () => {
  const texture = new THREE.Texture();
  const g = graph(
    [
      { id: "uv", op: "vec2", value: [0.25, 0.75] },
      { id: "sample", op: "sampleTexture", texture: "tex", inputs: ["uv"] },
    ],
    "sample",
    "vec4",
  );
  const node = typedGraphToTSL(
    g,
    float(0),
    new Map(),
    new Map([["tex", texture]]),
  );
  assert.equal(node.value, texture);
  assert.equal(node.levelNode.value, 0);
  assert.deepEqual(node.uvNode.value.toArray(), [0.25, 0.75]);
  texture.dispose();
});

test("surface graph channels preserve standard tint and opacity-factor semantics", () => {
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x203040,
    opacity: 0.2,
    transparent: true,
  });
  material.colorNode = vec3(1, 0, 0);
  material.opacityNode = float(0.5);
  const alpha = new THREE.DataTexture(
    new Uint8Array([255, 128, 255, 255]),
    1,
    1,
  );
  material.alphaMap = alpha;
  const scene = new THREE.Scene(),
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  scene.add(mesh);
  const graphs = binding({
    baseColor: constant("vec3", [1, 0, 0]),
    opacity: constant("float", 0.5),
    normalWorld: constant("vec3", [0, 0, 0]),
  });
  const bindings = new Map([[material, graphs]]),
    capture = createSurfaceCapture();
  try {
    const snapshot = capture.capture(scene, new Set(), bindings).surface;
    const captured = snapshot.materials[0];
    assert.equal(captured.baseColor[3], 1);
    assert.equal(captured.maps.alphaMap, undefined);
    assert.equal(material.opacity, 0.2);
    assert.equal(material.alphaMap, alpha);
    const program = compileSurfaceGraphs(snapshot, bindings);
    assert.match(
      program.source,
      /result\.base=.*\*vec3f\(triangle\.b\.w,triangle\.c\.w,triangle\.na\.w\)/,
    );
    assert.match(program.source, /result\.base\*=vertexColor\.rgb/);
    assert.match(program.source, /result\.alpha\*=clamp/);
    assert.match(SURFACE_SHADER, /alpha\*=custom\.x/);
    assert.match(
      program.source,
      /surfaceGraphNormal\(.*normalWorld\)\*surfaceNormalSign/,
    );
    assert.match(SURFACE_SHADER, /if\(scale==0\.0\)\{return fallback;\}/);
    assert.ok(materialGraphNormalToTSL(vec3(0)).isNode);
  } finally {
    capture.dispose();
    mesh.geometry.dispose();
    material.dispose();
    alpha.dispose();
  }
});

for (const input of ["uv", "uv1"] as const)
  test(
    "graph capture validates missing " + input + " only when reachable",
    () => {
      const material = new THREE.MeshStandardNodeMaterial();
      const geometry = new THREE.PlaneGeometry();
      geometry.deleteAttribute(input);
      const mesh = new THREE.Mesh(geometry, material),
        scene = new THREE.Scene();
      scene.add(mesh);
      const uvGraph = graph(
        [
          { id: "uv", op: "input", name: input },
          { id: "sample", op: "sampleTexture", texture: "tex", inputs: ["uv"] },
          { id: "rgb", op: "swizzle", components: "rgb", inputs: ["sample"] },
        ],
        "rgb",
        "vec3",
      );
      const graphs = binding({ baseColor: uvGraph }),
        capture = createSurfaceCapture();
      try {
        assert.throws(
          () =>
            capture.capture(scene, new Set(), new Map([[material, graphs]])),
          (error) =>
            error instanceof Error &&
            error.message.includes(
              "TC_GRAPH_UV: Material test requires " + input,
            ) &&
            error.message.includes(mesh.uuid),
        );
        graphs.graphs.baseColor = graph(
          [...uvGraph.nodes, { id: "value", op: "vec3", value: [1, 1, 1] }],
          "value",
          "vec3",
        );
        assert.doesNotThrow(() =>
          capture.capture(scene, new Set(), new Map([[material, graphs]])),
        );
      } finally {
        capture.dispose();
        geometry.dispose();
        material.dispose();
      }
    },
  );

test("black standard emissive does not remove graph emitters from the light proposal", () => {
  const material = new THREE.MeshStandardNodeMaterial({
    emissive: 0,
    emissiveIntensity: 0,
  });
  material.emissiveNode = uniform(new THREE.Vector3(3, 2, 1));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material),
    scene = new THREE.Scene();
  scene.add(mesh);
  const bindings = new Map([
      [material, binding({ emissive: constant("vec3", [3, 2, 1]) })],
    ]),
    capture = createSurfaceCapture();
  try {
    const snapshot = capture.capture(scene, new Set(), bindings).surface;
    assert.equal(
      appendEmissiveLights(snapshot, snapshot.triangles, new Float32Array())
        .emitters,
      0,
    );
    const proposal = graphEmissiveProposal(snapshot, bindings);
    const packed = appendEmissiveLights(
      proposal,
      snapshot.triangles,
      new Float32Array(),
    );
    assert.equal(packed.emitters, 2);
    assert.equal(packed.data[2], 0.5);
    assert.deepEqual(snapshot.materials[0].emissive, [0, 0, 0]);
    assert.equal(snapshot.materials[0].emissiveIntensity, 0);
    assert.equal(proposal.triangles, snapshot.triangles);
    assert.equal(graphEmissiveProposal(snapshot, new Map()), snapshot);
  } finally {
    capture.dispose();
    mesh.geometry.dispose();
    material.dispose();
  }
});

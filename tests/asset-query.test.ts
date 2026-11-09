import test from "node:test";
import assert from "node:assert/strict";
import { queryAssets } from "../tools/asset-query.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
const ir = {
  assets: [
    {
      id: "room",
      type: "model",
      sourcePath: "assets/room.glb",
      hash: "hash",
      metadata: {
        bytes: 100,
        triangleCount: 24,
        materialCount: 3,
        materials: [
          { index: 0, name: "wood" },
          { index: 1 },
          { index: 2, name: "brass" },
        ],
      },
      source: { file: "game.ts", line: 3, column: 1 },
    },
  ],
} as unknown as SceneIR;
test("asset queries page real metadata and material names without inventing a binding", () => {
  const list = queryAssets(ir);
  assert.ok("total" in list);
  assert.equal(list.total, 1);
  const detail = queryAssets(ir, "room", 2) as ReturnType<
    typeof queryAssets
  > & {
    materialSlots: {
      total: number;
      nextOffset: number;
      entries: { name: string | null; named: boolean }[];
    };
  };
  assert.equal(detail.materialSlots.total, 3);
  assert.equal(detail.materialSlots.nextOffset, 2);
  assert.equal(detail.materialSlots.entries[0].name, "wood");
  assert.equal(detail.materialSlots.entries[1].named, false);
  assert.deepEqual(queryAssets(ir, "room", 2, 2).materialSlots?.entries, [
    { index: 2, name: "brass", named: true, referencedByMesh: null },
  ]);
  assert.throws(() => queryAssets(ir, "missing"), /TC_ASSET_QUERY_UNKNOWN/);
  assert.throws(() => queryAssets(ir, undefined, 0), /TC_ASSET_QUERY/);
  assert.equal(ir.assets[0].metadata?.materialCount, 3);
});

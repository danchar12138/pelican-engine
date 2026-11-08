import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  declarationFingerprintSource,
  type DeclarationFingerprint,
} from "../packages/schema/src/declaration-fingerprint.ts";

const fingerprint = new Function(
  `${declarationFingerprintSource}; return fingerprint;`,
)() as (value: unknown) => DeclarationFingerprint;
const matches = new Function(
  `${declarationFingerprintSource}; return matchesDeclaration;`,
)() as (value: unknown, hash: number, encoded: string) => boolean;
function expected(value: unknown) {
  const { hash, numbers } = fingerprint(value),
    bytes = Buffer.alloc(numbers.length * 8);
  numbers.forEach((number, index) => bytes.writeDoubleLE(number, index * 8));
  return [hash, bytes.toString("base64")] as const;
}
test("construction comparison tolerates observed cross-runtime math tails without decimal quantization", () => {
  const reference = {
    geometry: [
      -0.06758126995938145,
      4.073026397178412e-17,
      1 / 3,
      1.0000000000000004,
      Number.MIN_VALUE * 10,
    ],
    count: 425,
  };
  const browser = {
    geometry: [
      -0.06758126995938143,
      4.0730263971784127e-17,
      1 / 3 + Number.EPSILON / 4,
      1,
      Number.MIN_VALUE * 11,
    ],
    count: 425,
  };
  assert.equal(matches(browser, ...expected(reference)), true);
  assert.deepEqual(reference.geometry, [
    -0.06758126995938145,
    4.073026397178412e-17,
    1 / 3,
    1.0000000000000004,
    Number.MIN_VALUE * 10,
  ]);
});
test("significant numeric, discrete, shape and identity drift still rejects", () => {
  const reference = {
    id: "game",
    count: 2 ** 52,
    zero: 0,
    values: [0.3, 1e-100],
    run() {},
  };
  for (const patch of [
    { id: "browser" },
    { count: 2 ** 52 + 1 },
    { zero: 1e-100 },
    { values: [0.3000000001, 1e-100] },
    { values: [0.3, 2e-100] },
    { values: [0.3] },
    { extra: true },
    { run: null },
  ])
    assert.equal(
      matches({ ...reference, ...patch }, ...expected(reference)),
      false,
      JSON.stringify(patch),
    );
  assert.throws(
    () => matches({ ...reference, zero: NaN }, ...expected(reference)),
    /TC_GAME_CONSTRUCTION_DRIFT/,
  );
});
test("encoded numeric table is explicit little-endian and matches in a separate browser-like realm", () => {
  const api = runInNewContext(
    `${declarationFingerprintSource}; matchesDeclaration`,
    { atob, Uint8Array, DataView },
  );
  const reference = { a: -0, b: [1.5, 3.2], nested: { x: 1 } };
  assert.equal(
    api({ nested: { x: 1 }, b: [1.5, 3.2], a: 0 }, ...expected(reference)),
    true,
  );
  const [hash, encoded] = expected(reference);
  assert.equal(api(reference, hash, encoded.slice(0, -4)), false);
});

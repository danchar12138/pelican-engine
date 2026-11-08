import test from "node:test";
import assert from "node:assert/strict";
import { changedBufferRanges } from "../packages/renderer/src/dirty-upload.ts";

test("dirty uploads cover only changed blocks and coalesce adjacent changes", () => {
  const first = new Uint8Array(4096),
    next = first.slice();
  assert.deepEqual(changedBufferRanges(undefined, next), [
    { offset: 0, size: 4096 },
  ]);
  assert.deepEqual(changedBufferRanges(first, next), []);
  next[3] = 1;
  next[2050] = 2;
  assert.deepEqual(changedBufferRanges(first, next), [
    { offset: 0, size: 1024 },
    { offset: 2048, size: 1024 },
  ]);
  next[1024] = 3;
  assert.deepEqual(changedBufferRanges(first, next), [
    { offset: 0, size: 3072 },
  ]);
  assert.deepEqual(changedBufferRanges(first, new Uint8Array(8)), [
    { offset: 0, size: 8 },
  ]);
  assert.throws(
    () => changedBufferRanges(undefined, new Uint8Array(3)),
    /TC_GPU_UPLOAD_ALIGNMENT/,
  );
});

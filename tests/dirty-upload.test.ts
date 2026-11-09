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
test("word comparisons retain byte-exact ranges for aligned and unaligned views", () => {
  for (const prefix of [0, 1, 2, 3, 4]) for (const block of [4, 12, 1024]) {
    const previous = new Uint8Array(4096 + prefix).subarray(prefix), next = previous.slice();
    for (const offset of [0, 3, 7, 35, 2049, 4095]) next[offset] = offset % 255 + 1;
    const oracle: { offset: number; size: number }[] = [];
    for (let offset = 0; offset < next.length; offset += block) {
      const size = Math.min(block, next.length - offset);
      if (!next.subarray(offset, offset + size).some((value, i) => value !== previous[offset + i])) continue;
      const last = oracle.at(-1);
      if (last && last.offset + last.size === offset) last.size += size;
      else oracle.push({ offset, size });
    }
    assert.deepEqual(changedBufferRanges(previous, next, block), oracle);
  }
  const bits = new Uint32Array([0x7fc00001, 0, 0x80000000, 0x7fc00002]), changed = bits.slice();
  changed[0] = 0x7fc00003; changed[1] = 0x80000000;
  assert.deepEqual(changedBufferRanges(new Uint8Array(bits.buffer), new Uint8Array(changed.buffer), 4), [{ offset: 0, size: 8 }]);
});

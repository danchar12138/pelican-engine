/** Byte-level dirty blocks, coalesced into writes aligned for queue.writeBuffer. */
export function changedBufferRanges(
  previous: Uint8Array | undefined,
  next: Uint8Array,
  blockBytes = 1024,
) {
  if (next.byteLength % 4 || blockBytes % 4 || blockBytes < 4)
    throw new Error(
      "TC_GPU_UPLOAD_ALIGNMENT: Buffer updates require four-byte alignment.",
    );
  if (!previous || previous.byteLength !== next.byteLength)
    return next.byteLength ? [{ offset: 0, size: next.byteLength }] : [];
  // Compare exact bit patterns four bytes at a time when source views permit it.
  // This keeps NaNs, signed zero and all existing block alignment semantics intact.
  const words = previous.byteOffset % 4 === 0 && next.byteOffset % 4 === 0;
  const oldValues = words
    ? new Uint32Array(
        previous.buffer,
        previous.byteOffset,
        previous.byteLength / 4,
      )
    : previous;
  const newValues = words
    ? new Uint32Array(next.buffer, next.byteOffset, next.byteLength / 4)
    : next;
  const unit = words ? 4 : 1;
  const ranges: { offset: number; size: number }[] = [];
  for (let offset = 0; offset < next.length; offset += blockBytes) {
    const end = Math.min(next.length, offset + blockBytes);
    let changed = false;
    for (let i = offset / unit; i < end / unit; i++)
      if (newValues[i] !== oldValues[i]) {
        changed = true;
        break;
      }
    if (!changed) continue;
    const last = ranges.at(-1);
    if (last && last.offset + last.size === offset) last.size += end - offset;
    else ranges.push({ offset, size: end - offset });
  }
  return ranges;
}

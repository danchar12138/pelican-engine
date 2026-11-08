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
  const ranges: { offset: number; size: number }[] = [];
  for (let offset = 0; offset < next.length; offset += blockBytes) {
    const end = Math.min(next.length, offset + blockBytes);
    let changed = false;
    for (let i = offset; i < end; i++)
      if (next[i] !== previous[i]) {
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

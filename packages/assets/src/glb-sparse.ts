const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const align4 = (value: number) => Math.ceil(value / 4) * 4;
const fail = (detail: string): never => {
  throw new Error(`TC_MODEL_SPARSE_ACCESSOR: ${detail}`);
};

type Chunk = { type: number; data: Uint8Array };
type BufferView = { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number };
type SparsePart = { bufferView: number; byteOffset?: number };
type SparseAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: { count: number; indices: SparsePart & { componentType: number }; values: SparsePart };
};

/** Rewrites sparse GLB accessors to tightly packed buffer views before Three's loader sees them. */
export function normalizeSparseGLB(input: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 20) return fail("GLB header is truncated.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x676c5446 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength)
    return fail("Expected a length-matched GLB 2.0 container.");
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return fail("Chunk header is truncated.");
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (length % 4 || end > bytes.byteLength) return fail("Chunk length exceeds container bounds.");
    chunks.push({ type, data: bytes.subarray(offset + 8, end) });
    offset = end;
  }
  const jsonChunk = chunks[0];
  if (!jsonChunk || jsonChunk.type !== 0x4e4f534a) return fail("JSON must be the first chunk.");
  let json: any;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonChunk.data)); }
  catch { return fail("JSON chunk is malformed."); }
  if (!json || typeof json !== "object" || Array.isArray(json) || (json.accessors !== undefined && !Array.isArray(json.accessors)))
    return fail("Expected a GLB object with an accessor array.");
  const accessors: SparseAccessor[] = json.accessors ?? [];
  if (accessors.some(accessor => !accessor || typeof accessor !== "object" || Array.isArray(accessor)))
    return fail("Each accessor must be an object.");
  const sparse = accessors.filter(accessor => accessor.sparse !== undefined);
  if (!sparse.length) return bytes;
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || !json.buffers[0] || typeof json.buffers[0] !== "object" || json.buffers[0].uri !== undefined)
    return fail("Sparse normalization requires one embedded GLB buffer.");
  const binChunks = chunks.filter(chunk => chunk.type === 0x004e4942);
  if (binChunks.length !== 1 || chunks.filter(chunk => chunk.type === 0x4e4f534a).length !== 1)
    return fail("Sparse data requires one JSON and one BIN chunk.");
  const binChunk = binChunks[0];
  const originalLength = json.buffers[0].byteLength;
  if (!Number.isSafeInteger(originalLength) || originalLength < 0 || originalLength > binChunk.data.byteLength || binChunk.data.byteLength - originalLength > 3)
    return fail("Declared buffer length does not match BIN data.");
  const source = binChunk.data.subarray(0, originalLength);
  if (!Array.isArray(json.bufferViews)) return fail("Sparse data requires buffer views.");
  const bufferViews: BufferView[] = json.bufferViews;
  const totalExpanded = sparse.reduce((sum, accessor) => {
    const size = COMPONENT_BYTES[accessor.componentType], components = COMPONENTS[accessor.type];
    if (!size || !components || (accessor.type.startsWith("MAT") && size !== 4)) return fail("Unsupported accessor component layout.");
    const bytes = accessor.count * size * components;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return fail("Accessor byte length is not representable.");
    return sum + bytes;
  }, 0);
  if (totalExpanded > 128 * 1024 * 1024) return fail("Expanded sparse accessor data exceeds 128 MiB.");
  const denseParts: Uint8Array[] = [source];
  let cursor = originalLength;
  for (const accessor of sparse) {
    const sparseInfo = accessor.sparse!;
    if (!sparseInfo || typeof sparseInfo !== "object" || !sparseInfo.indices || typeof sparseInfo.indices !== "object" || !sparseInfo.values || typeof sparseInfo.values !== "object")
      return fail("Sparse accessor requires indices and values.");
    const componentSize = COMPONENT_BYTES[accessor.componentType], components = COMPONENTS[accessor.type];
    const elementSize = componentSize * components;
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 1 || !Number.isSafeInteger(sparseInfo.count) || sparseInfo.count < 1 || sparseInfo.count > accessor.count)
      return fail("Invalid sparse accessor count.");
    const denseOffset = align4(cursor);
    if (denseOffset > cursor) denseParts.push(new Uint8Array(denseOffset - cursor));
    const dense = new Uint8Array(accessor.count * elementSize);
    if (accessor.bufferView !== undefined) {
      const baseView = bufferViews[accessor.bufferView];
      if (!Number.isSafeInteger(accessor.bufferView) || accessor.bufferView < 0 || !baseView || baseView.buffer !== 0) return fail("Invalid sparse accessor base buffer view.");
      if (!Number.isSafeInteger(baseView.byteOffset ?? 0) || (baseView.byteOffset ?? 0) < 0 || !Number.isSafeInteger(baseView.byteLength) || baseView.byteLength < 1)
        return fail("Invalid sparse accessor base buffer view range.");
      const baseOffset = (baseView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const stride = baseView.byteStride ?? elementSize;
      const end = baseOffset + (accessor.count - 1) * stride + elementSize;
      if (!Number.isSafeInteger(accessor.byteOffset ?? 0) || (accessor.byteOffset ?? 0) < 0 || !Number.isSafeInteger(baseOffset) || baseOffset < 0 || !Number.isSafeInteger(stride) || stride < elementSize || stride % componentSize || baseOffset % componentSize || !Number.isSafeInteger(end) || end > source.byteLength || end > (baseView.byteOffset ?? 0) + baseView.byteLength)
        return fail("Sparse accessor base range or stride is invalid.");
      for (let element = 0; element < accessor.count; element++)
        dense.set(source.subarray(baseOffset + element * stride, baseOffset + element * stride + elementSize), element * elementSize);
    } else if ((accessor.byteOffset ?? 0) !== 0) return fail("Accessor without a base view cannot have byteOffset.");
    const readPart = (part: SparsePart, byteCount: number, alignment: number, label: string) => {
      const partView = bufferViews[part.bufferView];
      if (!Number.isSafeInteger(part.bufferView) || part.bufferView < 0 || !partView || partView.buffer !== 0 || partView.byteStride !== undefined || partView.target !== undefined) return fail(`Invalid sparse ${label} view.`);
      if (!Number.isSafeInteger(partView.byteOffset ?? 0) || (partView.byteOffset ?? 0) < 0 || !Number.isSafeInteger(partView.byteLength) || partView.byteLength < 1)
        return fail(`Invalid sparse ${label} view range.`);
      const start = (partView.byteOffset ?? 0) + (part.byteOffset ?? 0);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(part.byteOffset ?? 0) || (part.byteOffset ?? 0) < 0 || (part.byteOffset ?? 0) % alignment || start % alignment || !Number.isSafeInteger(start + byteCount) || start + byteCount > (partView.byteOffset ?? 0) + partView.byteLength || start + byteCount > source.byteLength)
        return fail(`Sparse ${label} range or alignment is invalid.`);
      return start;
    };
    const indices = sparseInfo.indices;
    const indexSize = COMPONENT_BYTES[indices.componentType];
    if (![5121, 5123, 5125].includes(indices.componentType) || !indexSize) return fail("Sparse indices must use unsigned byte, short, or int.");
    const indexStart = readPart(indices, sparseInfo.count * indexSize, indexSize, "indices");
    const valuesStart = readPart(sparseInfo.values, sparseInfo.count * elementSize, componentSize, "values");
    const data = new DataView(source.buffer, source.byteOffset, source.byteLength);
    let previous = -1;
    for (let entry = 0; entry < sparseInfo.count; entry++) {
      const p = indexStart + entry * indexSize;
      const index = indexSize === 1 ? data.getUint8(p) : indexSize === 2 ? data.getUint16(p, true) : data.getUint32(p, true);
      if (index <= previous || index >= accessor.count) return fail("Sparse indices must be increasing and in range.");
      dense.set(source.subarray(valuesStart + entry * elementSize, valuesStart + (entry + 1) * elementSize), index * elementSize);
      previous = index;
    }
    denseParts.push(dense);
    cursor = denseOffset + dense.byteLength;
    const newView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: denseOffset, byteLength: dense.byteLength });
    accessor.bufferView = newView;
    accessor.byteOffset = 0;
    delete accessor.sparse;
  }
  const denseLength = cursor;
  const binLength = align4(denseLength);
  if (binLength > denseLength) denseParts.push(new Uint8Array(binLength - denseLength));
  const bin = new Uint8Array(binLength);
  let writeOffset = 0;
  for (const part of denseParts) { bin.set(part, writeOffset); writeOffset += part.byteLength; }
  if (writeOffset !== binLength) return fail("Internal dense buffer packing mismatch.");
  json.buffers[0].byteLength = denseLength;
  json.bufferViews = bufferViews;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.byteLength), jsonPadded = new Uint8Array(jsonLength);
  jsonPadded.fill(0x20); jsonPadded.set(jsonBytes);
  const extraChunks = chunks.filter(chunk => chunk !== jsonChunk && chunk !== binChunk);
  const outputLength = 12 + 8 + jsonLength + 8 + binLength + extraChunks.reduce((total, chunk) => total + 8 + chunk.data.byteLength, 0);
  if (outputLength > 0xffffffff) return fail("Normalized GLB exceeds the container length limit.");
  const output = new Uint8Array(outputLength), out = new DataView(output.buffer);
  out.setUint32(0, 0x676c5446, false); out.setUint32(4, 2, true); out.setUint32(8, outputLength, true);
  out.setUint32(12, jsonLength, true); out.setUint32(16, 0x4e4f534a, true); output.set(jsonPadded, 20);
  const binHeader = 20 + jsonLength; out.setUint32(binHeader, binLength, true); out.setUint32(binHeader + 4, 0x004e4942, true); output.set(bin, binHeader + 8);
  let extraOffset = binHeader + 8 + binLength;
  for (const chunk of extraChunks) {
    out.setUint32(extraOffset, chunk.data.byteLength, true); out.setUint32(extraOffset + 4, chunk.type, true);
    output.set(chunk.data, extraOffset + 8); extraOffset += 8 + chunk.data.byteLength;
  }
  return output;
}

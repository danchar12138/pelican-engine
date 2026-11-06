/** Vose alias proposals over exact spherical cell solid angles; every texel contributes to its cell's mean. */
export function buildEnvironmentImportance(
  data: Float32Array,
  width: number,
  height: number,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  )
    throw new Error("TC_ENVIRONMENT_IMPORTANCE: Invalid HDR image layout.");
  const columns = Math.min(64, width),
    rows = Math.min(32, height),
    weights = new Float64Array(columns * rows),
    counts = new Uint32Array(columns * rows),
    solidAngles = new Float64Array(columns * rows);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        if (
          !Number.isFinite(data[index + channel]) ||
          data[index + channel] < 0
        )
          throw new Error(
            "TC_ENVIRONMENT_RADIANCE: Expected nonnegative finite HDR radiance.",
          );
      const cell =
        Math.min(rows - 1, Math.floor((y * rows) / height)) * columns +
        Math.min(columns - 1, Math.floor((x * columns) / width));
      weights[cell] +=
        data[index] * 0.2126 +
        data[index + 1] * 0.7152 +
        data[index + 2] * 0.0722;
      counts[cell]++;
    }
  let energy = 0;
  for (let row = 0; row < rows; row++) {
    const area =
      ((2 * Math.PI) / columns) *
      (Math.cos((row * Math.PI) / rows) -
        Math.cos(((row + 1) * Math.PI) / rows));
    for (let column = 0; column < columns; column++) {
      const cell = row * columns + column;
      solidAngles[cell] = area;
      weights[cell] = (weights[cell] / Math.max(1, counts[cell])) * area;
      energy += weights[cell];
    }
  }
  const entries = columns * rows,
    probabilities = Float64Array.from(weights, (weight) =>
      energy > 0 ? weight / energy : 1 / entries,
    ),
    scaled = Float64Array.from(probabilities, (p) => p * entries),
    small: number[] = [],
    large: number[] = [],
    table = new Float32Array(entries * 4);
  scaled.forEach((value, index) => (value < 1 ? small : large).push(index));
  for (let index = 0; index < entries; index++)
    table.set([probabilities[index], index, 1, solidAngles[index]], index * 4);
  while (small.length && large.length) {
    const a = small.pop()!,
      b = large.pop()!;
    table[a * 4 + 1] = b;
    table[a * 4 + 2] = scaled[a];
    scaled[b] = scaled[b] + scaled[a] - 1;
    (scaled[b] < 1 ? small : large).push(b);
  }
  return {
    width: columns,
    height: rows,
    table,
    integralLuminance: energy,
    source: [width, height] as const,
  };
}

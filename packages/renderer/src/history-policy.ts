/** ABI material emission occupies floats 8..11; other channels require guide invalidation. */
export function emissionOnlyChange(
  previous: Float32Array | undefined,
  next: Float32Array,
): boolean {
  if (!previous || previous.length !== next.length) return false;
  for (let i = 0; i < next.length; i++)
    if (previous[i] !== next[i] && (i % 32 < 8 || i % 32 >= 12)) return false;
  return true;
}

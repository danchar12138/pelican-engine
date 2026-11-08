/** Fixed engine source embedded into compiled games; never evaluates author-provided source text. */
export const declarationFingerprintSource = String.raw`
function fingerprint(value) {
  const numbers = [];
  const text = JSON.stringify(value, function(_, item) {
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('TC_GAME_CONSTRUCTION_DRIFT: Nonfinite declaration number.');
      numbers.push(item);
      return 0;
    }
    if (typeof item === 'function') return {__runtime:true};
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item;
  });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return { hash: hash >>> 0, numbers: numbers };
}
function matchesDeclaration(value, hash, encoded) {
  const actual = fingerprint(value);
  if (actual.hash !== hash) return false;
  const raw = atob(encoded);
  if (raw.length !== actual.numbers.length * 8) return false;
  const bytes = Uint8Array.from(raw, function(character) { return character.charCodeAt(0); });
  const expected = new DataView(bytes.buffer);
  for (let i = 0; i < actual.numbers.length; i++) {
    const a = actual.numbers[i], b = expected.getFloat64(i * 8, true);
    if (a === b) continue;
    // Preserve exact discrete metadata; tolerate only tiny relative floating-point noise.
    if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return false;
    const tolerance = Math.max(Number.MIN_VALUE * 8, 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)));
    if (Math.abs(a - b) > tolerance) return false;
  }
  return true;
}`;

export interface DeclarationFingerprint {
  hash: number;
  numbers: number[];
}

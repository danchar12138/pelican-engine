const namedColors = new Set([
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
  "pink", "gray", "grey", "cyan", "magenta", "lime", "navy", "teal", "silver",
  "maroon", "olive", "aqua", "fuchsia", "rebeccapurple", "transparent",
]);
/** Shared declaration/runtime color syntax; browser rendering is still backend-dependent. */
export function isUiColor(value: unknown): value is string {
  return typeof value === "string" && (/^(#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|rgba|hsl|hsla)\([\d.% ,+-]+\))$/i.test(value) || namedColors.has(value.toLowerCase()));
}

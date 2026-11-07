/** Input limits use JavaScript UTF-16 code units, matching HTMLInputElement.maxLength. */
export const UI_INPUT_MAX_LENGTH = 4096;

/** Preserve surrogate pairs when constraining an IME commit or pasted text. */
export function limitUiInput(text: string): string {
  if (text.length <= UI_INPUT_MAX_LENGTH) return text;
  let end = UI_INPUT_MAX_LENGTH;
  const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}

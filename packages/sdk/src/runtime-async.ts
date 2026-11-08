/** Inspect method descriptors without invoking an author's getter or reserving ordinary data keys. */
export function isAsyncValue(value: unknown): value is PromiseLike<unknown> {
  if (!value || !["object", "function"].includes(typeof value)) return false;
  let object = value as object;
  const visited = new Set<object>();
  while (object && !visited.has(object)) {
    visited.add(object);
    const descriptor = Object.getOwnPropertyDescriptor(object, "then");
    if (descriptor)
      return "value" in descriptor && typeof descriptor.value === "function";
    object = Object.getPrototypeOf(object);
  }
  return false;
}

export function handleNativeRejection(value: unknown) {
  try {
    void Promise.prototype.then.call(
      value,
      () => {},
      () => {},
    );
  } catch {
    /* Rejected synchronous results are not assimilated through author-defined then methods. */
  }
}

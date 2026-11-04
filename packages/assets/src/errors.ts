export type AssetErrorCode =
  | "TC_ASSET_MISSING"
  | "TC_ASSET_INVALID"
  | "TC_ASSET_UNSUPPORTED";

export class AssetInspectionError extends Error {
  constructor(
    public readonly code: AssetErrorCode,
    public readonly file: string,
    public readonly resource: string,
    detail: string,
    public readonly suggestion: string,
  ) {
    super(`${code}: ${file} [${resource}]: ${detail} ${suggestion}`);
    this.name = "AssetInspectionError";
  }
}

export class InspectionContext {
  constructor(public readonly file: string) {}
  invalid(resource: string, detail: string): never {
    throw new AssetInspectionError(
      "TC_ASSET_INVALID",
      this.file,
      resource,
      detail,
      "Repair or re-export the source asset and inspect it again.",
    );
  }
  unsupported(resource: string, detail: string): never {
    throw new AssetInspectionError(
      "TC_ASSET_UNSUPPORTED",
      this.file,
      resource,
      detail,
      "Convert to a supported self-contained format; see packages/assets/README.md.",
    );
  }
  check(
    condition: unknown,
    resource: string,
    detail: string,
  ): asserts condition {
    if (!condition) this.invalid(resource, detail);
  }
  integer(
    value: unknown,
    resource: string,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  ): number {
    this.check(
      Number.isSafeInteger(value) &&
        Number(value) >= min &&
        Number(value) <= max,
      resource,
      `Expected an integer in [${min}, ${max}].`,
    );
    return value as number;
  }
}

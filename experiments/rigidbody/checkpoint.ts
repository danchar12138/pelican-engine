import type { RigidBodyDimension } from "./types.ts";

export class RigidBodyCheckpointError extends Error {
  readonly code = "RIGIDBODY_CHECKPOINT_INVALID";
  constructor(readonly dimension: RigidBodyDimension) {
    super(
      `RIGIDBODY_CHECKPOINT_INVALID: ${dimension} checkpoint could not be restored. Use an intact takeSnapshot() Uint8Array from the same Rapier package version and dimension.`,
    );
    this.name = "RigidBodyCheckpointError";
  }
}

/** Internal ownership boundary: caller owns the returned world and must free it. */
export function restoreCheckpoint<W extends { free(): void }>(
  dimension: RigidBodyDimension,
  restore: (bytes: Uint8Array) => W | null,
  data: unknown,
): W {
  if (!(data instanceof Uint8Array) || data.byteLength === 0)
    throw new RigidBodyCheckpointError(dimension);
  try {
    const world = restore(data);
    if (!world) throw new RigidBodyCheckpointError(dimension);
    return world;
  } catch {
    throw new RigidBodyCheckpointError(dimension);
  }
}

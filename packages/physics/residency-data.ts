import type { Vec3 } from "../sdk/src/index.ts";

export interface ParkedBodyState {
  velocity: Vec3;
  angularVelocity: Vec3;
  gravityScale: number;
  sleeping: boolean;
  character?: { verticalVelocity: number; velocity: Vec3; grounded: boolean; requested: Vec3; target?: Vec3 };
}

export function validateParkedBody(value: ParkedBodyState, character: boolean): void {
  const vector = (input: unknown) => Array.isArray(input) && input.length === 3 &&
    [0, 1, 2].every(index => typeof input[index] === "number" && Number.isFinite(input[index]) && Math.abs(input[index]) <= 1e12);
  const fail = (): never => { throw new Error("TC_PHYSICS_RESIDENCY: Invalid parked body state; restore an intact checkpoint."); };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["velocity", "angularVelocity", "gravityScale", "sleeping", "character"].includes(key)) ||
      !vector(value.velocity) || !vector(value.angularVelocity) || !Number.isFinite(value.gravityScale) || Math.abs(value.gravityScale) > 1000 || typeof value.sleeping !== "boolean" ||
      character !== (value.character !== undefined)) fail();
  const c = value.character;
  if (c && (Object.keys(c).some(key => !["verticalVelocity", "velocity", "grounded", "requested", "target"].includes(key)) ||
      !Number.isFinite(c.verticalVelocity) || Math.abs(c.verticalVelocity) > 1e12 || !vector(c.velocity) || !vector(c.requested) || typeof c.grounded !== "boolean" ||
      (c.target !== undefined && !vector(c.target)))) fail();
}

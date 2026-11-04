export type RigidBodyDimension = "2d" | "3d";

export interface RigidBodyCaseReport {
  dimension: RigidBodyDimension;
  passed: boolean;
  checks: Record<string, boolean>;
  fixedDt: number;
  ticks: number;
  bodies: {
    box: {
      initialY: number;
      finalY: number;
      finalSpeed: number;
      settled: boolean;
    };
    ball: {
      initialY: number;
      finalY: number;
      finalSpeed: number;
      bounced: boolean;
      peakUpwardSpeedAfterContact: number;
    };
    allStatesFinite: boolean;
  };
  contacts: {
    started: number;
    stopped: number;
    boxGroundStarted: number;
    ballGroundStarted: number;
    boxGroundManifoldSamples: number;
    ballGroundManifoldSamples: number;
  };
  raycast: {
    expectedColliderHandle: number;
    hitColliderHandle: number | null;
    timeOfImpact: number | null;
    miss: boolean;
    restoredHandleMatches: boolean;
  };
  joint: {
    kind: "fixed";
    handle: number;
    valid: boolean;
    maxAnchorError: number;
    finalSpeed: number;
  };
  snapshot: {
    bytes: number;
    captureWallMs: number;
    restoreWallMs: number;
    capturedTick: number;
    replayedSteps: number;
    tolerance: number;
    maxRestoreDifference: number;
    maxReplayDifference: number;
    handlesPreserved: boolean;
    eventsMatch: boolean;
    rejectedInvalidInputs: string[];
  };
  timing: {
    stepWallMs: number;
    meanStepWallMs: number;
    maxStepWallMs: number;
    replayStepWallMs: number;
    caseWallMs: number;
  };
  lifecycle: {
    cycles: number;
    worldsCreated: number;
    worldsFreed: number;
    eventQueuesCreated: number;
    eventQueuesFreed: number;
    ownedWorldsAfter: number;
    ownedEventQueuesAfter: number;
    releasedEveryCycle: boolean;
  };
  softBodyApi: {
    /** Runtime export/prototype inspection only, not a soft-body simulation acceptance. */
    exported: boolean;
    exports: string[];
    worldMethods: string[];
    descriptorFactories: string[];
    worldSetPresent: boolean;
  };
}

export interface RigidBodyProbeReport {
  passed: boolean;
  versions: {
    rapier2d: string;
    rapier3d: string;
    packages: { rapier2d: string; rapier3d: string };
    license: "Apache-2.0";
    /** This process's first call initializes each embedded WASM module once. */
    initialization: Record<
      RigidBodyDimension,
      { wallMs: number; cached: boolean; api: "init()" }
    >;
  };
  cases: RigidBodyCaseReport[];
  limitations: string[];
}

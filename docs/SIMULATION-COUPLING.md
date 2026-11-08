# Simulation Coupling

The engine owns a shared CPU contact stage for automatically stepped ropes,
cloth, tetrahedral soft bodies and WCSPH fluids. Games continue to use
`ctx.ropes`, `ctx.cloth`, `ctx.softBodies` and `ctx.fluid` through `pelican-engine`.
No native physics objects are exposed.

## Fixed Tick

1. Production Rapier advances rigid bodies. Dynamic rigid bodies have native CCD enabled.
2. Each automatic material solver advances its constitutive simulation. Bound
   dynamic spheres and boxes share one virtual body, including accumulated
   linear/angular reaction and effective mass, across all four plugins.
3. A shared stage discovers swept cross-entry particle, segment and triangle
   candidates. Conservative advancement uses linearly moving geometry and
   radius-bearing contacts. Eight contact/constraint passes reproject distance
   and tetrahedral volume constraints, manual obstacles and rope attachments.
4. Normal constraints and Coulomb-limited tangent projections update the
   detached candidate particle state. Successful candidates replace their
   solver state. Rigid reactions are applied as one sorted native batch.

Automatic entries interact across entries and material families. Manual
`step()` calls remain isolated. Same-entry self-contact remains the material
solver's responsibility. The shared stage does not increment simulation ticks
or consume queued forces a second time.

## Contacts And Recovery

Particle sweeps against spheres and planes are analytic. Rounded oriented-box
sweeps use distance-based conservative advancement rather than an inflated box
intersection. Cross-entry contacts use swept bounds, closest simplex points,
inverse-mass gradients and a shared normal/tangent constraint budget.

The default contact friction is 0.5. Native-bound contact reactions use the
bound collider's friction coefficient. Manual obstacle projections do not move
an obstacle. Rigid reactions include angular moments about the world origin.

Each participating plugin retains its pre-contact material state until the
transaction finishes. A later material/contact failure rolls those participants
back and discards virtual rigid reactions. A native reaction trap can leave the
native owner partially mutated; the physics owner is marked faulted and requires
checkpoint recovery or scene restart. No rollback can promise recovery from a
process termination or exhausted memory.

The shared stage caps active primitives at 100,000 and broadphase candidates at
2,000,000 per pass. CCD has bounded advancement and reports a diagnostic when it
cannot converge. These bounds fail explicitly; they do not silently skip contacts.

## Remaining 1.0 Work

This is a split-step contact stage, not complete simultaneous rigid/material
integration. Native moving/rotating obstacle sweeps, multiple live rigid bindings
for fluid/soft-body entries, shared fluid density/pressure, robust topology
tearing and complete cross-material lifecycle are not finished by this change.

Only compilation/builds are authorized at present. No numerical, physical,
runtime, performance, rendering, restoration or legacy-compatibility behavior
has been validated for this implementation.

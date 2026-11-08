# Simulation Coupling

The engine owns a shared substep clock for automatically stepped ropes,
cloth, tetrahedral soft bodies and WCSPH fluids. Games continue to use
`ctx.ropes`, `ctx.cloth`, `ctx.softBodies` and `ctx.fluid` through `pelican-engine`.
No native physics objects are exposed.

## Fixed Tick

1. The host selects the largest requested automatic substep count (at most 32).
   An automatic entry's requested count is a minimum resolution; manual stepping
   still uses exactly its own configured count. Each shared interval is host dt/count.
2. Production Rapier advances rigid bodies for that interval. Dynamic rigid
   bodies have native CCD enabled. Every material solver then advances only the
   same interval, keeping its fixed tick open. Bound
   dynamic spheres and boxes share one virtual body, including accumulated
   linear/angular reaction and effective mass, across all four plugins.
3. Automatic fluids sample one shared WCSPH density/pressure/viscosity field before
   material advancement. Different fluid entries exchange pressure forces through
   that field, not solid-particle repulsion. A shared stage discovers swept
   cross-entry particle, segment and triangle
   candidates. Conservative advancement uses linearly moving geometry and
   radius-bearing contacts. Eight contact/constraint passes reproject distance
   and tetrahedral volume constraints, manual obstacles and rope attachments.
4. Normal constraints and Coulomb-limited tangent projections update each
   solver's yielded particle view. Rigid reactions are applied as one sorted
   native batch before the next interval. These corrected positions/velocities
   feed the next constitutive interval; they are not a post-frame visual adjustment.
5. After all intervals complete, material ticks advance once and queued forces
   are consumed once. The whole integration remains inside the native physics
   system's ordering boundary, before systems ordered after that owner.

Automatic entries interact across entries and material families. Manual
`step()` calls remain isolated. Same-entry self-contact remains the material
solver's responsibility. The shared stage does not increment simulation ticks
or consume queued forces a second time.

## Contacts And Recovery

Relative particle/moving-sphere sweeps and plane sweeps are analytic. Rounded oriented-box
sweeps use distance-based conservative advancement rather than an inflated box
intersection. Moving/rotating boxes interpolate their sampled endpoint poses
and bound surface motion for advancement. Cross-entry contacts use swept bounds, closest simplex points,
inverse-mass gradients and a shared normal/tangent constraint budget.

The default contact friction is 0.5. Cross-domain friction uses the geometric
mean of each domain's coefficient; terrain supplies its authored coefficient.
Native-bound contact reactions use the
bound collider's friction coefficient. Manual obstacle projections do not move
an obstacle. Rigid reactions include angular moments about the world origin.

Each participating plugin retains a pre-tick material checkpoint until the
transaction finishes. Material generators can be cancelled and restored. Native
steps/reactions already applied during an earlier interval cannot be erased by
discarding a virtual body. Any failed coupled tick faults the native owner and requires
checkpoint recovery or scene restart. No rollback can promise recovery from a
process termination or exhausted memory.

The shared stage caps active primitives at 100,000 and broadphase candidates at
2,000,000 per pass. CCD has bounded advancement and reports a diagnostic when it
cannot converge. Shared SPH caps particles at 131,072 and neighborhood references
at 2,000,000. These bounds fail explicitly; they do not silently skip contacts.

Native substeps and reaction batches are stored as a fixed-tick transaction.
Reconstruction validates substep order/count/timestep and rejects incomplete
frames before creating a candidate. Legacy whole-tick actions remain supported.
The history budget is 100,000 top-level transactions/commands and 3,200,000 decoded
operations; a transaction contains at most 64 native step/reaction operations.

## Remaining 1.0 Work

Terrain surfaces participate as immovable zero-radius triangle domains. The
native rigid world consumes the same f32 vertices through its terrain bridge.

The implementation is a CPU, operator-split, interleaved integration with finite
constraint iterations, not an exact monolithic implicit solve. Multiple live rigid
bindings for fluid/soft-body entries and cross-material/world lifecycle are still
being finished under D60. Topology tearing and GPU solvers remain separate historical
roadmap work, not additions to the frozen final integration scope.

Only compilation/builds are authorized at present. No numerical, physical,
runtime, performance, rendering, restoration or legacy-compatibility behavior
has been validated for this implementation.

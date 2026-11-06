# Managed Compute to Render

Run `npm run dev -- --project examples/compute-render` from the checkout. This
game uses only `pelican-engine` imports and declares two logical CPU buffers,
one material slot, a compute feedback kernel, and a vertex graph reading that slot.

Each successful fixed tick retains and commits the actual GPU output. The engine
copies it to a Three-owned render storage buffer on the GPU. Inspector counters
distinguish checkpoint uploads, committed versions and render copies; this fixture
does not hide the readback used to validate results and maintain CPU mirrors.

`a` binds the alternative buffer, `p` binds the primary one, `r` reverses motion,
`q` demonstrates rejection of releasing a bound buffer, `f` submits an invalid
GPU read and `c` cancels a queued task. These failures preserve the committed
geometry. The authored object origin is off-frustum; derived bounds keep culling
enabled and follow the same deformed geometry used by ray queries and tracing.

`npm run probe:compute-render` is the bounded hardware validation entry. WebGL2
explicitly refuses the active storage slot with `TC_RENDER_BUFFER_CAPABILITY`;
the engine does not upload CPU mirror data to pretend WebGPU storage is supported.

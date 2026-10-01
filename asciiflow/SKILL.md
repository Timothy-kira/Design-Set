# ASCII Flow

A fluid drawn in letters. Everything lives in one file, `examples/ascii-fluid.html`.

## Run

Open `examples/ascii-fluid.html` by double-clicking it. It runs from `file://` —
no server, no build, no dependencies.

## Controls

| Input | Effect |
| --- | --- |
| Drag | Transfers momentum into the velocity field and tears the existing plume into vortices. Lays down a thin wake of ink, scaled by distance travelled. |
| Click | Drops a small puff of ink |
| `C` | Clears density and velocity |

A pointer that is only hovering starts a gentle tangential vortex under the
cursor. It adds no ink.

## How a frame is made

1. `step(dt)` — an emitter injects density and velocity near the lower middle,
   then velocity is diffused, projected to be divergence-free, advected, and
   projected again. Density is advected and dissipated.
2. `render()` — the background is filled, then every cell above `cut` picks a
   glyph from the ramp by `pow(density, gamma)` and blits it from the atlas.

The timestep is fixed at 1/60 with at most 3 steps per frame, so a backgrounded
tab does not flush a large step on return.

## Glyph ramp

`buildRamp()` renders every candidate glyph to an offscreen canvas, sums its
alpha channel, and sorts by that. A ramp hand-ordered for one font stops being
monotonic in another and the field then reads as noise instead of as density.

The ramp is letters only. Density is carried by which glyph is chosen, not by
alpha — fading on top of a thin glyph greys the fringe out instead of leaving
crisp sparse characters.

## Tuning

All constants live in the `CFG` object at the top of the script.

| Key | Meaning |
| --- | --- |
| `columns` | Target grid width. Cell size is derived from it, clamped to `cellMin`..`cellMax`. |
| `viscosity` | Velocity diffusion rate |
| `densityDissipate` | Per-step density retention |
| `velocityDissipate` | Per-step velocity retention |
| `pressureIters` | Jacobi iterations for the pressure projection |
| `force` | Cells/s of velocity per cell of pointer travel |
| `velCap` | Ceiling on the velocity one pointer event can inject |
| `inkPerCell` | Ink laid down per cell of pointer travel, not per event |
| `hoverSwirl`, `hoverRadius` | The hover vortex |
| `ambient`, `ambientDensity` | The idle emitter |
| `swirl` | Cross-stream shear at the emitter. A buoyant column with purely vertical flow stays a smooth slab; the shear is what the solver folds into filaments. |

Velocities are in **grid cells per second**. A single number from a normalised
0..1 formulation is off by two orders of magnitude here, and the first drag
flings the dye off-grid.

## Tools

`tools/solver_probe.py` is a line-for-line port of the solver to numpy. It runs
the same physics with no canvas and prints the density field as a text grid
using the same ramp, which makes emitter shape and density tunable without a
browser round trip.

```bash
python tools/solver_probe.py 420
```

Keep it mirroring the shipped emitter. If the two drift, tuning through the
probe tunes code that is not running.

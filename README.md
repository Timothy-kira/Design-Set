# Design Set

A collection of self-contained design plugins. Each one is a folder, runs with
no build step and no dependencies, and ships with its own skill documentation.

## [halo glow](halo%20glow/)

Lights a silhouette instead of blurring it. The artwork is never tinted or
overlaid — a signed distance field of its contour drives a WebGL2 optical
renderer, so an edge can stay razor sharp in one region while blooming in the
next and a hole in the shape glows from the inside too.

- Artwork from SVG, text, or an uploaded shape
- A light you can drag a route for by hand
- Three looks: Glow, Neon, Rim
- PNG and video export at full output resolution

Open `halo glow/examples/studio.html` by double-clicking it. It runs from
`file://` — no server, no install.

Documentation lives in [`halo glow/SKILL.md`](halo%20glow/SKILL.md).

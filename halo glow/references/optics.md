# The optics

What each stage computes and why it is shaped the way it is.

## 1. Why not blur the alpha channel

The obvious approach is to draw the artwork, blur the mask, and tint it. It
fails in a specific, visible way: the glow and the shape lose their
relationship. Either the core is soft (and the artwork stops reading as a crisp
object) or the core is hard (and the glow looks like a sticker behind glass).

The missing ingredient is **distance**. To light a contour you need to know
where you are relative to it, on which side, and how far — a single alpha
sample cannot answer any of those.

So the mask becomes a signed field:

```
d(p) = distance to the nearest edge, negative inside, positive outside
```

Exact euclidean, via Felzenszwalb & Huttenlocher: a 1D transform per column,
then per row. Each 1D pass is a lower envelope of parabolas, computed in one
monotone scan and one linear walk — O(n), no approximation.

Two transforms are needed for a filled shape (to the inside, to the outside);
one suffices for a stroke, whose whole point is to be lit along its centreline.

### Packing

`rg` carries the outward distance, `ba` the inward one, both as 16-bit
fractions of `maxDistance = height * 0.6`. The sign is recovered on the GPU as
`outward - inward`.

In **canvas-height units**, so the halo geometry is identical on a 9:16 poster
and a 1:1 avatar. Using the short edge would saturate distant pixels on tall
canvases — the glow would clip against the top and bottom.

Precision: 0.6 / 65535 ≈ 9e-6 height units per step, against a narrowest
gaussian of 1.6e-3. That is a 170× margin, so RGBA8 is plenty and there is no
reason to reach for a float texture.

Rows are flipped on write, so `UNPACK_FLIP_Y_WEBGL` stays false — flipping on
upload would flip the distance payload with it.

## 2. The defocus field

A second scalar field, `f`, in shape space: 0 is razor sharp, 1 is fully
bloomed. It is a low-frequency function of polar angle — a few harmonics plus a
handful of gaussians — advected around the silhouette over time. No noise
cells, no nearest-point seams, and the **mask and its field never move**, so
pushing the shape around cannot smear it.

It is held neutral at the centre (`mix(0.5, f, smoothstep(...))`), because
otherwise every shape grows a fixed hot dot in the middle regardless of its
geometry.

## 3. Edge emission — the spectral PSF

Light is placed along the contour as gaussians whose centres are offset per
wavelength. The offsets are what reads as dispersion:

- **red** sits *inside* the contour, short and tight
- **green** straddles it
- **blue** sits *outside*, long and soft

Each lobe has a different width on its two sides:

```glsl
float lobe(float d, float centre, float inward, float outward) {
  return gaussian(d - centre, mix(inward, outward, smoothstep(-0.0005, 0.0005, d - centre)));
}
```

so a stroke of light actually travels further out than in.

The emitter runs twice per frame, with `transport` 1 and 0. The convolved
source (1) must not depend on how sharp the visible inside is — otherwise
narrowing the interior would quietly remove energy from the outer bloom. The
two are separate because that is a real physical distinction, not a detail.

An open stroke takes a different branch: one luminous centreline with a single
peak, not two competing outlines.

## 4. Blur pyramid

The emitter writes to a half-resolution target, then a separable 5-tap linear
gaussian runs three pairs: one narrow (rays, tight halo), then two wide with the
last at 1.22×. Three pairs approximate a sigma about 1.9× a single pass, which
is what turns a contour into atmosphere.

Radii are expressed in the **target's** pixels, and the target's long edge is
capped at 1600, so the halo looks the same on every display size.

The chain stores `radiance / 8` to stay inside [0,1] and reads back with `* 8`.

## 5. Volumetric rays

The beam is an integral of the already-convolved emitter along the optical ray,
not a stretched mask:

```glsl
sum += fetch(uNearBlur, uv - ray * t * reach) * exp(-2.2*t) * (1-t) * (1-t);
```

Integrating the *blurred* texture is what makes it read as light in air — the
rays inherit the shape's structure instead of pointing at it. 24 steps: the
weight is already down to 6% by t=1, so more taps buy nothing and each one
costs a full-screen pass.

## 6. Flare furniture

- **source** — gaussian core + veil, plus six long spikes and eighteen fine ones.
  Six reads as a lens; eighteen reads as diffraction.
- **streaks** — four soft bars through the core, a real lens signature.
- **rings** — three concentric bands with a genuine spectral spread across each,
  and one bright arc rather than a closed circle, which looks synthetic.
- **ghosts** — nine defocused aperture images marching along the optical axis.

All four read the **same** light position, including when it is walking a
hand-drawn path. That is why the path feels like one lamp moving rather than
several effects drifting apart.

## 7. Colour

Two stages, in this order:

`bloomTint` repaints the wide, dim part with the outer colour, keyed on low
energy so the hot core keeps its own.

`adaptiveRadiance` then pulls the whole thing toward the chosen hue, and allows
only genuinely bright overlap of all three channels to go white:

```glsl
float whiteCore = smoothstep(0.65, 1.60, min(light.r, min(light.g, light.b))) * 0.94;
```

Without that guard a pale sky pushes everything to white and the colour setting
appears to do nothing.

## 8. Exposure

One curve for every layer:

```glsl
vec3 color = 1.0 - (1.0 - sky) * exp(-radiance);
```

This is what makes light *add* to the background instead of replacing it. It is
also why the layers must not be clamped individually, and why no hue may be
repainted after compositing — both turn stacked glows into flat cut-outs. A
per-pixel dither at the end keeps the sky gradient from banding.

## 9. Exaggeration

Applied in exactly two places, deliberately:

- it widens the crisp/bloomed gap in the defocus contrast, and
- it lifts the shape's total energy.

The combination is what reads as *dramatic*. Raising energy alone just looks
overexposed.

## 9. Three more layers, for the backlit look

**Interior** (`uInterior`, `uFillColor`, `uFillStrength`) decides whether the
shape is a lamp or a solid. At 1 the body radiates; near 0 the internal radiance
is scaled down to ~6% and the interior is painted with `uFillColor` as a
*surface* — applied to the base colour before exposure, not added as light, so
it does not glow. That is the difference between a lit object and a backlit
cutout.

**Spectrum rim** (`uRainbow`) is a hairline band on the contour, but the colour
model matters more than the width: it is a **magenta↔cyan two-pole lerp**, not
a hue cycle through the HSV wheel. The reference it imitates is chromatic
dispersion on a backlit edge — the light splits to two poles and reads white
where they meet. Sweeping the full spectrum puts a green/yellow/orange band on
the rim, which reads as a coloured vector outline rather than as light. The
band sits just outside the contour and is deliberately thin.

**Downward spill** (`uGodrays`) integrates the field straight upward, so a point
below the body collects it and a point above collects nothing. Collecting from
the body rather than from the contour alone is the difference between a beam
and a thin outline leak.

## 10. Distance field from artwork

The interesting failure is authored geometry. `fill-rule` cancels between
subpaths **of the same element** — a ring and its satellite holes spread across
several `<path>` elements do not subtract at all, and the disc fills solid with
no holes and no visible interior structure. One path element, `evenodd`, all
boundaries inside it.

Artwork made only of strokes has no filled region to light, so it is detected
and routed to the centreline branch instead: Zhang-Suen thinning, then a
distance transform to the skeleton. Thinning rather than "take the distance
maxima" because maxima leave gaps at tight bends, and a gapped centreline
breaks the light exactly where the artwork is most interesting.

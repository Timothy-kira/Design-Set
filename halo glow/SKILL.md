---
name: svg-halo-glow
description: Light arbitrary artwork - SVG, text, or an uploaded shape - with a physically-motivated WebGL2 optical renderer that gives it a real glowing edge, colour dispersion, volumetric rays, lens flare, and an animated light you can hand-draw a path for. Use when someone wants a logo, glyph, wordmark or silhouette to look lit, radiant, holographic, neon, or backlit; wants a light source to move along a route they drew; or wants this look exported as a still or a video. Triggers on "halo", "glow", "glowing logo", "light effect on SVG", "backlit shape", "neon text", "lens flare", "chromatic edge", "lit from behind", "light path".
---

# Halo Glow

Lights a silhouette instead of blurring it. The artwork is never tinted or
overlaid — a **signed distance field** of its contour is computed, and the GPU
emits light along that contour with a per-wavelength point spread function. That
is what makes an edge stay razor sharp in one region while blooming in the
next, and what makes a hole in the shape glow from the inside too.

## Try it first

Open `examples/studio.html` by double-clicking it. No server, no build step, no
dependencies — it runs from `file://`.

What you get: a live animated canvas, a hand-drawable light path, three
background modes, PNG export, and video export at full output resolution.

## Look presets

`Look` switches between three looks, each a flat patch of parameters that
leaves your artwork, light path and export settings alone:

| look | what it is |
|---|---|
| **Glow** | the shape is its own light source: lit interior, spectral edge, big bloom |
| **Neon** | a backlit cutout: flat body, magenta↔cyan dispersion rim, light falling out of frame below |
| **Rim** | same silhouette, single-colour rim, restrained spill |

```js
Object.assign(stage.params, HaloGlow.STYLES.neon.params);
```

Neon and Rim set `interior` low and `fillStrength` to 1, which turns the body
into a flat painted surface instead of another light source. `interior`,
`fillColor`, `rainbow`, `rainbowCycles` and `godrays` stay exposed so any of it
can be dialled back without leaving the preset.

**Adding a new look**: do it with more parameters, not a second render path.
The optics are shared; a look is a flat patch of values over them, so old looks
keep working and any single value can still be overridden. Match the reference
by the *widths and the colour model* first — a dispersion rim is a two-pole
magenta↔cyan split, not a full spectrum, and that is what separates "light on an
edge" from "a coloured outline"; then the brightness.

## Using the renderer in your own page

Two files, loaded in order, no build:

```html
<script src="src/distance-field.js"></script>
<script src="src/halo-glow.js"></script>
```

```js
const stage = HaloGlow.createStage(canvas, {
  source: { type: 'svg', svgText: mySvgMarkup, size: 0.8 },
  params: { glow: 1.45, glowColor: '#8fd1ff', palette: 'ink' }
});

await stage.setSource({ type: 'svg', svgText: mySvgMarkup, size: 0.8 });

function frame(now) {
  stage.draw(now);          // drives the flow phase and the light's position
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

`stage.draw(t)` takes milliseconds. Everything animated is a pure function of
`t`, which is what makes video export exact rather than a screen recording.

### Sources

| `source.type` | fields | notes |
|---|---|---|
| `'svg'` | `svgText` or `svgUrl`, or `image` | stroke-only artwork is detected and lit along its centreline instead |
| `'text'` | `text`, `fontFamily`, `weight` | the web font must already be loaded |

### A hand-drawn light path

```js
// uv points, y up, 0..1 = the frame. Values outside it are allowed on purpose:
// that is how the light gets placed outside the artwork.
stage.setPath([[0.2, 0.8], [0.5, 0.5], [0.8, 0.3]]);
stage.setPathPingPong(true);
```

Points are resampled to 64 by arc length, so the light moves at constant speed
regardless of how unevenly the stroke was captured. With two or more points the
single `params.light` is ignored and the walk drives the flare, the rays, the
rings, the ghosts and the trails — all of them read the same position, so they
never separate. `stage.lightAt(seconds)` mirrors the shader maths in JS, for
drawing your own overlay.

### Parameters worth knowing

| key | range | what it actually changes |
|---|---|---|
| `glow` | 0–3 | total emitted energy |
| `blur` | 0.01–0.14 | reach of the wide halo, and the length of the rays |
| `blurContrast` | 0–2 | how sharply the defocus field separates crisp from bloomed regions |
| `exaggeration` | 0–1 | widens the crisp/bloomed gap *and* lifts energy — drama, not brightness alone |
| `drift` | 0–2.5 | how far the single light wanders on its own. With no path and no drift the shape is self-lit and static, which reads as a picture rather than a preview |
| `dispersion` | 0–0.012 | how far blue travels past red. 0 gives a white edge |
| `glowColor` | hex | the hot core and most of the light |
| `glowColor2` | hex | the wide, dim falloff only. Two colours read as one real source |
| `adaptiveGlow` | 0–1 | how far the light takes on the chosen hue before compositing |
| `palette` | day/dawn/blue/pearl/ink | painted sky, not a flat gradient |
| `background` | `{mode, color, fit, image}` | `preset`, `color`, or `image` (cover / contain) |

## Exporting

```js
const blob = await stage.toPNG();
```

`canvas.captureStream(0)` plus `track.requestFrame()` per frame, recorded by
`MediaRecorder` with MP4 preferred and WebM as the honest fallback. The anchor
must be **in the document** when clicked, or the browser ignores its
`download` attribute and saves a mangled name.

**Pace the frames.** `MediaRecorder` timestamps by wall clock, so pushing 150
frames in 1.2 s yields a complete file that is 1.2 s long. Wait for each frame's
slot before pushing the next, and expect the export to take about as long as the
clip. See `examples/studio.html` for the loop. Give the recorder a timeslice
(~1 s) or it drops whole fragments when the renderer outruns the encoder.

**The auto-click is best-effort.** After a page has saved several files, Chromium
silently refuses further ones until a person allows them, and the bytes are then
gone with nothing in the UI to show for it. The studio therefore also leaves
every finished export as a visible link in the panel. Check the status line and
that link before concluding an export failed.

## Things that break this

- **Rebuild hangs with no error.** A promise chain that has already rejected
  stays rejected. Every serialised queue needs a leading `.catch`.
- **The distance-field worker never answers.** A generated blob worker with a
  syntax error fires neither `message` nor `error`. Keep a timeout that falls
  back to the main thread.
- **The preview darkens and never clears.** An `id` rule beats a
  `.class[hidden]` rule. Two elements sharing an id means `display: block`
  wins over `display: none` and your curtain is undismissable.
- **Nothing downloads, with no error anywhere.** Usually the browser's
  multi-file policy, not the code. Confirm the blob is real from the status
  line before chasing it.
- **Re-uploading a background every frame** saturates the upload queue and
  starves the worker reply, which looks exactly like a hung rebuild.
- **`fill-rule` only cancels between subpaths of the same element.** Holes
  spread across several `<path>` elements do not exist; the disc fills solid.
- **GLSL is strongly typed.** `for (int i...)` means `i == 1` is int-to-int and
  `fi == 2` is float-to-int; both are errors. Write the literal to match.

## Verifying an export

`python tools/probe_video.py <file.mp4>` reports the box layout, the real frame
count and the **playback length**. Frame count alone proves nothing: a file can
hold every frame you pushed and still be the wrong duration. The length comes
from summing sample durations across the fragments — `mvhd`/`mdhd` carry a
placeholder in a fragmented MP4. Per-sample fields in `trun` are opt-in, so
derive the stride from the flags (0x305 is duration + size, 8 bytes, not 16).

## Files

```
src/distance-field.js   exact euclidean distance transform + RGBA16 packing
src/halo-glow.js        the renderer: shaders, blur chain, path, background
examples/studio.html    the studio: controls, path drawing, export
assets/glyph.svg        the default artwork, generated by tools/make_glyph.py
tools/make_glyph.py     redraws the glyph
tools/inline_glyph.py   keeps the inline copy in studio.html in sync (--check)
tools/probe_video.py    structural check on an exported file
```

After changing `assets/glyph.svg`, run `python tools/inline_glyph.py`, or the
page served from `file://` keeps showing the previous shape.

`references/optics.md` covers the maths: why a distance field instead of a
blurred alpha, how the spectral PSF is laid out, and how each parameter maps to
what you see.

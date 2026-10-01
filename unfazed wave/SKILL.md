# Unfazed Wave

The `wave` shader from [OpenShaders](https://openshaders.com/@unfazed), in all
four of the forms its author published: two shader languages × two integration
styles. Every file in `src/` is byte-for-byte as published; the demo is
generated from one of them.

## The four implementations

| File | Language | Form | Entry point |
| --- | --- | --- | --- |
| `src/unfazed-shader.webgl.js` | GLSL ES 3.00 | JS module | `createShader(canvas, options)` — synchronous |
| `src/unfazed-shader.webgpu.js` | WGSL | JS module | `await createShader(canvas, options)` |
| `src/UnfazedShader.webgl.tsx` | GLSL ES 3.00 | React + TypeScript | `<UnfazedShader theme="dark" />` |
| `src/UnfazedShader.webgpu.tsx` | WGSL | React + TypeScript | `<UnfazedShader theme="dark" />` |

Use the WebGL module when WebGPU is not guaranteed — it needs no build step and
works in every current browser. The WebGPU module is async and throws a named
error when there is no adapter. The two `.tsx` files need React, a bundler, and
`@webgpu/types` in `tsconfig` `compilerOptions.types`.

## What the shader does

Two passes, both full-screen triangles.

1. **Field** — 78 iterations of a fold-and-shrink transform, each accumulating a
   glow. Colour comes from Oklch: hue cycles along the iteration index and
   travels with radius. A breath term scales zoom, glow and a small offset.
   Output is filmic-tonemapped, vignetted, and composited over the background
   for the current theme. Blue noise at ±1/255 dithers the gradient banding.
2. **Rarity** — resamples the field through `liquidFlow`, a sum of three
   travelling cosine waves along fixed directions, bent by a second sine. The
   result is that the whole image drifts as though seen through moving liquid.

Both passes take the same uniforms. `LAYERS`, `ECHO`, `FLOW_SPEED`,
`FLOW_DIRECTION` and `BREATH_AMOUNT` are the constants worth touching first.

## API

```js
const shader = createShader(canvas, {
  theme: "dark",                                  // or "light"
  background: { dark: "#07070b", light: "#f3efe6" },
  autoplay: true,                                 // false freezes time
  signal: controller.signal,                      // abort to destroy
  onError: (error) => {},
});

shader.setTheme("light");   // eased, ~0.3s
shader.render(12.5);         // only when autoplay is false
shader.destroy();
```

Theme changes ease at `THEME_EASE = 7`, so they need a few frames to arrive.
With `autoplay: false`, `setTheme` applies immediately instead.

The loop stops on `document.hidden`, when the canvas leaves the viewport
(`IntersectionObserver`), and under `prefers-reduced-motion`. Device pixel ratio
is capped at 2 and total pixels at 2 400 000.

## The demo

Open `examples/wave.html` by double-clicking it. No server, no install.

It carries its own copy of the WebGL2 module rather than importing it. A
`file://` page cannot import another `file://` module — the browser blocks it
under CORS — so importing `src/*.js` directly needs a static server. The copy is
generated, never hand-edited:

```bash
python tools/build_demo.py
```

Edit `src/unfazed-shader.webgl.js`, rerun that, and the demo picks the change up.

/* Halo Glow - a WebGL2 optical renderer that lights arbitrary artwork.
 *
 * Pipeline, once per shape change:
 *   1. artwork -> alpha mask (canvas 2D)
 *   2. mask -> signed distance field (HaloDistanceField, in a worker)
 *   3. field -> emitter pass: spectral edge light along the contour
 *   4. emitter -> two blur pyramids (near / wide)
 *   5. composite: shape radiance + scattered rays + sun flare + lens rings +
 *      ghosts, tinted, then exposed over a background
 *
 * The distance field is what makes this hold up: an alpha mask cannot light an
 * edge, and a blurred mask cannot produce a contour that stays crisp in one
 * region while blooming in the next.
 *
 * Classic script on purpose so the demo opens from file:// without a server.
 * Exposes window.HaloGlow.
 */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- shaders */

  var VERTEX_SOURCE = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

  /* Shared by the emitter and the composite: how to read the field, and where
   * the scene is currently in or out of focus. */
  var FIELD_SOURCE = `
const float PI = 3.14159265359;

uniform sampler2D uField;
uniform vec2  uResolution;
uniform vec2  uShapeCentre;
uniform vec2  uShapeOffset;
uniform float uSpan;
uniform float uFieldScale;
uniform float uLineMode;
uniform float uBlur;
uniform float uBlurContrast;
uniform float uDispersion;
uniform float uSeed;
uniform float uFlowPhase;
uniform float uExaggeration;

float gaussian(float x, float sigma) {
  float q = x / max(sigma, 0.00025);
  return exp(-0.5 * q * q);
}

// Aspect-corrected space, so a flare stays round on a 9:16 canvas.
vec2 metric(vec2 p) { return p * vec2(uResolution.x / uResolution.y, 1.0); }

// rg = outward distance, ba = inward distance, both unsigned.
// Translating rather than resampling is why moving the shape never rescales
// its glow or distorts its geometry.
float fieldAt(vec2 uv) {
  vec2 local = uv - uShapeOffset;
  vec2 sampleUv = clamp(local, vec2(0.0), vec2(1.0));
  vec4 packed = texture(uField, sampleUv);
  float outward = (packed.r * 256.0 + packed.g) / 257.0;
  float inward  = (packed.b * 256.0 + packed.a) / 257.0;
  // Outside the texture the field is unknown; fall back to the distance to the
  // nearest sampled border so a shape pushed off-frame still glows.
  return (outward - inward) * uFieldScale + length(metric(local - sampleUv));
}

/* Defocus field: a broad, periodic scalar in shape space, 0 = razor sharp,
 * 1 = fully bloomed. Advected around the silhouette, but the field itself and
 * the mask never move - no noise cells, no nearest-point seams. */
float defocusAt(vec2 uv) {
  vec2 p = metric(uv - uShapeCentre) / max(uSpan, 0.08);
  float spin = uFlowPhase;
  p = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * p;
  float theta = atan(p.y, p.x);
  float phase = uSeed * 0.41;

  float f = 0.52 - 0.30 * cos(2.0 * theta - 0.50 + phase)
                  + 0.09 * cos(5.0 * theta + 1.20 - phase);
  f += 0.20 * gaussian(p.x - 0.26, 0.16) * gaussian(p.y, 0.32);
  f -= 0.52 * gaussian(p.x + 0.22, 0.14) * gaussian(p.y - 0.30, 0.18);
  f *= 1.0 - 0.62 * smoothstep(0.26, 0.55, p.y);
  // Stay neutral at the centre, or every shape grows a fixed hot dot there.
  f = mix(0.5, f, smoothstep(0.02, 0.16, length(p)));
  // Exaggeration widens the gap between the sharp and bloomed regions, which is
  // what makes the light read as dramatic rather than merely soft.
  float contrast = uBlurContrast * mix(1.0, 1.7, clamp(uExaggeration, 0.0, 1.0));
  return clamp(0.5 + (f - 0.5) * contrast, 0.05, 0.98);
}

// A gaussian whose width differs on the two sides of its centre.
float lobe(float d, float centre, float inward, float outward) {
  return gaussian(d - centre, mix(inward, outward, smoothstep(-0.0005, 0.0005, d - centre)));
}

/* Light emitted along the contour. Wavelengths are given different point
 * spread functions: red stays short and pulls inward, blue travels further and
 * softens - that offset is the dispersion.
 * transport != 0 renders the energy source for the blur chain, which must not
 * depend on how sharp the visible inside is. */
vec3 edgeEmission(vec2 uv, float transport) {
  float d = fieldAt(uv);
  float f = defocusAt(uv);
  float scale = clamp(uSpan / 0.82, 0.34, 1.35);
  float w = mix(0.0016, 0.0088, f) * scale;
  float spread = uDispersion / 0.0045;
  float s = (0.0016 + 0.0036 * f) * spread * scale;

  // Interior stays focused until a broad defocus lobe sweeps through it.
  float inner = mix(0.22, 0.92, smoothstep(0.30, 0.95, f));
  inner = mix(inner, mix(0.60, 2.0, f), transport);

  float redShift = s * mix(0.26, 0.90, smoothstep(0.30, 0.95, f));
  redShift = mix(redShift, s * 1.30, transport);

  vec3 light;
  light.r = lobe(d, -redShift, w * inner * 1.45, w * 1.30);
  light.g = 0.60 * lobe(d, s * 0.10, w * inner * 1.20, w * 1.00)
          + 0.40 * lobe(d, s * 0.10, w * inner * 1.20, w * (2.10 + spread * 0.5));
  light.b = 0.50 * lobe(d, s * 0.45, w * inner * 0.80, w * 1.60)
          + 0.50 * lobe(d, s * 0.45, w * inner * 0.80, w * (3.50 + spread));

  if (uLineMode > 0.5) {
    // An open stroke is one luminous centreline with a single peak, not two
    // competing outlines.
    light = vec3(gaussian(d, w),
                 gaussian(d, w * (1.50 + spread * 0.4)),
                 gaussian(d, w * (1.90 + spread * 0.9)));
  }

  float energy = mix(1.15, 1.42, f);
  // A hint of extra energy on the side facing the light, so the shape reads
  // as lit rather than evenly self-luminous.
  float upper = metric(uv - uShapeCentre).y / max(uSpan, 0.08);
  energy *= 1.0 + 0.55 * smoothstep(0.25, 0.50, upper);

  float halo = lobe(d, 0.005 * scale,
                    (0.002 + 0.010 * f * f) * scale,
                    (0.030 + 0.065 * f) * scale);
  return light * energy + vec3(0.05, 0.10, 0.16) * halo * (0.5 + f);
}`;

  var EMITTER_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${FIELD_SOURCE}
void main() { outColor = vec4(edgeEmission(vUv, 1.0) / 8.0, 1.0); }`;

  /* Five linear-sampled taps approximating a gaussian, run separable. */
  var BLUR_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uStep;
uniform float uRadius;
void main() {
  vec2 o = uTexel * uStep * uRadius;
  vec4 c = texture(uSource, vUv) * 0.2270270270;
  c += texture(uSource, vUv + o * 1.3846153846) * 0.3162162162;
  c += texture(uSource, vUv - o * 1.3846153846) * 0.3162162162;
  c += texture(uSource, vUv + o * 3.2307692308) * 0.0702702703;
  c += texture(uSource, vUv - o * 3.2307692308) * 0.0702702703;
  outColor = c;
}`;

  var COMPOSITE_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${FIELD_SOURCE}

uniform sampler2D uNearBlur;
uniform sampler2D uWideBlur;
uniform vec2  uLightPos;
uniform vec2  uPath[64];
uniform int   uPathCount;
uniform float uPathHead;
uniform float uPathPing;
uniform float uDrift;
uniform vec3  uSkyTop, uSkyMid, uSkyBottom;
uniform int   uBackgroundMode;   // 0 gradient, 1 solid, 2 image
uniform vec3  uBackgroundColor;
uniform sampler2D uBackgroundImage;
uniform float uBackgroundImageAspect;
uniform int   uBackgroundFit;
uniform float uTime, uGlow, uSun, uStreak, uRings, uGhost, uAdaptiveGlow;
uniform vec3  uGlowColor;
uniform vec3  uGlowColor2;
uniform float uInterior;
uniform vec3  uFillColor;
uniform float uFillStrength;
uniform float uRainbow;
uniform float uRainbowCycles;
uniform float uGodrays;

/* Where the light is right now. With a hand-drawn path it walks the path; with
 * one point it drifts around it on a slow Lissajous, because a pinned light
 * over a self-lit shape reads as a still image. Every layer below must read
 * this instead of uLightPos, or the flare detaches from the glow. */
vec2 lightPosition(float head) {
  if (uPathCount < 2) {
    if (uDrift <= 0.0) return uLightPos;
    vec2 offset = vec2(
      sin(uTime * 0.23) * 0.115 + sin(uTime * 0.11) * 0.055,
      cos(uTime * 0.19) * 0.085 + cos(uTime * 0.07) * 0.040
    );
    return uLightPos + offset * uDrift;
  }
  float t = uPathPing > 0.5 ? abs(fract(head * 0.5) * 2.0 - 1.0) : fract(head);
  float f = t * float(uPathCount - 1);
  int i = int(floor(f));
  int j = int(min(float(i + 1), float(uPathCount - 1)));
  return mix(uPath[i], uPath[j], fract(f));
}

vec2 lightPosition() { return lightPosition(uPathHead); }

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 spin(vec2 p, float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)) * p; }

// The blur chain stores radiance / 8. Outside its footprint there is no data.
vec3 fetch(sampler2D source, vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  return texture(source, uv).rgb * 8.0;
}

/* Volumetric scattering: integrate the already convolved emitter along the
 * optical ray instead of along a solid mask. The decay is exponential, so the
 * beams look like light in air rather than like a stretched blur. */
vec3 scatteredRays(vec2 uv, float d) {
  vec2 ray = uv - lightPosition();
  float f = defocusAt(uv);
  float reach = uBlur * mix(2.0, 6.0, f);
  vec3 sum = vec3(0.0);
  float total = 0.0;
  // 24 steps, not more: the weight is exp(-2.2t), which has already fallen to
  // 6% by t=1, so extra taps buy nothing and cost a full-screen pass per step.
  for (int i = 0; i < 24; i += 1) {
    float t = (float(i) + 0.5) / 24.0;
    float weight = exp(-2.2 * t) * (1.0 - t) * (1.0 - t);
    sum += fetch(uNearBlur, uv - ray * t * reach) * weight;
    total += weight;
  }
  float outside = smoothstep(-0.002, 0.012, d);
  return sum / total * mix(0.08 + f * 0.20, 0.58, outside) * (uBlur / 0.068);
}

/* The light source itself: hot core, veil, two sets of diffraction spokes. */
vec3 sunLight(vec2 p) {
  float r = length(p);
  float core = gaussian(r, 0.030) * 2.3 + gaussian(r, 0.092) * 0.85;
  float veil = gaussian(r, 0.180) * 0.28;
  vec3 light = vec3(core) + vec3(0.58, 0.76, 1.0) * veil;
  light += vec3(0.22, 0.32, 0.50) * gaussian(r, 0.290);

  float a = atan(p.y, p.x);
  // Six long spikes read as a lens; the eighteen fine ones read as diffraction.
  float spikes = pow(0.5 + 0.5 * cos(6.0 * a + 0.25), 7.0)
               + 0.6 * pow(0.5 + 0.5 * cos(18.0 * a - 1.10), 9.0);
  light += vec3(0.38, 0.53, 0.66) * spikes * gaussian(r, 0.190)
         * smoothstep(0.015, 0.055, r) * 0.06;
  return light * uSun;
}

/* Anamorphic streaks: four soft bars through the core, a signature of a real
 * lens rather than a symmetric glow. */
vec3 streaks(vec2 p) {
  vec3 light = vec3(0.0);
  vec2 here = lightPosition();
  float drift = (here.x - 0.478) * 0.6 + sin(uTime * 0.13) * 0.014;
  for (int i = 0; i < 4; i += 1) {
    float fi = float(i);
    vec2 q = spin(p, fi * PI / 4.0 + 0.14 + drift);
    float along = gaussian(q.x, fi == 2.0 ? 0.20 : 0.15);
    float across = gaussian(q.y, 0.008 + abs(q.x) * 0.075);
    light += vec3(0.85, 0.93, 1.0) * along * across * (i == 0 ? 0.20 : (i == 2 ? 0.24 : 0.07));
  }
  return light * uStreak;
}

/* Concentric lens rings with a real spectral spread across each band. */
vec3 lensRings(vec2 uv) {
  vec3 light = vec3(0.0);
  vec2 here = lightPosition();
  vec2 drift = metric(here - vec2(0.478, 0.455));
  for (int i = 0; i < 3; i += 1) {
    float fi = float(i);
    vec2 centre = vec2(-0.015 + 0.012 * sin(fi * 3.1 + uSeed), 0.018 * cos(fi * 2.7));
    vec2 p = metric(uv - here) - centre + drift * (fi * 0.2 - 0.1);
    p = spin(p, 0.030 * (fi - 1.0));
    p.x *= 1.0 + fi * 0.020;
    float r = length(p);
    float radius = 0.615 + fi * 0.072 + 0.013 * sin(fi * 1.7 + uSeed);
    float d = r - radius;
    float a = atan(p.y, p.x);
    // One bright arc rather than a closed ring: a full circle looks synthetic.
    float arc = pow(0.5 + 0.5 * cos(a - 3.4 + fi * 0.45), 3.0)
              + 0.22 * pow(0.5 + 0.5 * cos(a + 0.2), 8.0);
    vec3 spectrum = vec3(gaussian(d + 0.0035, 0.0038), gaussian(d, 0.0045), gaussian(d - 0.0040, 0.0054));
    vec3 tint = i == 1 ? vec3(0.36, 0.60, 0.68) : vec3(0.26, 0.64, 0.55);
    vec3 band = i == 0 ? spectrum * vec3(0.020, 0.16, 0.12)
                       : tint * gaussian(d, 0.0025 + fi * 0.001) * 0.028;
    light += band * arc;
  }
  return light * uRings;
}

/* Flare ghosts: defocused aperture images marching along the optical axis. */
vec3 ghostTrain(vec2 uv) {
  vec2 here = lightPosition();
  vec2 p = metric(uv - here);
  vec2 axis = vec2(0.23, -0.067) - metric(here - vec2(0.478, 0.455)) * 2.0;
  vec3 light = vec3(0.0);
  for (int i = 0; i < 9; i += 1) {
    float t = float(i) / 8.0;
    vec2 centre = axis * (0.19 + t * 0.90);
    float radius = 0.0045 + t * t * 0.019;
    float r = length(p - centre);
    float disc = 1.0 - smoothstep(radius * 0.30, radius * 1.90, r);
    float haze = gaussian(r, radius * 1.35);
    vec3 tint = mix(vec3(0.90, 0.96, 1.0), vec3(0.32, 0.72, 1.0), t);
    light += tint * (disc * 0.035 + haze * 0.026) * (1.0 - t * 0.7);
  }
  return light * uGhost;
}

/* Tint the light towards the chosen colour once, after every layer is summed
 * and before compositing. Only genuinely bright overlap of all three channels
 * is allowed to go white, so soft bloom keeps its hue on a pale sky. */
vec3 adaptiveRadiance(vec3 light) {
  if (uAdaptiveGlow <= 0.0) return light;
  float energy = max(light.r, max(light.g, light.b));
  if (energy <= 0.000001) return light;

  vec3 tint = max(uGlowColor, vec3(0.0));
  float peak = max(tint.r, max(tint.g, tint.b));
  tint = peak > 0.000001 ? tint / peak : vec3(1.0);

  // Keep a little wavelength variation inside the chosen family.
  vec3 spectrum = light / energy;
  spectrum -= vec3(dot(spectrum, vec3(1.0 / 3.0)));
  tint *= vec3(1.0) + spectrum * 0.16;
  tint /= max(tint.r, max(tint.g, tint.b));

  float shared = min(light.r, min(light.g, light.b));
  float whiteCore = smoothstep(0.65, 1.60, shared) * 0.94;
  vec3 adapted = energy * mix(tint, vec3(1.0), whiteCore);
  return mix(light, adapted, clamp(uAdaptiveGlow, 0.0, 1.0));
}

/* Second colour for the wide, dim falloff. The core keeps the first colour, so
 * a warm core over a cool bloom reads as a real light rather than one flat
 * tint applied to everything. */
vec3 bloomTint(vec3 light) {
  if (uAdaptiveGlow <= 0.0) return light;
  float energy = max(light.r, max(light.g, light.b));
  if (energy <= 0.0) return light;
  vec3 rim = max(uGlowColor2, vec3(0.0));
  float peak = max(rim.r, max(rim.g, rim.b));
  rim = peak > 0.000001 ? rim / peak : vec3(1.0);
  // Only the soft, wide part is repainted; the hot core keeps its own colour.
  float wide = 1.0 - smoothstep(0.25, 1.30, energy);
  return energy * mix(vec3(1.0), rim, wide * 0.85);
}

vec3 shapeRadiance(vec2 uv) {
  float d = fieldAt(uv);
  vec3 edge = edgeEmission(uv, 0.0);
  float f = defocusAt(uv);
  float outside = smoothstep(-0.002, 0.018, d);

  vec3 near = fetch(uNearBlur, uv);
  vec3 wide = fetch(uWideBlur, uv) * vec3(0.25, 0.75, 1.10);
  vec3 glow = edge + near * (0.03 + 0.12 * f) + wide * mix(0.025 + 0.08 * f * f, 0.80, outside);

  vec3 rays = scatteredRays(uv, d);
  rays *= mix(1.0, 1.8, smoothstep(0.014, 0.070, d));

  // Transmission must reach the contour. A wider fade-out here paints a false
  // dark inner rim, because the much narrower emitting edge no longer covers it.
  float transmission = 1.0 - smoothstep(-0.0015, 0.0015, d);
  vec3 radiance = (glow + rays) * uGlow / 1.45;
  radiance += vec3(0.12, 0.16, 0.20) * transmission
            * gaussian(length(metric(uv - lightPosition())), 0.5) * uGlow / 1.45;
  // Exaggeration is deliberately applied here, once, so the whole shape gets
  // more dramatic together instead of only the parts that read loudest.
  radiance *= mix(1.0, 1.45, clamp(uExaggeration, 0.0, 1.0));
  return radiance;
}

/* Light spilling downward from the contour, the way a backlit cutout leaks
 * past the surface below it. Sampling only upward makes the direction
 * automatic: a point below the body collects it, a point above collects
 * nothing. The source is a narrow band around the contour rather than the
 * whole interior - collecting from the body gives one flat slab of light,
 * and the reference look is several distinct beams with gaps between them. */
vec3 downwardRays(vec2 uv, float d) {
  if (uGodrays <= 0.0 || d < 0.0) return vec3(0.0);
  vec3 sum = vec3(0.0);
  float weight = 1.0;
  for (int i = 1; i <= 14; i += 1) {
    weight *= 0.90;
    if (weight < 0.010) break;
    vec2 p = uv + vec2(0.0, float(i) * 0.0075);
    float dp = fieldAt(p);
    sum += vec3(exp(-abs(dp) * 95.0)) * weight;
  }
  return sum * uGodrays * 0.55;
}

/* An iridescent band riding the contour. Hue advances with the angle around
 * the shape, which is what makes it read as a spectrum rather than a smear.
/* An iridescent band riding the contour. The reference this imitates is NOT a
 * full spectrum: it is a magenta<->cyan dispersion fringe that reads white
 * where the two meet, the way a thin backlit cutout splits light at its rim.
 * A hue cycle through the whole HSV wheel is the wrong model - it produces the
 * green/yellow/orange band that makes it read as a vector outline instead of
 * light. So this lerps between exactly two poles. */
vec3 rainbowEdge(vec2 uv, float d) {
  if (uRainbow <= 0.0) return vec3(0.0);
  vec2 p = metric(uv - uShapeCentre);
  float angle = atan(p.y, p.x);
  // One smooth sweep around the shape; a few of these are allowed but the
  // default look uses roughly one so it reads as a single refraction sweep.
  float t = 0.5 + 0.5 * sin(angle * uRainbowCycles + uTime * 0.012);
  vec3 magenta = vec3(1.00, 0.42, 0.88);
  vec3 cyan    = vec3(0.40, 0.88, 1.00);
  vec3 tint = mix(magenta, cyan, smoothstep(0.0, 1.0, t));
  // Hairline band, sitting just outside the contour.
  float band = exp(-abs(d) / 0.0012);
  return tint * band * uRainbow * 2.0;
}

vec3 backgroundAt(vec2 uv) {
  if (uBackgroundMode == 1) return uBackgroundColor;
  if (uBackgroundMode == 2) {
    float canvasAspect = uResolution.x / uResolution.y;
    float imageAspect = max(uBackgroundImageAspect, 0.0001);
    vec2 ratio = vec2(canvasAspect / imageAspect, imageAspect / canvasAspect);
    // cover crops, contain letterboxes; both keep the image centred and undistorted
    vec2 scale = uBackgroundFit == 1 ? min(ratio, vec2(1.0)) : max(ratio, vec2(1.0));
    vec2 imageUv = (uv - 0.5) * scale + 0.5;
    if (any(lessThan(imageUv, vec2(0.0))) || any(greaterThan(imageUv, vec2(1.0)))) {
      return uBackgroundColor;
    }
    vec4 image = texture(uBackgroundImage, imageUv);
    return mix(uBackgroundColor, image.rgb, image.a);
  }
  vec3 sky = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, uv.y));
  return mix(sky, uSkyMid, 0.10 * gaussian(uv.y - 0.53, 0.22));
}

void main() {
  vec2 uv = vUv;
  float d = fieldAt(uv);
  vec3 radiance = shapeRadiance(uv);
  vec3 sky = backgroundAt(uv);

  /* Interior as a body, not just as light. Turning uInterior down leaves a
   * silhouette whose only lit feature is its edge. */
  float inside = 1.0 - smoothstep(-0.0015, 0.0015, d);
  radiance *= mix(1.0, mix(0.06, 1.0, clamp(uInterior, 0.0, 1.0)), inside);

  vec2 here = lightPosition();
  radiance += sunLight(metric(uv - here)) * uSun;
  // A short trail, only meaningful once there is a route to trail along. Kept
  // low on purpose: two extra full-strength cores would triple the flare and
  // wash the whole frame out.
  if (uPathCount >= 2) {
    radiance += (sunLight(metric(uv - lightPosition(uPathHead - 0.035)))
              + sunLight(metric(uv - lightPosition(uPathHead - 0.070))) * 0.7) * uSun * 0.28;
  }
  radiance += streaks(metric(uv - here)) + lensRings(uv) + ghostTrain(uv);

  radiance = bloomTint(radiance);
  radiance = adaptiveRadiance(radiance);
  radiance += rainbowEdge(uv, d) + downwardRays(uv, d);

  // The silhouette body is painted before exposure, so it is a surface the
  // light sits on rather than another light source.
  vec3 base = mix(sky, uFillColor, inside * clamp(uFillStrength, 0.0, 1.0));

  // One exposure curve for every layer. Clamping each layer separately, or
  // repainting a hue after the fact, is what makes stacked glows look cheap.
  vec3 color = 1.0 - (1.0 - base) * exp(-max(radiance, vec3(0.0)));
  color += (hash(gl_FragCoord.xy) - 0.5) / 650.0;   // dither the gradient
  outColor = vec4(color, 1.0);
}`;

  /* ------------------------------------------------------------ gl helpers */

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile failed: ' + info);
    }
    return shader;
  }

  function link(gl, fragmentSource) {
    var vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    var fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    var program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
    }
    return program;
  }

  /* The distance transform is a few hundred milliseconds of straight-line
   * number crunching. A worker built from an inline blob keeps it off the
   * render loop, and unlike new Worker('file.js') it still works from file://. */
  function createFieldWorker(field) {
    if (typeof Worker === 'undefined') return null;
    try {
      var source = [
        '"use strict";',
        field.edt1d.toString(),
        field.distanceTransform.toString(),
        field.extractCenterline.toString(),
        'var FAR = ' + field.FAR + ';',
        field.build.toString(),
        'self.onmessage = function (event) {',
        '  try { self.postMessage({ ok: true, result: build(event.data) }); }',
        '  catch (error) { self.postMessage({ ok: false, error: String(error && error.message || error) }); }',
        '};'
      ].join('\n');
      var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      var worker = new Worker(url);
      URL.revokeObjectURL(url);
      return worker;
    } catch (error) {
      return null;
    }
  }

  /* ------------------------------------------------------------- the stage */

  var DEFAULTS = {
    glow: 1.45,
    blur: 0.068,
    blurContrast: 1.0,
    dispersion: 0.0045,
    sun: 1.1,
    streak: 0.88,
    rings: 0.76,
    ghost: 0.82,
    seed: 2.371,
    flowSpeed: 1,
    exaggeration: 0.35,
    drift: 1,
    light: [0.36, 0.69],
    position: { x: 0, y: 0 },   // shape offset, uv units
    size: 0.82,
    glowColor: '#8FD1FF',
    glowColor2: '#4C6BFF',
    adaptiveGlow: 1,
    interior: 1,          // 1 = the shape is its own light, 0 = silhouette
    fillColor: '#2b6fd6',
    fillStrength: 0,      // only a silhouette gets a body colour
    rainbow: 0,           // iridescent band riding the contour
    rainbowCycles: 1,
    godrays: 0,           // light spilling downward off the contour
    palette: 'day',
    background: { mode: 'preset', color: '#10131a', fit: 'cover', image: null, aspect: 1 }
  };

  var MAX_PATH_POINTS = 64;

  /* Look presets. Each is a flat patch over params, so switching style never
   * touches the light path, the artwork or the export settings. */
  var STYLES = {
    glow: {
      label: 'Glow',
      params: {
        interior: 1, fillStrength: 0, rainbow: 0, godrays: 0,
        glow: 1.45, blur: 0.068, sun: 1.1, dispersion: 0.0045,
        glowColor: '#8FD1FF', glowColor2: '#4C6BFF', adaptiveGlow: 1
      }
    },
    neon: {
      /* Backlit cutout: a flat body, a hairline spectrum along the rim, and
       * the rim's light falling out of frame below. Nearly all the interior
       * light is off - the body is a surface, not a lamp. */
      label: 'Neon',
      params: {
        interior: 0.03, fillStrength: 1, rainbow: 1, godrays: 0.9,
        glow: 0.62, blur: 0.030, blurContrast: 0.35, sun: 0.18,
        streak: 0.20, rings: 0.12, ghost: 0.20,
        dispersion: 0.0009, rainbowCycles: 1.0,
        glowColor: '#dff3ff', glowColor2: '#5fd0f0', adaptiveGlow: 1,
        fillColor: '#2f8fdc', exaggeration: 0.12
      }
    },
    rim: {
      label: 'Rim',
      params: {
        interior: 0.10, fillStrength: 1, rainbow: 0, godrays: 0.45,
        glow: 1.30, blur: 0.058, blurContrast: 0.85, sun: 0.5,
        streak: 0.6, rings: 0.35, ghost: 0.4,
        dispersion: 0.0030,
        glowColor: '#ffffff', glowColor2: '#69b7ff', adaptiveGlow: 1,
        fillColor: '#12203a'
      }
    }
  };

  var PALETTES = {
    day:   { top: [0.495, 0.635, 0.790], mid: [0.443, 0.602, 0.779], bottom: [0.362, 0.492, 0.663] },
    dawn:  { top: [0.380, 0.560, 0.760], mid: [0.690, 0.700, 0.790], bottom: [0.840, 0.550, 0.490] },
    blue:  { top: [0.100, 0.220, 0.380], mid: [0.220, 0.430, 0.650], bottom: [0.460, 0.660, 0.820] },
    pearl: { top: [0.530, 0.650, 0.750], mid: [0.730, 0.770, 0.790], bottom: [0.810, 0.730, 0.660] },
    ink:   { top: [0.070, 0.075, 0.095], mid: [0.045, 0.050, 0.065], bottom: [0.025, 0.028, 0.038] }
  };

  function hexToRgb(hex) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return [1, 1, 1];
    var n = parseInt(match[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* Preset skies are painted, not shipped as photographs: a vertical ramp, a
   * horizon bloom and a few blurred bands. It costs nothing to bundle, scales
   * to any canvas ratio, and gives the bloom something to sit in that a flat
   * three-stop gradient cannot. */
  function paintSky(palette, variant) {
    var width = 512, height = 512;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var rgb = function (c) {
      return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
    };

    var ramp = ctx.createLinearGradient(0, 0, 0, height);
    ramp.addColorStop(0, rgb(palette.top));
    ramp.addColorStop(0.58, rgb(palette.mid));
    ramp.addColorStop(1, rgb(palette.bottom));
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, width, height);

    var horizon = height * (0.60 + 0.04 * variant);
    var bloom = ctx.createRadialGradient(
      width * (0.30 + 0.14 * variant), horizon, height * 0.02,
      width * 0.5, horizon, width * 0.8);
    bloom.addColorStop(0, 'rgba(255,255,255,0.32)');
    bloom.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);

    var blur = Math.round(width * 0.055);
    ctx.filter = 'blur(' + blur + 'px)';
    for (var i = 0; i < 7; i += 1) {
      var y = height * (0.16 + 0.62 * ((i + 0.5) / 7));
      var bandWidth = width * (0.32 + 0.46 * Math.abs(Math.sin(i * 2.1 + variant)));
      var bandHeight = height * 0.032;
      var x = width * (0.5 + 0.32 * Math.sin(i * 1.7 + variant * 2.3));
      ctx.fillStyle = 'rgba(255,255,255,'
        + (0.05 + 0.07 * Math.abs(Math.cos(i * 1.3 + variant))).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(x, y, bandWidth, bandHeight, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.filter = 'none';
    return canvas;
  }

  function createStage(canvas, options) {
    var settings = options || {};
    var field = root.HaloDistanceField;
    if (!field) throw new Error('HaloDistanceField must load before HaloGlow.');

    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser does not support WebGL2.');

    var params = Object.assign({}, DEFAULTS, settings.params || {});
    var source = Object.assign({ type: 'svg', size: params.size }, settings.source || {});

    var floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'));
    var maxEdge = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    /* Only used to explain a slow export. The blur chain stores radiance/8, so
     * a byte target would cover the range - but it quantises the halo into
     * visible banding, and speed here is not worth that. */
    var renderer = '';
    try {
      var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');
    } catch (error) { /* the extension is optional */ }

    var programs = {
      emitter: link(gl, EMITTER_SOURCE),
      blur: link(gl, BLUR_SOURCE),
      composite: link(gl, COMPOSITE_SOURCE)
    };

    var positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    var uniformCache = new WeakMap();
    function uniform(program, name) {
      if (!uniformCache.has(program)) uniformCache.set(program, new Map());
      var cache = uniformCache.get(program);
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
      return cache.get(name);
    }

    function makeTarget(width, height) {
      var texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, floatTargets ? gl.RGBA16F : gl.RGBA8, width, height, 0,
        gl.RGBA, floatTargets ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      var framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Could not create the optical render buffer.');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { texture: texture, framebuffer: framebuffer, width: width, height: height };
    }

    function drawFullscreen(program) {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      var location = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function toTarget(program, target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      drawFullscreen(program);
    }

    function bind(program, name, texture, unit) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniform(program, name), unit);
    }

    /* ------------------------------------------------------------ state */

    var state = {
      span: 1,
      centre: [0.5, 0.5],
      scale: 0.6,
      lineMode: false,
      geometryReady: false,
      blurDirty: true
    };

    var fieldTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // A valid empty field, so the first frame renders before any result lands.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 0, 0]));

    var blurTargets = [];
    var blurSize = [0, 0];

    /* ------------------------------------------------------- light path */

    /* A hand-drawn path arrives as however many raw pointer samples the user
     * happened to produce - unevenly spaced, often far more than the shader can
     * hold. Resample by arc length so the light moves at a constant speed
     * instead of stalling in the slow parts of the stroke. */
    function resamplePath(points, count) {
      if (!points || points.length < 2) return points ? points.slice(0, count) : [];
      var cumulative = [0];
      var i;
      for (i = 1; i < points.length; i += 1) {
        var dx = points[i][0] - points[i - 1][0];
        var dy = points[i][1] - points[i - 1][1];
        cumulative.push(cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy));
      }
      var total = cumulative[cumulative.length - 1];
      if (total <= 0) return [points[0], points[points.length - 1]];

      var out = [];
      var segment = 1;
      for (i = 0; i < count; i += 1) {
        var target = (i / (count - 1)) * total;
        while (segment < cumulative.length - 1 && cumulative[segment] < target) segment += 1;
        var span = cumulative[segment] - cumulative[segment - 1];
        var mix = span > 0 ? (target - cumulative[segment - 1]) / span : 0;
        out.push([
          points[segment - 1][0] + (points[segment][0] - points[segment - 1][0]) * mix,
          points[segment - 1][1] + (points[segment][1] - points[segment - 1][1]) * mix
        ]);
      }
      return out;
    }

    var pathPoints = [];
    var pathData = new Float32Array(MAX_PATH_POINTS * 2);
    var pathCount = 0;
    var pathPing = true;

    function setPath(points) {
      var next = resamplePath(points || [], MAX_PATH_POINTS);
      pathPoints = next;
      pathCount = next.length;
      for (var i = 0; i < MAX_PATH_POINTS; i += 1) {
        var p = next[Math.min(i, next.length - 1)] || [0.5, 0.5];
        pathData[i * 2] = p[0];
        pathData[i * 2 + 1] = p[1];
      }
      return stage;
    }

    /* ------------------------------------------------------- background */

    var backgroundTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // A 1x1 opaque white so the image branch is safe before anything loads.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));

    function uploadBackground(source) {
      var width = source.naturalWidth || source.width;
      var height = source.naturalHeight || source.height;
      if (!width || !height) return;
      gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      params.background.image = source;
      params.background.aspect = width / height;
    }

    var skyCache = {};
    var uploadedBackground = null;

    /* Re-uploading a 512x512 texture on every frame saturates the upload queue
     * and starves the worker reply, which is what makes a rebuild look hung.
     * Upload only when the source actually changed. */
    function ensureBackgroundTexture() {
      var settings = params.background;
      var source = null;
      if (settings.mode === 'image') {
        source = settings.image || null;
      } else if (settings.mode === 'preset') {
        if (!skyCache[params.palette]) {
          var names = Object.keys(PALETTES);
          skyCache[params.palette] = paintSky(
            PALETTES[params.palette] || PALETTES.day, Math.max(names.indexOf(params.palette), 0));
        }
        source = skyCache[params.palette];
      }
      if (source && source !== uploadedBackground) {
        uploadBackground(source);
        uploadedBackground = source;
      }
    }

    function ensureBlurTargets() {
      // Cap the long edge: the blur radii are expressed in these pixels, so the
      // halo geometry is identical whatever the display size.
      var factor = Math.min(0.5, 1600 / Math.max(canvas.width, canvas.height));
      var width = Math.max(2, Math.round(canvas.width * factor));
      var height = Math.max(2, Math.round(canvas.height * factor));
      if (blurSize[0] === width && blurSize[1] === height) return;
      blurTargets.forEach(function (t) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer); });
      blurTargets = [makeTarget(width, height), makeTarget(width, height), makeTarget(width, height)];
      blurSize = [width, height];
      state.blurDirty = true;
    }

    function setFieldUniforms(program, timeMs) {
      var offset = [params.position.x, params.position.y];
      gl.uniform2f(uniform(program, 'uResolution'), canvas.width, canvas.height);
      gl.uniform2f(uniform(program, 'uShapeOffset'), offset[0], offset[1]);
      gl.uniform2f(uniform(program, 'uShapeCentre'),
        state.centre[0] + offset[0], state.centre[1] + offset[1]);
      gl.uniform1f(uniform(program, 'uSpan'), state.span);
      gl.uniform1f(uniform(program, 'uFieldScale'), state.scale);
      gl.uniform1f(uniform(program, 'uLineMode'), state.lineMode ? 1 : 0);
      gl.uniform1f(uniform(program, 'uBlur'), params.blur);
      gl.uniform1f(uniform(program, 'uBlurContrast'), params.blurContrast);
      gl.uniform1f(uniform(program, 'uDispersion'), params.dispersion);
      gl.uniform1f(uniform(program, 'uSeed'), params.seed);
      gl.uniform1f(uniform(program, 'uExaggeration'), params.exaggeration);
      gl.uniform1f(uniform(program, 'uFlowPhase'), timeMs * 0.001 * Math.PI * 2 / 36 * params.flowSpeed);
    }

    function blurPass(from, to, direction, radius) {
      var program = programs.blur;
      gl.useProgram(program);
      bind(program, 'uSource', from.texture, 0);
      gl.uniform2f(uniform(program, 'uTexel'), 1 / to.width, 1 / to.height);
      gl.uniform2f(uniform(program, 'uStep'), direction[0], direction[1]);
      gl.uniform1f(uniform(program, 'uRadius'), radius);
      toTarget(program, to);
    }

    function rebuildBlur() {
      ensureBlurTargets();
      var a = blurTargets[0], b = blurTargets[1], near = blurTargets[2];
      gl.useProgram(programs.emitter);
      setFieldUniforms(programs.emitter, 0);
      bind(programs.emitter, 'uField', fieldTexture, 0);
      toTarget(programs.emitter, a);

      // Near: one pass pair, for rays and tight halo.
      var nearRadius = a.height * 0.0025;
      blurPass(a, b, [1, 0], nearRadius);
      blurPass(b, near, [0, 1], nearRadius);

      // Wide: three pass pairs, the third slightly wider - the extra reach is
      // what turns a contour into atmosphere.
      var wideRadius = a.height * (0.010 + params.blur * 0.12);
      blurPass(near, a, [1, 0], wideRadius);
      blurPass(a, b, [0, 1], wideRadius);
      blurPass(b, a, [1, 0], wideRadius * 1.22);
      blurPass(a, b, [0, 1], wideRadius * 1.22);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      state.blurDirty = false;
    }

    /* ------------------------------------------------------------ drawing */

    function draw(timeMs) {
      if (!state.geometryReady) return false;
      if (state.blurDirty) rebuildBlur();

      var program = programs.composite;
      var palette = PALETTES[params.palette] || PALETTES.day;
      var background = params.background;
      ensureBackgroundTexture();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      setFieldUniforms(program, timeMs);
      bind(program, 'uField', fieldTexture, 0);
      bind(program, 'uNearBlur', blurTargets[2].texture, 1);
      bind(program, 'uWideBlur', blurTargets[1].texture, 2);
      bind(program, 'uBackgroundImage', backgroundTexture, 3);
      gl.uniform3fv(uniform(program, 'uSkyTop'), palette.top);
      gl.uniform3fv(uniform(program, 'uSkyMid'), palette.mid);
      gl.uniform3fv(uniform(program, 'uSkyBottom'), palette.bottom);
      gl.uniform1i(uniform(program, 'uBackgroundMode'),
        background.mode === 'color' ? 1 : (background.mode === 'image' ? 2 : 0));
      gl.uniform3fv(uniform(program, 'uBackgroundColor'), hexToRgb(background.color));
      gl.uniform1f(uniform(program, 'uBackgroundImageAspect'), background.aspect || 1);
      gl.uniform1i(uniform(program, 'uBackgroundFit'), background.fit === 'contain' ? 1 : 0);
      gl.uniform2f(uniform(program, 'uLightPos'), params.light[0], params.light[1]);

      gl.uniform2fv(uniform(program, 'uPath'), pathData);
      gl.uniform1i(uniform(program, 'uPathCount'), pathCount);
      gl.uniform1f(uniform(program, 'uPathHead'), timeMs * 0.001 * 0.06 * params.flowSpeed);
      gl.uniform1f(uniform(program, 'uPathPing'), pathPing ? 1 : 0);
      gl.uniform1f(uniform(program, 'uDrift'), pathCount >= 2 ? 0 : params.drift);

      gl.uniform1f(uniform(program, 'uTime'), timeMs * 0.001);
      gl.uniform1f(uniform(program, 'uGlow'), params.glow);
      gl.uniform1f(uniform(program, 'uSun'), params.sun);
      gl.uniform1f(uniform(program, 'uStreak'), params.streak);
      gl.uniform1f(uniform(program, 'uRings'), params.rings);
      gl.uniform1f(uniform(program, 'uGhost'), params.ghost);
      gl.uniform1f(uniform(program, 'uAdaptiveGlow'), params.adaptiveGlow);
      gl.uniform3fv(uniform(program, 'uGlowColor'), hexToRgb(params.glowColor));
      gl.uniform3fv(uniform(program, 'uGlowColor2'), hexToRgb(params.glowColor2));
      gl.uniform1f(uniform(program, 'uInterior'), params.interior);
      gl.uniform3fv(uniform(program, 'uFillColor'), hexToRgb(params.fillColor));
      gl.uniform1f(uniform(program, 'uFillStrength'), params.fillStrength);
      gl.uniform1f(uniform(program, 'uRainbow'), params.rainbow);
      gl.uniform1f(uniform(program, 'uRainbowCycles'), params.rainbowCycles);
      gl.uniform1f(uniform(program, 'uGodrays'), params.godrays);
      drawFullscreen(program);
      return true;
    }

    /* --------------------------------------------------------- the artwork */

    var maskCanvas = document.createElement('canvas');
    var maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    var artwork = { image: null, mode: 'fill' };
    var worker = null;
    var workerBroken = false;
    var pending = 0;
    var queue = Promise.resolve();

    function fieldJob(payload) {
      if (!workerBroken) {
        if (!worker) worker = createFieldWorker(field);
        if (worker) {
          return new Promise(function (resolve) {
            var id = ++pending;
            var settled = false;
            var finish = function (fn) {
              if (settled) return;
              settled = true;
              clearTimeout(guard);
              worker.removeEventListener('message', onMessage);
              worker.removeEventListener('error', onError);
              resolve(fn());
            };
            var onMessage = function (event) {
              if (event.data && event.data.__id !== undefined && event.data.__id !== id) return;
              if (event.data && event.data.ok) finish(function () { return event.data.result; });
              else { workerBroken = true; finish(function () { return field.build(payload); }); }
            };
            var onError = function () {
              workerBroken = true;
              finish(function () { return field.build(payload); });
            };
            // A worker that never loads - a syntax error in the generated blob,
            // most often - fires neither message nor a rejection, so without
            // this the caller waits forever with no error anywhere.
            var guard = setTimeout(function () {
              console.warn('[halo] distance field worker timed out; running on main thread');
              onError();
            }, 15000);

            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            try {
              worker.postMessage(Object.assign({ __id: id }, payload));
            } catch (error) {
              onError();
            }
          });
        }
      }
      return Promise.resolve(field.build(payload));
    }

    function loadImage(src) {
      return new Promise(function (resolve, reject) {
        var image = new Image();
        image.onload = function () { resolve(image); };
        image.onerror = function () { reject(new Error('Could not decode the artwork image.')); };
        image.src = src;
      });
    }

    /* An artwork made only of strokes has no filled region to light, so it is
     * treated as a line and lit along its skeleton instead. */
    function detectStrokeArtwork(svgText) {
      try {
        var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        if (doc.querySelector('parsererror')) return false;
        var shapes = Array.prototype.slice.call(doc.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect'));
        if (!shapes.length) return false;
        var stroked = 0, filled = 0;
        shapes.forEach(function (el) {
          var tag = el.tagName.toLowerCase();
          var stroke = presentationOf(el, 'stroke');
          var fill = presentationOf(el, 'fill');
          if (stroke !== 'none' && stroke !== 'transparent' && stroke !== '') stroked += 1;
          if (tag !== 'line' && tag !== 'polyline' && fill !== 'none' && fill !== 'transparent' && fill !== '') filled += 1;
        });
        return stroked > 0 && filled === 0;
      } catch (error) {
        return false;
      }
    }

    function presentationOf(element, property) {
      var node = element;
      while (node && node.nodeType === 1) {
        var inline = node.getAttribute('style') || '';
        var match = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'i').exec(inline);
        if (match) return match[1].trim().toLowerCase();
        var attribute = node.getAttribute(property);
        if (attribute !== null) return attribute.trim().toLowerCase();
        node = node.parentElement;
      }
      return property === 'fill' ? 'black' : 'none';
    }

    function paintMask(fieldResolution) {
      var aspect = canvas.width / Math.max(canvas.height, 1);
      maskCanvas.width = aspect >= 1 ? fieldResolution : Math.max(2, Math.round(fieldResolution * aspect));
      maskCanvas.height = aspect >= 1 ? Math.max(2, Math.round(fieldResolution / aspect)) : fieldResolution;
      var width = maskCanvas.width, height = maskCanvas.height;

      maskContext.clearRect(0, 0, width, height);
      maskContext.save();
      maskContext.translate(width / 2, height / 2);
      maskContext.fillStyle = '#fff';
      maskContext.textAlign = 'center';
      maskContext.textBaseline = 'middle';

      var scale = source.size;
      if (artwork.image) {
        var ratio = artwork.image.naturalWidth / Math.max(artwork.image.naturalHeight, 1);
        var drawWidth = width * scale;
        var drawHeight = drawWidth / ratio;
        if (drawHeight > height * scale) { drawHeight = height * scale; drawWidth = drawHeight * ratio; }
        maskContext.drawImage(artwork.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      } else if (source.type === 'text') {
        var text = (source.text || '').trim() || 'AURA';
        var maxWidth = width * scale;
        var maxHeight = height * Math.min(scale * 0.72, 0.66);
        var fontSize = maxHeight;
        maskContext.font = (source.weight || 500) + ' ' + fontSize + 'px ' + (source.fontFamily || 'sans-serif');
        var measured = maskContext.measureText(text);
        if (measured.width > maxWidth) {
          fontSize *= maxWidth / measured.width;
          maskContext.font = (source.weight || 500) + ' ' + fontSize + 'px ' + (source.fontFamily || 'sans-serif');
        }
        var metrics = maskContext.measureText(text);
        // Nudge up: the visual centre of text sits above the font's middle.
        var optical = ((metrics.actualBoundingBoxAscent || fontSize * 0.7)
          - (metrics.actualBoundingBoxDescent || fontSize * 0.2)) * 0.04;
        maskContext.fillText(text, 0, optical);
      }
      maskContext.restore();
      return { width: width, height: height };
    }

    function applyField(result) {
      if (!result) return false;
      state.span = result.span;
      state.centre = result.centre;
      state.scale = result.scale;
      state.lineMode = result.mode === 'centreline';
      state.geometryReady = !result.empty;
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
      // The payload was flipped on write; flipping on upload would undo it.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, result.width, result.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, result.encoded);
      state.blurDirty = true;
      return true;
    }

    /* Serialised on purpose: a slider drag can outrun the worker, and running
     * two distance transforms at once on the same GL context is wasted work.
     * The leading catch is load-bearing - a chain that has already rejected
     * stays rejected forever, so one failed rebuild would hang every later
     * setSource() with no error anywhere. */
    function rebuild(fieldResolution) {
      var resolution = Math.min(maxEdge, fieldResolution || 1600);
      queue = queue.catch(function () { return null; }).then(function () {
        var size = paintMask(resolution);
        var pixels = maskContext.getImageData(0, 0, size.width, size.height).data;
        return fieldJob({
          pixels: pixels, width: size.width, height: size.height, mode: artwork.mode
        }).then(applyField);
      });
      return queue;
    }

    /* ------------------------------------------------------------ public */

    var stage = {
      canvas: canvas,
      params: params,
      palettes: Object.keys(PALETTES),
      defaults: DEFAULTS,
      usesFloatTargets: floatTargets,

      setParams: function (patch) {
        Object.assign(params, patch || {});
        return stage;
      },

      /* points: [[u, v], ...] in the same space as params.light. The path may
       * leave the 0..1 frame - that is how a light gets placed outside the
       * artwork on purpose. */
      setPath: function (points) {
        return setPath(points);
      },
      clearPath: function () { return setPath([]); },
      hasPath: function () { return pathCount >= 2; },
      pathLength: function () { return pathCount; },
      setPathPingPong: function (on) { pathPing = !!on; return stage; },

      /* Mirror of the shader's lightPosition(), so an overlay can mark where
       * the light is without having to guess at the path maths. */
      lightAt: function (seconds) {
        if (pathCount < 2) {
          if (params.drift <= 0) return params.light.slice();
          var t = seconds;
          return [
            params.light[0] + (Math.sin(t * 0.23) * 0.115 + Math.sin(t * 0.11) * 0.055) * params.drift,
            params.light[1] + (Math.cos(t * 0.19) * 0.085 + Math.cos(t * 0.07) * 0.040) * params.drift
          ];
        }
        var head = seconds * 0.06 * params.flowSpeed;
        var t = pathPing
          ? Math.abs(((head * 0.5) % 1) * 2 - 1)
          : (head % 1);
        var f = t * (pathCount - 1);
        var i = Math.floor(f);
        var j = Math.min(i + 1, pathCount - 1);
        var a = pathPoints[i], b = pathPoints[j];
        if (!a || !b) return params.light.slice();
        var mix = f - i;
        return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix];
      },
      pathPoints: function () {
        return pathPoints.map(function (p) { return p.slice(); });
      },

      /* A canvas or an <img>; anything texImage2D accepts. */
      setBackgroundImage: function (source) {
        params.background.mode = 'image';
        if (source) uploadBackground(source);
        return stage;
      },

      setSource: function (next) {
        return new Promise(function (resolve, reject) {
          var incoming = Object.assign({}, source, next || {});
          // Merging inherits the previous image, and a stale one silently wins:
          // text mode would keep painting the old artwork because paintMask
          // tests artwork.image before it ever looks at the type.
          if (incoming.type === 'text') incoming.image = null;
          if (incoming.type === 'svg' && (incoming.svgText || incoming.svgUrl) && !incoming.image) {
            var text = incoming.svgText;
            var prepare = text
              ? Promise.resolve(text)
              : fetch(incoming.svgUrl).then(function (r) {
                if (!r.ok) throw new Error('Could not load ' + incoming.svgUrl);
                return r.text();
              });
            prepare.then(function (svgText) {
              var blob = new Blob([svgText], { type: 'image/svg+xml' });
              return loadImage(URL.createObjectURL(blob)).then(function (image) {
                incoming.image = image;
                // paintMask reads artwork.image, so this is the assignment that
                // actually puts pixels in the mask.
                artwork.image = image;
                artwork.mode = incoming.mode
                  || (detectStrokeArtwork(svgText) ? 'centreline' : 'fill');
              });
            }).then(function () {
              return rebuild(incoming.fieldResolution);
            }).then(function () {
              source = incoming;
              resolve(stage);
            }).catch(reject);
            return;
          }
          source = incoming;
          artwork.image = incoming.image || null;
          artwork.mode = incoming.mode || 'fill';
          rebuild(source.fieldResolution).then(function () { resolve(stage); }, reject);
        });
      },

      /* Resize invalidates the blur chain, but not the field: the field lives
       * in its own texture at its own resolution. */
      resize: function (width, height) {
        if (canvas.width === width && canvas.height === height) return stage;
        canvas.width = width;
        canvas.height = height;
        blurSize = [0, 0];
        state.blurDirty = true;
        return stage;
      },

      rebuild: rebuild,
      draw: draw,

      /* Everything a blank canvas could be blamed on, in one object. */
      inspect: function () {
        return {
          canvas: [canvas.width, canvas.height],
          geometryReady: state.geometryReady,
          span: state.span,
          centre: state.centre.slice(),
          fieldScale: state.scale,
          lineMode: state.lineMode,
          blurTargets: blurTargets.length,
          blurSize: blurSize.slice(),
          blurDirty: state.blurDirty,
          fieldWorker: workerBroken ? 'main-thread fallback' : (worker ? 'worker' : 'unavailable'),
          lineModeSet: artwork.mode,
          light: params.light.slice(),
          position: [params.position.x, params.position.y],
          glError: gl.getError()
        };
      },

      renderer: renderer,

      toPNG: function () {
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('PNG encoding failed.'));
          }, 'image/png');
        });
      },

      destroy: function () {
        if (worker) { worker.terminate(); worker = null; }
        blurTargets.forEach(function (t) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer); });
        gl.deleteTexture(fieldTexture);
        Object.keys(programs).forEach(function (name) { gl.deleteProgram(programs[name]); });
      }
    };

    return stage;
  }

  root.HaloGlow = {
    createStage: createStage,
    STYLES: STYLES,
    SHADERS: {
      vertex: VERTEX_SOURCE,
      field: FIELD_SOURCE,
      emitter: EMITTER_SOURCE,
      blur: BLUR_SOURCE,
      composite: COMPOSITE_SOURCE
    },
    PALETTES: PALETTES,
    DEFAULTS: DEFAULTS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

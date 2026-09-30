/* Signed distance field construction.
 *
 * The optical shader needs more than an alpha mask: it needs to know how far a
 * pixel is from the nearest edge, and on which side. An alpha channel answers
 * neither, so the mask is converted to a signed field here and shipped to the
 * GPU as a single RGBA texture (rg = unsigned outward distance, ba = unsigned
 * inward distance).
 *
 * Classic script on purpose: the demo must open from file:// without a server,
 * and ES module imports are blocked there. Exposes window.HaloDistanceField.
 */
(function (root) {
  'use strict';

  var FAR = 1e6;

  /* Felzenszwalb & Huttenlocher exact 1D squared distance transform.
   * Lower envelope of parabolas: monotone scan, then a linear walk.
   * `input` is consumed in place. */
  function edt1d(input, length, output, locations, boundaries) {
    var envelope = 0;
    locations[0] = 0;
    boundaries[0] = -Infinity;
    boundaries[1] = Infinity;

    var q, previous, intersection;
    for (q = 1; q < length; q += 1) {
      for (;;) {
        previous = locations[envelope];
        intersection = ((input[q] + q * q) - (input[previous] + previous * previous)) / (2 * (q - previous));
        if (intersection > boundaries[envelope]) break;
        envelope -= 1;
      }
      envelope += 1;
      locations[envelope] = q;
      boundaries[envelope] = intersection;
      boundaries[envelope + 1] = Infinity;
    }

    envelope = 0;
    var delta;
    for (q = 0; q < length; q += 1) {
      while (boundaries[envelope + 1] < q) envelope += 1;
      delta = q - locations[envelope];
      output[q] = delta * delta + input[locations[envelope]];
    }
  }

  /* Exact squared euclidean distance to the nearest feature pixel.
   * Separable: transform every column, then every row. */
  function distanceTransform(features, width, height) {
    var count = 0;
    var i;
    for (i = 0; i < features.length; i += 1) count += features[i];
    var result = new Float32Array(width * height);
    if (count === 0) {
      result.fill(FAR);
      return result;
    }

    var intermediate = new Float32Array(width * height);
    var maxLength = Math.max(width, height);
    var input = new Float32Array(maxLength);
    var output = new Float32Array(maxLength);
    var locations = new Int32Array(maxLength);
    var boundaries = new Float64Array(maxLength + 1);

    var x, y, row, index;
    for (x = 0; x < width; x += 1) {
      for (y = 0; y < height; y += 1) input[y] = features[y * width + x] ? 0 : FAR;
      edt1d(input, height, output, locations, boundaries);
      for (y = 0; y < height; y += 1) intermediate[y * width + x] = output[y];
    }
    for (y = 0; y < height; y += 1) {
      row = y * width;
      for (x = 0; x < width; x += 1) input[x] = intermediate[row + x];
      edt1d(input, width, output, locations, boundaries);
      for (x = 0; x < width; x += 1) result[row + x] = output[x];
    }
    return result;
  }

  /* Zhang-Suen thinning of a stroke mask down to a one-pixel centreline.
   * Plain distance maxima leave gaps at tight bends, and a gapped centreline
   * makes the light break exactly where the artwork is most interesting. */
  function extractCenterline(inside, width, height) {
    var centerline = inside.slice();
    var candidates = [];
    var x, y, index;
    for (y = 1; y < height - 1; y += 1) {
      for (x = 1; x < width - 1; x += 1) {
        if (inside[y * width + x]) candidates.push(y * width + x);
      }
    }

    var scratch = new Int32Array(candidates.length);
    var iteration, pass, count, i, neighbourCount, transitions, remove;

    for (iteration = 0; iteration < Math.max(width, height); iteration += 1) {
      var changed = false;
      for (pass = 0; pass < 2; pass += 1) {
        count = 0;
        for (i = 0; i < candidates.length; i += 1) {
          index = candidates[i];
          if (!centerline[index]) continue;
          var n = centerline[index - width];
          var ne = centerline[index - width + 1];
          var e = centerline[index + 1];
          var se = centerline[index + width + 1];
          var s = centerline[index + width];
          var sw = centerline[index + width - 1];
          var w = centerline[index - 1];
          var nw = centerline[index - width - 1];

          neighbourCount = n + ne + e + se + s + sw + w + nw;
          if (neighbourCount < 2 || neighbourCount > 6) continue;

          transitions = (1 - n) * ne + (1 - ne) * e + (1 - e) * se + (1 - se) * s
            + (1 - s) * sw + (1 - sw) * w + (1 - w) * nw + (1 - nw) * n;
          if (transitions !== 1) continue;

          // Two sub-iteration guards so a stroke thins evenly instead of eroding one side.
          if (pass === 0 ? (n * e * s || e * s * w) : (n * e * w || n * s * w)) continue;
          scratch[count] = index;
          count += 1;
          remove = true;
        }
        for (i = 0; i < count; i += 1) centerline[scratch[i]] = 0;
        if (count > 0) changed = true;
      }
      if (!changed) break;
      candidates = candidates.filter(function (i2) { return centerline[i2]; });
    }
    return centerline;
  }

  /* pixels: RGBA bytes, row-major, canvas order (y down).
   * mode: 'fill'      - light the silhouette contour
   *       'centreline'- light the stroke's skeleton, one luminous ridge
   * Returns the packed field plus the geometry the shader needs to reason
   * about the shape in canvas-height units.
   *
   * Both output channels are unsigned; the sign is recovered on the GPU as
   * (outward - inward). Flipping the row order here removes the need for
   * UNPACK_FLIP_Y_WEBGL, which would also flip the distance payload.
   */
  function build(options) {
    var pixels = options.pixels;
    var width = options.width;
    var height = options.height;
    var mode = options.mode === 'centreline' ? 'centreline' : 'fill';

    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError('Distance field dimensions must be positive whole numbers.');
    }
    if (!pixels || pixels.length !== width * height * 4) {
      throw new RangeError('Distance field pixels must hold RGBA data for the requested size.');
    }

    var inside = new Uint8Array(width * height);
    var outside = new Uint8Array(width * height);
    var minX = width, minY = height, maxX = -1, maxY = -1;
    var x, y, index, covered;

    for (y = 0; y < height; y += 1) {
      for (x = 0; x < width; x += 1) {
        index = y * width + x;
        inside[index] = pixels[index * 4 + 3] >= 128 ? 1 : 0;
        outside[index] = inside[index] ? 0 : 1;
        if (!inside[index]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    var found = maxX >= minX;
    // Optics measure distance in canvas-height units. Using the short edge
    // would saturate far pixels inside the halo radius on tall canvases.
    var span = found
      ? Math.max(maxX - minX + 1, maxY - minY + 1) / Math.max(height, 1)
      : 1.0;
    var centre = found
      ? [(minX + maxX) / (2 * width), 1 - (minY + maxY) / (2 * height)]
      : [0.5, 0.5];

    var toInside = null;
    var toOutside = null;
    var toCenterline = null;
    if (mode === 'centreline') {
      toCenterline = distanceTransform(extractCenterline(inside, width, height), width, height);
    } else {
      toInside = distanceTransform(inside, width, height);
      toOutside = distanceTransform(outside, width, height);
    }

    var maxDistance = Math.max(8, height * 0.6);
    var encoded = new Uint8Array(width * height * 4);
    var outer, inner, outward, inward, target;

    for (y = 0; y < height; y += 1) {
      for (x = 0; x < width; x += 1) {
        index = y * width + x;
        // Canvas rows run top-down; GL samples v=0 at the bottom.
        target = ((height - 1 - y) * width + x) * 4;

        if (mode === 'centreline') {
          outward = Math.min(maxDistance, Math.sqrt(toCenterline[index]));
          inward = 0;
        } else if (inside[index]) {
          outward = 0;
          inward = Math.min(maxDistance, Math.max(0, Math.sqrt(toOutside[index]) - 0.5));
        } else {
          outward = Math.min(maxDistance, Math.max(0, Math.sqrt(toInside[index]) - 0.5));
          inward = 0;
        }

        // Antialiased rim pixels carry a real sub-pixel offset; re-derive it
        // from coverage so the contour does not quantise into a staircase.
        covered = pixels[index * 4 + 3] / 255;
        if (mode === 'fill' && covered > 0 && covered < 1) {
          outward = Math.max(0, 0.5 - covered);
          inward = Math.max(0, covered - 0.5);
        }

        outer = Math.round((outward / maxDistance) * 65535);
        inner = Math.round((inward / maxDistance) * 65535);
        encoded[target] = outer >> 8;
        encoded[target + 1] = outer & 255;
        encoded[target + 2] = inner >> 8;
        encoded[target + 3] = inner & 255;
      }
    }

    return {
      encoded: encoded,
      width: width,
      height: height,
      mode: mode,
      span: span,
      centre: centre,
      // GPU side: distance = decoded * scale, in canvas-height units.
      scale: maxDistance / height,
      maxDistance: maxDistance,
      empty: !found
    };
  }

  var api = { build: build, distanceTransform: distanceTransform, extractCenterline: extractCenterline, edt1d: edt1d, FAR: FAR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HaloDistanceField = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

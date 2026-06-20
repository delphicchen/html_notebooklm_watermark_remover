/* engine.js — low-level image ops + watermark reconstruction.
 *
 * Reimplements (does NOT copy) the spirit of the reference remover.py:
 *   - grayscale + local-background estimate (box blur ~ reference's medianBlur)
 *   - binary morphology (dilate / erode / close)
 *   - 8-connectivity connected components with stats
 *   - patch-heal reconstruction (clean-tile copy) with neighbour-interpolation
 *     inpaint fallback (the reference's _background_fill_from_neighbors)
 *
 * All operations work on flat typed arrays for speed. Masks are Uint8Array
 * (0 / 255). Detection (mask building) lives in detect.js and uses these ops.
 */
(function () {
  'use strict';
  var NLM = window.NLM;
  var Engine = (NLM.Engine = {});

  /* ------------------------- colour / blur -------------------------- */

  // RGBA ImageData -> Uint8 luma (Rec.601, same weights cv2 uses).
  Engine.toGray = function (imageData) {
    var d = imageData.data, n = imageData.width * imageData.height;
    var g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) | 0;
    }
    return g;
  };

  // Separable box blur (mean) — fast local-background estimate. radius in px.
  Engine.boxBlur = function (gray, w, h, radius) {
    radius = Math.max(1, radius | 0);
    var tmp = new Float32Array(w * h);
    var out = new Uint8Array(w * h);
    var win = radius * 2 + 1;
    var x, y, i, acc;
    // horizontal
    for (y = 0; y < h; y++) {
      var row = y * w;
      acc = 0;
      for (i = -radius; i <= radius; i++) acc += gray[row + Math.min(w - 1, Math.max(0, i))];
      for (x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        var add = Math.min(w - 1, x + radius + 1);
        var sub = Math.max(0, x - radius);
        acc += gray[row + add] - gray[row + sub];
      }
    }
    // vertical
    for (x = 0; x < w; x++) {
      acc = 0;
      for (i = -radius; i <= radius; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
      for (y = 0; y < h; y++) {
        out[y * w + x] = (acc / win) | 0;
        var addy = Math.min(h - 1, y + radius + 1);
        var suby = Math.max(0, y - radius);
        acc += tmp[addy * w + x] - tmp[suby * w + x];
      }
    }
    return out;
  };

  /* --------------------------- morphology --------------------------- */

  // 3x3 dilate (max) on a 0/255 mask.
  Engine.dilate = function (mask, w, h) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var on = 0;
        for (var dy = -1; dy <= 1 && !on; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            if (mask[yy * w + xx]) { on = 1; break; }
          }
        }
        out[y * w + x] = on ? 255 : 0;
      }
    }
    return out;
  };

  // 3x3 erode (min) on a 0/255 mask.
  Engine.erode = function (mask, w, h) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var keep = 1;
        for (var dy = -1; dy <= 1 && keep; dy++) {
          var yy = y + dy;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w || yy < 0 || yy >= h || !mask[yy * w + xx]) { keep = 0; break; }
          }
        }
        out[y * w + x] = keep ? 255 : 0;
      }
    }
    return out;
  };

  Engine.close = function (mask, w, h, iters) {
    var m = mask;
    for (var i = 0; i < (iters || 1); i++) m = Engine.dilate(m, w, h);
    for (i = 0; i < (iters || 1); i++) m = Engine.erode(m, w, h);
    return m;
  };

  Engine.dilateN = function (mask, w, h, iters) {
    var m = mask;
    for (var i = 0; i < (iters || 1); i++) m = Engine.dilate(m, w, h);
    return m;
  };

  /* ----------------------- connected components --------------------- */

  // 8-connectivity labelling with per-component stats. Iterative (stack) to
  // avoid recursion limits on large regions.
  Engine.connectedComponents = function (mask, w, h) {
    var labels = new Int32Array(w * h); // 0 = background / unlabelled
    var stats = [];
    var stack = new Int32Array(w * h);
    var label = 0;
    for (var start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start]) continue;
      label++;
      var sp = 0; stack[sp++] = start; labels[start] = label;
      var minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
      while (sp > 0) {
        var p = stack[--sp];
        var px = p % w, py = (p / w) | 0;
        area++;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = py + dy; if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = px + dx; if (nx < 0 || nx >= w) continue;
            var q = ny * w + nx;
            if (mask[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
          }
        }
      }
      stats.push({ label: label, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area: area });
    }
    return { numLabels: label, labels: labels, stats: stats };
  };

  // Build a 0/255 mask from a set of component labels.
  Engine.maskFromLabels = function (labels, w, h, labelSet) {
    var out = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) if (labels[i] && labelSet[labels[i]]) out[i] = 255;
    return out;
  };

  Engine.countNonZero = function (mask) {
    var c = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) c++;
    return c;
  };

  // Fill holes fully enclosed by mask pixels (e.g. the interior of a solid icon
  // or the inside of letters like o/e/b). Background reachable from the border
  // stays background; any unreached 0-pixel is an enclosed hole -> set to 255.
  Engine.fillHoles = function (mask, w, h) {
    var reach = new Uint8Array(w * h);
    var stack = [];
    function push(i) { if (!mask[i] && !reach[i]) { reach[i] = 1; stack.push(i); } }
    for (var x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      var p = stack.pop(), px = p % w, py = (p / w) | 0;
      if (px > 0) push(p - 1);
      if (px < w - 1) push(p + 1);
      if (py > 0) push(p - w);
      if (py < h - 1) push(p + w);
    }
    var out = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) out[i] = (mask[i] || !reach[i]) ? 255 : 0;
    return out;
  };

  Engine.maskBBox = function (mask, w, h) {
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };

  /* -------------------------- reconstruction ------------------------ */

  // Feather a 0/255 mask into a 0..1 float alpha with a small gaussian blur so
  // pasted/inpainted pixels blend at the edges.
  function featherMask(mask, w, h, sigma) {
    var a = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) a[i] = mask[i] ? 1 : 0;
    if (sigma <= 0) return a;
    var r = Math.max(1, Math.round(sigma * 2));
    // two-pass separable box blur approximates a gaussian well enough for a seam
    var tmp = new Float32Array(w * h), win = r * 2 + 1, x, y, acc;
    for (y = 0; y < h; y++) {
      acc = 0; var row = y * w;
      for (var k = -r; k <= r; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      for (x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (x = 0; x < w; x++) {
      acc = 0;
      for (var k2 = -r; k2 <= r; k2++) acc += tmp[Math.min(h - 1, Math.max(0, k2)) * w + x];
      for (y = 0; y < h; y++) {
        a[y * w + x] = acc / win;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return a;
  }

  // Neighbour-interpolation inpaint: fill each masked pixel by linearly
  // interpolating between the nearest known pixels on its row and column, then
  // averaging the two. Great for gradients / solid / subtle textures.
  // (Reimplementation of the reference _background_fill_from_neighbors.)
  Engine.neighborInpaint = function (imageData, mask, cfg) {
    var w = imageData.width, h = imageData.height, d = imageData.data;
    var bb = Engine.maskBBox(mask, w, h);
    if (!bb) return imageData;
    // Expand the working window beyond the mask so known background pixels
    // surround it — essential for solid masks (e.g. a manual rectangle), which
    // otherwise have no interior anchors to interpolate from.
    var ex = (cfg && cfg.inpaintExpand != null) ? cfg.inpaintExpand : 8;
    var bx1 = Math.min(w, bb.x + bb.w + ex), by1 = Math.min(h, bb.y + bb.h + ex);
    bb.x = Math.max(0, bb.x - ex); bb.y = Math.max(0, bb.y - ex);
    bb.w = bx1 - bb.x; bb.h = by1 - bb.y;
    var c;
    // horizontal estimate
    var horiz = new Float32Array((bb.w) * (bb.h) * 3);
    var vert = new Float32Array((bb.w) * (bb.h) * 3);
    var hValid = new Uint8Array(bb.w * bb.h);
    var vValid = new Uint8Array(bb.w * bb.h);
    var x, y, ch;

    // Horizontal: for each row, interpolate masked pixels between known neighbours.
    for (y = 0; y < bb.h; y++) {
      var gy2 = bb.y + y;
      for (ch = 0; ch < 3; ch++) {
        var knownXs = [];
        for (x = 0; x < bb.w; x++) {
          var gx2 = bb.x + x;
          if (!mask[gy2 * w + gx2]) knownXs.push(x);
        }
        if (knownXs.length >= 1) {
          for (var ki = 0; ki < bb.w; ki++) {
            var li = ki * 3 + ch;
            var gxk = bb.x + ki;
            if (!mask[gy2 * w + gxk]) {
              horiz[(y * bb.w + ki) * 3 + ch] = d[(gy2 * w + gxk) * 4 + ch];
              hValid[y * bb.w + ki] = 1;
            } else {
              // find neighbours in knownXs
              var lo = -1, hi = -1;
              for (var t = 0; t < knownXs.length; t++) {
                if (knownXs[t] < ki) lo = knownXs[t];
                if (knownXs[t] > ki) { hi = knownXs[t]; break; }
              }
              var val;
              if (lo >= 0 && hi >= 0) {
                var vlo = d[(gy2 * w + bb.x + lo) * 4 + ch];
                var vhi = d[(gy2 * w + bb.x + hi) * 4 + ch];
                val = vlo + (vhi - vlo) * (ki - lo) / (hi - lo);
              } else if (lo >= 0) val = d[(gy2 * w + bb.x + lo) * 4 + ch];
              else if (hi >= 0) val = d[(gy2 * w + bb.x + hi) * 4 + ch];
              else val = -1;
              if (val >= 0) { horiz[(y * bb.w + ki) * 3 + ch] = val; hValid[y * bb.w + ki] = 1; }
            }
          }
        }
      }
    }
    // Vertical:
    for (x = 0; x < bb.w; x++) {
      var gx3 = bb.x + x;
      for (ch = 0; ch < 3; ch++) {
        var knownYs = [];
        for (y = 0; y < bb.h; y++) {
          var gy3 = bb.y + y;
          if (!mask[gy3 * w + gx3]) knownYs.push(y);
        }
        if (knownYs.length >= 1) {
          for (var kj = 0; kj < bb.h; kj++) {
            var gyk = bb.y + kj;
            if (!mask[gyk * w + gx3]) {
              vert[(kj * bb.w + x) * 3 + ch] = d[(gyk * w + gx3) * 4 + ch];
              vValid[kj * bb.w + x] = 1;
            } else {
              var lo2 = -1, hi2 = -1;
              for (var t2 = 0; t2 < knownYs.length; t2++) {
                if (knownYs[t2] < kj) lo2 = knownYs[t2];
                if (knownYs[t2] > kj) { hi2 = knownYs[t2]; break; }
              }
              var val2;
              if (lo2 >= 0 && hi2 >= 0) {
                var vlo2 = d[((bb.y + lo2) * w + gx3) * 4 + ch];
                var vhi2 = d[((bb.y + hi2) * w + gx3) * 4 + ch];
                val2 = vlo2 + (vhi2 - vlo2) * (kj - lo2) / (hi2 - lo2);
              } else if (lo2 >= 0) val2 = d[((bb.y + lo2) * w + gx3) * 4 + ch];
              else if (hi2 >= 0) val2 = d[((bb.y + hi2) * w + gx3) * 4 + ch];
              else val2 = -1;
              if (val2 >= 0) { vert[(kj * bb.w + x) * 3 + ch] = val2; vValid[kj * bb.w + x] = 1; }
            }
          }
        }
      }
    }
    // blend horiz + vert over masked pixels
    for (y = 0; y < bb.h; y++) {
      var GY = bb.y + y;
      for (x = 0; x < bb.w; x++) {
        var GX = bb.x + x;
        if (!mask[GY * w + GX]) continue;
        var li2 = y * bb.w + x;
        var hv = hValid[li2], vv = vValid[li2];
        for (c = 0; c < 3; c++) {
          var hVal = horiz[(li2) * 3 + c], vVal = vert[(li2) * 3 + c];
          var out;
          if (hv && vv) out = 0.5 * hVal + 0.5 * vVal;
          else if (hv) out = hVal;
          else if (vv) out = vVal;
          else continue;
          d[(GY * w + GX) * 4 + c] = Math.max(0, Math.min(255, out)) | 0;
        }
      }
    }
    return imageData;
  };

  // Patch-heal: copy a fully-clean tile (no mask pixels) from nearby — to the
  // left of, or above, the watermark bbox — and feather it over the masked
  // pixels. Best for repeating textures (dotted paper, grain). Falls back to
  // neighbour inpaint if no clean tile is available.
  Engine.patchHeal = function (imageData, mask, cfg) {
    var w = imageData.width, h = imageData.height, d = imageData.data;
    var bb = Engine.maskBBox(mask, w, h);
    if (!bb) return imageData;
    var gap = cfg.patchGap | 0;
    // candidate source offsets: left of bbox, above bbox, and the diagonal.
    var offsets = [
      { dx: -(bb.w + gap), dy: 0 },
      { dx: 0, dy: -(bb.h + gap) },
      { dx: -(bb.w + gap), dy: -(bb.h + gap) },
      { dx: -(Math.round(bb.w * 0.5) + gap), dy: 0 }
    ];
    var src = null;
    for (var o = 0; o < offsets.length; o++) {
      var sx = bb.x + offsets[o].dx, sy = bb.y + offsets[o].dy;
      if (sx < 0 || sy < 0 || sx + bb.w > w || sy + bb.h > h) continue;
      // tile must be clean (contain no masked pixels)
      var clean = true;
      for (var yy = 0; yy < bb.h && clean; yy++)
        for (var xx = 0; xx < bb.w; xx++)
          if (mask[(sy + yy) * w + (sx + xx)]) { clean = false; break; }
      if (clean) { src = { x: sx, y: sy }; break; }
    }
    if (!src) return Engine.neighborInpaint(imageData, mask, cfg);

    // local feathered alpha over the bbox region
    var alpha = featherMask(mask, w, h, cfg.feather);
    for (var ry = 0; ry < bb.h; ry++) {
      for (var rx = 0; rx < bb.w; rx++) {
        var tx = bb.x + rx, ty = bb.y + ry;
        var a = alpha[ty * w + tx];
        if (a <= 0) continue;
        var ti = (ty * w + tx) * 4;
        var si = ((src.y + ry) * w + (src.x + rx)) * 4;
        for (var c = 0; c < 3; c++) {
          d[ti + c] = (d[ti + c] * (1 - a) + d[si + c] * a) | 0;
        }
      }
    }
    return imageData;
  };

  // Top-level reconstruction dispatcher.
  Engine.reconstruct = function (imageData, mask, cfg) {
    if (cfg.usePatchHeal) return Engine.patchHeal(imageData, mask, cfg);
    return Engine.neighborInpaint(imageData, mask, cfg);
  };
})();

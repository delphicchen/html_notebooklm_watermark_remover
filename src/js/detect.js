/* detect.js — locate the NotebookLM watermark inside a bottom-right ROI.
 *
 * Strategy (reimplemented from remover.py, adapted for browser performance):
 *   1. dark-on-light candidate extraction (gray < darkThreshold AND
 *      localBackground - gray > pixelThreshold)
 *   2. restrict to the bottom-right of the ROI (geometric bias)
 *   3. morphology + connected components with size filters
 *   4. cluster the compact bottom-right components into the watermark strip
 *      (icon + "NotebookLM"); discard large blobs that are real slide content
 *   5. optional lightweight text-template confirmation (off by default — the
 *      true cv2 template match is too slow for batch in JS)
 *
 * Returns { found, mask:Uint8Array(0/255), bbox } in ROI pixel coordinates.
 */
(function () {
  'use strict';
  var NLM = window.NLM, Engine = NLM.Engine;
  var Detect = (NLM.Detect = {});

  function darkCandidates(gray, w, h, cfg) {
    // background estimate radius ~ reference ksize/2 (clamped)
    var ksize = Math.min(41, Math.max(15, (Math.min(w, h) / 5) | 1));
    var radius = Math.max(3, (ksize - 1) >> 1);
    var bg = Engine.boxBlur(gray, w, h, radius);
    var mask = new Uint8Array(w * h);
    var x0 = (w * cfg.roiRightBias) | 0;
    var y0 = (h * cfg.roiBottomBias) | 0;
    for (var y = 0; y < h; y++) {
      if (y < y0) continue;
      for (var x = 0; x < w; x++) {
        if (x < x0) continue;
        var i = y * w + x;
        var diff = bg[i] - gray[i];
        if (gray[i] < cfg.darkTextThreshold && diff > cfg.pixelThreshold) mask[i] = 255;
      }
    }
    return mask;
  }

  Detect.buildMask = function (roiImageData, cfg) {
    var w = roiImageData.width, h = roiImageData.height;
    if (w < 20 || h < 10) return { found: false };

    var gray = Engine.toGray(roiImageData);
    var cand = darkCandidates(gray, w, h, cfg);

    // morphology: close gaps then dilate slightly
    cand = Engine.close(cand, w, h, cfg.closeIterations);
    cand = Engine.dilateN(cand, w, h, 1);

    var cc = Engine.connectedComponents(cand, w, h);
    if (!cc.stats.length) return { found: false };

    var maxArea = (w * h) * cfg.maxComponentAreaRatio;
    var kept = cc.stats.filter(function (s) {
      if (s.area < cfg.minComponentArea) return false;     // noise
      if (s.area > maxArea) return false;                  // huge blob
      if (s.h > h * 0.85 || s.w > w * 0.95) return false;  // full-height/width = slide content
      return true;
    });
    if (!kept.length) return { found: false };

    // Optional text-template confirmation / anchoring.
    var anchorBand = null;
    if (cfg.useTemplateMatch) {
      var tm = Detect.matchText(gray, w, h, cfg);
      if (!tm || tm.score < cfg.textMatchThreshold) return { found: false };
      anchorBand = { cy: tm.y + tm.h / 2, half: Math.max(tm.h, 18) };
    }

    // Keep components forming the bottom-right strip. If we have a text anchor,
    // keep those vertically near it; otherwise keep all surviving compact comps.
    var labelSet = {};
    var selected = 0;
    kept.forEach(function (s) {
      var cy = s.y + s.h / 2;
      if (anchorBand && Math.abs(cy - anchorBand.cy) > anchorBand.half * 1.6) return;
      labelSet[s.label] = true; selected++;
    });
    if (!selected) return { found: false };

    var mask = Engine.maskFromLabels(cc.labels, w, h, labelSet);
    if (Engine.countNonZero(mask) < cfg.minWatermarkArea) return { found: false };

    // fill enclosed holes (solid-icon interior, letter holes) that the
    // local-background subtraction misses, then grow to cover AA edges
    mask = Engine.fillHoles(mask, w, h);
    mask = Engine.dilateN(mask, w, h, cfg.dilateIterations);

    return { found: true, mask: mask, bbox: Engine.maskBBox(mask, w, h) };
  };

  /* ----------------- optional lightweight text matcher ---------------- */

  var _tplCache = {};
  function renderTemplate(textHeight) {
    var key = Math.max(10, textHeight | 0);
    if (_tplCache[key]) return _tplCache[key];
    var fontPx = Math.max(12, Math.round(key * 1.25));
    var c = NLM.canvas(fontPx * 9, Math.round(fontPx * 1.8));
    var ctx = NLM.ctxOf(c);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000';
    ctx.font = '600 ' + fontPx + 'px Arial, "Helvetica Neue", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('NotebookLM', 2, 2);
    var img = ctx.getImageData(0, 0, c.width, c.height);
    // tight crop of the dark glyphs into a 0/1 template
    var minX = c.width, minY = c.height, maxX = 0, maxY = 0, d = img.data;
    for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4] < 128) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX) { _tplCache[key] = { w: 0, h: 0, data: new Uint8Array(0) }; return _tplCache[key]; }
    var tw = maxX - minX + 1, th = maxY - minY + 1;
    var t = new Uint8Array(tw * th);
    for (var ty = 0; ty < th; ty++) for (var tx = 0; tx < tw; tx++) {
      t[ty * tw + tx] = d[((minY + ty) * c.width + (minX + tx)) * 4] < 128 ? 1 : 0;
    }
    _tplCache[key] = { w: tw, h: th, data: t };
    return _tplCache[key];
  }

  // Normalised cross-correlation of a binary template against ROI "darkness"
  // (255 - gray), evaluated on a downscaled grid for speed. Coarse but enough
  // to gate presence. Returns best { x, y, w, h, score } in ROI coords or null.
  Detect.matchText = function (gray, w, h, cfg) {
    // downscale darkness map to a manageable width
    var maxW = 240;
    var sf = Math.min(1, maxW / w);
    var sw = Math.max(20, Math.round(w * sf)), sh = Math.max(10, Math.round(h * sf));
    var dark = new Float32Array(sw * sh);
    for (var y = 0; y < sh; y++) for (var x = 0; x < sw; x++) {
      var gx = Math.min(w - 1, (x / sf) | 0), gy = Math.min(h - 1, (y / sf) | 0);
      dark[y * sw + x] = 255 - gray[gy * w + gx];
    }
    var best = null;
    var hMin = Math.max(8, (sh / 6) | 0), hMax = Math.max(hMin + 2, (sh / 2) | 0);
    for (var th = hMin; th <= hMax; th += Math.max(2, (th / 6) | 0)) {
      var tpl = renderTemplate(Math.round(th / sf));
      if (!tpl.w) continue;
      // scale template to th
      var scale = th / tpl.h, tw = Math.max(8, Math.round(tpl.w * scale));
      if (tw >= sw || th >= sh) continue;
      var T = new Float32Array(tw * th), tsum = 0, tcount = tw * th;
      for (var iy = 0; iy < th; iy++) for (var ix = 0; ix < tw; ix++) {
        var sxv = Math.min(tpl.w - 1, (ix / scale) | 0), syv = Math.min(tpl.h - 1, (iy / scale) | 0);
        var v = tpl.data[syv * tpl.w + sxv]; T[iy * tw + ix] = v; tsum += v;
      }
      var tmean = tsum / tcount, tnorm = 0;
      for (var k = 0; k < tcount; k++) { T[k] -= tmean; tnorm += T[k] * T[k]; }
      tnorm = Math.sqrt(tnorm) || 1;
      var step = 2;
      for (var py = 0; py + th <= sh; py += step) {
        for (var px = 0; px + tw <= sw; px += step) {
          var imean = 0;
          for (var yy = 0; yy < th; yy++) for (var xx = 0; xx < tw; xx++) imean += dark[(py + yy) * sw + (px + xx)];
          imean /= tcount;
          var num = 0, inorm = 0;
          for (var yy2 = 0; yy2 < th; yy2++) for (var xx2 = 0; xx2 < tw; xx2++) {
            var iv = dark[(py + yy2) * sw + (px + xx2)] - imean;
            num += iv * T[yy2 * tw + xx2]; inorm += iv * iv;
          }
          var score = num / (tnorm * (Math.sqrt(inorm) || 1));
          if (!best || score > best.score) {
            best = { score: score, x: px / sf, y: py / sf, w: tw / sf, h: th / sf };
          }
        }
      }
    }
    return best;
  };
})();

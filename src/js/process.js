/* process.js — orchestration shared by the image / pptx / pdf handlers.
 *
 * Mirrors the reference flow: take the bottom-right corner, upscale it so the
 * mark is large enough to detect (reference renders/upscales 3.5x), build the
 * mask, reconstruct, downscale back, composite into the original. RGB only is
 * written back so any alpha channel is preserved.
 */
(function () {
  'use strict';
  var NLM = window.NLM, Engine = NLM.Engine, Detect = NLM.Detect;
  var Process = (NLM.Process = {});

  // Detect + reconstruct inside a small ROI, working at `upscale` for detection.
  Process.cleanRoiScaled = function (roi, cfg) {
    var scale = cfg.upscale || 1;
    var hrW = Math.max(1, Math.round(roi.width * scale));
    var hrH = Math.max(1, Math.round(roi.height * scale));
    var hr = scale === 1 ? NLM.cloneImageData(roi) : NLM.resizeImageData(roi, hrW, hrH, true);
    var det = Detect.buildMask(hr, cfg);
    if (!det.found) return { found: false, imageData: roi, mask: null };
    Engine.reconstruct(hr, det.mask, cfg);
    var back = scale === 1 ? hr : NLM.resizeImageData(hr, roi.width, roi.height, true);
    return { found: true, imageData: back, bbox: det.bbox };
  };

  // Clean the bottom-right corner of a full image. Returns the cleaned copy and
  // whether a watermark was found (original returned unchanged if not).
  Process.cleanFullImage = function (full, cfg) {
    var w = full.width, h = full.height;
    var mx = Math.min(w, cfg.searchMarginX), my = Math.min(h, cfg.searchMarginY);
    var x0 = Math.max(0, w - mx), y0 = Math.max(0, h - my);
    var roi = NLM.cropImageData(full, x0, y0, w - x0, h - y0);
    var res = Process.cleanRoiScaled(roi, cfg);
    if (!res.found) return { found: false, imageData: full };
    var out = NLM.cloneImageData(full);
    NLM.pasteImageData(out, res.imageData, x0, y0);
    return { found: true, imageData: out };
  };

  // Manual mode: reconstruct using a user-supplied full-resolution mask.
  Process.cleanWithUserMask = function (full, mask, cfg) {
    var out = NLM.cloneImageData(full);
    Engine.reconstruct(out, mask, cfg);
    return { found: true, imageData: out };
  };

  // Rasterize a resolution-independent manual spec (normalized 0..1 shapes:
  // rectangles and brush dots) into a 0/255 mask at the target resolution.
  // Lets one set of strokes apply to images and to every page/media of a doc.
  Process.maskFromSpec = function (spec, w, h) {
    var mask = new Uint8Array(w * h);
    var shapes = (spec && spec.shapes) || [];
    shapes.forEach(function (s) {
      if (s.type === 'rect') {
        var x0 = Math.max(0, Math.floor(s.x * w)), y0 = Math.max(0, Math.floor(s.y * h));
        var x1 = Math.min(w, Math.ceil((s.x + s.w) * w)), y1 = Math.min(h, Math.ceil((s.y + s.h) * h));
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) mask[y * w + x] = 255;
      } else if (s.type === 'dot') {
        var cx = s.x * w, cy = s.y * h, r = s.r * Math.min(w, h);
        var rx0 = Math.max(0, Math.floor(cx - r)), ry0 = Math.max(0, Math.floor(cy - r));
        var rx1 = Math.min(w, Math.ceil(cx + r)), ry1 = Math.min(h, Math.ceil(cy + r));
        for (var yy = ry0; yy < ry1; yy++) for (var xx = rx0; xx < rx1; xx++) {
          var ddx = xx - cx, ddy = yy - cy;
          if (ddx * ddx + ddy * ddy <= r * r) mask[yy * w + xx] = 255;
        }
      }
    });
    return mask;
  };

  Process.specHasShapes = function (spec) {
    return !!(spec && spec.shapes && spec.shapes.length);
  };
})();

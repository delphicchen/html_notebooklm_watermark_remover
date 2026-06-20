/* core.js — NLM namespace, tiny event bus, config, canvas/image/download helpers.
 *
 * Offline IIFE + global-namespace pattern (no import/export, no fetch) so the
 * built single file runs from file:// with no server. Everything hangs off the
 * global `NLM` object. Other modules extend it (NLM.Engine, NLM.Detect, ...).
 */
(function () {
  'use strict';

  var NLM = (window.NLM = window.NLM || {});

  /* ----------------------------- event bus ----------------------------- */
  // Minimal pub/sub used to decouple the UI from the processing modules.
  NLM.bus = (function () {
    var map = {};
    return {
      on: function (evt, fn) {
        (map[evt] = map[evt] || []).push(fn);
        return function () {
          map[evt] = (map[evt] || []).filter(function (f) { return f !== fn; });
        };
      },
      emit: function (evt, payload) {
        (map[evt] || []).forEach(function (fn) {
          try { fn(payload); } catch (e) { console.error('[NLM.bus]', evt, e); }
        });
      }
    };
  })();

  /* ----------------------------- config -------------------------------- */
  // Defaults mirror the reference remover.py (search margins, thresholds, scale).
  // All are surfaced in the UI "advanced" panel.
  NLM.defaultConfig = function () {
    return {
      // bottom-right ROI taken from the full image, in source pixels
      searchMarginX: 400,
      searchMarginY: 120,
      // padding added around a detected watermark bbox before reconstruction
      watermarkPadding: 6,
      // dark-on-light candidate extraction
      pixelThreshold: 22,      // (localBackground - gray) must exceed this
      darkTextThreshold: 210,  // gray must be below this to count as "ink"
      // restrict candidates to the bottom-right of the ROI (reduce false hits).
      // Kept permissive so the icon left of the text is not clipped; compactness
      // + area filters and (optional) template matching guard against false hits.
      roiRightBias: 0.28,
      roiBottomBias: 0.28,
      // detection upscale (helps small marks); reference renders/upscales 3.5x
      upscale: 3.5,
      // connected-component filters (areas are in upscaled pixels)
      minComponentArea: 18,
      maxComponentAreaRatio: 0.25,
      minWatermarkArea: 400,
      // morphology (dilate grows the mask to swallow anti-aliased glyph halos)
      dilateIterations: 3,
      closeIterations: 1,
      // reconstruction — neighbour interpolation is seamless on the smooth
      // gradient / solid backgrounds NotebookLM uses; patch-heal (opt-in) suits
      // repeating textures (dotted paper, grain) but can leave a tile seam.
      usePatchHeal: false,
      inpaintExpand: 8,        // grow the inpaint window past the mask for anchors
      patchGap: 10,            // gap between watermark bbox and the clean source tile
      feather: 1.5,            // gaussian feather (px) on the heal seam
      // optional, slower text-template confirmation of presence
      useTemplateMatch: false,
      textMatchThreshold: 0.42
    };
  };

  /* --------------------------- canvas helpers -------------------------- */
  NLM.canvas = function (w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  NLM.ctxOf = function (canvas) {
    return canvas.getContext('2d', { willReadFrequently: true });
  };

  // Decode a Blob/File into an ImageData (RGBA) at native resolution.
  NLM.blobToImageData = function (blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var c = NLM.canvas(img.naturalWidth, img.naturalHeight);
          var ctx = NLM.ctxOf(c);
          ctx.drawImage(img, 0, 0);
          var data = ctx.getImageData(0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(data);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  };

  // ImageData -> Blob of the requested mime ("image/png" | "image/jpeg" | "image/webp").
  NLM.imageDataToBlob = function (imageData, mime, quality) {
    var c = NLM.canvas(imageData.width, imageData.height);
    NLM.ctxOf(c).putImageData(imageData, 0, 0);
    return new Promise(function (resolve) {
      if (c.toBlob) {
        c.toBlob(function (b) { resolve(b); }, mime || 'image/png', quality);
      } else {
        // very old fallback
        var bin = atob(c.toDataURL(mime || 'image/png', quality).split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: mime || 'image/png' }));
      }
    });
  };

  // Copy an ImageData (independent backing buffer).
  NLM.cloneImageData = function (src) {
    var out = new ImageData(src.width, src.height);
    out.data.set(src.data);
    return out;
  };

  // Extract a sub-rectangle as a new ImageData.
  NLM.cropImageData = function (src, x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.min(src.width - x, Math.floor(w));
    h = Math.min(src.height - y, Math.floor(h));
    var out = new ImageData(w, h);
    var sd = src.data, od = out.data, sw = src.width;
    for (var row = 0; row < h; row++) {
      var so = ((y + row) * sw + x) * 4;
      var oo = row * w * 4;
      od.set(sd.subarray(so, so + w * 4), oo);
    }
    return out;
  };

  // Paste `patch` ImageData into `dst` at (x,y), overwriting RGB (keeps dst alpha
  // where patch alpha is 255; otherwise blends nothing — patches here are opaque).
  NLM.pasteImageData = function (dst, patch, x, y) {
    x = Math.floor(x); y = Math.floor(y);
    var dd = dst.data, pd = patch.data, dw = dst.width;
    for (var row = 0; row < patch.height; row++) {
      var dy = y + row; if (dy < 0 || dy >= dst.height) continue;
      for (var col = 0; col < patch.width; col++) {
        var dx = x + col; if (dx < 0 || dx >= dst.width) continue;
        var di = (dy * dw + dx) * 4, pi = (row * patch.width + col) * 4;
        dd[di] = pd[pi]; dd[di + 1] = pd[pi + 1]; dd[di + 2] = pd[pi + 2];
        // preserve destination alpha
      }
    }
  };

  // Nearest/bilinear resize of an ImageData via canvas (browser does the sampling).
  NLM.resizeImageData = function (src, w, h, smooth) {
    var s = NLM.canvas(src.width, src.height);
    NLM.ctxOf(s).putImageData(src, 0, 0);
    var d = NLM.canvas(w, h);
    var dctx = NLM.ctxOf(d);
    dctx.imageSmoothingEnabled = smooth !== false;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(s, 0, 0, src.width, src.height, 0, 0, w, h);
    return dctx.getImageData(0, 0, w, h);
  };

  NLM.imageDataToCanvas = function (imageData) {
    var c = NLM.canvas(imageData.width, imageData.height);
    NLM.ctxOf(c).putImageData(imageData, 0, 0);
    return c;
  };

  /* --------------------------- misc helpers --------------------------- */
  NLM.extOf = function (name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  };

  NLM.withSuffix = function (name, suffix) {
    var i = name.lastIndexOf('.');
    if (i < 0) return name + suffix;
    return name.slice(0, i) + suffix + name.slice(i);
  };

  NLM.mimeForExt = function (ext) {
    switch (ext) {
      case 'jpg': case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'png': default: return 'image/png';
    }
  };

  NLM.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  };

  NLM.fmtBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  };
})();

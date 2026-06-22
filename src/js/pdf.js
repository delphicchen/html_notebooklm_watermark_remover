/* pdf.js — PDF handler.
 *
 * Mirrors the reference philosophy: clean the bottom-right corner and leave the
 * rest of the document intact. To get a clean reconstruction we render a
 * *generous* corner (plenty of surrounding background — like the image path),
 * detect + reconstruct there, then overlay only the **tight watermark bbox**
 * back onto the page so we overwrite as little of the PDF as possible.
 *
 *   pdf.js (pdfjsLib)  -> render the corner at hi-res
 *   pdf-lib (PDFLib)   -> embed the cleaned patch and draw it over the page
 *
 * Worker is configured in app.js (GlobalWorkerOptions.workerSrc = blob URL).
 */
(function () {
  'use strict';
  var NLM = window.NLM, Process = NLM.Process, Detect = NLM.Detect, Engine = NLM.Engine;
  var Handler = (NLM.PdfHandler = {});

  function readBytes(file) {
    return file.arrayBuffer ? file.arrayBuffer() : new Response(file).arrayBuffer();
  }

  function renderPage(page, scale) {
    var viewport = page.getViewport({ scale: scale });
    var canvas = NLM.canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    var ctx = NLM.ctxOf(canvas);
    return page.render({ canvasContext: ctx, viewport: viewport }).promise
      .then(function () { return { canvas: canvas, ctx: ctx, viewport: viewport }; });
  }

  // Crop a user-space rect { x0,y0(bottom),x1,y1(top) } out of a rendered page.
  function cropRect(render, rect) {
    var p0 = render.viewport.convertToViewportPoint(rect.x0, rect.y1); // top-left (device)
    var p1 = render.viewport.convertToViewportPoint(rect.x1, rect.y0); // bottom-right
    var x = Math.round(Math.min(p0[0], p1[0])), y = Math.round(Math.min(p0[1], p1[1]));
    var w = Math.round(Math.abs(p1[0] - p0[0])), h = Math.round(Math.abs(p1[1] - p0[1]));
    return { imageData: render.ctx.getImageData(x, y, w, h), dx: x, dy: y };
  }

  // Union (normalized, top-left, y-down) bbox of manual shapes, padded.
  function shapesBBoxNorm(shapes, pad) {
    var x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    shapes.forEach(function (s) {
      var a = s.type === 'dot' ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : [s.x, s.y, s.x + s.w, s.y + s.h];
      x0 = Math.min(x0, a[0]); y0 = Math.min(y0, a[1]); x1 = Math.max(x1, a[2]); y1 = Math.max(y1, a[3]);
    });
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
    return { x: x0, y: y0, w: Math.max(0.001, x1 - x0), h: Math.max(0.001, y1 - y0) };
  }

  Handler.representative = function (file) {
    return readBytes(file).then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    }).then(function (doc) {
      return doc.getPage(1).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var scale = Math.max(0.5, Math.min(2, 1000 / Math.max(base.width, base.height)));
        return renderPage(page, scale).then(function (r) {
          var img = r.ctx.getImageData(0, 0, r.canvas.width, r.canvas.height);
          return { imageData: img, width: img.width, height: img.height, label: file.name + ' (p.1)' };
        });
      });
    });
  };

  Handler.process = function (file, cfg, manualSpec, onProgress) {
    var manual = Process.specHasShapes(manualSpec);
    var origBytes;
    return readBytes(file).then(function (buf) {
      origBytes = buf;
      return Promise.all([
        pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise,
        PDFLib.PDFDocument.load(buf.slice(0))
      ]);
    }).then(function (both) {
      var doc = both[0], libDoc = both[1];
      var pageCount = doc.numPages, patched = 0;
      var preview = { before: null, after: null };
      var chain = Promise.resolve();

      for (var p = 1; p <= pageCount; p++) {
        (function (pageNum) {
          chain = chain.then(function () { return doc.getPage(pageNum); }).then(function (page) {
            var view = page.view, mbx0 = view[0], mby0 = view[1];
            var W = view[2] - view[0], H = view[3] - view[1];
            var scale = Math.min(cfg.upscale, 4000 / Math.max(W, H));

            // region to render (user coords, y0=bottom, y1=top) + how to mask it
            var regionNorm, region;
            if (manual) {
              regionNorm = shapesBBoxNorm(manualSpec.shapes, 0.06);
            } else {
              var cw = Math.min(1, Math.max(0.5, 240 / W));
              var chh = Math.min(1, Math.max(0.16, 80 / H));
              regionNorm = { x: 1 - cw, y: 1 - chh, w: cw, h: chh };
            }
            region = {
              x0: mbx0 + regionNorm.x * W,
              x1: mbx0 + (regionNorm.x + regionNorm.w) * W,
              y1: mby0 + (1 - regionNorm.y) * H,                 // top
              y0: mby0 + (1 - (regionNorm.y + regionNorm.h)) * H // bottom
            };

            return renderPage(page, scale).then(function (r) {
              var crop = cropRect(r, region), roi = crop.imageData;
              if (roi.width < 6 || roi.height < 6) return false;

              var mask;
              if (manual) {
                var local = manualSpec.shapes.map(function (s) {
                  var o = { type: s.type, x: (s.x - regionNorm.x) / regionNorm.w, y: (s.y - regionNorm.y) / regionNorm.h };
                  if (s.type === 'rect') { o.w = s.w / regionNorm.w; o.h = s.h / regionNorm.h; }
                  else { o.r = s.r / Math.max(regionNorm.w, regionNorm.h); }
                  return o;
                });
                mask = Process.maskFromSpec({ shapes: local }, roi.width, roi.height);
              } else {
                var det = Detect.buildMask(roi, cfg);
                if (!det.found) return false;
                mask = det.mask;
              }

              Engine.reconstruct(roi, mask, cfg);
              var mb = Engine.maskBBox(mask, roi.width, roi.height);
              if (!mb) return false;
              var pad = Math.round(Math.max(roi.width, roi.height) * 0.012) + 2;
              var sx = Math.max(0, mb.x - pad), sy = Math.max(0, mb.y - pad);
              var sw = Math.min(roi.width - sx, mb.w + 2 * pad), sh = Math.min(roi.height - sy, mb.h + 2 * pad);
              var sub = NLM.cropImageData(roi, sx, sy, sw, sh);

              if (pageNum === 1 && !preview.before) {
                var beforeImg = r.ctx.getImageData(0, 0, r.canvas.width, r.canvas.height);
                preview.before = NLM.imageDataToCanvas(beforeImg);
                var aft = NLM.cloneImageData(beforeImg);
                NLM.pasteImageData(aft, sub, crop.dx + sx, crop.dy + sy);
                preview.after = NLM.imageDataToCanvas(aft);
              }

              // map the sub-rect (roi pixels, y-down) back to user coords (y-up)
              var ux0 = region.x0 + (sx / roi.width) * (region.x1 - region.x0);
              var ux1 = region.x0 + ((sx + sw) / roi.width) * (region.x1 - region.x0);
              var uyTop = region.y1 - (sy / roi.height) * (region.y1 - region.y0);
              var uyBot = region.y1 - ((sy + sh) / roi.height) * (region.y1 - region.y0);

              return NLM.imageDataToBlob(sub, 'image/png')
                .then(function (b) { return b.arrayBuffer(); })
                .then(function (pngBuf) { return libDoc.embedPng(pngBuf); })
                .then(function (png) {
                  libDoc.getPage(pageNum - 1).drawImage(png, {
                    x: ux0 - mbx0, y: uyBot - mby0, width: ux1 - ux0, height: uyTop - uyBot
                  });
                  return true;
                });
            }).then(function (ok) {
              if (ok) patched++;
              if (onProgress) onProgress(pageNum, pageCount);
            });
          });
        })(p);
      }

      return chain.then(function () {
        if (!manual && patched === 0) {
          return result(new Blob([origBytes], { type: 'application/pdf' }), false, 'noWatermark', null);
        }
        return libDoc.save().then(function (out) {
          return result(new Blob([out], { type: 'application/pdf' }), patched > 0,
            'pdfCleaned', { n: patched, t: pageCount });
        });
      });

      function result(blob, found, messageKey, messageParams) {
        return {
          ok: true, found: found, kind: 'pdf',
          name: NLM.withSuffix(file.name, '_cleaned'),
          blob: blob, mime: 'application/pdf', pageCount: pageCount,
          previewBefore: preview.before, previewAfter: preview.after,
          messageKey: messageKey, messageParams: messageParams
        };
      }
    });
  };
})();

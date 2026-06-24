/* pptx.js — PowerPoint (.pptx) handler.
 *
 * A .pptx is a zip; NotebookLM bakes the watermark into the slide images under
 * ppt/media/. We unzip with JSZip, clean every media bitmap (same engine as the
 * image handler), write them back, and rezip. Non-media parts are untouched.
 */
(function () {
  'use strict';
  var NLM = window.NLM, Process = NLM.Process;
  var MEDIA_RE = /^ppt\/media\/.+\.(png|jpe?g|webp)$/i;
  var PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  var Handler = (NLM.PptxHandler = {});

  function mediaEntries(zip) {
    var names = [];
    zip.forEach(function (path, entry) {
      if (!entry.dir && MEDIA_RE.test(path)) names.push(path);
    });
    names.sort();
    return names;
  }

  // Representative image for the manual editor: the largest media bitmap.
  Handler.representative = function (file) {
    return JSZip.loadAsync(file).then(function (zip) {
      var names = mediaEntries(zip);
      if (!names.length) throw new Error('PPTX 內找不到圖片 · no media images');
      // decode each, keep the biggest by pixel area
      var best = null;
      var chain = Promise.resolve();
      names.forEach(function (name) {
        chain = chain.then(function () {
          return zip.file(name).async('blob').then(function (b) {
            return NLM.blobToImageData(b).then(function (img) {
              if (!best || img.width * img.height > best.imageData.width * best.imageData.height) {
                best = { imageData: img, width: img.width, height: img.height, label: name };
              }
            }, function () { /* skip undecodable */ });
          });
        });
      });
      return chain.then(function () {
        if (!best) throw new Error('PPTX 內圖片無法解碼 · media not decodable');
        return best;
      });
    });
  };

  Handler.process = function (file, cfg, manualSpec, onProgress) {
    var preview = { before: null, after: null, foundPage: false };
    return JSZip.loadAsync(file).then(function (zip) {
      var names = mediaEntries(zip);
      if (!names.length) throw new Error('PPTX 內找不到圖片 · no media images');
      var patched = 0, processed = 0;
      var chain = Promise.resolve();

      names.forEach(function (name) {
        chain = chain.then(function () {
          var ext = NLM.extOf(name);
          var mime = NLM.mimeForExt(ext);
          return zip.file(name).async('blob')
            .then(function (b) { return NLM.blobToImageData(b); })
            .then(function (img) {
              // Always capture the first decodable image as a baseline preview
              if (!preview.before) {
                preview.before = NLM.imageDataToCanvas(img);
                preview.after = NLM.imageDataToCanvas(img);
              }
              var res, found;
              if (Process.specHasShapes(manualSpec)) {
                var mask = Process.maskFromSpec(manualSpec, img.width, img.height);
                res = Process.cleanWithUserMask(img, mask, cfg); found = true;
              } else {
                res = Process.cleanFullImage(img, cfg); found = res.found;
              }
              processed++;
              if (onProgress) onProgress(processed, names.length);
              if (!found) return;            // leave original media untouched
              patched++;
              var outData = res.imageData;
              if (!preview.foundPage) {      // capture first cleaned image as preview
                preview.before = NLM.imageDataToCanvas(img);
                preview.after = NLM.imageDataToCanvas(outData);
                preview.foundPage = true;
              }
              var q = (mime === 'image/jpeg' || mime === 'image/webp') ? 0.95 : undefined;
              return NLM.imageDataToBlob(outData, mime, q).then(function (blob) {
                zip.file(name, blob);
              });
            }, function () { processed++; if (onProgress) onProgress(processed, names.length); });
        });
      });

      return chain.then(function () {
        return zip.generateAsync({ type: 'blob', mimeType: PPTX_MIME, compression: 'DEFLATE' })
          .then(function (blob) {
            return {
              ok: true, found: patched > 0, kind: 'pptx',
              name: NLM.withSuffix(file.name, '_cleaned'),
              blob: blob, mime: PPTX_MIME, pageCount: names.length,
              previewBefore: preview.before, previewAfter: preview.after,
              messageKey: patched > 0 ? 'pptxCleaned' : 'noWatermark',
              messageParams: patched > 0 ? { n: patched, t: names.length } : null
            };
          });
      });
    });
  };
})();

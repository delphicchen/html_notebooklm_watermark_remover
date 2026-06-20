/* image.js — PNG / JPG / JPEG / WEBP handler.
 *
 * Loads the bitmap to a canvas, cleans the bottom-right corner (auto) or applies
 * a manual mask, and re-encodes to the original format. Destination alpha is
 * preserved (Process writes RGB only).
 */
(function () {
  'use strict';
  var NLM = window.NLM, Process = NLM.Process;

  function outMime(file) { return NLM.mimeForExt(NLM.extOf(file.name) || 'png'); }

  var Handler = (NLM.ImageHandler = {});

  // Representative image to draw a manual mask on (the image itself).
  Handler.representative = function (file) {
    return NLM.blobToImageData(file).then(function (img) {
      return { imageData: img, width: img.width, height: img.height, label: file.name };
    });
  };

  // Process one file. `manualSpec` (optional) carries normalized manual shapes;
  // when present we skip auto-detection and reconstruct that region instead.
  Handler.process = function (file, cfg, manualSpec) {
    return NLM.blobToImageData(file).then(function (img) {
      var res, found, message = '';
      if (Process.specHasShapes(manualSpec)) {
        var mask = Process.maskFromSpec(manualSpec, img.width, img.height);
        res = Process.cleanWithUserMask(img, mask, cfg);
        found = true;
      } else {
        res = Process.cleanFullImage(img, cfg);
        found = res.found;
        if (!found) message = '未偵測到浮水印 · no watermark detected';
      }
      var outData = res.found ? res.imageData : img;
      var mime = outMime(file);
      var q = mime === 'image/jpeg' || mime === 'image/webp' ? 0.95 : undefined;
      return NLM.imageDataToBlob(outData, mime, q).then(function (blob) {
        return {
          ok: true, found: found, kind: 'image',
          name: NLM.withSuffix(file.name, '_cleaned'),
          blob: blob, mime: mime, pageCount: 1,
          previewBefore: NLM.imageDataToCanvas(img),
          previewAfter: NLM.imageDataToCanvas(outData),
          message: message
        };
      });
    });
  };
})();

/* app.js — bootstrap. Configures the pdf.js worker and starts the UI.
 *
 * In the built single file, build.py injects window.__NLM_PDF_WORKER_B64__ (the
 * pdf.worker source, base64). We turn it into a Blob URL so pdf.js has a worker
 * with zero external files on file://. Unbuilt, we fall back to vendor/.
 */
(function () {
  'use strict';
  var NLM = window.NLM;

  function setupPdfWorker() {
    if (!window.pdfjsLib) return;
    try {
      var b64 = window.__NLM_PDF_WORKER_B64__;
      if (b64) {
        var bin = atob(b64), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([arr], { type: 'application/javascript' }));
        pdfjsLib.GlobalWorkerOptions.workerSrc = url;
      } else {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      }
    } catch (e) {
      console.warn('[NLM] pdf.js worker setup failed; pdf.js will run on the main thread', e);
    }
  }

  function boot() {
    setupPdfWorker();
    NLM.UI.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

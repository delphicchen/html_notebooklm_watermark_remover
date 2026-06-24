/* ui.js — drag & drop batch UI, large side-by-side preview, manual toggle, downloads.
 *
 * Wires the static markup in index.template.html. Keeps a small queue of files,
 * routes each to its handler (image / pptx / pdf), shows a large before/after
 * comparison for the selected item, and lets the user download individually or
 * as a zip. All user-facing strings go through NLM.t() and re-render on the
 * `lang` bus event (中文 / English toggle).
 *
 * On file load, a representative preview is generated immediately so users can
 * see the original image before any processing. After processing, the preview
 * upgrades to a side-by-side before/after comparison.
 */
(function () {
  'use strict';
  var NLM = window.NLM;
  var UI = (NLM.UI = {});

  var SUPPORTED = { png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', pdf: 'pdf', pptx: 'pptx' };
  var HANDLERS = {
    image: function () { return NLM.ImageHandler; },
    pdf: function () { return NLM.PdfHandler; },
    pptx: function () { return NLM.PptxHandler; }
  };
  var BADGE_KEY = { image: 'badgeImage', pdf: 'badgePdf', pptx: 'badgePptx' };
  function badge(kind) { return NLM.t(BADGE_KEY[kind]); }

  var queue = [];
  var seq = 0;
  var selectedId = null;
  var $ = function (id) { return document.getElementById(id); };
  function find(id) { for (var i = 0; i < queue.length; i++) if (queue[i].id === id) return queue[i]; return null; }

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'data') Object.keys(attrs.data).forEach(function (d) { n.dataset[d] = attrs.data[d]; });
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function stop(fn) { return function (e) { if (e && e.stopPropagation) e.stopPropagation(); return fn(e); }; }

  function thumb(canvas, maxW) {
    if (!canvas) return null;
    var r = Math.min(1, maxW / canvas.width);
    var c = NLM.canvas(Math.round(canvas.width * r), Math.round(canvas.height * r));
    var ctx = NLM.ctxOf(c); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  function readConfig() {
    var c = NLM.defaultConfig();
    var num = function (id, key) { var v = parseFloat($(id).value); if (!isNaN(v)) c[key] = v; };
    num('cfg-marginX', 'searchMarginX'); num('cfg-marginY', 'searchMarginY');
    num('cfg-pixel', 'pixelThreshold'); num('cfg-dark', 'darkTextThreshold');
    num('cfg-upscale', 'upscale');
    c.usePatchHeal = $('cfg-patchheal').checked;
    c.useTemplateMatch = $('cfg-template').checked;
    return c;
  }

  /* ------------------- representative preview loader ------------------- */
  // Asynchronously load a representative preview for a queue item right after
  // the file is added: get the representative image, then immediately run
  // watermark detection + removal on it, so the user sees a before/after
  // comparison even before clicking "Process".
  function loadRepresentative(it) {
    var handler = HANDLERS[it.kind]();
    handler.representative(it.file).then(function (rep) {
      var img = rep.imageData;
      it.repBefore = NLM.imageDataToCanvas(img);
      // Run auto detection on the representative to produce an instant preview
      var cfg = readConfig();
      var res = NLM.Process.cleanFullImage(img, cfg);
      var outData = res.found ? res.imageData : img;
      it.repAfter = NLM.imageDataToCanvas(outData);
      it.repFound = res.found;
      renderRow(it);
      // auto-select the first file for large preview
      if (selectedId == null) selectItem(it.id);
      else if (selectedId === it.id) renderPreview();
    }).catch(function (err) {
      console.warn('[NLM.UI] representative preview failed for', it.file.name, err);
    });
  }

  /* ----------------------------- queue ----------------------------- */
  function addFiles(files) {
    var firstId = null;
    Array.prototype.forEach.call(files, function (file) {
      var ext = NLM.extOf(file.name);
      var kind = SUPPORTED[ext];
      if (!kind) { flash(NLM.t('flashUnsupported', { name: file.name })); return; }
      var it = { id: ++seq, file: file, kind: kind, mode: 'auto', manualSpec: null,
                 status: 'pending', result: null, repBefore: null, repAfter: null, repFound: false };
      queue.push(it);
      if (!firstId) firstId = it.id;
      loadRepresentative(it);
    });
    render();
    // select the first newly-added file if nothing is selected
    if (firstId && selectedId == null) selectItem(firstId);
  }

  function removeItem(id) {
    queue = queue.filter(function (it) { return it.id !== id; });
    if (selectedId === id) selectedId = null;
    render(); renderPreview();
  }

  function runItem(it) {
    if (it.status === 'processing') return Promise.resolve();
    it.status = 'processing'; it.progress = null; renderRow(it);
    var cfg = readConfig();
    var handler = HANDLERS[it.kind]();
    return handler.process(it.file, cfg, it.manualSpec, function (cur, total) {
      it.progress = cur + '/' + total; renderRow(it);
    }).then(function (res) {
      it.result = res; it.status = res.found ? 'done' : 'empty';
    }).catch(function (err) {
      console.error(err); it.status = 'error'; it.error = (err && err.message) || String(err);
    }).then(function () {
      // Always select item for preview if preview data exists (handlers now
      // always generate before/after even when no watermark was found)
      if (it.result && it.result.previewBefore) selectItem(it.id);
      else { renderRow(it); updateToolbar(); }
    });
  }

  function processAll() {
    var pending = queue.filter(function (it) { return it.status === 'pending' || it.status === 'empty' || it.status === 'error'; });
    return pending.reduce(function (chain, it) { return chain.then(function () { return runItem(it); }); }, Promise.resolve());
  }

  function openManual(it) {
    var handler = HANDLERS[it.kind]();
    it.status = 'loading'; renderRow(it);
    handler.representative(it.file).then(function (rep) {
      it.status = it.result ? (it.result.found ? 'done' : 'empty') : 'pending'; renderRow(it);
      return NLM.Manual.edit(rep, it.manualSpec);
    }).then(function (spec) {
      if (!spec) return;
      it.manualSpec = spec; it.mode = 'manual';
      runItem(it);
    }).catch(function (err) {
      console.error(err); it.status = 'error'; it.error = (err && err.message) || String(err); renderRow(it);
    });
  }

  function setAuto(it) { it.mode = 'auto'; it.manualSpec = null; renderRow(it); }

  function downloadOne(it) { if (it.result && it.result.blob) NLM.downloadBlob(it.result.blob, it.result.name); }

  function downloadAll() {
    var done = queue.filter(function (it) { return it.result && it.result.blob; });
    if (!done.length) return;
    if (done.length === 1) return downloadOne(done[0]);
    var zip = new JSZip();
    done.forEach(function (it) { zip.file(it.result.name, it.result.blob); });
    flash(NLM.t('flashZipping'));
    zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (blob) {
      NLM.downloadBlob(blob, 'notebooklm_cleaned.zip'); flash(NLM.t('flashDownloaded', { n: done.length }));
    });
  }

  /* --------------------------- selection / big preview --------------------------- */
  function selectItem(id) { selectedId = id; render(); renderPreview(); }

  function fillStage(stage, srcCanvas) {
    stage.innerHTML = '';
    if (!srcCanvas) return;
    var boxW = Math.max(200, stage.clientWidth - 16);
    var boxH = Math.min(Math.round(window.innerHeight * 0.78), 820);
    var scale = Math.min(boxW / srcCanvas.width, boxH / srcCanvas.height);
    scale = Math.min(scale, 3);
    if (!(scale > 0)) scale = 1;
    var w = Math.max(1, Math.round(srcCanvas.width * scale));
    var hh = Math.max(1, Math.round(srcCanvas.height * scale));
    var c = NLM.canvas(w, hh);
    var ctx = NLM.ctxOf(c); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, w, hh);
    stage.appendChild(c);
  }

  function renderPreview() {
    var panel = $('nlm-preview');
    var it = selectedId != null ? find(selectedId) : null;

    // Two sources of before/after:
    // 1. result.previewBefore/After — from actual processing (final)
    // 2. repBefore/repAfter — from representative quick preview (instant on load)
    var hasResult = it && it.result && it.result.previewBefore;
    var hasRep = it && it.repBefore;

    if (!hasResult && !hasRep) { panel.hidden = true; return; }
    panel.hidden = false;
    $('nlm-preview-name').textContent = it.file.name;

    var beforeStage = $('nlm-pv-before');
    var afterStage = $('nlm-pv-after');
    var beforeLabel = beforeStage.parentNode.querySelector('figcaption');
    var afterLabel = afterStage.parentNode.querySelector('figcaption');

    // Always show side-by-side before/after; use result data if available,
    // otherwise use the representative quick-preview data
    var bCanvas = hasResult ? it.result.previewBefore : it.repBefore;
    var aCanvas = hasResult ? it.result.previewAfter : it.repAfter;

    beforeStage.parentNode.style.display = '';
    afterStage.parentNode.style.display = '';
    beforeLabel.textContent = NLM.t('previewBefore');
    afterLabel.textContent = NLM.t('previewAfter');
    fillStage(beforeStage, bCanvas);
    fillStage(afterStage, aCanvas);
  }

  /* ----------------------------- render ----------------------------- */
  function render() {
    var list = $('nlm-list');
    $('nlm-empty').style.display = queue.length ? 'none' : 'block';
    list.innerHTML = '';
    queue.forEach(function (it) { list.appendChild(buildRow(it)); });
    updateToolbar();
  }

  function renderRow(it) {
    var old = document.querySelector('.nlm-row[data-id="' + it.id + '"]');
    if (old) old.parentNode.replaceChild(buildRow(it), old);
    else render();
    updateToolbar();
  }

  function msgOf(it) {
    if (it.result && it.result.messageKey) return NLM.t(it.result.messageKey, it.result.messageParams);
    return NLM.t('doneDefault');
  }

  function statusText(it) {
    switch (it.status) {
      case 'pending': return NLM.t('stPending');
      case 'loading': return NLM.t('stLoading');
      case 'processing': return NLM.t('stProcessing') + (it.progress ? ' · ' + it.progress : '…');
      case 'done': return '✅ ' + msgOf(it);
      case 'empty': return '⚠️ ' + msgOf(it);
      case 'error': return '❌ ' + (it.error || NLM.t('stError'));
      default: return '';
    }
  }

  function buildRow(it) {
    var previews = [];
    // Use result data if processed, otherwise use rep quick-preview
    var bSrc = (it.result && it.result.previewBefore) ? it.result.previewBefore : it.repBefore;
    var aSrc = (it.result && it.result.previewAfter) ? it.result.previewAfter : it.repAfter;
    if (bSrc) {
      previews.push(h('div', { class: 'nlm-pv' }, [
        h('span', { class: 'nlm-pv-label', text: NLM.t('previewBefore') }), thumb(bSrc, 150)
      ]));
      previews.push(h('div', { class: 'nlm-pv' }, [
        h('span', { class: 'nlm-pv-label', text: NLM.t('previewAfter') }), thumb(aSrc, 150)
      ]));
    } else {
      // Still loading representative
      previews.push(h('div', { class: 'nlm-thumb-ph', text: badge(it.kind) }));
    }

    var modeBtns = h('div', { class: 'nlm-mode' }, [
      h('button', { class: 'nlm-seg' + (it.mode === 'auto' ? ' active' : ''), text: NLM.t('modeAuto'), onclick: stop(function () { setAuto(it); }) }),
      h('button', { class: 'nlm-seg' + (it.mode === 'manual' ? ' active' : ''), text: NLM.t('modeManual'), onclick: stop(function () { openManual(it); }) })
    ]);

    var dlBtn = h('button', { class: 'nlm-btn small', text: NLM.t('btnDownload'), onclick: stop(function () { downloadOne(it); }) });
    dlBtn.disabled = !(it.result && it.result.blob);

    return h('li', { class: 'nlm-row' + (it.id === selectedId ? ' selected' : ''), data: { id: it.id }, onclick: function () { selectItem(it.id); } }, [
      h('div', { class: 'nlm-thumb' }, previews),
      h('div', { class: 'nlm-meta' }, [
        h('div', { class: 'nlm-name' }, [it.file.name, h('span', { class: 'nlm-badge ' + it.kind, text: badge(it.kind) })]),
        h('div', { class: 'nlm-sub ' + it.status, text: statusText(it) }),
        modeBtns
      ]),
      h('div', { class: 'nlm-actions' }, [
        h('button', { class: 'nlm-btn small primary', text: NLM.t('btnProcess'), onclick: stop(function () { runItem(it); }) }),
        dlBtn,
        h('button', { class: 'nlm-btn small ghost', text: NLM.t('btnRemove'), onclick: stop(function () { removeItem(it.id); }) })
      ])
    ]);
  }

  function updateToolbar() {
    var anyDone = queue.some(function (it) { return it.result && it.result.blob; });
    $('nlm-process').disabled = !queue.length;
    $('nlm-download').disabled = !anyDone;
    $('nlm-clear').disabled = !queue.length;
    var n = queue.length, d = queue.filter(function (it) { return it.status === 'done'; }).length;
    $('nlm-status').textContent = n ? NLM.t('toolbarCount', { n: n, d: d }) : '';
  }

  function syncAdvToggle() {
    var adv = $('nlm-adv'), advToggle = $('nlm-adv-toggle');
    advToggle.textContent = (adv.classList.contains('open') ? '▾ ' : '▸ ') + NLM.t('advToggle');
  }

  var flashTimer;
  function flash(msg) {
    var f = $('nlm-flash'); f.textContent = msg; f.classList.add('show');
    clearTimeout(flashTimer); flashTimer = setTimeout(function () { f.classList.remove('show'); }, 2600);
  }

  /* ------------------------------ init ------------------------------ */
  UI.init = function () {
    NLM.i18n.apply();

    var drop = $('nlm-drop'), input = $('nlm-input');
    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (e) {
      drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (e) {
      drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (ev) { if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files); });
    // allow dropping anywhere on the page
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('nlm-process').addEventListener('click', processAll);
    $('nlm-download').addEventListener('click', downloadAll);
    $('nlm-clear').addEventListener('click', function () { queue = []; selectedId = null; render(); renderPreview(); });

    $('nlm-lang').addEventListener('click', function () { NLM.i18n.toggle(); });

    var advToggle = $('nlm-adv-toggle'), adv = $('nlm-adv');
    advToggle.addEventListener('click', function () { adv.classList.toggle('open'); syncAdvToggle(); });
    syncAdvToggle();

    // re-render everything that holds translated strings when the language flips
    NLM.bus.on('lang', function () { render(); syncAdvToggle(); renderPreview(); });

    // keep the big preview readable when the window is resized
    var rt;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(renderPreview, 150); });

    render();
  };
})();

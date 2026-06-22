/* manual.js — manual mask editor (the override when auto-detection misses).
 *
 * Opens a modal over a representative image and lets the user mark the watermark
 * with rectangles or a brush. Produces a resolution-independent spec of
 * normalized (0..1, top-left origin) shapes — so the same marks apply to a single
 * image, or to every page/media of a PDF/PPTX.
 *
 *   NLM.Manual.edit(representative, initialSpec) -> Promise<spec|null>
 */
(function () {
  'use strict';
  var NLM = window.NLM;
  var Manual = (NLM.Manual = {});

  Manual.edit = function (rep, initialSpec) {
    return new Promise(function (resolve) {
      var shapes = (initialSpec && initialSpec.shapes ? initialSpec.shapes.slice() : []);
      var tool = 'rect';        // 'rect' | 'brush'
      var brush = 0.03;         // brush radius as fraction of min(side)

      // ---- layout: fit the image into the available viewport ----
      var maxW = Math.min(920, window.innerWidth - 48);
      var maxH = window.innerHeight - 220;
      var ratio = Math.min(maxW / rep.width, maxH / rep.height, 1);
      var dispW = Math.max(80, Math.round(rep.width * ratio));
      var dispH = Math.max(60, Math.round(rep.height * ratio));

      var overlay = el('div', 'nlm-modal');
      var box = el('div', 'nlm-modal-box');
      overlay.appendChild(box);

      box.appendChild(el('div', 'nlm-modal-title', NLM.t('mTitle') + (rep.label ? ' — ' + rep.label : '')));
      var hint = el('div', 'nlm-modal-hint', NLM.t('mHint'));
      box.appendChild(hint);

      // toolbar
      var bar = el('div', 'nlm-tools');
      var bRect = btn(NLM.t('mRect'), true), bBrush = btn(NLM.t('mBrush'), false);
      var bUndo = btn(NLM.t('mUndo'), false), bClear = btn(NLM.t('mClear'), false);
      var brushWrap = el('label', 'nlm-brush');
      brushWrap.appendChild(document.createTextNode(NLM.t('mBrushSize')));
      var brushRange = document.createElement('input');
      brushRange.type = 'range'; brushRange.min = '1'; brushRange.max = '12'; brushRange.value = '3';
      brushWrap.appendChild(brushRange);
      [bRect, bBrush, bUndo, bClear, brushWrap].forEach(function (b) { bar.appendChild(b); });
      box.appendChild(bar);

      // canvas stack
      var stack = el('div', 'nlm-canvas-stack');
      stack.style.width = dispW + 'px'; stack.style.height = dispH + 'px';
      var base = NLM.canvas(dispW, dispH);
      NLM.ctxOf(base).drawImage(NLM.imageDataToCanvas(rep.imageData), 0, 0, dispW, dispH);
      var draw = NLM.canvas(dispW, dispH);
      base.className = 'nlm-c-base'; draw.className = 'nlm-c-draw';
      stack.appendChild(base); stack.appendChild(draw);
      box.appendChild(stack);

      // actions
      var actions = el('div', 'nlm-modal-actions');
      var bApply = btn(NLM.t('mApply'), false); bApply.classList.add('primary');
      var bCancel = btn(NLM.t('mCancel'), false);
      actions.appendChild(bCancel); actions.appendChild(bApply);
      box.appendChild(actions);

      document.body.appendChild(overlay);
      var dctx = NLM.ctxOf(draw);
      redraw();

      // ---- tool wiring ----
      function setTool(t) {
        tool = t;
        bRect.classList.toggle('active', t === 'rect');
        bBrush.classList.toggle('active', t === 'brush');
        brushWrap.style.opacity = t === 'brush' ? '1' : '0.4';
      }
      bRect.onclick = function () { setTool('rect'); };
      bBrush.onclick = function () { setTool('brush'); };
      brushRange.oninput = function () { brush = (+brushRange.value) * 0.01; };
      bUndo.onclick = function () { shapes.pop(); redraw(); };
      bClear.onclick = function () { shapes.length = 0; redraw(); };
      bCancel.onclick = function () { close(null); };
      bApply.onclick = function () { close({ shapes: shapes.slice() }); };
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(null); });

      // ---- drawing ----
      var dragging = false, start = null, pending = null;
      draw.addEventListener('pointerdown', function (e) {
        draw.setPointerCapture(e.pointerId);
        dragging = true;
        var p = pos(e);
        if (tool === 'rect') { start = p; pending = null; }
        else { addDot(p); }
      });
      draw.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var p = pos(e);
        if (tool === 'rect') {
          pending = { type: 'rect', x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
          redraw();
        } else { addDot(p); }
      });
      draw.addEventListener('pointerup', function () {
        dragging = false;
        if (tool === 'rect' && pending && pending.w > 0.003 && pending.h > 0.003) shapes.push(pending);
        pending = null; redraw();
      });

      function addDot(p) { shapes.push({ type: 'dot', x: p.x, y: p.y, r: brush }); redraw(); }
      function pos(e) {
        var r = draw.getBoundingClientRect();
        return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
      }

      function redraw() {
        dctx.clearRect(0, 0, dispW, dispH);
        dctx.fillStyle = 'rgba(239,68,68,0.38)';
        dctx.strokeStyle = 'rgba(239,68,68,0.95)';
        dctx.lineWidth = 1.5;
        var all = pending ? shapes.concat([pending]) : shapes;
        all.forEach(function (s) {
          if (s.type === 'rect') {
            dctx.fillRect(s.x * dispW, s.y * dispH, s.w * dispW, s.h * dispH);
            dctx.strokeRect(s.x * dispW, s.y * dispH, s.w * dispW, s.h * dispH);
          } else {
            var rr = s.r * Math.min(dispW, dispH);
            dctx.beginPath(); dctx.arc(s.x * dispW, s.y * dispH, rr, 0, 7); dctx.fill();
          }
        });
      }

      function close(result) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }
      function btn(label, active) {
        var b = el('button', 'nlm-tool' + (active ? ' active' : ''), label);
        b.type = 'button'; return b;
      }
    });

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  };
})();

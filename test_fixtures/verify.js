// Headless-Chrome verification of the built offline app.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = 'file://' + path.join(ROOT, 'dist', 'notebooklm-watermark-remover.html');
const FIX = __dirname;
const b64 = (f) => fs.readFileSync(path.join(FIX, f)).toString('base64');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
           '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(HTML, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));

  // 1) globals + pdf worker
  const env = await page.evaluate(() => ({
    NLM: !!window.NLM, UI: !!(window.NLM && NLM.UI),
    jszip: !!window.JSZip, pdfjs: !!window.pdfjsLib, pdflib: !!window.PDFLib,
    worker: window.pdfjsLib ? pdfjsLib.GlobalWorkerOptions.workerSrc.slice(0, 5) : null,
    handlers: !!(NLM.ImageHandler && NLM.PdfHandler && NLM.PptxHandler)
  }));
  console.log('ENV', JSON.stringify(env));

  // 2) image auto path — measure bottom-right darkness before/after
  async function imageTest(file, manual) {
    return page.evaluate(async (data, mime, manualSpec) => {
      const bin = atob(data), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f = new File([arr], 'fixture.png', { type: mime });
      const cfg = NLM.defaultConfig();
      function cornerDark(img) {
        const w = img.width, h = img.height, d = img.data;
        const mx = Math.min(w, cfg.searchMarginX), my = Math.min(h, cfg.searchMarginY);
        let cnt = 0;
        for (let y = h - my; y < h; y++) for (let x = w - mx; x < w; x++) {
          const i = (y * w + x) * 4, L = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          if (L < 150) cnt++;
        }
        return cnt;
      }
      const before = await NLM.blobToImageData(f);
      const res = await NLM.ImageHandler.process(f, cfg, manualSpec || null);
      const after = await NLM.blobToImageData(res.blob);
      return { found: res.found, name: res.name, size: res.blob.size,
               darkBefore: cornerDark(before), darkAfter: cornerDark(after) };
    }, file, 'image/png', manual);
  }

  const imgAuto = await imageTest(b64('wm_gradient.png'), null);
  console.log('IMAGE_AUTO', JSON.stringify(imgAuto));

  const imgManual = await imageTest(b64('wm_gradient.png'),
    { shapes: [{ type: 'rect', x: 0.80, y: 0.88, w: 0.19, h: 0.10 }] });
  console.log('IMAGE_MANUAL', JSON.stringify(imgManual));

  const imgAlpha = await imageTest(b64('wm_alpha.png'), null);
  console.log('IMAGE_ALPHA', JSON.stringify(imgAlpha));

  // 3) pdf auto path
  const pdfRes = await page.evaluate(async (data) => {
    const bin = atob(data), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], 'fixture.pdf', { type: 'application/pdf' });
    const res = await NLM.PdfHandler.process(f, NLM.defaultConfig(), null);
    return { found: res.found, name: res.name, size: res.blob.size, pages: res.pageCount, msg: res.message };
  }, b64('wm_slides.pdf'));
  console.log('PDF_AUTO', JSON.stringify(pdfRes));

  // 4) pptx auto path
  const pptxRes = await page.evaluate(async (data) => {
    const bin = atob(data), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], 'deck.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const res = await NLM.PptxHandler.process(f, NLM.defaultConfig(), null);
    return { found: res.found, name: res.name, size: res.blob.size, media: res.pageCount, msg: res.message };
  }, b64('wm_deck.pptx'));
  console.log('PPTX_AUTO', JSON.stringify(pptxRes));

  // 5) UI smoke test: upload via the real input + click 處理全部
  const input = await page.$('#nlm-input');
  await input.uploadFile(path.join(FIX, 'wm_gradient.png'), path.join(FIX, 'wm_slides.pdf'));
  await page.click('#nlm-process');
  await page.waitForFunction(() => {
    const subs = Array.from(document.querySelectorAll('.nlm-sub'));
    return subs.length >= 2 && subs.every(s => /done|empty|error/.test(s.className));
  }, { timeout: 30000 });
  const uiStatus = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.nlm-row')).map(r => ({
      name: r.querySelector('.nlm-name').textContent.trim().slice(0, 24),
      sub: r.querySelector('.nlm-sub').textContent.trim(),
      hasPreview: !!r.querySelector('.nlm-thumb canvas')
    })));
  console.log('UI', JSON.stringify(uiStatus));

  console.log('ERRORS', JSON.stringify(errors));
  await browser.close();
  // exit non-zero if anything obviously failed
  const ok = env.NLM && env.handlers && env.worker === 'blob:' &&
    imgAuto.found && imgAuto.darkAfter < imgAuto.darkBefore * 0.25 &&
    imgManual.found && imgManual.darkAfter < imgManual.darkBefore * 0.25 &&
    pdfRes.found && pptxRes.found && errors.length === 0;
  console.log('RESULT', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('DRIVER_FAIL', e); process.exit(2); });

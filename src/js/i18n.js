/* i18n.js — tiny bilingual (zh-Hant / en) string table + live language switch.
 *
 * Static markup carries `data-i18n="key"` (textContent) or `data-i18n-html="key"`
 * (innerHTML, for the disclaimer markup). Dynamic modules call `NLM.t(key, params)`
 * at render time and re-render on the `lang` bus event. No network, no frameworks.
 *
 *   NLM.t('btnProcess')            -> current-language string
 *   NLM.t('pdfCleaned',{n:2,t:3})  -> "2/3 頁已清除" | "2/3 pages cleaned"
 *   NLM.i18n.set('en')             -> switch language, re-apply, emit 'lang'
 */
(function () {
  'use strict';
  var NLM = window.NLM;

  var DICT = {
    zh: {
      docTitle: 'NotebookLM 浮水印移除工具 · 離線版',
      appTitle: 'NotebookLM 浮水印移除工具',
      appSubtitle: '離線執行 · 不上傳任何檔案 · 完全在本機處理',
      pill: '100% 本機處理',
      langToggle: 'EN',

      dropTitle: '拖放檔案到這裡，或點此選擇',
      dropSub: '支援 PNG · JPG · JPEG · WEBP · PDF · PPTX',

      btnProcessAll: '▶ 處理全部',
      btnDownloadAll: '⬇ 下載全部 (zip)',
      btnClear: '清空',

      advToggle: '進階設定 · Advanced',
      advMarginX: '右邊界 marginX',
      advMarginY: '下邊界 marginY',
      advPixel: '暗點門檻 pixel',
      advDark: '文字亮度上限 dark',
      advUpscale: '偵測放大 upscale',
      advPatchHeal: '貼補重建 patch-heal（材質背景用）',
      advTemplate: '文字比對確認 template',

      emptyHint: '尚未加入任何檔案。把 NotebookLM 匯出的圖片 / PDF / PPTX 拖進來即可。',
      previewTitle: '預覽對比',
      previewBefore: '原圖',
      previewAfter: '結果',
      previewEmpty: '處理檔案後，點選下方項目即可在此並列檢視大圖對比。',

      footerDisclaimer: '<strong>使用聲明：</strong>本工具僅供處理你<strong>擁有或有權修改</strong>的內容。是否符合各服務的使用條款由使用者自行負責。所有處理皆在你的瀏覽器本機完成，不會連網或上傳。',
      footerMuted: '以離線 HTML/Canvas 重新實作，架構參考自 Albonire/notebooklm-watermark-remover（非照抄）。',

      badgeImage: '圖片', badgePdf: 'PDF', badgePptx: 'PPTX',
      modeAuto: '自動偵測', modeManual: '✋ 手動框選',
      btnProcess: '處理', btnDownload: '下載', btnRemove: '移除',

      stPending: '待處理', stLoading: '載入中…', stProcessing: '處理中', stError: '處理失敗',
      doneDefault: '完成',
      noWatermark: '未偵測到浮水印',
      imageCleaned: '已清除浮水印',
      pptxCleaned: '{n}/{t} 張圖片已清除',
      pdfCleaned: '{n}/{t} 頁已清除',

      toolbarCount: '{n} 個檔案 · {d} 已清除',
      flashUnsupported: '不支援的格式: {name}',
      flashZipping: '打包中…',
      flashDownloaded: '已下載 {n} 個檔案',

      mTitle: '手動框選浮水印',
      mHint: '用「矩形」拖曳框住浮水印，或用「筆刷」塗抹。框越貼合，背景重建越乾淨。',
      mRect: '▭ 矩形', mBrush: '🖌 筆刷', mUndo: '↶ 復原', mClear: '✕ 清除',
      mBrushSize: '筆刷大小', mApply: '套用並重建', mCancel: '取消'
    },
    en: {
      docTitle: 'NotebookLM Watermark Remover · Offline',
      appTitle: 'NotebookLM Watermark Remover',
      appSubtitle: 'Runs offline · nothing is uploaded · 100% on your device',
      pill: '100% on-device',
      langToggle: '中文',

      dropTitle: 'Drop files here, or click to choose',
      dropSub: 'Supports PNG · JPG · JPEG · WEBP · PDF · PPTX',

      btnProcessAll: '▶ Process all',
      btnDownloadAll: '⬇ Download all (zip)',
      btnClear: 'Clear',

      advToggle: 'Advanced settings',
      advMarginX: 'Right margin (marginX)',
      advMarginY: 'Bottom margin (marginY)',
      advPixel: 'Dark threshold (pixel)',
      advDark: 'Text brightness max (dark)',
      advUpscale: 'Detection upscale',
      advPatchHeal: 'Patch-heal (textured backgrounds)',
      advTemplate: 'Text-template confirm',

      emptyHint: 'No files yet. Drop NotebookLM-exported images / PDF / PPTX here.',
      previewTitle: 'Before / After',
      previewBefore: 'Before',
      previewAfter: 'After',
      previewEmpty: 'Process a file, then select it below to compare before / after side by side here.',

      footerDisclaimer: '<strong>Disclaimer:</strong> Use this tool only on content you <strong>own or have the right to modify</strong>. Compliance with each service’s terms is your responsibility. All processing happens locally in your browser — nothing is uploaded.',
      footerMuted: 'Reimplemented in offline HTML/Canvas, inspired by the architecture of Albonire/notebooklm-watermark-remover (not a copy).',

      badgeImage: 'Image', badgePdf: 'PDF', badgePptx: 'PPTX',
      modeAuto: 'Auto', modeManual: '✋ Manual',
      btnProcess: 'Process', btnDownload: 'Download', btnRemove: 'Remove',

      stPending: 'Pending', stLoading: 'Loading…', stProcessing: 'Processing', stError: 'Failed',
      doneDefault: 'Done',
      noWatermark: 'No watermark detected',
      imageCleaned: 'Watermark removed',
      pptxCleaned: '{n}/{t} images cleaned',
      pdfCleaned: '{n}/{t} pages cleaned',

      toolbarCount: '{n} files · {d} cleaned',
      flashUnsupported: 'Unsupported format: {name}',
      flashZipping: 'Zipping…',
      flashDownloaded: 'Downloaded {n} files',

      mTitle: 'Manual mask',
      mHint: 'Drag a rectangle over the watermark, or paint it with the brush. Tighter marks reconstruct cleaner.',
      mRect: '▭ Rectangle', mBrush: '🖌 Brush', mUndo: '↶ Undo', mClear: '✕ Clear',
      mBrushSize: 'Brush size', mApply: 'Apply & rebuild', mCancel: 'Cancel'
    }
  };

  function format(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] != null ? params[k] : m;
    });
  }

  var i18n = (NLM.i18n = {
    lang: 'zh',
    set: function (lang) {
      if (lang !== 'zh' && lang !== 'en') return;
      if (lang === i18n.lang) return;
      i18n.lang = lang;
      i18n.apply();
      NLM.bus.emit('lang', lang);
    },
    toggle: function () { i18n.set(i18n.lang === 'zh' ? 'en' : 'zh'); },
    // Apply to all static [data-i18n] / [data-i18n-html] markup + <title> + <html lang>.
    apply: function () {
      document.documentElement.lang = i18n.lang === 'zh' ? 'zh-Hant' : 'en';
      document.title = NLM.t('docTitle');
      var nodes = document.querySelectorAll('[data-i18n]');
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = NLM.t(nodes[i].getAttribute('data-i18n'));
      var html = document.querySelectorAll('[data-i18n-html]');
      for (var j = 0; j < html.length; j++) html[j].innerHTML = NLM.t(html[j].getAttribute('data-i18n-html'));
    }
  });

  NLM.t = function (key, params) {
    var table = DICT[i18n.lang] || DICT.zh;
    var s = table[key];
    if (s == null) s = DICT.zh[key];
    if (s == null) s = key;
    return format(s, params);
  };
})();

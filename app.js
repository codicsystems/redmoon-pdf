/**
 * RedMoon PDF — client-side PDF compression.
 *
 * The approach: render each page with pdf.js to a canvas at a resolution capped
 * by the user's DPI setting, re-encode it as JPEG at a chosen quality, and
 * assemble a new PDF with pdf-lib. For an exact target size, run that pipeline
 * repeatedly under a binary search over a combined quality/scale axis.
 *
 * Everything runs in the tab. No network calls after the page loads.
 */

(function () {
  'use strict';

  // pdf.js needs its worker. Both are vendored locally so the tool works
  // offline and so no third-party CDN sees which documents you open.
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const { PDFDocument } = PDFLib;

  const MAX_BYTES = 200 * 1024 * 1024;      // 200 MB
  const MAX_SEARCH_PASSES = 7;              // binary search depth for exact-size
  const TARGET_TOLERANCE = 0.04;            // accept within 4% under target

  // ── element handles ──────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const els = {
    dropZone: $('dropZone'), fileInput: $('fileInput'),
    controls: $('controls'), fileName: $('fileName'), fileMeta: $('fileMeta'),
    clearBtn: $('clearBtn'), compressBtn: $('compressBtn'),
    percentField: $('percentField'), percent: $('percent'),
    percentOut: $('percentOut'), percentBytes: $('percentBytes'),
    sizeField: $('sizeField'), targetSize: $('targetSize'), sizeUnit: $('sizeUnit'),
    qualityField: $('qualityField'), quality: $('quality'), qualityOut: $('qualityOut'),
    maxDpi: $('maxDpi'), dpiOut: $('dpiOut'), grayscale: $('grayscale'),
    warnBig: $('warnBig'),
    progress: $('progress'), progressBar: $('progressBar'), progressPct: $('progressPct'),
    progressLabel: $('progressLabel'), progressDetail: $('progressDetail'),
    cancelBtn: $('cancelBtn'),
    result: $('result'), beforeSize: $('beforeSize'), afterSize: $('afterSize'),
    savingLine: $('savingLine'), donut: $('donut'), donutPct: $('donutPct'),
    downloadBtn: $('downloadBtn'), againBtn: $('againBtn'),
    missedTarget: $('missedTarget'), resultNote: $('resultNote'),
    errorBox: $('errorBox')
  };

  // ── state ────────────────────────────────────────────────────────────────
  let sourceFile = null;
  let sourceBytes = null;
  let pageCount = 0;
  let outputBlob = null;
  let cancelled = false;
  let running = false;

  // ── helpers ──────────────────────────────────────────────────────────────

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function showError(message) {
    els.errorBox.textContent = message;
    show(els.errorBox);
  }

  function clearError() {
    els.errorBox.textContent = '';
    hide(els.errorBox);
  }

  function setProgress(fraction, label, detail) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    els.progressBar.style.width = pct + '%';
    els.progressPct.textContent = pct + '%';
    if (label) els.progressLabel.textContent = label;
    if (detail) els.progressDetail.textContent = detail;
  }

  /** Yield to the event loop so the progress bar actually paints. */
  const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

  function currentMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'percent';
  }

  function targetBytes() {
    const mode = currentMode();
    if (mode === 'percent') {
      return sourceBytes ? sourceBytes.byteLength * (Number(els.percent.value) / 100) : 0;
    }
    if (mode === 'size') {
      return Number(els.targetSize.value) * Number(els.sizeUnit.value);
    }
    return 0; // quality mode has no size target
  }

  // ── file intake ──────────────────────────────────────────────────────────

  async function acceptFile(file) {
    clearError();

    if (!file) return;

    const looksPdf = file.type === 'application/pdf' ||
                     file.name.toLowerCase().endsWith('.pdf');
    if (!looksPdf) {
      showError('That does not look like a PDF. Choose a file ending in .pdf.');
      return;
    }
    if (file.size > MAX_BYTES) {
      showError('That file is ' + formatBytes(file.size) +
                '. The limit is 200 MB, because everything happens in this tab.');
      return;
    }
    if (file.size === 0) {
      showError('That file is empty.');
      return;
    }

    sourceFile = file;
    hide(els.result);
    hide(els.progress);

    try {
      sourceBytes = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
      pageCount = doc.numPages;
      doc.destroy();
    } catch (err) {
      // An encrypted PDF is the most common cause and worth naming explicitly.
      if (String(err && err.name) === 'PasswordException') {
        showError('That PDF is password protected. Remove the password first — ' +
                  'this tool cannot open it, and nor could a server-side one without the password.');
      } else {
        showError('That file could not be read as a PDF. It may be damaged.');
      }
      sourceFile = null;
      sourceBytes = null;
      return;
    }

    els.fileName.textContent = file.name;
    els.fileMeta.textContent = formatBytes(file.size) + ' · ' + pageCount +
                               (pageCount === 1 ? ' page' : ' pages');
    els.warnBig.hidden = file.size < 25 * 1024 * 1024;

    // Seed the exact-size box with something sensible.
    els.targetSize.value = Math.max(0.05, (file.size / 1048576) * 0.5).toFixed(2);
    els.sizeUnit.value = '1048576';

    updateEstimates();
    show(els.controls);
  }

  function updateEstimates() {
    els.percentOut.textContent = els.percent.value;
    els.qualityOut.textContent = els.quality.value;
    els.dpiOut.textContent = els.maxDpi.value;
    if (sourceBytes) {
      els.percentBytes.textContent =
        formatBytes(sourceBytes.byteLength * (Number(els.percent.value) / 100));
    }
  }

  // ── the compression pipeline ─────────────────────────────────────────────

  /**
   * Render every page and rebuild the document at a given quality and scale.
   * Returns the produced bytes.
   *
   * @param {number} quality  JPEG quality, 0–1
   * @param {number} scale    multiplier on the DPI cap, 0–1
   * @param {function} onPage progress callback (index, total)
   */
  async function buildAtQuality(quality, scale, onPage) {
    const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
    const out = await PDFDocument.create();
    const dpiCap = Number(els.maxDpi.value) * scale;
    const grayscale = els.grayscale.checked;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: grayscale });

    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) throw new Error('cancelled');

        const page = await pdf.getPage(i);

        // pdf.js viewport at scale 1 is 72 DPI, so the DPI cap is a direct ratio.
        const base = page.getViewport({ scale: 1 });
        const renderScale = Math.min(dpiCap / 72, 4);
        const viewport = page.getViewport({ scale: renderScale });

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));

        // JPEG has no alpha channel, so paint white before rendering or
        // transparent regions come out black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        if (grayscale) {
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = img.data;
          for (let p = 0; p < d.length; p += 4) {
            // Rec. 601 luma — matches how the eye weights the channels.
            const y = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
            d[p] = d[p + 1] = d[p + 2] = y;
          }
          ctx.putImageData(img, 0, 0);
        }

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const embedded = await out.embedJpg(dataUrl);

        // Keep the original page dimensions in points so the document still
        // prints at the right physical size.
        const newPage = out.addPage([base.width, base.height]);
        newPage.drawImage(embedded, {
          x: 0, y: 0, width: base.width, height: base.height
        });

        page.cleanup();
        if (onPage) onPage(i, pdf.numPages);
        await breathe();
      }

      return await out.save({ useObjectStreams: true });
    } finally {
      pdf.destroy();
      canvas.width = canvas.height = 0;
    }
  }

  /**
   * Map a single 0–1 search parameter onto quality and scale together.
   *
   * Dropping quality alone produces JPEG artefacts long before it produces a
   * small file, so past the midpoint we hold quality and start reducing
   * resolution instead, which degrades far more gracefully.
   */
  function paramsFor(t) {
    if (t >= 0.5) {
      const k = (t - 0.5) / 0.5;             // 0 → 1 across the upper half
      return { quality: 0.45 + k * 0.5, scale: 1.0 };
    }
    const k = t / 0.5;                        // 0 → 1 across the lower half
    return { quality: 0.45, scale: 0.45 + k * 0.55 };
  }

  async function compress() {
    if (running || !sourceBytes) return;

    running = true;
    cancelled = false;
    clearError();
    hide(els.controls);
    hide(els.result);
    show(els.progress);
    setProgress(0, 'Working…', 'Reading the document');

    const mode = currentMode();
    const originalSize = sourceBytes.byteLength;

    try {
      let bytes;
      let note = '';

      if (mode === 'quality') {
        // One pass, fixed quality.
        bytes = await buildAtQuality(
          Number(els.quality.value) / 100, 1,
          (i, n) => setProgress(i / n, 'Compressing',
                                'Page ' + i + ' of ' + n)
        );
      } else {
        // Binary search for the largest parameter that still fits the target.
        const target = targetBytes();

        if (target >= originalSize) {
          throw new Error('That target is bigger than the original file. ' +
                          'Pick a smaller one.');
        }

        let low = 0, high = 1;
        let best = null;
        let bestSize = Infinity;

        for (let pass = 0; pass < MAX_SEARCH_PASSES; pass++) {
          if (cancelled) throw new Error('cancelled');

          const t = (low + high) / 2;
          const { quality, scale } = paramsFor(t);

          const passBase = pass / MAX_SEARCH_PASSES;
          const passSpan = 1 / MAX_SEARCH_PASSES;

          const candidate = await buildAtQuality(quality, scale, (i, n) => {
            setProgress(passBase + (i / n) * passSpan,
                        'Searching for the right settings',
                        'Attempt ' + (pass + 1) + ' — page ' + i + ' of ' + n);
          });

          if (candidate.byteLength <= target) {
            // Fits. Keep it and try for better quality.
            best = candidate;
            bestSize = candidate.byteLength;
            low = t;
            // Close enough to the target that more passes are not worth the wait.
            if (candidate.byteLength >= target * (1 - TARGET_TOLERANCE)) break;
          } else {
            high = t;
          }
        }

        if (!best) {
          // Even the most aggressive settings could not reach the target.
          best = await buildAtQuality(0.45, 0.45, (i, n) =>
            setProgress(0.9 + (i / n) * 0.1, 'Final attempt',
                        'Page ' + i + ' of ' + n));
          bestSize = best.byteLength;
          note = 'This is as small as it goes without making the pages unreadable.';
        }

        bytes = best;
      }

      if (cancelled) throw new Error('cancelled');

      const blob = new Blob([bytes], { type: 'application/pdf' });
      outputBlob = blob;

      showResult(originalSize, blob.size, note, mode);

    } catch (err) {
      hide(els.progress);
      show(els.controls);

      if (String(err && err.message) === 'cancelled') {
        clearError();
      } else if (err instanceof RangeError ||
                 /allocation|memory/i.test(String(err && err.message))) {
        showError('The browser ran out of memory on this file. Try a lower ' +
                  'maximum resolution in Advanced, or split the PDF first.');
      } else {
        showError(err && err.message ? err.message :
                  'Something went wrong compressing that file.');
      }
    } finally {
      running = false;
    }
  }

  function showResult(before, after, note, mode) {
    hide(els.progress);
    show(els.result);

    const saved = before - after;
    const pct = Math.round((saved / before) * 100);

    els.beforeSize.textContent = formatBytes(before);
    els.afterSize.textContent = formatBytes(after);
    els.donut.style.setProperty('--pct', Math.max(0, pct));
    els.donutPct.textContent = (pct > 0 ? pct : 0) + '%';

    if (saved > 0) {
      els.savingLine.textContent = formatBytes(saved) + ' smaller';
      els.savingLine.className = 'saving good';
    } else {
      // Being honest about this is the whole point.
      els.savingLine.textContent = formatBytes(-saved) + ' larger';
      els.savingLine.className = 'saving bad';
    }

    hide(els.missedTarget);
    if (saved <= 0) {
      els.missedTarget.textContent =
        'This PDF got bigger, which means it was already efficiently ' +
        'compressed — most likely it is mostly text with few images. ' +
        'Keep your original; this one is worse.';
      show(els.missedTarget);
    } else if (mode !== 'quality') {
      const target = targetBytes();
      if (after > target) {
        els.missedTarget.textContent =
          'Could not reach ' + formatBytes(target) +
          ' without making the pages unreadable. This is the smallest sensible result.';
        show(els.missedTarget);
      }
    }

    els.resultNote.textContent = note ||
      'Pages are now images: the document looks the same but text is no longer ' +
      'selectable or searchable. Check it before you send it.';
  }

  function download() {
    if (!outputBlob) return;
    const base = (sourceFile.name || 'document').replace(/\.pdf$/i, '');
    const url = URL.createObjectURL(outputBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base + '-compressed.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the download a moment to start before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function reset() {
    sourceFile = null;
    sourceBytes = null;
    outputBlob = null;
    pageCount = 0;
    els.fileInput.value = '';
    hide(els.controls);
    hide(els.progress);
    hide(els.result);
    clearError();
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener('change', (e) => acceptFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach((evt) =>
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.add('over');
    }));

  ['dragleave', 'drop'].forEach((evt) =>
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('over');
    }));

  els.dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    acceptFile(file);
  });

  // Dropping anywhere else should not navigate away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const mode = currentMode();
      els.percentField.classList.toggle('hidden', mode !== 'percent');
      els.sizeField.classList.toggle('hidden', mode !== 'size');
      els.qualityField.classList.toggle('hidden', mode !== 'quality');
    });
  });

  ['input', 'change'].forEach((evt) => {
    els.percent.addEventListener(evt, updateEstimates);
    els.quality.addEventListener(evt, updateEstimates);
    els.maxDpi.addEventListener(evt, updateEstimates);
  });

  els.compressBtn.addEventListener('click', compress);
  els.clearBtn.addEventListener('click', reset);
  els.againBtn.addEventListener('click', () => {
    hide(els.result);
    show(els.controls);
  });
  els.downloadBtn.addEventListener('click', download);
  els.cancelBtn.addEventListener('click', () => { cancelled = true; });

  updateEstimates();
})();

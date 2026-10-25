// UI wiring. Everything happens in memory in this tab; nothing is stored
// or sent anywhere.

import { drawWatermark, toGrayscale, createCanvas, canvasToBlob, releaseCanvas, clampScale } from './watermark.js';
import { openPdf, renderPage } from './pdf-reader.js';
import { buildPdf } from './pdf-writer.js';

// Output presets. PDFs are rendered at `dpi`; images are downscaled so the
// long edge is at most `maxEdge`. `quality` is the JPEG quality.
const PRESETS = {
  small: { dpi: 100, maxEdge: 1600, quality: 0.6 },
  balanced: { dpi: 144, maxEdge: 2400, quality: 0.72 },
  high: { dpi: 200, maxEdge: Infinity, quality: 0.85 },
};
const PREVIEW_MAX_EDGE = 1400;

const $ = (id) => document.getElementById(id);
const form = $('settings');
const fileInput = $('file-input');
const dropzone = $('dropzone');
const preview = $('preview');

const state = {
  file: null,
  kind: null, // 'image' | 'pdf'
  bitmap: null,
  pdf: null,
  page: 1,
  pageCount: 0,
  previewBase: null, // canvas with the page/image at preview size, no watermark
  busy: false,
  loadToken: 0,
};

// ---------- Settings ----------

function getSettings() {
  const f = form.elements;
  return {
    text: f.text.value,
    opacity: Number(f.opacity.value) / 100,
    size: Number(f.size.value),
    angle: Number(f.angle.value),
    color: f.color.value,
    layout: f.layout.value,
    spacing: Number(f.spacing.value),
    quality: f.quality.value,
    format: f.format.value,
    grayscale: f.grayscale.checked,
  };
}

function updateOutputs() {
  const s = getSettings();
  $('opacity-out').value = `${Math.round(s.opacity * 100)}%`;
  $('size-out').value = `${s.size}%`;
  $('angle-out').value = `${s.angle}°`;
  $('spacing-out').value = `${s.spacing}×`;
  $('spacing-row').hidden = s.layout !== 'tiled';
  $('format-row').hidden = state.kind === 'pdf';
}

// ---------- Status ----------

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function setProgress(done, total) {
  $('progress').hidden = total == null;
  if (total != null) {
    $('progress-bar').value = done / total;
    $('progress-text').textContent = `Page ${Math.min(done + 1, total)} of ${total}`;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setBusy(busy) {
  state.busy = busy;
  $('download').disabled = busy || !state.kind;
  $('reset').disabled = busy || !state.kind;
}

// ---------- Loading ----------

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function loadFile(file) {
  clearDocument();
  const token = ++state.loadToken;
  setStatus('Loading…');
  try {
    if (isPdf(file)) {
      const pdf = await openPdf(await file.arrayBuffer());
      if (token !== state.loadToken) return void pdf.destroy();
      Object.assign(state, { kind: 'pdf', pdf, page: 1, pageCount: pdf.numPages });
    } else {
      const bitmap = await createImageBitmap(file);
      if (token !== state.loadToken) return void bitmap.close();
      Object.assign(state, { kind: 'image', bitmap });
    }
    state.file = file;
    const fileName = $('file-name');
    fileName.textContent = `${file.name} · ${formatBytes(file.size)}`;
    fileName.hidden = false;
    updateOutputs();
    await refreshPreviewBase();
    setBusy(false);
    setStatus(state.kind === 'pdf' && state.pageCount > 50
      ? `This PDF has ${state.pageCount} pages; generating it may take a while.`
      : '');
  } catch (err) {
    if (token !== state.loadToken) return;
    console.error(err);
    clearDocument();
    setStatus(err?.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password first and try again.'
      : 'Could not read this file. Use a JPG, PNG, WebP or PDF.', true);
  }
}

function clearDocument() {
  state.loadToken++;
  state.pdf?.destroy();
  state.bitmap?.close();
  if (state.previewBase) releaseCanvas(state.previewBase);
  Object.assign(state, { file: null, kind: null, bitmap: null, pdf: null, page: 1, pageCount: 0, previewBase: null });
  preview.hidden = true;
  $('preview-empty').hidden = false;
  $('pager').hidden = true;
  $('file-name').hidden = true;
  setProgress(0, null);
  setBusy(false);
}

// ---------- Preview ----------

async function refreshPreviewBase() {
  let base;
  if (state.kind === 'image') {
    const { width: w, height: h } = state.bitmap;
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(w, h));
    base = createCanvas(w * scale, h * scale).canvas;
    base.getContext('2d').drawImage(state.bitmap, 0, 0, base.width, base.height);
  } else if (state.kind === 'pdf') {
    const token = state.loadToken;
    const r = await renderPage(state.pdf, state.page, (w, h) => PREVIEW_MAX_EDGE / Math.max(w, h));
    if (token !== state.loadToken) return releaseCanvas(r.canvas);
    base = r.canvas;
    $('page-info').textContent = `Page ${state.page} of ${state.pageCount}`;
    $('prev-page').disabled = state.page <= 1;
    $('next-page').disabled = state.page >= state.pageCount;
    $('pager').hidden = state.pageCount < 2;
  } else {
    return;
  }
  if (state.previewBase) releaseCanvas(state.previewBase);
  state.previewBase = base;
  drawPreview();
}

let frame = 0;
function schedulePreview() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawPreview);
}

function drawPreview() {
  const base = state.previewBase;
  if (!base) return;
  const s = getSettings();
  preview.width = base.width;
  preview.height = base.height;
  const ctx = preview.getContext('2d');
  ctx.drawImage(base, 0, 0);
  if (s.grayscale) toGrayscale(ctx, base.width, base.height);
  drawWatermark(ctx, base.width, base.height, s);
  preview.hidden = false;
  $('preview-empty').hidden = true;
}

async function goToPage(delta) {
  const next = state.page + delta;
  if (!state.pdf || next < 1 || next > state.pageCount) return;
  state.page = next;
  await refreshPreviewBase();
}

// ---------- Export ----------

function outputName(original, ext) {
  const stem = original.replace(/\.[^.]+$/, '') || 'document';
  return `${stem}_watermarked.${ext}`;
}

async function exportImage(s, preset) {
  const { width: w, height: h } = state.bitmap;
  const scale = clampScale(w, h, Math.min(1, preset.maxEdge / Math.max(w, h)));
  const { canvas, ctx } = createCanvas(w * scale, h * scale);
  try {
    ctx.drawImage(state.bitmap, 0, 0, canvas.width, canvas.height);
    if (s.grayscale) toGrayscale(ctx, canvas.width, canvas.height);
    drawWatermark(ctx, canvas.width, canvas.height, s);
    const isJpeg = s.format === 'image/jpeg';
    const blob = await canvasToBlob(canvas, s.format, isJpeg ? preset.quality : undefined);
    return { blob, name: outputName(state.file.name, isJpeg ? 'jpg' : 'png') };
  } finally {
    releaseCanvas(canvas);
  }
}

async function exportPdf(s, preset) {
  const pages = [];
  for (let n = 1; n <= state.pageCount; n++) {
    setProgress(n - 1, state.pageCount);
    const { canvas, ctx, ptW, ptH } = await renderPage(state.pdf, n, () => preset.dpi / 72);
    try {
      if (s.grayscale) toGrayscale(ctx, canvas.width, canvas.height);
      drawWatermark(ctx, canvas.width, canvas.height, s);
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', preset.quality);
      pages.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), pxW: canvas.width, pxH: canvas.height, ptW, ptH });
    } finally {
      releaseCanvas(canvas);
    }
  }
  setProgress(state.pageCount, state.pageCount);
  return { blob: buildPdf(pages), name: outputName(state.file.name, 'pdf') };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function onExport(event) {
  event.preventDefault();
  if (state.busy || !state.kind) return;
  const s = getSettings();
  if (!s.text.trim()) {
    setStatus('Enter some watermark text first.', true);
    $('wm-text').focus();
    return;
  }
  const preset = PRESETS[s.quality];
  setBusy(true);
  setStatus('Generating…');
  try {
    const { blob, name } = state.kind === 'pdf' ? await exportPdf(s, preset) : await exportImage(s, preset);
    download(blob, name);
    const before = state.file.size;
    const ratio = blob.size / before;
    const change = ratio >= 2
      ? `${ratio.toFixed(1)}× larger`
      : `${ratio < 1 ? '−' : '+'}${Math.abs(Math.round((ratio - 1) * 100))}%`;
    let msg = `Done: ${formatBytes(before)} → ${formatBytes(blob.size)} (${change}).`;
    if (ratio > 1.5 && s.quality !== 'small') msg += ' Tip: choose “Small” for a lighter file.';
    setStatus(msg);
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong while generating the file. Try the “Small” size for very large files.', true);
  } finally {
    setProgress(0, null);
    setBusy(false);
  }
}

// ---------- Events ----------

form.addEventListener('input', () => {
  updateOutputs();
  schedulePreview();
});
form.addEventListener('submit', onExport);

$('add-date').addEventListener('click', () => {
  const textarea = $('wm-text');
  const date = new Date().toLocaleDateString();
  textarea.value = `${textarea.value.replace(/\s+$/, '')}\n${date}`.trim();
  form.dispatchEvent(new Event('input'));
});

$('reset').addEventListener('click', () => {
  clearDocument();
  fileInput.value = '';
  setStatus('');
});

$('prev-page').addEventListener('click', () => goToPage(-1));
$('next-page').addEventListener('click', () => goToPage(1));

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

// Prevent the browser from opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

updateOutputs();

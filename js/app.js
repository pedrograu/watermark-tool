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
const MAX_FILES = 50;

const $ = (id) => document.getElementById(id);
const form = $('settings');
const fileInput = $('file-input');
const dropzone = $('dropzone');
const preview = $('preview');

const state = {
  docs: [], // {id, file, kind: 'image'|'pdf', pageCount}
  selected: -1, // index into docs shown in the preview
  source: null, // {bitmap} or {pdf} for the selected doc
  page: 1,
  previewBase: null, // canvas with the page/image at preview size, no watermark
  busy: false,
  loadToken: 0,
};
let nextId = 1;

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
  $('format-row').hidden = !state.docs.some((d) => d.kind === 'image');
  $('download').textContent = state.docs.length > 1
    ? `Download ${state.docs.length} watermarked files`
    : 'Download watermarked file';
}

// ---------- Status ----------

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function setProgress(fraction, label) {
  $('progress').hidden = fraction == null;
  if (fraction != null) {
    $('progress-bar').value = fraction;
    $('progress-text').textContent = label;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setBusy(busy) {
  state.busy = busy;
  const empty = !state.docs.length;
  $('download').disabled = busy || empty;
  $('reset').disabled = busy || empty;
  fileInput.disabled = busy;
  dropzone.classList.toggle('disabled', busy);
  for (const button of $('file-list').querySelectorAll('button')) button.disabled = busy;
}

// ---------- Files ----------

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Open a file's content. The caller must call closeSource() on the result. */
async function openSource(doc) {
  return doc.kind === 'pdf'
    ? { pdf: await openPdf(await doc.file.arrayBuffer()) }
    : { bitmap: await createImageBitmap(doc.file) };
}

function closeSource(source) {
  source?.pdf?.destroy();
  source?.bitmap?.close();
}

/** Check that a file can be read and count its pages. */
async function probe(file) {
  const kind = isPdf(file) ? 'pdf' : 'image';
  const doc = { id: nextId++, file, kind, pageCount: 1 };
  const source = await openSource(doc);
  if (kind === 'pdf') doc.pageCount = source.pdf.numPages;
  closeSource(source);
  return doc;
}

function describeError(file, err) {
  return err?.name === 'PasswordException'
    ? `${file.name} is password-protected`
    : `${file.name} could not be read`;
}

async function addFiles(fileList) {
  if (state.busy) return;
  let files = [...fileList];
  const skipped = [];
  const room = MAX_FILES - state.docs.length;
  if (files.length > room) {
    skipped.push(`only ${MAX_FILES} files at a time`);
    files = files.slice(0, Math.max(0, room));
  }
  if (!files.length) return void setStatus(`Skipped: ${skipped.join('; ')}.`, true);

  setBusy(true);
  setStatus(files.length > 1 ? `Reading ${files.length} files…` : 'Loading…');
  const firstNew = state.docs.length;
  for (const file of files) {
    try {
      state.docs.push(await probe(file));
    } catch (err) {
      console.error(err);
      skipped.push(describeError(file, err));
    }
  }
  setBusy(false);
  renderFileList();
  updateOutputs();

  const pages = state.docs.reduce((sum, d) => sum + d.pageCount, 0);
  if (skipped.length) {
    setStatus(`Skipped: ${skipped.join('; ')}. Use JPG, PNG, WebP or PDF without a password.`, true);
  } else {
    setStatus(pages > 50 ? `${pages} pages in total; generating may take a while.` : '');
  }
  if (state.docs.length > firstNew) await selectDoc(firstNew);
}

async function selectDoc(index) {
  const doc = state.docs[index];
  const token = ++state.loadToken;
  closeSource(state.source);
  state.source = null;
  state.selected = index;
  state.page = 1;
  renderFileList();
  if (!doc) return showEmptyPreview();
  try {
    const source = await openSource(doc);
    if (token !== state.loadToken) return closeSource(source);
    state.source = source;
    await refreshPreviewBase();
  } catch (err) {
    console.error(err);
    if (token === state.loadToken) setStatus(`${describeError(doc.file, err)}.`, true);
  }
}

async function removeDoc(index) {
  state.docs.splice(index, 1);
  updateOutputs();
  setBusy(false);
  if (!state.docs.length) return clearAll();
  if (index < state.selected) {
    state.selected--;
    renderFileList();
  } else if (index === state.selected) {
    await selectDoc(Math.min(index, state.docs.length - 1));
  } else {
    renderFileList();
  }
}

function clearAll() {
  state.loadToken++;
  closeSource(state.source);
  Object.assign(state, { docs: [], selected: -1, source: null, page: 1 });
  fileInput.value = '';
  renderFileList();
  showEmptyPreview();
  setProgress(null);
  updateOutputs();
  setBusy(false);
}

function renderFileList() {
  const list = $('file-list');
  list.replaceChildren(...state.docs.map((doc, i) => {
    const li = document.createElement('li');
    li.className = `file-item${i === state.selected ? ' selected' : ''}`;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'file-select';
    select.setAttribute('aria-pressed', String(i === state.selected));
    select.title = 'Show in preview';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = doc.file.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const pages = doc.kind === 'pdf' ? ` · ${doc.pageCount} page${doc.pageCount > 1 ? 's' : ''}` : '';
    meta.textContent = `${doc.kind === 'pdf' ? 'PDF' : 'Image'}${pages} · ${formatBytes(doc.file.size)}`;
    select.append(name, meta);
    select.addEventListener('click', () => i !== state.selected && selectDoc(i));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Remove ${doc.file.name}`);
    remove.addEventListener('click', () => removeDoc(i));

    li.append(select, remove);
    return li;
  }));
  list.hidden = !state.docs.length;
  for (const button of list.querySelectorAll('button')) button.disabled = state.busy;
}

// ---------- Preview ----------

function showEmptyPreview() {
  if (state.previewBase) releaseCanvas(state.previewBase);
  state.previewBase = null;
  preview.hidden = true;
  $('preview-empty').hidden = false;
  $('pager').hidden = true;
}

async function refreshPreviewBase() {
  const { source } = state;
  if (!source) return;
  let base;
  if (source.bitmap) {
    const { width: w, height: h } = source.bitmap;
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(w, h));
    base = createCanvas(w * scale, h * scale).canvas;
    base.getContext('2d').drawImage(source.bitmap, 0, 0, base.width, base.height);
    $('pager').hidden = true;
  } else {
    const token = state.loadToken;
    const pageCount = source.pdf.numPages;
    const r = await renderPage(source.pdf, state.page, (w, h) => PREVIEW_MAX_EDGE / Math.max(w, h));
    if (token !== state.loadToken) return releaseCanvas(r.canvas);
    base = r.canvas;
    $('page-info').textContent = `Page ${state.page} of ${pageCount}`;
    $('prev-page').disabled = state.page <= 1;
    $('next-page').disabled = state.page >= pageCount;
    $('pager').hidden = pageCount < 2;
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
  const pdf = state.source?.pdf;
  const next = state.page + delta;
  if (!pdf || next < 1 || next > pdf.numPages) return;
  state.page = next;
  await refreshPreviewBase();
}

// ---------- Export ----------

function stem(fileName) {
  return fileName.replace(/\.[^.]+$/, '') || 'document';
}

/** Draw a bitmap at preset size with grayscale + watermark applied. */
function watermarkBitmap(bitmap, s, preset) {
  const { width: w, height: h } = bitmap;
  const scale = clampScale(w, h, Math.min(1, preset.maxEdge / Math.max(w, h)));
  const { canvas, ctx } = createCanvas(w * scale, h * scale);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (s.grayscale) toGrayscale(ctx, canvas.width, canvas.height);
  drawWatermark(ctx, canvas.width, canvas.height, s);
  return canvas;
}

/** Watermark every page of a PDF and return them as JPEG pages for buildPdf. */
async function pdfToPages(pdf, s, preset, onPage) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onPage(n);
    const { canvas, ctx, ptW, ptH } = await renderPage(pdf, n, () => preset.dpi / 72);
    try {
      if (s.grayscale) toGrayscale(ctx, canvas.width, canvas.height);
      drawWatermark(ctx, canvas.width, canvas.height, s);
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', preset.quality);
      pages.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), pxW: canvas.width, pxH: canvas.height, ptW, ptH });
    } finally {
      releaseCanvas(canvas);
    }
  }
  return pages;
}

/** Watermark one doc into its own output file. */
async function exportDoc(doc, s, preset, onPage) {
  const source = await openSource(doc);
  try {
    if (doc.kind === 'pdf') {
      const pages = await pdfToPages(source.pdf, s, preset, onPage);
      return { blob: buildPdf(pages), name: `${stem(doc.file.name)}_watermarked.pdf` };
    }
    onPage(1);
    const canvas = watermarkBitmap(source.bitmap, s, preset);
    try {
      const isJpeg = s.format === 'image/jpeg';
      const blob = await canvasToBlob(canvas, s.format, isJpeg ? preset.quality : undefined);
      return { blob, name: `${stem(doc.file.name)}_watermarked.${isJpeg ? 'jpg' : 'png'}` };
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    closeSource(source);
  }
}

/** Make output names unique: "a.pdf", "a (2).pdf", … */
function uniqueNames(results) {
  const used = new Set();
  return results.map(({ blob, name }) => {
    let candidate = name;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) {
      candidate = name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    }
    used.add(candidate.toLowerCase());
    return { blob, name: candidate };
  });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function onExport(event) {
  event.preventDefault();
  if (state.busy || !state.docs.length) return;
  const s = getSettings();
  if (!s.text.trim()) {
    setStatus('Enter some watermark text first.', true);
    $('wm-text').focus();
    return;
  }
  const preset = PRESETS[s.quality];
  const docs = [...state.docs];
  const many = docs.length > 1;
  const totalPages = docs.reduce((sum, d) => sum + d.pageCount, 0);
  let pagesDone = 0;
  const progressFor = (fileIndex, doc) => (n) => {
    const file = many ? `File ${fileIndex + 1} of ${docs.length}` : '';
    const page = doc.pageCount > 1 ? `page ${n} of ${doc.pageCount}` : '';
    setProgress(pagesDone++ / totalPages, [file, page].filter(Boolean).join(' · ') || 'Working…');
  };

  setBusy(true);
  setStatus('Generating…');
  try {
    const results = [];
    for (const [i, doc] of docs.entries()) results.push(await exportDoc(doc, s, preset, progressFor(i, doc)));
    for (const r of uniqueNames(results)) {
      download(r.blob, r.name);
      if (many) await pause(400); // browsers drop rapid back-to-back downloads
    }

    const outputSize = results.reduce((sum, r) => sum + r.blob.size, 0);
    const before = docs.reduce((sum, d) => sum + d.file.size, 0);
    const ratio = outputSize / before;
    const change = ratio >= 2
      ? `${ratio.toFixed(1)}× larger`
      : `${ratio < 1 ? '−' : '+'}${Math.abs(Math.round((ratio - 1) * 100))}%`;
    let msg = `Done: ${formatBytes(before)} → ${formatBytes(outputSize)} (${change}).`;
    if (ratio > 1.5 && s.quality !== 'small') msg += ' Tip: choose “Small” for a lighter file.';
    if (many) msg += ' If your browser asks, allow multiple downloads.';
    setStatus(msg);
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong while generating. Try the “Small” size or fewer files at once.', true);
  } finally {
    setProgress(null);
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
  clearAll();
  setStatus('');
});

$('prev-page').addEventListener('click', () => goToPage(-1));
$('next-page').addEventListener('click', () => goToPage(1));

dropzone.addEventListener('click', () => !state.busy && fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (!state.busy) fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = ''; // allow re-adding the same file later
});

// Prevent the browser from opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  dropzone.classList.remove('dragover');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

updateOutputs();

// UI wiring. Everything happens in memory in this tab; nothing is stored
// or sent anywhere.

import { drawWatermark, toGrayscale, createCanvas, canvasToBlob, releaseCanvas, clampScale } from './watermark.js?v=dev';
import { openPdf, renderPage } from './pdf-reader.js?v=dev';
import { buildPdf } from './pdf-writer.js?v=dev';
import { applyRedactions } from './redact.js?v=dev';
import { createRegionEditor } from './region-editor.js?v=dev';
import { createZoom } from './zoom.js?v=dev';

// Output presets. PDFs are rendered at `dpi`; images are downscaled so the
// long edge is at most `maxEdge`. `quality` is the JPEG quality.
const PRESETS = {
  small: { dpi: 100, maxEdge: 1600, quality: 0.6 },
  balanced: { dpi: 144, maxEdge: 2400, quality: 0.72 },
  high: { dpi: 200, maxEdge: Infinity, quality: 0.85 },
};
const PREVIEW_MAX_EDGE = 1400;
// When zoomed in, the preview is re-rendered sharper, up to this multiple.
const PREVIEW_MAX_DETAIL = 3;
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
    hide: f.hide.value,
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
  $('download-label').textContent = state.docs.length > 1 ? `Download ${state.docs.length}` : 'Download';
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
  // regions: page number → hidden areas on that page
  const doc = { id: nextId++, file, kind, pageCount: 1, regions: new Map() };
  const source = await openSource(doc);
  if (kind === 'pdf') doc.pageCount = source.pdf.numPages;
  closeSource(source);
  return doc;
}

function describeError(file, err) {
  return err?.name === 'PasswordException'
    ? `${file.name} (password)`
    : file.name;
}

async function addFiles(fileList) {
  if (state.busy) return;
  let files = [...fileList];
  const skipped = [];
  const room = MAX_FILES - state.docs.length;
  if (files.length > room) {
    skipped.push(`files over ${MAX_FILES}`);
    files = files.slice(0, Math.max(0, room));
  }
  if (!files.length) return void setStatus(`Skipped ${skipped.join(', ')}`, true);

  setBusy(true);
  setStatus('Loading…');
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
    setStatus(`Couldn't open ${skipped.join(', ')}`, true);
  } else {
    setStatus(pages > 50 ? `${pages} pages · this may take a moment` : '');
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
  zoom.reset();
  renderFileList();
  if (!doc) return showEmptyPreview();
  try {
    const source = await openSource(doc);
    if (token !== state.loadToken) return closeSource(source);
    state.source = source;
    await refreshPreviewBase();
  } catch (err) {
    console.error(err);
    if (token === state.loadToken) setStatus(`Couldn't open ${describeError(doc.file, err)}`, true);
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

// ---------- Rename ----------

/** Turn a list item into a name field; Enter or leaving saves, Esc cancels. */
function startRename(li, doc) {
  if (state.busy || li.querySelector('.rename')) return;
  const ext = outputExt(doc);
  const box = document.createElement('span');
  box.className = 'rename';
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = doc.outName || `${stem(doc.file.name)}_watermarked`;
  input.setAttribute('aria-label', 'File name');
  input.spellcheck = false;
  const suffix = document.createElement('span');
  suffix.className = 'rename-ext';
  suffix.textContent = `.${ext}`;
  box.append(input, suffix);
  li.querySelector('.file-select').replaceWith(box);
  li.classList.add('renaming');
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const clean = input.value
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '') // not allowed in file names
        .trim()
        .replace(new RegExp(`\\.${ext}$`, 'i'), '') // the extension is added for them
        .replace(/[. ]+$/, '')
        .slice(0, 120);
      doc.outName = clean && clean !== `${stem(doc.file.name)}_watermarked` ? clean : null;
    }
    renderFileList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
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
    name.textContent = doc.outName ? `${doc.outName}.${outputExt(doc)}` : doc.file.name;
    if (doc.outName) name.title = `Original: ${doc.file.name}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const pages = doc.kind === 'pdf' ? ` · ${doc.pageCount} page${doc.pageCount > 1 ? 's' : ''}` : '';
    meta.textContent = doc.kind === 'pdf' ? `${doc.pageCount} page${doc.pageCount > 1 ? 's' : ''}` : formatBytes(doc.file.size);
    meta.title = `${doc.kind === 'pdf' ? `PDF${pages}` : 'Image'} · ${formatBytes(doc.file.size)}`;
    select.append(name, meta);
    select.addEventListener('click', () => i !== state.selected && selectDoc(i));
    select.addEventListener('dblclick', () => startRename(li, doc));

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'file-action';
    rename.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>';
    rename.setAttribute('aria-label', `Rename ${doc.file.name}`);
    rename.title = 'Rename';
    rename.addEventListener('click', () => startRename(li, doc));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-action file-remove';
    remove.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.setAttribute('aria-label', `Remove ${doc.file.name}`);
    remove.addEventListener('click', () => removeDoc(i));

    li.append(select, rename, remove);
    return li;
  }));
  list.hidden = !state.docs.length;
  document.body.classList.toggle('has-files', state.docs.length > 0);
  for (const button of list.querySelectorAll('button')) button.disabled = state.busy;
}

// ---------- Preview ----------

function showEmptyPreview() {
  if (state.previewBase) releaseCanvas(state.previewBase);
  state.previewBase = null;
  preview.hidden = true;
  $('preview-empty').hidden = false;
  $('pager').hidden = true;
  editor.setDrawMode(false);
  editor.render();
  zoom.reset();
  updateHideToolbar();
}

// ---------- Hidden areas ----------

/** Hidden areas of the page shown in the preview ([] if none). */
function currentRegions(create) {
  const doc = state.docs[state.selected];
  if (!doc) return [];
  if (!doc.regions.has(state.page)) {
    if (!create) return [];
    doc.regions.set(state.page, []);
  }
  return doc.regions.get(state.page);
}

const editor = createRegionEditor($('region-overlay'), {
  getRegions: currentRegions,
  onChange: () => {
    schedulePreview();
    updateHideToolbar();
  },
});

function updateHideToolbar() {
  const drawing = editor.isDrawing();
  const count = currentRegions(false).length;
  $('hide-toolbar').hidden = !state.previewBase;
  $('hide-toggle').setAttribute('aria-pressed', String(drawing));
  $('hide-toggle-label').textContent = drawing ? 'Done' : 'Hide';
  $('hide-style').hidden = !drawing && !count;
  // Shown together with the styles (not on first area) so the preview never jumps while drawing
  $('hide-clear').hidden = !drawing && !count;
  $('hide-clear').disabled = !count;
  $('hide-hint').hidden = !drawing || count > 0; // it covers the page top, so only until the first area
}

// ---------- Zoom ----------

const zoom = createZoom({
  stage: $('stage'),
  canvas: preview,
  badge: $('zoom-badge'),
  canPan: (e) => !editor.isDrawing() && [$('stage'), $('region-overlay'), preview].includes(e.target),
  onPinchStart: () => editor.cancel(),
  onChange: scheduleDetail,
});

// Re-render the page sharper (or lighter) once zooming settles.
let detailTimer = 0;
let renderedEdge = 0;
function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    if (state.previewBase && previewEdge() !== renderedEdge) refreshPreviewBase();
  }, 250);
}

function setDrawMode(on) {
  editor.setDrawMode(on);
  updateHideToolbar();
}

/** Longest side of the preview render: sharper when zoomed in. */
function previewEdge() {
  return PREVIEW_MAX_EDGE * Math.min(PREVIEW_MAX_DETAIL, Math.ceil(zoom.level()));
}

async function refreshPreviewBase() {
  const { source } = state;
  if (!source) return;
  let base;
  if (source.bitmap) {
    const { width: w, height: h } = source.bitmap;
    const scale = clampScale(w, h, Math.min(1, previewEdge() / Math.max(w, h)));
    base = createCanvas(w * scale, h * scale).canvas;
    base.getContext('2d').drawImage(source.bitmap, 0, 0, base.width, base.height);
    $('pager').hidden = true;
  } else {
    const token = state.loadToken;
    const pageCount = source.pdf.numPages;
    const r = await renderPage(source.pdf, state.page, (w, h) => previewEdge() / Math.max(w, h));
    if (token !== state.loadToken) return releaseCanvas(r.canvas);
    base = r.canvas;
    $('page-info').textContent = `${state.page} / ${pageCount}`;
    $('prev-page').disabled = state.page <= 1;
    $('next-page').disabled = state.page >= pageCount;
    $('pager').hidden = pageCount < 2;
  }
  if (state.previewBase) releaseCanvas(state.previewBase);
  state.previewBase = base;
  renderedEdge = previewEdge();
  drawPreview();
  editor.render();
  updateHideToolbar();
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
  applyRedactions(ctx, base.width, base.height, currentRegions(false), s.hide);
  drawWatermark(ctx, base.width, base.height, s);
  preview.hidden = false;
  $('preview-empty').hidden = true;
}

async function goToPage(delta) {
  const pdf = state.source?.pdf;
  const next = state.page + delta;
  if (!pdf || next < 1 || next > pdf.numPages) return;
  state.page = next;
  zoom.reset();
  await refreshPreviewBase();
}

// ---------- Export ----------

function stem(fileName) {
  return fileName.replace(/\.[^.]+$/, '') || 'document';
}

/** Extension of the file a doc will be downloaded as. */
function outputExt(doc) {
  if (doc.kind === 'pdf') return 'pdf';
  return getSettings().format === 'image/png' ? 'png' : 'jpg';
}

/** Custom name if the user renamed the file, else "<original>_watermarked". */
function outputName(doc) {
  return `${doc.outName || `${stem(doc.file.name)}_watermarked`}.${outputExt(doc)}`;
}

/** Draw a bitmap at preset size with grayscale + watermark applied. */
function watermarkBitmap(bitmap, s, preset, regions) {
  const { width: w, height: h } = bitmap;
  const scale = clampScale(w, h, Math.min(1, preset.maxEdge / Math.max(w, h)));
  const { canvas, ctx } = createCanvas(w * scale, h * scale);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (s.grayscale) toGrayscale(ctx, canvas.width, canvas.height);
  applyRedactions(ctx, canvas.width, canvas.height, regions, s.hide);
  drawWatermark(ctx, canvas.width, canvas.height, s);
  return canvas;
}

/** Watermark every page of a PDF and return them as JPEG pages for buildPdf. */
async function pdfToPages(pdf, s, preset, onPage, regionsByPage) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onPage(n);
    const { canvas, ctx, ptW, ptH } = await renderPage(pdf, n, () => preset.dpi / 72);
    try {
      if (s.grayscale) toGrayscale(ctx, canvas.width, canvas.height);
      applyRedactions(ctx, canvas.width, canvas.height, regionsByPage.get(n), s.hide);
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
      const pages = await pdfToPages(source.pdf, s, preset, onPage, doc.regions);
      return { blob: buildPdf(pages), name: outputName(doc) };
    }
    onPage(1);
    const canvas = watermarkBitmap(source.bitmap, s, preset, doc.regions.get(1));
    try {
      const isJpeg = s.format === 'image/jpeg';
      const blob = await canvasToBlob(canvas, s.format, isJpeg ? preset.quality : undefined);
      return { blob, name: outputName(doc) };
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
    setStatus('Add some text first', true);
    $('wm-text').focus();
    return;
  }
  const preset = PRESETS[s.quality];
  const docs = [...state.docs];
  const many = docs.length > 1;
  const totalPages = docs.reduce((sum, d) => sum + d.pageCount, 0);
  let pagesDone = 0;
  const progressFor = (fileIndex, doc) => (n) => {
    const file = many ? `${fileIndex + 1}/${docs.length}` : '';
    const page = doc.pageCount > 1 ? `p. ${n}/${doc.pageCount}` : '';
    setProgress(pagesDone++ / totalPages, [file, page].filter(Boolean).join(' · '));
  };

  setBusy(true);
  setStatus('');
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
    let msg = `✓ ${formatBytes(outputSize)} (${change})`;
    if (ratio > 1.5 && s.quality !== 'small') msg += ' · smaller: Options → File size';
    setStatus(msg);
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong. Try a smaller file size in Options.', true);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

// ---------- Events ----------

$('hide-toggle').addEventListener('click', () => setDrawMode(!editor.isDrawing()));
$('hide-style').addEventListener('input', schedulePreview); // radios live outside the form element
$('hide-clear').addEventListener('click', () => {
  currentRegions(false).length = 0;
  editor.render();
  schedulePreview();
  updateHideToolbar();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editor.isDrawing()) setDrawMode(false);
});

form.addEventListener('input', (e) => {
  if (e.target.name === 'format') renderFileList(); // renamed files show the new extension
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

// Put every advanced option back to the value written in the HTML,
// leaving the watermark text alone.
$('restore-defaults').addEventListener('click', () => {
  for (const el of $('advanced').querySelectorAll('input, select')) {
    if (el.type === 'radio' || el.type === 'checkbox') el.checked = el.defaultChecked;
    else if (el.tagName === 'SELECT') for (const o of el.options) o.selected = o.defaultSelected;
    else el.value = el.defaultValue;
  }
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

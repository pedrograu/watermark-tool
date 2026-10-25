// Drawing helpers shared by the image and PDF pipelines.
// All sizes are relative to the canvas, so the preview and the
// full-resolution export look identical.

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/**
 * Draw the watermark text onto a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w canvas width in px
 * @param {number} h canvas height in px
 * @param {{text: string, opacity: number, size: number, angle: number,
 *          color: string, layout: 'tiled'|'single', spacing: number}} opts
 *   opacity 0–1, size = % of the shorter side, angle in degrees,
 *   spacing = gap between tiles as a multiple of the font size.
 */
export function drawWatermark(ctx, w, h, opts) {
  const lines = opts.text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;

  const fontPx = Math.max(4, (opts.size / 100) * Math.min(w, h));
  const lineHeight = fontPx * 1.2;

  ctx.save();
  ctx.globalAlpha = opts.opacity;
  ctx.fillStyle = opts.color;
  ctx.font = `700 ${fontPx}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const blockW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const blockH = lines.length * lineHeight;

  const drawBlock = (cx, cy) => {
    const top = cy - blockH / 2 + lineHeight / 2;
    lines.forEach((line, i) => ctx.fillText(line, cx, top + i * lineHeight));
  };

  ctx.translate(w / 2, h / 2);
  ctx.rotate((opts.angle * Math.PI) / 180);

  if (opts.layout === 'single') {
    drawBlock(0, 0);
  } else {
    const gap = fontPx * opts.spacing;
    const stepX = blockW + gap;
    const stepY = blockH + gap;
    // After rotating, the canvas must still be fully covered: tile a square
    // as large as the diagonal, with alternate rows offset (brick pattern).
    const half = Math.hypot(w, h) / 2 + Math.max(stepX, stepY);
    const rows = Math.ceil(half / stepY);
    const cols = Math.ceil(half / stepX) + 1;
    for (let r = -rows; r <= rows; r++) {
      const offset = r % 2 ? stepX / 2 : 0;
      for (let c = -cols; c <= cols; c++) {
        drawBlock(c * stepX + offset, r * stepY);
      }
    }
  }
  ctx.restore();
}

/** Convert the canvas contents to grayscale in place. */
export function toGrayscale(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
}

/** Create a canvas with a white background (JPEG has no transparency). */
export function createCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/** Promise wrapper around canvas.toBlob. */
export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type, quality);
  });
}

/** Free the memory held by a canvas (important on mobile Safari). */
export function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

// Browsers refuse canvases above ~16.7 MP (Safari) — stay safely below.
export const MAX_PIXELS = 16_000_000;

/** Scale factor that keeps w*h*scale² under MAX_PIXELS. */
export function clampScale(w, h, scale) {
  const max = Math.sqrt(MAX_PIXELS / (w * h));
  return Math.min(scale, max);
}

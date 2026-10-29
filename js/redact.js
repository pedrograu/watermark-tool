// Hide parts of a page by painting over its pixels. Because every output is
// flattened to an image, the original content under a hidden area is gone.
// Region coordinates are fractions (0–1) of the page, so the preview and the
// full-resolution export get exactly the same result.

/** Copy a rectangle of `src` into a new canvas of the given size (smoothed). */
function scaled(src, sx, sy, sw, sh, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w canvas width in px
 * @param {number} h canvas height in px
 * @param {{x: number, y: number, w: number, h: number}[]} regions
 * @param {'box'|'pixelate'|'blur'} style
 */
export function applyRedactions(ctx, w, h, regions, style) {
  if (!regions?.length) return;
  // Pixel block size, relative to the page so it looks the same at any DPI.
  const cell = Math.max(6, Math.round(Math.min(w, h) * 0.04));

  for (const r of regions) {
    const x = Math.max(0, Math.floor(r.x * w));
    const y = Math.max(0, Math.floor(r.y * h));
    const rw = Math.min(w - x, Math.ceil(r.w * w));
    const rh = Math.min(h - y, Math.ceil(r.h * h));
    if (rw < 1 || rh < 1) continue;

    if (style === 'box') {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, rw, rh);
      ctx.restore();
      continue;
    }

    // Pixelate and blur: shrink the area to a few pixels, then stretch it
    // back. Without smoothing that gives big blocks; with smoothing (through
    // an intermediate size, to avoid a visible grid) a strong blur.
    const small = scaled(ctx.canvas, x, y, rw, rh, rw / cell, rh / cell);
    const source = style === 'blur' ? scaled(small, 0, 0, small.width, small.height, small.width * 4, small.height * 4) : small;

    ctx.save();
    ctx.imageSmoothingEnabled = style === 'blur';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, source.width, source.height, x, y, rw, rh);
    ctx.restore();
  }
}

# Watermark Tool

Add a semi-transparent text watermark to images and PDFs — for example an ID
you have to send with a rental application — **entirely in your browser**.

**Live:** https://pedrograu.github.io/watermark/

## Privacy

- Files are processed in memory in your browser tab. Nothing is uploaded, stored or logged.
- The page sets a Content-Security-Policy with `connect-src 'none'`, so the
  browser itself blocks any network request (fetch, XHR, WebSocket, beacon)
  from the page. You can verify this in the DevTools Network tab.
- No analytics, cookies, external fonts or CDNs. The only dependency
  ([pdf.js](https://github.com/mozilla/pdf.js)) is hosted in this repository.
- Output files carry no metadata: images are re-encoded (EXIF/GPS removed) and
  PDFs are rebuilt from scratch.

## Features

- JPG, PNG, WebP and PDF (multi-page) input.
- Several files at once (up to 50): the same settings apply to all, click a
  file in the list to preview it, and each one downloads as its own
  watermarked file.
- Rename a file before downloading (pencil icon, or double-click its name):
  `12dfsfdsf.pdf` renamed to `PedroId` downloads as `PedroId.pdf`. Files you
  don't rename download as `<original>_watermarked`.
- Pictures are saved as **PDF** by default, or as JPEG/PNG (Options → Format). As PDF,
  each picture becomes a one-page PDF sized to the picture.
- Watermark text (multi-line), opacity, size, angle, color.
- Tiled (repeated, hard to crop) or single centered layout.
- **Hide areas** such as the ID number: click *Hide* above the preview
  and drag over it. Areas can be moved, resized and removed, and belong to one
  page of one file. Styles: **Box** (recommended for numbers and other
  sensitive data), **Pixelate** and **Blur**. Blurred or pixelated text can
  sometimes be guessed back, so use Box for anything sensitive. Because
  the output is flattened, the hidden content is not in the file at all.
- Live preview with page navigation for PDFs.
- Zoom the preview with the mouse wheel, a trackpad pinch or two fingers on a
  phone; double-click / double-tap toggles zoom, drag to move around.
- PDFs are **flattened**: each page becomes an image with the watermark burned
  in, so the watermark can't be removed with a PDF editor. The output text is
  not selectable.
- File size presets (Small / Medium / High) and a Black & white option to
  keep the output small. The original and new sizes are shown after export.

| Preset   | PDF resolution | Image max edge | JPEG quality |
|----------|----------------|----------------|--------------|
| Small    | 100 DPI        | 1600 px        | 0.60         |
| Medium   | 144 DPI        | 2400 px        | 0.72         |
| High     | 200 DPI        | original       | 0.85         |

## Run locally

ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml`, which publishes the site
to GitHub Pages. One-time setup: **Settings → Pages → Build and deployment →
Source: GitHub Actions**.

## Project structure

```
index.html            page + Content-Security-Policy
css/styles.css
js/app.js             UI wiring and export flow
js/watermark.js       draws the watermark on a canvas (shared)
js/pdf-reader.js      pdf.js wrapper: PDF page → canvas
js/pdf-writer.js      minimal PDF writer: JPEG pages → PDF
js/redact.js          paints hidden areas (box / pixelate / blur)
js/region-editor.js   draw, move, resize hidden areas on the preview
js/zoom.js            wheel / pinch / double-tap zoom and panning of the preview
vendor/pdfjs/         pdf.js 4.10.38 (Apache-2.0), self-hosted
```

## License

MIT. pdf.js is Apache-2.0 (see `vendor/pdfjs/LICENSE`).

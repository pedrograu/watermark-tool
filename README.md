# Watermark Tool

Add a semi-transparent text watermark to images and PDFs — for example an ID
you have to send with a rental application — **entirely in your browser**.

**Live:** https://pedrograu.github.io/watermark-tool/

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
- Watermark text (multi-line), opacity, size, angle, color.
- Tiled (repeated, hard to crop) or single centered layout.
- Live preview with page navigation for PDFs.
- PDFs are **flattened**: each page becomes an image with the watermark burned
  in, so the watermark can't be removed with a PDF editor. The output text is
  not selectable.
- File size presets (Small / Balanced / High) and a Black & white option to
  keep the output small. The original and new sizes are shown after export.

| Preset   | PDF resolution | Image max edge | JPEG quality |
|----------|----------------|----------------|--------------|
| Small    | 100 DPI        | 1600 px        | 0.60         |
| Balanced | 144 DPI        | 2400 px        | 0.72         |
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
vendor/pdfjs/         pdf.js 4.10.38 (Apache-2.0), self-hosted
```

## License

MIT. pdf.js is Apache-2.0 (see `vendor/pdfjs/LICENSE`).

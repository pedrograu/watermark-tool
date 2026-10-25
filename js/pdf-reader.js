// Thin wrapper around the self-hosted pdf.js. The library (~1.7 MB) is only
// loaded the first time a PDF is opened, so image-only use stays light.

import { createCanvas, clampScale } from './watermark.js?v=dev';

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Open a PDF from its bytes. Throws an Error with name 'PasswordException'
 * for encrypted files.
 * @param {ArrayBuffer} buffer
 */
export async function openPdf(buffer) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // no eval: required by our CSP and safer
    useSystemFonts: true, // standard fonts can't be fetched (connect-src 'none')
    enableXfa: false,
  }).promise;
}

/**
 * Render one page to a new canvas with a white background.
 * @param {*} pdf pdf.js document
 * @param {number} pageNumber 1-based
 * @param {(ptW: number, ptH: number) => number} pickScale returns px per pt
 * @returns {Promise<{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, ptW: number, ptH: number}>}
 */
export async function renderPage(pdf, pageNumber, pickScale) {
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 }); // 1 unit = 1 pt, page rotation applied
    const scale = clampScale(base.width, base.height, pickScale(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const { canvas, ctx } = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: ctx, viewport, annotationMode: 2 /* ENABLE_FORMS: print form values */ }).promise;
    return { canvas, ctx, ptW: base.width, ptH: base.height };
  } finally {
    page.cleanup();
  }
}

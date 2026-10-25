// Minimal PDF writer: every page is one full-page JPEG image.
// A JPEG can be embedded as-is (DCTDecode filter), so no compression
// library is needed and the output is as small as the JPEGs themselves.
// No metadata (author, producer, dates) is written.

const encoder = new TextEncoder();
const num = (n) => (Math.round(n * 1000) / 1000).toString();

/**
 * @param {{jpeg: Uint8Array, pxW: number, pxH: number, ptW: number, ptH: number}[]} pages
 * @returns {Blob} application/pdf
 */
export function buildPdf(pages) {
  const chunks = [];
  const offsets = []; // byte offset of each object, index = object number - 1
  let length = 0;

  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObject = (id) => {
    offsets[id - 1] = length;
    push(`${id} 0 obj\n`);
  };

  // Header; the binary comment tells transfer tools the file is binary.
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object layout: 1 = catalog, 2 = page tree, then 3 objects per page.
  const pageIds = pages.map((_, i) => 3 + i * 3);

  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const pageId = pageIds[i];
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const content = `q ${num(p.ptW)} 0 0 ${num(p.ptH)} 0 0 cm /Im0 Do Q`;

    beginObject(pageId);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.ptW)} ${num(p.ptH)}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);

    beginObject(imageId);
    push(`<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push('\nendstream\nendobj\n');

    beginObject(contentId);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const xrefOffset = length;
  const count = offsets.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}

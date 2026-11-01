/**
 * Safe reading of PDF metadata and embedded text using pdf.js.
 *
 * PDFs are untrusted input. They are opened with script evaluation and font loading disabled, so nothing embedded
 * in the document is executed; only text and metadata are read. pdf.js version 6 relies on `Promise.withResolvers`,
 * which is native from Node 22; a small polyfill is installed for Node 20 development machines (production images
 * run Node 24).
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs/promises';

// pdf.js 6 uses Promise.withResolvers (Node 22+). Polyfill for Node 20 development machines; production
// images run Node 24 where it is native.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/**
 * Opens a PDF file with pdf.js in a safe configuration.
 *
 * A `close` method is attached to the returned document that releases the pdf.js resources, whichever pdf.js API
 * version is installed.
 *
 * @param {string} filePath Path of the PDF.
 * @returns {Promise<object>} The loaded pdf.js document.
 */
async function load(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  // Untrusted input: evaluation disabled, no fonts or scripts executed; only text and metadata are read.
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  doc.close = () => (typeof doc.destroy === 'function' ? doc.destroy() : task.destroy());
  return doc;
}

/**
 * Reads basic information about a PDF: page count, title, producing software, PDF version and whether it declares
 * PDF/A conformance (relevant for long-term preservation).
 *
 * @param {string} filePath Path of the PDF.
 * @returns {Promise<object>} The PDF information.
 */
export async function pdfInfo(filePath) {
  const doc = await load(filePath);
  const meta = await doc.getMetadata().catch(() => ({}));
  const info = {
    pageCount: doc.numPages,
    title: meta.info?.Title || null,
    producer: meta.info?.Producer || null,
    pdfVersion: meta.info?.PDFFormatVersion || null,
    isPdfA: /pdfaid/i.test(meta.metadata?.getRaw?.() || ''),
    tool: 'pdf.js',
  };
  await doc.close();
  return info;
}

/**
 * Extracts the embedded text of each page of a born-digital PDF.
 *
 * @param {string} filePath Path of the PDF.
 * @param {number} [maxPages=2000] Maximum number of pages to read, to bound the work done for very large files.
 * @returns {Promise<Array<{ pageNumber: number, text: string }>>} One entry per page; pages of a scanned PDF have
 *   empty text.
 */
export async function pdfTextLayer(filePath, maxPages = 2000) {
  const doc = await load(filePath);
  const pages = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push({
      pageNumber: p,
      text: content.items
        .map((i) => i.str + (i.hasEOL ? '\n' : ' '))
        .join('')
        .trim(),
    });
  }
  await doc.close();
  return pages;
}

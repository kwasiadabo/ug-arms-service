/**
 * University of Ghana branding for generated documents.
 *
 * Holds the crest colours (matching the frontend theme in frontend/src/styles/index.css) and the location of the
 * crest image, and provides a helper that places the crest on PDF pages such as accession receipts, disposal
 * certificates and reports.
 *
 * @author Kwasi Adabo Boakye
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// University of Ghana crest colours, matching the frontend theme (frontend/src/styles/index.css).
export const BRAND = { indigo: '#2b1471', gold: '#dfb725', goldText: '#8a6a0c', ink: '#1e1c2b' };

export const CREST_PATH = fileURLToPath(new URL('../assets/ug-crest.png', import.meta.url));
const crestAvailable = fs.existsSync(CREST_PATH);

/**
 * Draws the University crest in the top-right corner of the current PDF page.
 *
 * The text cursor position is restored afterwards, so the caller's layout is not affected. Nothing is drawn if the
 * crest image is missing.
 *
 * @param {PDFKit.PDFDocument} doc The PDF document being written.
 * @param {number} [size=52] Width and height of the crest in points.
 */
export function stampCrest(doc, size = 52) {
  if (!crestAvailable) return;
  const { x, y } = doc;
  doc.image(CREST_PATH, doc.page.width - doc.page.margins.right - size, doc.page.margins.top - 8, {
    fit: [size, size],
  });
  doc.x = x;
  doc.y = y;
}

/**
 * Printable labels for boxes, folders, shelves and other locations. Each label carries the code twice in machine-
 * readable form: a QR code, for phone cameras and 2D imaging scanners, and a Code 128 linear barcode, for the laser
 * scanners common at issue desks, which cannot read QR codes.
 *
 * @author Kwasi Adabo Boakye
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import bwipjs from 'bwip-js';
import { BRAND } from '../../services/branding.js';

/**
 * Draws a Code 128 barcode for a code, or returns null for a code outside printable ASCII, in which case the label
 * relies on its QR code. Accented letters can be squeezed into Code 128, but scanners read them back as different
 * characters (BOÎTE-7 comes back as BOÃTE-7), and a barcode that scans as the wrong code is worse than none.
 *
 * @param {string} code The code to encode.
 * @returns {Promise<Buffer|null>} A PNG of the bars, without human-readable text (the label prints the code above).
 */
export async function code128Png(code) {
  if (!/^[\x20-\x7e]+$/.test(code)) return null;
  try {
    return await bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 10, includetext: false });
  } catch {
    return null;
  }
}

/**
 * Lays out labels on A4 pages, two columns by six rows. Each label shows a QR code, the archive name, the code, a
 * title (shortened if too long), an optional subtitle and, along the bottom, a Code 128 barcode of the code. The
 * barcode keeps a blank margin on each side, which scanners need to find where the bars begin and end.
 *
 * @param {Array<{ code: string, title?: string, subtitle?: string }>} labels The labels to print.
 * @returns {Promise<PDFKit.PDFDocument>} The finished PDF stream.
 */
export async function labelsPdf(labels) {
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: 'UG-ARMS labels' } });
  const cols = 2;
  const rows = 6;
  const perPage = cols * rows;
  const w = 260;
  const h = 120;
  const text = 84; // left edge of the text beside the QR code
  let i = 0;
  for (const label of labels) {
    if (i > 0 && i % perPage === 0) doc.addPage();
    const pos = i % perPage;
    const x = 30 + (pos % cols) * (w + 15);
    const y = 30 + Math.floor(pos / cols) * (h + 8);
    doc.roundedRect(x, y, w, h, 6).lineWidth(0.5).strokeColor('#9ca3af').stroke();
    const qr = await QRCode.toBuffer(label.code, { margin: 0, width: 180, errorCorrectionLevel: 'M' });
    doc.image(qr, x + 10, y + 10, { width: 64 });
    doc
      .fillColor(BRAND.indigo)
      .fontSize(7)
      .text('UNIVERSITY OF GHANA ARCHIVES', x + text, y + 11, { width: w - text - 10 });
    doc
      .fillColor('#111')
      .fontSize(12)
      .text(label.code, x + text, y + 22, { width: w - text - 10, height: 15, ellipsis: true });
    doc
      .fillColor('#333')
      .fontSize(8)
      .text(label.title || '', x + text, y + 40, { width: w - text - 10, height: 20, ellipsis: true });
    if (label.subtitle)
      doc
        .fillColor('#666')
        .fontSize(7)
        .text(label.subtitle, x + text, y + 63, { width: w - text - 10, height: 9, ellipsis: true });
    const bars = await code128Png(label.code);
    if (bars) doc.image(bars, x + 20, y + 82, { width: w - 40, height: 28 });
    i += 1;
  }
  doc.end();
  return doc;
}

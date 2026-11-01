/**
 * Printable labels for boxes, folders, shelves and other locations, with a QR code encoding the barcode or location
 * code.
 *
 * @author Kwasi Adabo Boakye
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { BRAND } from '../../services/branding.js';

/**
 * Lays out labels on A4 pages, two columns by six rows. Each label shows a QR code, the archive name, the code, a
 * title (shortened if too long) and an optional subtitle.
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
  let i = 0;
  for (const label of labels) {
    if (i > 0 && i % perPage === 0) doc.addPage();
    const pos = i % perPage;
    const x = 30 + (pos % cols) * (w + 15);
    const y = 30 + Math.floor(pos / cols) * (h + 8);
    doc.roundedRect(x, y, w, h, 6).lineWidth(0.5).strokeColor('#9ca3af').stroke();
    const png = await QRCode.toBuffer(label.code, { margin: 0, width: 180, errorCorrectionLevel: 'M' });
    doc.image(png, x + 10, y + 12, { width: 90 });
    doc
      .fillColor(BRAND.indigo)
      .fontSize(7)
      .text('UNIVERSITY OF GHANA ARCHIVES', x + 110, y + 14, { width: w - 120 });
    doc
      .fillColor('#111')
      .fontSize(13)
      .text(label.code, x + 110, y + 28, { width: w - 120 });
    doc
      .fillColor('#333')
      .fontSize(8)
      .text(label.title || '', x + 110, y + 48, { width: w - 120, height: 40, ellipsis: true });
    if (label.subtitle)
      doc
        .fillColor('#666')
        .fontSize(7)
        .text(label.subtitle, x + 110, y + 92, { width: w - 120 });
    i += 1;
  }
  doc.end();
  return doc;
}

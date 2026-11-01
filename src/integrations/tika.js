/**
 * Optional document metadata and text extraction through an Apache Tika server.
 *
 * Tika is disabled unless TIKA_ENABLED is true. Files are streamed to the server and only the extracted values come
 * back; nothing is executed.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import { env } from '../config/env.js';

/**
 * Extracts descriptive and technical metadata from a document: title, creator, creation and modification dates,
 * page count, language, producing software, PDF version and PDF/A conformance.
 *
 * Errors are returned as `{ error }` instead of being thrown, so ingest can continue without this metadata.
 *
 * @param {string} filePath Path of the document.
 * @param {string} [mediaType] Detected media type, passed to Tika as the content type.
 * @returns {Promise<object|null>} The metadata, `{ error }` on failure, or null when Tika is disabled.
 */
export async function extractMetadata(filePath, mediaType) {
  if (!env.TIKA_ENABLED) return null;
  try {
    const res = await fetch(`${env.TIKA_URL}/meta`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': mediaType || 'application/octet-stream' },
      body: fs.createReadStream(filePath),
      duplex: 'half',
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { error: `Tika returned ${res.status}` };
    const meta = await res.json();

    /**
     * Reads one property from the Tika response, returning null when it is absent.
     *
     * @param {string} k Tika property name, for example "dc:title".
     * @returns {*} The property value or null.
     */
    const pick = (k) => meta[k] ?? null;
    return {
      title: pick('dc:title'),
      creator: pick('dc:creator'),
      created: pick('dcterms:created'),
      modified: pick('dcterms:modified'),
      pageCount: pick('xmpTPg:NPages'),
      language: pick('language'),
      producer: pick('pdf:producer'),
      pdfVersion: pick('pdf:PDFVersion'),
      pdfaConformance: pick('pdfa:PDFVersion'),
      tool: 'tika',
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Extracts the plain text of a document with Tika.
 *
 * @param {string} filePath Path of the document.
 * @param {string} [mediaType] Detected media type.
 * @returns {Promise<string|null>} The extracted text, or null when Tika is disabled or the extraction failed.
 */
export async function extractText(filePath, mediaType) {
  if (!env.TIKA_ENABLED) return null;
  const res = await fetch(`${env.TIKA_URL}/tika`, {
    method: 'PUT',
    headers: { Accept: 'text/plain', 'Content-Type': mediaType || 'application/octet-stream' },
    body: fs.createReadStream(filePath),
    duplex: 'half',
    signal: AbortSignal.timeout(300_000),
  });
  return res.ok ? res.text() : null;
}

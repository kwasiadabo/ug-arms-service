/**
 * Optical character recognition (OCR) for images and PDF files.
 *
 * Three engines are supported, in order of preference:
 * - a remote OCR service at OCR_SERVICE_URL, if configured;
 * - the Tesseract command-line tool (installed in the worker image), with pdftoppm to turn scanned PDFs into page
 *   images;
 * - tesseract.js (WebAssembly) as a fallback for single images on machines without Tesseract.
 *
 * PDFs that already contain a text layer use that text directly. Uploaded files are untrusted: they are only read,
 * and errors raised while recognising a damaged file fail that single OCR job instead of stopping the worker. OCR
 * text is machine output and is not an authoritative transcription.
 *
 * @author Kwasi Adabo Boakye
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { env } from '../config/env.js';
import { pdfTextLayer } from './pdf.js';

const run = promisify(execFile);

// Language data downloaded by tesseract.js is cached here instead of the process's working directory.
const TESSDATA_CACHE = path.join(os.tmpdir(), 'ug-arms-tessdata');

/**
 * Checks whether the Tesseract command-line tool is installed.
 *
 * @returns {Promise<string|null>} The first line of `tesseract --version` (the engine version), or null if the tool
 *   is not available.
 */
async function tesseractCli() {
  try {
    const { stdout, stderr } = await run(env.TESSERACT_PATH, ['--version'], { timeout: 10_000 });
    return ((stdout || stderr).split('\n')[0] || 'tesseract').trim();
  } catch {
    return null;
  }
}

/**
 * Calculates the mean word confidence from Tesseract's TSV output.
 *
 * Only rows that contain a recognised word and a non-negative confidence are counted; layout rows for blocks,
 * paragraphs and lines are ignored.
 *
 * @param {string} tsv Tesseract TSV output, including its header row.
 * @returns {number|null} Mean confidence from 0 to 100, or null if no words were recognised.
 */
function meanConfidence(tsv) {
  const words = tsv
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 12 && c[11]?.trim() && Number(c[10]) >= 0);
  return words.length ? words.reduce((s, c) => s + Number(c[10]), 0) / words.length : null;
}

/**
 * Recognises the text of one image with the Tesseract command-line tool.
 *
 * Text and TSV output are written to temporary files, which are deleted after reading. The process is stopped after
 * ten minutes.
 *
 * @param {string} filePath Path of the image.
 * @param {string} language Tesseract language code, for example "eng".
 * @returns {Promise<{ text: string, confidence: number|null }>}
 */
async function ocrImageCli(filePath, language) {
  const outBase = path.join(os.tmpdir(), `ocr-${process.pid}-${Date.now()}`);
  await run(env.TESSERACT_PATH, [filePath, outBase, '-l', language, 'txt', 'tsv'], {
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  const [text, tsv] = await Promise.all([fs.readFile(`${outBase}.txt`, 'utf8'), fs.readFile(`${outBase}.tsv`, 'utf8')]);
  await Promise.all([fs.rm(`${outBase}.txt`, { force: true }), fs.rm(`${outBase}.tsv`, { force: true })]);
  return { text: text.trim(), confidence: meanConfidence(tsv) };
}

/**
 * Recognises the text of one image with tesseract.js.
 *
 * tesseract.js normally rethrows internal worker errors (for example from a corrupt image) on the process, which
 * would stop the whole background worker. An error handler routes those errors into this call's promise instead, so
 * only this OCR job fails and can be retried. Downloaded language data is cached in a temporary folder, and the
 * worker is always terminated.
 *
 * @param {string} filePath Path of the image.
 * @param {string} language Tesseract language code, for example "eng".
 * @returns {Promise<{ text: string, confidence: number }>}
 */
async function ocrImageJs(filePath, language) {
  const { createWorker } = await import('tesseract.js');
  // Uploaded images are untrusted. Without an errorHandler, tesseract.js rethrows worker errors
  // (for example a corrupt image) on the process and kills the whole background worker.
  // Route them into this job's promise so only this OCR job fails and can be retried.
  let fail;
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  await fs.mkdir(TESSDATA_CACHE, { recursive: true });
  const worker = await createWorker(language, 1, {
    cachePath: TESSDATA_CACHE,
    errorHandler: (err) => fail(err instanceof Error ? err : new Error(String(err))),
  });
  try {
    const { data } = await Promise.race([worker.recognize(filePath), failed]);
    return { text: data.text.trim(), confidence: data.confidence };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/**
 * Converts every page of a PDF into a 300 dpi greyscale PNG image with pdftoppm, ready for OCR.
 *
 * @param {string} filePath Path of the PDF.
 * @returns {Promise<{ dir: string, files: string[] }>} The temporary folder (which the caller must delete) and the
 *   page images in page order.
 */
async function rasterisePdf(filePath) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-'));
  await run('pdftoppm', ['-r', '300', '-gray', '-png', filePath, path.join(dir, 'p')], { timeout: 1_800_000 });
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  return { dir, files: files.map((f) => path.join(dir, f)) };
}

/**
 * Extracts text from an image or PDF, page by page.
 *
 * - When a remote OCR service is configured, the file is sent there.
 * - A PDF whose pages carry on average more than 40 characters of embedded text is treated as born-digital, and
 *   that text is returned with a confidence of 100.
 * - A scanned PDF is rasterised and every page is recognised with the Tesseract command-line tool.
 * - An image is recognised with the Tesseract command-line tool if installed, otherwise with tesseract.js.
 *
 * @param {string} filePath Path of the file.
 * @param {string} mediaType Detected media type, for example "application/pdf".
 * @param {string} [language='eng'] Tesseract language code.
 * @returns {Promise<{ engine: string, engineVersion: string|null, pages: Array<{ pageNumber: number, text: string,
 *   confidence: number|null }> }>}
 * @throws {Error} When a scanned PDF needs tools that are not installed, or recognition fails.
 */
export async function runOcr(filePath, mediaType, language = 'eng') {
  if (env.OCR_SERVICE_URL) return runRemoteOcr(filePath, mediaType, language);
  const cli = await tesseractCli();
  if (mediaType === 'application/pdf') {
    const layer = await pdfTextLayer(filePath);
    const textChars = layer.reduce((n, p) => n + p.text.length, 0);
    if (layer.length && textChars / layer.length > 40) {
      return {
        engine: 'pdf-text-layer',
        engineVersion: 'pdf.js',
        pages: layer.map((p) => ({ ...p, confidence: 100 })),
      };
    }
    if (!cli)
      throw new Error(
        'This PDF has no text layer. Scanned-PDF OCR needs the tesseract and pdftoppm tools (installed in the worker image).',
      );
    let raster;
    try {
      raster = await rasterisePdf(filePath);
    } catch (err) {
      throw new Error(`PDF rasterisation failed (is poppler-utils installed?): ${err.message}`, { cause: err });
    }
    try {
      const pages = [];
      for (const [i, f] of raster.files.entries())
        pages.push({ pageNumber: i + 1, ...(await ocrImageCli(f, language)) });
      return { engine: 'tesseract', engineVersion: cli, pages };
    } finally {
      await fs.rm(raster.dir, { recursive: true, force: true });
    }
  }
  if (cli)
    return {
      engine: 'tesseract',
      engineVersion: cli,
      pages: [{ pageNumber: 1, ...(await ocrImageCli(filePath, language)) }],
    };
  const r = await ocrImageJs(filePath, language);
  return { engine: 'tesseract.js', engineVersion: 'tesseract.js', pages: [{ pageNumber: 1, ...r }] };
}

/**
 * Sends a file to the remote OCR service and normalises its response.
 *
 * Contract: `POST multipart/form-data { file, language, mediaType }`, with `Authorization: Bearer
 * OCR_SERVICE_TOKEN` when a token is set, answered by `200 { engine, engineVersion, pages: [{ pageNumber, text,
 * confidence }] }`. The service receives only the file being processed and must not keep it after the request. The
 * request is abandoned after 30 minutes.
 *
 * @param {string} filePath Path of the file.
 * @param {string} mediaType Detected media type.
 * @param {string} language Tesseract language code.
 * @returns {Promise<{ engine: string, engineVersion: string|null, pages: Array<{ pageNumber: number, text: string,
 *   confidence: number|null }> }>}
 * @throws {Error} When the service answers with an error status or without a list of pages.
 */
async function runRemoteOcr(filePath, mediaType, language) {
  const fd = new FormData();
  fd.append('file', new Blob([await fs.readFile(filePath)], { type: mediaType }), path.basename(filePath));
  fd.append('language', language);
  fd.append('mediaType', mediaType);
  const res = await fetch(env.OCR_SERVICE_URL, {
    method: 'POST',
    body: fd,
    headers: env.OCR_SERVICE_TOKEN ? { Authorization: `Bearer ${env.OCR_SERVICE_TOKEN}` } : {},
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok) throw new Error(`OCR service returned ${res.status}`);
  const out = await res.json();
  if (!Array.isArray(out.pages)) throw new Error('OCR service response has no pages');
  return {
    engine: out.engine || 'remote',
    engineVersion: out.engineVersion || null,
    pages: out.pages.map((p, i) => ({
      pageNumber: Number(p.pageNumber) || i + 1,
      text: String(p.text || ''),
      confidence: p.confidence ?? null,
    })),
  };
}

/**
 * Reading of CSV and Excel files uploaded for imports and transfer inventories, and normalisation of the date
 * formats commonly found in them.
 *
 * @author Kwasi Adabo Boakye
 */

import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { badRequest } from '../utils/errors.js';

// Limits for Excel uploads, which are zip archives. A legitimate register of tens of thousands of rows expands to a
// few tens of megabytes; a "zip bomb" expands a small upload to gigabytes and would exhaust the server's memory.
const XLSX_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const XLSX_MAX_ENTRIES = 5000;
const XLSX_MAX_RATIO = 200;

/**
 * Checks an Excel file's zip structure before it is parsed, without decompressing anything.
 *
 * The zip central directory lists every entry's compressed and uncompressed size. The file is rejected when it is
 * not a well-formed zip, uses ZIP64 (never needed for spreadsheets of the sizes accepted here, and a way to hide
 * sizes), has too many entries, would expand beyond 250 MB, or has an entry compressed more than 200 times.
 *
 * @param {Buffer} buffer The uploaded file.
 * @throws {AppError} 400 when the file is not a safe spreadsheet archive.
 */
export function assertSafeXlsx(buffer) {
  const reject = (why) => {
    throw badRequest(`The Excel file was rejected: ${why}`);
  };
  // End-of-central-directory record: signature 0x06054b50, within the last 64 KB plus its fixed 22 bytes.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) reject('it is not a valid .xlsx file');
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) reject('ZIP64 archives are not accepted');
  if (entries > XLSX_MAX_ENTRIES) reject('it contains too many parts');
  let total = 0;
  let pos = cdOffset;
  for (let n = 0; n < entries; n += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) reject('its structure is damaged');
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) reject('ZIP64 archives are not accepted');
    if (uncompressed > Math.max(compressed, 1) * XLSX_MAX_RATIO && uncompressed > 1024 * 1024)
      reject('it expands far more than a normal spreadsheet');
    total += uncompressed;
    if (total > XLSX_MAX_UNCOMPRESSED_BYTES) reject('it would expand to more than 250 MB');
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
}

/**
 * Reads a CSV or XLSX file into a list of rows keyed by the column headings in the first row.
 *
 * Values are trimmed, blank rows are skipped, Excel dates become YYYY-MM-DD, and a byte-order mark at the start of
 * a CSV file is ignored. Only the first worksheet of an Excel file is read.
 *
 * @param {Buffer} buffer File content.
 * @param {string} filename Original file name; its extension selects the parser.
 * @param {{ maxRows?: number }} [options] Maximum number of data rows accepted (default 20,000).
 * @returns {Promise<{ headers: string[], rows: Array<Record<string, *>> }>}
 * @throws {AppError} 400 when the file type is not supported, the file cannot be read, or it has too many rows.
 */
export async function parseTabular(buffer, filename, { maxRows = 20000 } = {}) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    let records;
    try {
      records = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      });
    } catch (err) {
      throw badRequest(`The CSV file could not be read: ${err.message}`);
    }
    if (records.length > maxRows) throw badRequest(`The file has more than ${maxRows} rows`);
    return { headers: records.length ? Object.keys(records[0]) : [], rows: records };
  }
  if (lower.endsWith('.xlsx')) {
    assertSafeXlsx(buffer);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer);
    } catch (err) {
      throw badRequest(`The Excel file could not be read: ${err.message}`);
    }
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = String(cell.text || '').trim();
    });
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const obj = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const cell = row.getCell(i + 1);
        const v = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text;
        obj[h] = typeof v === 'string' ? v.trim() : v;
      });
      if (Object.values(obj).some((v) => v !== '' && v != null)) rows.push(obj);
    });
    if (rows.length > maxRows) throw badRequest(`The file has more than ${maxRows} rows`);
    return { headers: headers.filter(Boolean), rows };
  }
  throw badRequest('Upload a .csv or .xlsx file');
}

/**
 * Converts common date spellings to the ISO form YYYY-MM-DD.
 *
 * Accepted forms are a year on its own (taken as 1 January), YYYY-MM-DD, and day-month-year with "/", "." or "-"
 * separators, as used in Ghana.
 *
 * @param {*} v The value to convert.
 * @returns {string|null|undefined} The ISO date, null when the value is blank, or undefined when it is not a valid
 *   date.
 */
export function normaliseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Number.isNaN(Date.parse(s)) ? undefined : s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? undefined : iso;
  }
  return undefined;
}

/**
 * Neutralises a value that a spreadsheet program would otherwise run as a formula (CSV or "formula" injection).
 *
 * Exported files contain text typed by users, such as titles and names. A value starting with =, +, @, a tab or a
 * carriage return, or with - unless the whole value is a plain negative number, is prefixed with an apostrophe so Excel and LibreOffice show
 * it as text instead of evaluating it. Numbers, dates and ordinary text are returned unchanged.
 *
 * @param {*} value The cell value.
 * @returns {*} The value, made safe when it is text.
 */
export function csvSafe(value) {
  if (typeof value !== 'string') return value;
  const formulaLike = /^[=+@\t\r]/.test(value) || (value.startsWith('-') && !/^-\d+(\.\d+)?$/.test(value));
  return formulaLike ? `'${value}` : value;
}

/**
 * Applies {@link csvSafe} to every value of a row object.
 *
 * @param {Record<string, *>} row The row.
 * @returns {Record<string, *>} A new row with every text value made safe.
 */
export const csvSafeRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, csvSafe(v)]));

/**
 * Human-readable reference numbers, such as accession numbers (UGA/ACC/2026/0001) and research request numbers.
 *
 * Formats are configurable per kind through the "numbering.<kind>" settings. Counters are allocated atomically in
 * the database, so two simultaneous requests can never receive the same number.
 *
 * @author Kwasi Adabo Boakye
 */

import { sequelize } from '../database/models/index.js';
import { getSetting } from './settings.service.js';

/**
 * Allocates the next value of a counter atomically.
 *
 * A single MERGE statement with HOLDLOCK increments the counter, or creates it starting at 1, and returns the
 * allocated value. Run it inside the caller's transaction so a rolled-back operation does not consume a number.
 *
 * @param {string} scope Counter name, for example "accession:2026".
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<number>} The allocated value.
 */
export async function nextSequence(scope, transaction) {
  const [rows] = await sequelize.query(
    `MERGE ReferenceSequences WITH (HOLDLOCK) AS t
     USING (SELECT :scope AS scope) AS s ON t.scope = s.scope
     WHEN MATCHED THEN UPDATE SET nextValue = t.nextValue + 1, updatedAt = SYSDATETIMEOFFSET()
     WHEN NOT MATCHED THEN INSERT (id, scope, nextValue, createdAt, updatedAt) VALUES (NEWID(), :scope, 2, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
     OUTPUT inserted.nextValue - 1 AS value;`,
    { replacements: { scope }, transaction },
  );
  return rows[0].value;
}

export const DEFAULT_FORMATS = {
  accession: 'UGA/ACC/{YYYY}/{SEQ:4}',
  transfer: 'UGA/TRF/{YYYY}/{SEQ:4}',
  research_request: 'UGA/RR/{YYYY}/{SEQ:5}',
  appraisal_case: 'UGA/APR/{YYYY}/{SEQ:4}',
  disposal_case: 'UGA/DSP/{YYYY}/{SEQ:4}',
  disposal_certificate: 'UGA/DC/{YYYY}/{SEQ:4}',
  digitisation_project: 'UGA/DIG/{YYYY}/{SEQ:3}',
  digitisation_batch: 'UGA/DB/{YYYY}/{SEQ:4}',
  legal_hold: 'UGA/LH/{YYYY}/{SEQ:3}',
  receipt: 'UGA/RCPT/{YYYY}/{SEQ:5}',
  // Barcodes generated for boxes registered without a pre-printed label; no slashes, for barcode scanners.
  physical_item: 'UGA-BX-{SEQ:6}',
};

/**
 * Generates the next reference number for a kind of item from its configured pattern.
 *
 * Patterns support {YYYY} for the current year and {SEQ:n} for the counter padded to n digits. When the pattern
 * includes the year, the counter starts again each year.
 *
 * @param {string} kind Kind of item, for example "accession" or "research_request".
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<string>} The new reference number.
 * @throws {Error} When no pattern is configured for the kind.
 */
export async function generateReference(kind, transaction) {
  const pattern = (await getSetting(`numbering.${kind}`)) || DEFAULT_FORMATS[kind];
  if (!pattern) throw new Error(`No numbering rule for ${kind}`);
  const year = String(new Date().getUTCFullYear());
  const scope = pattern.includes('{YYYY}') ? `${kind}:${year}` : kind;
  const seq = await nextSequence(scope, transaction);
  return pattern
    .replace('{YYYY}', year)
    .replace(/\{SEQ(?::(\d+))?\}/, (_, pad) => String(seq).padStart(Number(pad || 1), '0'));
}

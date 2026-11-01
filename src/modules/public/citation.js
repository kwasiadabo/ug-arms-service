/**
 * Citation text for descriptions shown on the public portal.
 *
 * @author Kwasi Adabo Boakye
 */

import { getSetting } from '../../services/settings.service.js';

/**
 * Returns the citation for a description: the archivist's preferred citation if one has been written, otherwise one
 * generated from the title, date (unless already in the title), collection, reference code and institution name.
 *
 * @param {object} record The description.
 * @param {Array<{ title: string }>} [breadcrumbs=[]] Ancestors from the top down; the first is the collection.
 * @returns {Promise<{ text: string, source: 'preferred'|'generated' }>}
 */
export async function buildCitation(record, breadcrumbs = []) {
  if (record.preferredCitation) return { text: record.preferredCitation, source: 'preferred' };
  const institution = await getSetting('institution.name');
  const collection = breadcrumbs[0]?.title;
  const date = record.dateExpression && !record.title.includes(record.dateExpression) ? record.dateExpression : null;
  const parts = [
    record.title,
    date,
    collection && collection !== record.title ? collection : null,
    record.referenceCode,
    institution,
  ];
  return { text: `${parts.filter(Boolean).join(', ')}.`, source: 'generated' };
}

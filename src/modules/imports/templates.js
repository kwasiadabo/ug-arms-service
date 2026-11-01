/**
 * Import templates: for each import type, the target fields with their labels, validation hints (required, type,
 * allowed values, controlled vocabulary) and the column-heading aliases used to suggest a mapping automatically.
 *
 * @author Kwasi Adabo Boakye
 */

import { LEVELS, ACCESS_LEVELS } from '../../database/models/archival.js';

export const TEMPLATES = {
  archival_records: {
    label: 'Archival descriptions',
    keyField: 'sourceId',
    fields: {
      sourceId: {
        label: 'Legacy / source identifier',
        required: true,
        aliases: ['source id', 'legacy id', 'id', 'old reference', 'register no'],
      },
      referenceCode: { label: 'Reference code', aliases: ['reference', 'ref code', 'refcode', 'reference code'] },
      parentReference: { label: 'Parent reference code', aliases: ['parent', 'parent ref', 'parent reference'] },
      localIdentifier: { label: 'Local identifier', aliases: ['local id', 'item no', 'file no'] },
      level: { label: 'Level of description', required: true, enum: LEVELS, aliases: ['level'] },
      title: { label: 'Title', required: true, aliases: ['title', 'description title'] },
      dateExpression: { label: 'Date (as written)', aliases: ['date', 'dates'] },
      dateStart: { label: 'Start date', type: 'date', aliases: ['start date', 'from date', 'date from'] },
      dateEnd: { label: 'End date', type: 'date', aliases: ['end date', 'to date', 'date to'] },
      extentAndMedium: { label: 'Extent and medium', aliases: ['extent', 'quantity'] },
      creatorNote: { label: 'Creator', aliases: ['creator', 'created by'] },
      scopeAndContent: { label: 'Scope and content', aliases: ['scope', 'scope and content', 'contents', 'summary'] },
      adminBiographicalHistory: {
        label: 'Administrative / biographical history',
        aliases: ['history', 'admin history', 'biographical history'],
      },
      accessConditions: { label: 'Conditions of access', aliases: ['access', 'access conditions'] },
      reproductionConditions: { label: 'Conditions of reproduction', aliases: ['reproduction', 'copyright'] },
      languages: { label: 'Languages (; separated)', type: 'list', aliases: ['language', 'languages'] },
      subjects: {
        label: 'Subjects (; separated, controlled vocabulary)',
        type: 'list',
        vocabulary: 'subjects',
        aliases: ['subject', 'subjects', 'keywords'],
      },
      accessLevel: { label: 'Access level', enum: ACCESS_LEVELS, aliases: ['access level', 'restriction'] },
      archivistNote: { label: "Archivist's note", aliases: ['note', 'notes', 'remarks'] },
    },
  },
  authority_records: {
    label: 'Authority records',
    keyField: 'sourceId',
    fields: {
      sourceId: { label: 'Source identifier', required: true, aliases: ['id', 'source id'] },
      entityType: {
        label: 'Entity type',
        required: true,
        enum: ['person', 'family', 'corporate_body', 'university_unit', 'place', 'subject', 'function'],
        aliases: ['type', 'entity type'],
      },
      authorizedName: {
        label: 'Authorised name',
        required: true,
        aliases: ['name', 'authorised name', 'authorized name'],
      },
      otherNames: {
        label: 'Other names (; separated)',
        type: 'list',
        aliases: ['other names', 'variants', 'alternative names'],
      },
      datesOfExistence: { label: 'Dates of existence', aliases: ['dates', 'dates of existence'] },
      history: { label: 'History', aliases: ['history', 'biography'] },
    },
  },
  physical_items: {
    label: 'Physical items (boxes, folders)',
    keyField: 'barcode',
    fields: {
      barcode: { label: 'Barcode', required: true, aliases: ['barcode', 'box id', 'box number'] },
      title: { label: 'Title / label', required: true, aliases: ['title', 'label', 'description'] },
      itemType: {
        label: 'Item type',
        enum: [
          'box',
          'folder',
          'volume',
          'item',
          'map',
          'drawing',
          'photograph',
          'audiovisual_carrier',
          'artefact',
          'other',
        ],
        aliases: ['type', 'item type'],
      },
      recordReference: { label: 'Description reference code', aliases: ['reference', 'record reference'] },
      locationCode: { label: 'Location code', aliases: ['location', 'shelf', 'location code'] },
      sizeUnits: { label: 'Size units', type: 'number', aliases: ['size', 'units'] },
    },
  },
};

/**
 * Suggests which target field each column heading maps to.
 *
 * A heading matches a field when, ignoring case, underscores, hyphens and spaces, it equals the field name or one
 * of its aliases. Each field is mapped at most once.
 *
 * @param {string} importType Import type.
 * @param {string[]} headers Column headings from the file.
 * @returns {Record<string, string>} Column heading to target field, for the headings that matched.
 */
export function suggestMapping(importType, headers) {
  const t = TEMPLATES[importType];
  const mapping = {};
  for (const h of headers) {
    const k = h.toLowerCase().replace(/[_-]+/g, ' ').trim();
    const hit = Object.entries(t.fields).find(
      ([name, f]) => name.toLowerCase() === k.replace(/ /g, '') || f.aliases?.includes(k),
    );
    if (hit && !Object.values(mapping).includes(hit[0])) mapping[h] = hit[0];
  }
  return mapping;
}

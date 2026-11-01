/**
 * Zod schemas for creating and updating archival descriptions and their links. Text fields are trimmed and bounded,
 * dates use YYYY-MM-DD with the end on or after the start, and enumerations come from the model definitions.
 *
 * @author Kwasi Adabo Boakye
 */

import { z } from 'zod';
import { LEVELS, ACCESS_LEVELS } from '../../database/models/archival.js';
import { uuid, isoDate, optionalText } from '../../validators/common.js';
import { paginationSchema } from '../../utils/pagination.js';

const strList = z.array(z.string().trim().min(1).max(120)).max(50);

// Every descriptive field an archivist can edit. System fields (status, path, publication...) are excluded.
export const descriptiveFields = {
  title: z.string().trim().min(1).max(1000),
  alternativeTitle: optionalText(1000),
  localIdentifier: optionalText(120),
  collectionType: optionalText(80),
  dateExpression: optionalText(255),
  dateStart: isoDate,
  dateEnd: isoDate,
  bulkDateStart: isoDate,
  bulkDateEnd: isoDate,
  extentAndMedium: optionalText(2000),
  creatorNote: optionalText(1000),
  adminBiographicalHistory: optionalText(100000),
  archivalHistory: optionalText(100000),
  immediateSource: optionalText(100000),
  scopeAndContent: optionalText(100000),
  appraisalInfo: optionalText(100000),
  accruals: optionalText(20000),
  arrangement: optionalText(20000),
  accessConditions: optionalText(20000),
  reproductionConditions: optionalText(20000),
  copyrightStatement: optionalText(20000),
  languages: strList.optional(),
  scripts: strList.optional(),
  physicalCharacteristics: optionalText(20000),
  findingAids: optionalText(20000),
  locationOfOriginals: optionalText(20000),
  locationOfCopies: optionalText(20000),
  relatedMaterials: optionalText(20000),
  publicationNote: optionalText(20000),
  archivistNote: optionalText(20000),
  rulesConventions: optionalText(1000),
  descriptionDate: isoDate,
  preferredCitation: optionalText(1000),
  geographicCoverage: optionalText(1000),
  preservationNote: optionalText(20000),
  keywords: strList.optional(),
  originatingUnitId: uuid.nullable().optional(),
  responsibleArchivistId: uuid.nullable().optional(),
  reviewDate: isoDate,
  isFeatured: z.boolean().optional(),
  isPermanent: z.boolean().optional(),
  custodyStatus: z.enum(['accessioned', 'departmental']).optional(),
  retentionScheduleId: uuid.nullable().optional(),
  retentionTriggerDate: isoDate,
  aiProcessingAllowed: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
};

/**
 * Checks that a description's end date is not before its start date. Missing dates pass.
 *
 * @param {{ dateStart?: string, dateEnd?: string }} d The dates.
 * @returns {boolean}
 */
const dateOrder = (d) => !d.dateStart || !d.dateEnd || d.dateStart <= d.dateEnd;

export const createRecordSchema = z
  .object({
    ...descriptiveFields,
    repositoryId: uuid.optional(),
    parentId: uuid.nullable().optional(),
    level: z.enum(LEVELS),
    referenceCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[\w./ -]+$/, 'Letters, digits, / . - _ and spaces only')
      .optional(),
    accessLevel: z.enum(ACCESS_LEVELS).optional(),
    embargoUntil: isoDate,
  })
  .refine(dateOrder, { message: 'End date must be on or after start date', path: ['dateEnd'] });

export const updateRecordSchema = z
  .object({
    ...Object.fromEntries(Object.entries(descriptiveFields).map(([k, v]) => [k, v.optional()])),
    referenceCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[\w./ -]+$/)
      .optional(),
    version: z.number().int().min(0),
    changeSummary: z.string().trim().max(1000).optional(),
  })
  .refine(dateOrder, { message: 'End date must be on or after start date', path: ['dateEnd'] });

export const listRecordsSchema = paginationSchema.extend({
  level: z.enum(LEVELS).optional(),
  status: z.string().max(200).optional(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
  parentId: uuid.optional(),
  rootId: uuid.optional(),
  repositoryId: uuid.optional(),
  originatingUnitId: uuid.optional(),
  topLevel: z.enum(['true', 'false']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}(-\d{2}-\d{2})?$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}(-\d{2}-\d{2})?$/)
    .optional(),
});

export const transitionSchema = z.object({
  action: z.enum(['submit_for_review', 'return_to_draft', 'approve', 'publish', 'withdraw', 'reinstate']),
  reason: z.string().trim().max(4000).optional(),
});

export const moveSchema = z.object({
  parentId: uuid.nullable(),
  sortOrder: z.number().int().min(0).optional(),
  reason: z.string().trim().max(1000).optional(),
});

export const creatorsSchema = z.object({
  creators: z.array(z.object({ authorityId: uuid, role: z.string().trim().max(80).default('creator') })).max(50),
});
export const subjectsSchema = z.object({
  subjects: z
    .array(
      z
        .object({
          termId: uuid.optional(),
          authorityId: uuid.optional(),
          subjectType: z.enum(['subject', 'place', 'person', 'organisation', 'genre', 'function']).default('subject'),
        })
        .refine((s) => Boolean(s.termId) !== Boolean(s.authorityId), 'Provide exactly one of termId or authorityId'),
    )
    .max(100),
});
export const identifiersSchema = z.object({
  identifiers: z
    .array(z.object({ scheme: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(255) }))
    .max(50),
});
export const relationshipSchema = z.object({
  targetId: uuid,
  relationType: z
    .enum(['related', 'associated_material', 'copy_of', 'original_of', 'continues', 'continued_by', 'see_also'])
    .default('related'),
  note: z.string().max(1000).optional(),
});

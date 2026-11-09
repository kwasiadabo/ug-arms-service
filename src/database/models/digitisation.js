/**
 * Sequelize model definitions for the digitisation and OCR domain.
 *
 * Defines the tables for quality profiles, digitisation projects, batches and items, quality assurance reviews, OCR
 * jobs, OCR pages and OCR text revisions. OCR text is stored per page, separately from the files, and becomes
 * searchable only after an authorised person approves it.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { pk, fk, str, req, text, bool, int, date, dateOnly, status, json, dec } from './_helpers.js';

export const BATCH_STATUSES = [
  'planned',
  'in_progress',
  'processing',
  'quality_review',
  'rework_required',
  'approved',
  'completed',
  'failed',
];

/**
 * Defines the digitisation and OCR models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineDigitisation(sequelize) {
  const QualityProfile = sequelize.define('QualityProfile', {
    id: pk(),
    name: req(200),
    materialType: req(80),
    minResolutionDpi: int(300),
    colourMode: str(40),
    bitDepth: int(),
    masterFormat: str(40),
    accessFormat: str(40),
    requiresColourTarget: bool(false),
    notes: str(2000),
    isActive: bool(true),
  });

  const DigitisationProject = sequelize.define(
    'DigitisationProject',
    {
      id: pk(),
      code: req(60),
      title: req(500),
      description: text(),
      sourceRecordId: fk(),
      // The accession whose material the project digitises, when it was planned from one.
      accessionId: fk(),
      qualityProfileId: fk(),
      status: status(['proposed', 'approved', 'active', 'completed', 'cancelled'], 'proposed'),
      priority: status(['low', 'normal', 'high', 'urgent'], 'normal'),
      startDate: dateOnly(),
      targetDate: dateOnly(),
      approvedById: fk(),
      approvedAt: date(),
      createdById: fk(),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const DigitisationBatch = sequelize.define(
    'DigitisationBatch',
    {
      id: pk(),
      projectId: fk(false),
      batchNumber: req(60),
      status: status(BATCH_STATUSES, 'planned'),
      operatorId: fk(),
      qaReviewerId: fk(),
      captureDevice: str(255),
      resolutionDpi: int(),
      colourProfile: str(80),
      bitDepth: int(),
      fileNamingPattern: str(255),
      ocrEnabled: bool(true),
      ocrLanguage: str(40, { defaultValue: 'eng' }),
      captureStartedAt: date(),
      completedAt: date(),
      notes: text(),
    },
    {
      version: true,
      indexes: [{ unique: true, fields: ['batchNumber'] }, { fields: ['projectId'] }, { fields: ['status'] }],
    },
  );

  const DigitisationItem = sequelize.define(
    'DigitisationItem',
    {
      id: pk(),
      batchId: fk(false),
      recordId: fk(),
      physicalItemId: fk(),
      // The accession the item came in with: from the batch's plan, or from its box.
      accessionId: fk(),
      sequence: int(1),
      label: req(500),
      expectedPages: int(),
      capturedPages: int(0),
      status: status(['pending', 'captured', 'qa_passed', 'qa_failed', 'rework', 'skipped'], 'pending'),
      notes: str(2000),
    },
    { indexes: [{ fields: ['batchId', 'sequence'] }] },
  );

  const QualityAssuranceReview = sequelize.define(
    'QualityAssuranceReview',
    {
      id: pk(),
      batchId: fk(false),
      itemId: fk(),
      assetId: fk(),
      reviewerId: fk(false),
      outcome: status(['pass', 'fail', 'rework']),
      checks: json('checks', {}),
      comments: str(4000),
    },
    { updatedAt: false, indexes: [{ fields: ['batchId'] }] },
  );

  const OCRJob = sequelize.define(
    'OCRJob',
    {
      id: pk(),
      assetId: fk(false),
      status: status(['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'queued'),
      language: str(40, { defaultValue: 'eng' }),
      engine: str(60),
      engineVersion: str(60),
      meanConfidence: dec(5, 2),
      pageCount: int(),
      attempts: int(0),
      error: str(4000),
      requestedById: fk(),
      startedAt: date(),
      finishedAt: date(),
    },
    { indexes: [{ fields: ['assetId'] }, { fields: ['status'] }] },
  );

  const OCRPage = sequelize.define(
    'OCRPage',
    {
      id: pk(),
      ocrJobId: fk(false),
      assetId: fk(false),
      pageNumber: int(1),
      text: text(),
      confidence: dec(5, 2),
      needsReview: bool(false),
      reviewStatus: status(['pending', 'corrected', 'approved'], 'pending'),
      approvedForSearch: bool(false),
      currentRevision: int(1),
      reviewedById: fk(),
      reviewedAt: date(),
    },
    { indexes: [{ fields: ['assetId', 'pageNumber'] }, { fields: ['ocrJobId'] }] },
  );

  const OCRRevision = sequelize.define(
    'OCRRevision',
    {
      id: pk(),
      pageId: fk(false),
      revision: int(1),
      text: text(),
      source: status(['engine', 'manual']),
      editedById: fk(),
      note: str(1000),
    },
    { updatedAt: false, indexes: [{ unique: true, fields: ['pageId', 'revision'] }] },
  );

  return {
    QualityProfile,
    DigitisationProject,
    DigitisationBatch,
    DigitisationItem,
    QualityAssuranceReview,
    OCRJob,
    OCRPage,
    OCRRevision,
  };
}

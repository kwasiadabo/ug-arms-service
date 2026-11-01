/**
 * Sequelize model definitions for the transfer and accessioning domain.
 *
 * Defines the tables for transfer submissions from departments, their inventory lines and submitted revisions,
 * accessions, accession items, links between accessions and catalogue descriptions, and supporting documents. A
 * transfer is a proposal from a department; an accession is the formal record that the Archives has taken custody.
 * Revisions keep a snapshot of every submission so later edits can be compared with what was originally sent.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import {
  pk,
  fk,
  str,
  req,
  text,
  bool,
  int,
  date,
  dateOnly,
  status,
  json,
  dec,
  big,
  uniqueWhenSet,
} from './_helpers.js';

export const TRANSFER_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'query_raised',
  'resubmitted',
  'accepted',
  'partially_accepted',
  'rejected',
  'cancelled',
];
export const ACCESSION_STATUSES = ['draft', 'submitted', 'under_review', 'queried', 'approved', 'rejected', 'closed'];

/**
 * Defines the transfer and accessioning models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineAccessioning(sequelize) {
  const TransferSubmission = sequelize.define(
    'TransferSubmission',
    {
      id: pk(),
      referenceNumber: str(60),
      title: req(500),
      originatingUnitId: fk(false),
      contactName: req(200),
      contactEmail: str(320),
      contactPhone: str(60),
      proposedTransferDate: dateOnly(),
      transferAuthority: str(1000),
      reason: text(),
      recordsDateRange: str(255),
      totalExtent: str(255),
      confidentialityNotes: text(),
      status: status(TRANSFER_STATUSES, 'draft'),
      submittedById: fk(),
      submittedAt: date(),
      reviewerId: fk(),
      decisionById: fk(),
      decisionAt: date(),
      decisionNote: text(),
      accessionId: fk(),
      revision: int(0),
    },
    {
      version: true,
      indexes: [uniqueWhenSet('referenceNumber'), { fields: ['status'] }, { fields: ['originatingUnitId'] }],
    },
  );

  const TransferInventoryItem = sequelize.define(
    'TransferInventoryItem',
    {
      id: pk(),
      submissionId: fk(false),
      lineNumber: int(1),
      sourceIdentifier: str(120),
      title: req(1000),
      dateExpression: str(255),
      dateStart: dateOnly(),
      dateEnd: dateOnly(),
      format: str(80),
      quantity: int(1),
      extent: str(255),
      boxNumber: str(60),
      condition: str(255),
      confidentiality: str(255),
      notes: str(2000),
      decision: status(['pending', 'accepted', 'rejected'], 'pending'),
      decisionNote: str(1000),
    },
    { indexes: [{ fields: ['submissionId', 'lineNumber'] }] },
  );

  // Immutable snapshot of a submission and its inventory at each submit/resubmit, so the
  // originally submitted inventory and every correction remain available.
  const TransferSubmissionRevision = sequelize.define(
    'TransferSubmissionRevision',
    {
      id: pk(),
      submissionId: fk(false),
      revision: int(1),
      snapshot: json('snapshot', {}),
      createdById: fk(),
    },
    { updatedAt: false, indexes: [{ unique: true, fields: ['submissionId', 'revision'] }] },
  );

  const Accession = sequelize.define(
    'Accession',
    {
      id: pk(),
      accessionNumber: req(60),
      title: req(500),
      repositoryId: fk(false),
      transferSubmissionId: fk(),
      accessionDate: dateOnly(),
      transferDate: dateOnly(),
      sourceType: status(
        ['department', 'donor', 'external_organisation', 'purchase', 'deposit', 'other'],
        'department',
      ),
      sourceUnitId: fk(),
      donorName: str(255),
      contactPerson: str(200),
      contactEmail: str(320),
      transferAuthority: str(1000),
      legalBasis: str(1000),
      transferMethod: str(255),
      formats: json('formats', []),
      quantity: int(),
      extent: str(500),
      physicalCondition: text(),
      provenance: text(),
      custodialHistory: text(),
      confidentialityConcerns: text(),
      rightsStatement: text(),
      restrictionsNote: text(),
      embargoUntil: dateOnly(),
      completenessNote: text(),
      missingInformation: json('missingInformation', []),
      appraisalNote: text(),
      status: status(ACCESSION_STATUSES, 'draft'),
      isQuarantined: bool(false),
      quarantineReason: str(1000),
      responsibleOfficerId: fk(),
      submittedById: fk(),
      submittedAt: date(),
      approvedById: fk(),
      approvedAt: date(),
      decisionNote: text(),
      receiptNumber: str(60),
      receiptIssuedAt: date(),
      estimatedValue: dec(14, 2),
      createdById: fk(),
      updatedById: fk(),
    },
    {
      version: true,
      indexes: [{ unique: true, fields: ['accessionNumber'] }, { fields: ['status'] }, { fields: ['accessionDate'] }],
    },
  );

  const AccessionItem = sequelize.define(
    'AccessionItem',
    {
      id: pk(),
      accessionId: fk(false),
      inventoryItemId: fk(),
      lineNumber: int(1),
      description: req(1000),
      format: str(80),
      quantity: int(1),
      extent: str(255),
      condition: str(255),
      status: status(['pending', 'accepted', 'rejected'], 'pending'),
      recordId: fk(),
      physicalItemId: fk(),
    },
    { indexes: [{ fields: ['accessionId'] }] },
  );

  const AccessionRecordLink = sequelize.define(
    'AccessionRecordLink',
    {
      id: pk(),
      accessionId: fk(false),
      recordId: fk(false),
      note: str(500),
    },
    { indexes: [{ unique: true, fields: ['accessionId', 'recordId'] }] },
  );

  // Supporting documents for submissions and accessions (agreements, lists, deeds of gift).
  const TransferDocument = sequelize.define(
    'TransferDocument',
    {
      id: pk(),
      ownerType: status(['transfer_submission', 'accession', 'disposal_case', 'appraisal_case']),
      ownerId: fk(false),
      documentType: str(80),
      originalFilename: req(500),
      mediaType: str(150),
      sizeBytes: big(),
      sha256: str(64),
      storageKey: req(500),
      malwareStatus: status(['pending', 'clean', 'infected', 'skipped', 'error'], 'pending'),
      uploadedById: fk(),
    },
    { indexes: [{ fields: ['ownerType', 'ownerId'] }] },
  );

  return {
    TransferSubmission,
    TransferInventoryItem,
    TransferSubmissionRevision,
    Accession,
    AccessionItem,
    AccessionRecordLink,
    TransferDocument,
  };
}

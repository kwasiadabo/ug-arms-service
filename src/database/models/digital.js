/**
 * Sequelize model definitions for the digital assets and preservation domain.
 *
 * Defines the tables for the format registry, digital assets (preservation masters, access copies, thumbnails and
 * migrated versions), checksums, background jobs, PREMIS-style preservation events, fixity checks, preservation
 * alerts, preservation policies and storage replicas. The checksum recorded at ingest is never overwritten; later
 * fixity checks are compared against it and any mismatch raises an alert.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { pk, fk, str, req, text, bool, int, date, status, json, big, dec } from './_helpers.js';

export const ASSET_ROLES = [
  'preservation_master',
  'original_upload',
  'access_derivative',
  'thumbnail',
  'ocr_text',
  'migrated_version',
];
export const ASSET_STATUSES = [
  'uploaded',
  'scanning',
  'processing',
  'available',
  'quarantined',
  'rejected',
  'failed',
  'deleted',
];

/**
 * Defines the digital asset and preservation models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineDigital(sequelize) {
  const FormatRegistry = sequelize.define(
    'FormatRegistry',
    {
      id: pk(),
      mediaType: req(150),
      extensions: json('extensions', []),
      name: req(200),
      category: status(
        ['document', 'image', 'audio', 'video', 'spreadsheet', 'presentation', 'text', 'email', 'archive', 'other'],
        'other',
      ),
      riskLevel: status(['low', 'medium', 'high'], 'medium'),
      isAcceptedForIngest: bool(true),
      isPreservationFormat: bool(false),
      ocrEligible: bool(false),
      previewable: bool(false),
      preservationAction: str(1000),
    },
    { indexes: [{ unique: true, fields: ['mediaType'] }] },
  );

  const DigitalAsset = sequelize.define(
    'DigitalAsset',
    {
      id: pk(),
      recordId: fk(),
      physicalItemId: fk(),
      digitisationItemId: fk(),
      parentAssetId: fk(),
      role: status(ASSET_ROLES, 'preservation_master'),
      versionNumber: int(1),
      supersededById: fk(),
      originalFilename: req(500),
      title: str(500),
      declaredMediaType: str(150),
      mediaType: str(150),
      extension: str(20),
      sizeBytes: big(),
      sha256: str(64),
      storageKey: str(600),
      storageDriver: str(20),
      status: status(ASSET_STATUSES, 'uploaded'),
      malwareStatus: status(['pending', 'clean', 'infected', 'skipped', 'error'], 'pending'),
      ocrStatus: status(
        ['not_applicable', 'pending', 'queued', 'running', 'succeeded', 'failed', 'reviewed'],
        'not_applicable',
      ),
      preservationStatus: status(['pending', 'ok', 'at_risk', 'fixity_failed', 'missing', 'recovered'], 'pending'),
      accessLevel: status(
        ['inherit', 'open', 'staff_only', 'restricted', 'embargoed', 'confidential', 'closed'],
        'inherit',
      ),
      downloadAllowed: bool(false),
      isPublished: bool(false),
      qaStatus: status(['not_required', 'pending', 'passed', 'failed'], 'not_required'),
      rightsStatement: str(1000),
      copyrightHolder: str(500),
      licence: str(255),
      technicalMetadata: json('technicalMetadata', {}),
      extractedMetadata: json('extractedMetadata', {}),
      pageCount: int(),
      width: int(),
      height: int(),
      durationSeconds: dec(12, 3),
      formatRisk: str(20),
      duplicateOfId: fk(),
      ingestError: str(2000),
      lastFixityAt: date(),
      nextFixityAt: date(),
      uploadedById: fk(),
      idempotencyKey: str(120),
      deletedAt: date(),
      deletedById: fk(),
      deletionReason: str(1000),
    },
    {
      version: true,
      indexes: [
        { fields: ['recordId'] },
        { fields: ['sha256'] },
        { fields: ['status'] },
        { fields: ['parentAssetId'] },
        { fields: ['nextFixityAt'] },
        { fields: ['digitisationItemId'] },
      ],
    },
  );

  const AssetChecksum = sequelize.define(
    'AssetChecksum',
    {
      id: pk(),
      assetId: fk(false),
      algorithm: req(20),
      value: req(128),
      source: status(['ingest', 'client_supplied', 'fixity', 'migration']),
    },
    { updatedAt: false, indexes: [{ fields: ['assetId'] }] },
  );

  // Generic background job tracker used for asset processing, exports, OCR and maintenance.
  const BackgroundJob = sequelize.define(
    'BackgroundJob',
    {
      id: pk(),
      queue: req(60),
      jobType: req(80),
      entityType: str(60),
      entityId: str(64),
      status: status(['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'queued'),
      attempts: int(0),
      maxAttempts: int(3),
      progress: int(0),
      payload: json('payload', {}),
      result: json('result', {}),
      lastError: str(4000),
      requestedById: fk(),
      startedAt: date(),
      finishedAt: date(),
    },
    { indexes: [{ fields: ['status', 'queue'] }, { fields: ['entityType', 'entityId'] }] },
  );

  const PreservationEvent = sequelize.define(
    'PreservationEvent',
    {
      id: pk(),
      assetId: fk(),
      recordId: fk(),
      eventType: status([
        'ingest',
        'validation',
        'malware_scan',
        'checksum_calculation',
        'format_identification',
        'metadata_extraction',
        'ocr',
        'derivative_creation',
        'metadata_modification',
        'format_migration',
        'replication',
        'fixity_check',
        'restoration',
        'deletion',
        'quarantine',
        'publication',
        'withdrawal',
      ]),
      eventAt: date({ allowNull: false }),
      agentType: status(['user', 'system']),
      agentUserId: fk(),
      agentName: str(200),
      outcome: status(['success', 'failure', 'warning']),
      detail: str(2000),
      technicalDetail: json('technicalDetail', {}),
    },
    { updatedAt: false, indexes: [{ fields: ['assetId', 'eventAt'] }, { fields: ['eventType', 'eventAt'] }] },
  );

  const FixityCheck = sequelize.define(
    'FixityCheck',
    {
      id: pk(),
      assetId: fk(false),
      expectedSha256: str(64),
      actualSha256: str(64),
      status: status(['queued', 'running', 'passed', 'failed', 'investigating', 'recovered', 'closed'], 'queued'),
      checkedAt: date(),
      durationMs: int(),
      error: str(2000),
      triggeredBy: status(['schedule', 'manual', 'recovery'], 'schedule'),
    },
    { indexes: [{ fields: ['assetId', 'createdAt'] }, { fields: ['status'] }] },
  );

  const PreservationAlert = sequelize.define(
    'PreservationAlert',
    {
      id: pk(),
      assetId: fk(),
      fixityCheckId: fk(),
      alertType: status([
        'fixity_failure',
        'missing_file',
        'format_risk',
        'replication_failure',
        'malware_detected',
        'processing_failure',
      ]),
      severity: status(['low', 'medium', 'high', 'critical'], 'medium'),
      status: status(['open', 'investigating', 'recovered', 'resolved', 'closed'], 'open'),
      message: req(2000),
      assignedToId: fk(),
      resolution: text(),
      recoverySource: str(500),
      resolvedById: fk(),
      resolvedAt: date(),
    },
    { indexes: [{ fields: ['status', 'severity'] }, { fields: ['assetId'] }] },
  );

  const PreservationPolicy = sequelize.define('PreservationPolicy', {
    id: pk(),
    name: req(200),
    description: str(2000),
    appliesToCategories: json('appliesToCategories', []),
    fixityIntervalDays: int(90),
    replicationTargets: json('replicationTargets', []),
    retainOriginalUploads: bool(true),
    generateAccessDerivatives: bool(true),
    isDefault: bool(false),
    isActive: bool(true),
  });

  const StorageReplica = sequelize.define(
    'StorageReplica',
    {
      id: pk(),
      assetId: fk(false),
      target: req(120),
      storageKey: req(600),
      status: status(['pending', 'replicated', 'failed', 'verified'], 'pending'),
      sha256: str(64),
      verifiedAt: date(),
      error: str(2000),
    },
    { indexes: [{ fields: ['assetId'] }] },
  );

  return {
    FormatRegistry,
    DigitalAsset,
    AssetChecksum,
    BackgroundJob,
    PreservationEvent,
    FixityCheck,
    PreservationAlert,
    PreservationPolicy,
    StorageReplica,
  };
}

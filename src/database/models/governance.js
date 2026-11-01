/**
 * Sequelize model definitions for the governance, workflow and administration domain.
 *
 * Defines the tables for retention schedules, appraisal cases and items, legal holds, disposal cases and
 * certificates, approvals, comments, the audit trail, workflow definitions, workflow history and tasks, import and
 * export jobs, system settings, reference number sequences and idempotency keys. Audit events are hash-chained
 * (each stores the hash of the previous event) and protected by an append-only trigger, so tampering can be
 * detected.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { DataTypes } from 'sequelize';
import { pk, fk, str, req, text, bool, int, date, dateOnly, status, json } from './_helpers.js';

export const APPRAISAL_STATUSES = [
  'open',
  'under_review',
  'on_hold',
  'recommended',
  'awaiting_approval',
  'approved',
  'rejected',
  'executed',
  'closed',
];
export const DISPOSAL_STATUSES = ['draft', 'pending_approval', 'approved', 'executed', 'blocked', 'cancelled'];
export const IMPORT_STATUSES = [
  'uploaded',
  'validating',
  'ready',
  'running',
  'completed_with_errors',
  'completed',
  'failed',
  'cancelled',
];

/**
 * Defines the governance, workflow and administration models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineGovernance(sequelize) {
  const RetentionSchedule = sequelize.define(
    'RetentionSchedule',
    {
      id: pk(),
      code: req(60),
      title: req(500),
      recordCategory: req(255),
      description: text(),
      triggerEvent: req(255),
      retentionYears: int(),
      finalAction: status(['permanent', 'review', 'transfer_to_archives', 'destroy', 'return_to_department']),
      legalBasis: str(2000),
      status: status(['draft', 'approved', 'retired'], 'draft'),
      approvedById: fk(),
      approvedAt: date(),
      policyNote: str(2000),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const AppraisalCase = sequelize.define(
    'AppraisalCase',
    {
      id: pk(),
      caseNumber: req(60),
      title: req(500),
      scheduleId: fk(),
      status: status(APPRAISAL_STATUSES, 'open'),
      recommendation: status(
        [
          'undecided',
          'retain_permanent',
          'transfer_to_archives',
          'extend_retention',
          'dispose',
          'return_to_department',
        ],
        'undecided',
      ),
      rationale: text(),
      reportSummary: json('reportSummary', {}),
      holdReason: str(2000),
      openedById: fk(false),
      recommendedById: fk(),
      recommendedAt: date(),
      decidedById: fk(),
      decidedAt: date(),
      decisionNote: text(),
      requiresInstitutionalApproval: bool(false),
    },
    { version: true, indexes: [{ unique: true, fields: ['caseNumber'] }, { fields: ['status'] }] },
  );

  const AppraisalCaseItem = sequelize.define(
    'AppraisalCaseItem',
    {
      id: pk(),
      caseId: fk(false),
      recordId: fk(),
      physicalItemId: fk(),
      assetId: fk(),
      triggerDate: dateOnly(),
      eligibility: status(
        [
          'eligible',
          'blocked_legal_hold',
          'blocked_permanent',
          'blocked_active_request',
          'blocked_restriction',
          'excluded',
        ],
        'eligible',
      ),
      blockReason: str(1000),
    },
    { indexes: [{ fields: ['caseId'] }] },
  );

  const LegalHold = sequelize.define(
    'LegalHold',
    {
      id: pk(),
      reference: req(60),
      title: req(500),
      description: text(),
      authority: str(500),
      status: status(['active', 'released'], 'active'),
      placedById: fk(false),
      placedAt: date({ allowNull: false }),
      releasedById: fk(),
      releasedAt: date(),
      releaseReason: str(2000),
    },
    { indexes: [{ unique: true, fields: ['reference'] }, { fields: ['status'] }] },
  );

  const LegalHoldItem = sequelize.define(
    'LegalHoldItem',
    {
      id: pk(),
      holdId: fk(false),
      recordId: fk(),
      assetId: fk(),
      physicalItemId: fk(),
      includeDescendants: bool(true),
    },
    { indexes: [{ fields: ['holdId'] }, { fields: ['recordId'] }] },
  );

  const DisposalCase = sequelize.define(
    'DisposalCase',
    {
      id: pk(),
      caseNumber: req(60),
      appraisalCaseId: fk(false),
      action: status(['destroy_physical', 'delete_digital', 'transfer_external', 'return_to_department']),
      status: status(DISPOSAL_STATUSES, 'draft'),
      dryRunSnapshot: json('dryRunSnapshot', null),
      dryRunAt: date(),
      requiredApprovals: int(2),
      executionConfirmation: str(200),
      executedById: fk(),
      executedAt: date(),
      executionResult: json('executionResult', {}),
      blockReason: str(2000),
      createdById: fk(false),
    },
    { version: true, indexes: [{ unique: true, fields: ['caseNumber'] }] },
  );

  const DisposalCertificate = sequelize.define(
    'DisposalCertificate',
    {
      id: pk(),
      disposalCaseId: fk(false),
      certificateNumber: req(60),
      issuedAt: date({ allowNull: false }),
      content: json('content', {}),
      sha256: str(64),
      storageKey: str(600),
      issuedById: fk(),
    },
    { indexes: [{ unique: true, fields: ['certificateNumber'] }] },
  );

  // Generic approvals ledger used for accession, publication, access, appraisal and disposal decisions.
  const Approval = sequelize.define(
    'Approval',
    {
      id: pk(),
      entityType: req(60),
      entityId: fk(false),
      stage: req(120),
      approverId: fk(false),
      decision: status(['approved', 'rejected', 'returned']),
      reason: str(4000),
    },
    { updatedAt: false, indexes: [{ fields: ['entityType', 'entityId'] }] },
  );

  const Comment = sequelize.define(
    'Comment',
    {
      id: pk(),
      entityType: req(60),
      entityId: fk(false),
      authorId: fk(),
      body: req(4000),
      visibility: status(['internal', 'shared'], 'internal'),
    },
    { indexes: [{ fields: ['entityType', 'entityId'] }] },
  );

  // Append-only. A trigger in the baseline migration blocks UPDATE and DELETE.
  // Each row stores the hash of the previous row so tampering is detectable.
  const AuditEvent = sequelize.define(
    'AuditEvent',
    {
      seq: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      eventId: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false },
      occurredAt: date({ allowNull: false }),
      actorType: status(['user', 'system', 'anonymous']),
      actorUserId: fk(),
      actorLabel: str(320),
      action: req(120),
      resourceType: str(60),
      resourceId: str(64),
      outcome: status(['success', 'failure', 'denied']),
      correlationId: str(64),
      ipAddress: str(64),
      userAgent: str(500),
      before: json('before', null),
      after: json('after', null),
      reason: str(2000),
      metadata: json('metadata', null),
      sensitive: bool(false),
      prevHash: str(64),
      hash: str(64),
    },
    {
      timestamps: false,
      indexes: [
        { unique: true, fields: ['eventId'] },
        { fields: ['occurredAt'] },
        { fields: ['actorUserId'] },
        { fields: ['resourceType', 'resourceId'] },
        { fields: ['action'] },
      ],
    },
  );

  const WorkflowDefinition = sequelize.define(
    'WorkflowDefinition',
    {
      id: pk(),
      code: req(60),
      name: req(200),
      entityType: req(60),
      config: json('config', {}),
      isActive: bool(true),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const WorkflowHistory = sequelize.define(
    'WorkflowHistory',
    {
      id: pk(),
      entityType: req(60),
      entityId: fk(false),
      action: req(80),
      fromState: str(40),
      toState: str(40),
      actorId: fk(),
      reason: str(4000),
      metadata: json('metadata', null),
    },
    { updatedAt: false, indexes: [{ fields: ['entityType', 'entityId', 'createdAt'] }] },
  );

  const WorkflowTask = sequelize.define(
    'WorkflowTask',
    {
      id: pk(),
      entityType: req(60),
      entityId: fk(false),
      taskType: req(80),
      title: req(500),
      assigneeId: fk(),
      assigneeRole: str(80),
      delegatedFromId: fk(),
      status: status(['open', 'completed', 'cancelled'], 'open'),
      dueAt: date(),
      lastReminderAt: date(),
      escalatedAt: date(),
      escalationLevel: int(0),
      completedAt: date(),
      completedById: fk(),
    },
    {
      indexes: [
        { fields: ['assigneeId', 'status'] },
        { fields: ['assigneeRole', 'status'] },
        { fields: ['entityType', 'entityId'] },
        { fields: ['dueAt'] },
      ],
    },
  );

  const ImportJob = sequelize.define(
    'ImportJob',
    {
      id: pk(),
      importType: status(['archival_records', 'authority_records', 'storage_locations', 'physical_items', 'users']),
      status: status(IMPORT_STATUSES, 'uploaded'),
      sourceFilename: req(500),
      storageKey: str(600),
      sha256: str(64),
      headers: json('headers', []),
      mapping: json('mapping', {}),
      options: json('options', {}),
      totalRows: int(0),
      validRows: int(0),
      invalidRows: int(0),
      importedRows: int(0),
      skippedRows: int(0),
      failedRows: int(0),
      lastError: str(4000),
      createdById: fk(false),
      completedAt: date(),
      approvedById: fk(),
      approvedAt: date(),
    },
    { indexes: [{ fields: ['status'] }, { fields: ['createdById'] }] },
  );

  const ImportRowResult = sequelize.define(
    'ImportRowResult',
    {
      id: pk(),
      jobId: fk(false),
      rowNumber: int(1),
      sourceKey: str(255),
      status: status(['pending', 'valid', 'invalid', 'imported', 'skipped', 'failed'], 'pending'),
      errors: json('errors', []),
      warnings: json('warnings', []),
      raw: json('raw', {}),
      entityId: fk(),
    },
    { indexes: [{ unique: true, fields: ['jobId', 'rowNumber'] }, { fields: ['jobId', 'status'] }] },
  );

  const ExportJob = sequelize.define(
    'ExportJob',
    {
      id: pk(),
      reportType: req(80),
      format: status(['csv', 'xlsx', 'pdf', 'xml', 'json']),
      filters: json('filters', {}),
      status: status(['queued', 'running', 'succeeded', 'failed', 'expired'], 'queued'),
      isSensitive: bool(false),
      rowCount: int(),
      storageKey: str(600),
      filename: str(255),
      error: str(4000),
      requestedById: fk(false),
      expiresAt: date(),
      completedAt: date(),
    },
    { indexes: [{ fields: ['requestedById'] }, { fields: ['status'] }] },
  );

  const SystemSetting = sequelize.define(
    'SystemSetting',
    {
      id: pk(),
      key: req(120),
      category: req(60),
      value: json('value', null),
      description: str(1000),
      isSecret: bool(false),
      updatedById: fk(),
    },
    { indexes: [{ unique: true, fields: ['key'] }] },
  );

  // Atomic counters for human-readable reference numbers (accessions, requests, cases...).
  const ReferenceSequence = sequelize.define(
    'ReferenceSequence',
    {
      id: pk(),
      scope: req(120),
      nextValue: int(1),
    },
    { indexes: [{ unique: true, fields: ['scope'] }] },
  );

  const IdempotencyKey = sequelize.define(
    'IdempotencyKey',
    {
      id: pk(),
      key: req(120),
      userId: fk(),
      method: req(10),
      path: req(500),
      requestHash: str(64),
      responseStatus: int(),
      responseBody: { type: DataTypes.TEXT, allowNull: true },
      expiresAt: date(),
    },
    { indexes: [{ unique: true, fields: ['key', 'userId'] }] },
  );

  return {
    RetentionSchedule,
    AppraisalCase,
    AppraisalCaseItem,
    LegalHold,
    LegalHoldItem,
    DisposalCase,
    DisposalCertificate,
    Approval,
    Comment,
    AuditEvent,
    WorkflowDefinition,
    WorkflowHistory,
    WorkflowTask,
    ImportJob,
    ImportRowResult,
    ExportJob,
    SystemSetting,
    ReferenceSequence,
    IdempotencyKey,
  };
}

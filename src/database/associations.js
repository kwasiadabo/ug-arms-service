/**
 * Relationships between all Sequelize models.
 *
 * Every association is declared here in one place, grouped by domain, so the full data model can be reviewed
 * together. All foreign keys use NO ACTION on delete and update: archival descriptions, custody records, audit
 * evidence and history must never disappear through a cascading delete, and SQL Server also rejects tables
 * reachable through more than one cascade path. Records are withdrawn or marked as deleted instead.
 *
 * @author Kwasi Adabo Boakye
 */

const SAFE = { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };

/**
 * Declares a many-to-one relationship (for example, a user belongs to one organisation unit) with non-cascading
 * foreign keys.
 *
 * @param {import('sequelize').ModelStatic} source Model that holds the foreign key.
 * @param {import('sequelize').ModelStatic} target Model being referenced.
 * @param {string} foreignKey Foreign key column on the source model.
 * @param {string} as Alias used when including the related row in queries.
 */
function belongs(source, target, foreignKey, as) {
  source.belongsTo(target, { foreignKey, as, ...SAFE });
}

/**
 * Declares a one-to-many relationship (for example, an accession has many items) with non-cascading foreign keys.
 *
 * @param {import('sequelize').ModelStatic} source Parent model.
 * @param {import('sequelize').ModelStatic} target Child model that holds the foreign key.
 * @param {string} foreignKey Foreign key column on the child model.
 * @param {string} as Alias used when including the children in queries.
 */
function has(source, target, foreignKey, as) {
  source.hasMany(target, { foreignKey, as, ...SAFE });
}

/**
 * Registers every association between the application models.
 *
 * Called once after all models are defined. The order of declarations has no effect; they are grouped by domain
 * (identity, archival description, accessioning, physical storage, digital assets, digitisation, research services
 * and governance) for readability.
 *
 * @param {Record<string, import('sequelize').ModelStatic>} m All defined models, keyed by model name.
 */
export function applyAssociations(m) {
  /**
   * Declares several "performed by" references from one model to the User model in a single call.
   *
   * The alias is the column name without its "Id" suffix, so `approvedById` becomes `approvedBy`.
   *
   * @param {import('sequelize').ModelStatic} Model Model that holds the user references.
   * @param {...string} keys Foreign key columns, for example "createdById" and "approvedById".
   */
  const userRefs = (Model, ...keys) => keys.forEach((k) => belongs(Model, m.User, k, k.replace(/Id$/, '')));

  // Identity
  belongs(m.User, m.OrganisationUnit, 'organisationUnitId', 'organisationUnit');
  belongs(m.OrganisationUnit, m.OrganisationUnit, 'parentId', 'parent');
  has(m.OrganisationUnit, m.OrganisationUnit, 'parentId', 'children');
  m.User.belongsToMany(m.Role, { through: m.UserRole, foreignKey: 'userId', otherKey: 'roleId', as: 'roles' });
  m.Role.belongsToMany(m.User, { through: m.UserRole, foreignKey: 'roleId', otherKey: 'userId', as: 'users' });
  m.Role.belongsToMany(m.Permission, {
    through: m.RolePermission,
    foreignKey: 'roleId',
    otherKey: 'permissionId',
    as: 'permissions',
  });
  m.Permission.belongsToMany(m.Role, {
    through: m.RolePermission,
    foreignKey: 'permissionId',
    otherKey: 'roleId',
    as: 'roles',
  });
  belongs(m.UserRole, m.User, 'userId', 'user');
  belongs(m.UserRole, m.Role, 'roleId', 'role');
  userRefs(m.UserRole, 'assignedById');
  belongs(m.RolePermission, m.Role, 'roleId', 'role');
  belongs(m.RolePermission, m.Permission, 'permissionId', 'permission');
  belongs(m.UserSession, m.User, 'userId', 'user');
  belongs(m.ActionToken, m.User, 'userId', 'user');
  belongs(m.Notification, m.User, 'userId', 'user');
  belongs(m.NotificationPreference, m.User, 'userId', 'user');

  // Archival description
  belongs(m.ArchivalRecord, m.Repository, 'repositoryId', 'repository');
  belongs(m.ArchivalRecord, m.ArchivalRecord, 'parentId', 'parent');
  has(m.ArchivalRecord, m.ArchivalRecord, 'parentId', 'children');
  belongs(m.ArchivalRecord, m.ArchivalRecord, 'rootId', 'root');
  belongs(m.ArchivalRecord, m.OrganisationUnit, 'originatingUnitId', 'originatingUnit');
  belongs(m.ArchivalRecord, m.RetentionSchedule, 'retentionScheduleId', 'retentionSchedule');
  userRefs(
    m.ArchivalRecord,
    'responsibleArchivistId',
    'createdById',
    'updatedById',
    'approvedById',
    'publishedById',
    'submittedForReviewById',
  );
  belongs(m.ArchivalRecordVersion, m.ArchivalRecord, 'recordId', 'record');
  has(m.ArchivalRecord, m.ArchivalRecordVersion, 'recordId', 'versions');
  userRefs(m.ArchivalRecordVersion, 'changedById');
  belongs(m.AuthorityRecord, m.OrganisationUnit, 'organisationUnitId', 'organisationUnit');
  belongs(m.AuthorityRecord, m.AuthorityRecord, 'mergedIntoId', 'mergedInto');
  userRefs(m.AuthorityRecord, 'createdById', 'updatedById');
  belongs(m.AuthorityRelationship, m.AuthorityRecord, 'sourceId', 'source');
  belongs(m.AuthorityRelationship, m.AuthorityRecord, 'targetId', 'target');
  belongs(m.VocabularyTerm, m.ControlledVocabulary, 'vocabularyId', 'vocabulary');
  has(m.ControlledVocabulary, m.VocabularyTerm, 'vocabularyId', 'terms');
  belongs(m.VocabularyTerm, m.VocabularyTerm, 'parentId', 'parent');
  belongs(m.RecordCreator, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.RecordCreator, m.AuthorityRecord, 'authorityId', 'authority');
  has(m.ArchivalRecord, m.RecordCreator, 'recordId', 'creators');
  belongs(m.RecordSubject, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.RecordSubject, m.VocabularyTerm, 'termId', 'term');
  belongs(m.RecordSubject, m.AuthorityRecord, 'authorityId', 'authority');
  has(m.ArchivalRecord, m.RecordSubject, 'recordId', 'subjects');
  belongs(m.RecordIdentifier, m.ArchivalRecord, 'recordId', 'record');
  has(m.ArchivalRecord, m.RecordIdentifier, 'recordId', 'identifiers');
  belongs(m.RecordRelationship, m.ArchivalRecord, 'sourceId', 'source');
  belongs(m.RecordRelationship, m.ArchivalRecord, 'targetId', 'target');
  has(m.ArchivalRecord, m.RecordRelationship, 'sourceId', 'relationships');
  userRefs(m.AccessRestriction, 'requestedById', 'authorisedById', 'liftedById');
  belongs(m.AccessException, m.ArchivalRecord, 'recordId', 'record');
  userRefs(m.AccessException, 'requestedById', 'approvedById', 'revokedById');
  userRefs(m.AccessChangeRequest, 'requestedById', 'decidedById');
  belongs(m.AccessGrant, m.User, 'userId', 'user');
  userRefs(m.AccessGrant, 'grantedById', 'revokedById');
  belongs(m.AccessGrant, m.ResearchRequest, 'researchRequestId', 'researchRequest');

  // Accessioning
  belongs(m.TransferSubmission, m.OrganisationUnit, 'originatingUnitId', 'originatingUnit');
  userRefs(m.TransferSubmission, 'submittedById', 'reviewerId', 'decisionById');
  belongs(m.TransferSubmission, m.Accession, 'accessionId', 'accession');
  belongs(m.TransferInventoryItem, m.TransferSubmission, 'submissionId', 'submission');
  has(m.TransferSubmission, m.TransferInventoryItem, 'submissionId', 'items');
  belongs(m.TransferSubmissionRevision, m.TransferSubmission, 'submissionId', 'submission');
  has(m.TransferSubmission, m.TransferSubmissionRevision, 'submissionId', 'revisions');
  userRefs(m.TransferSubmissionRevision, 'createdById');
  belongs(m.Accession, m.Repository, 'repositoryId', 'repository');
  belongs(m.Accession, m.TransferSubmission, 'transferSubmissionId', 'transferSubmission');
  belongs(m.Accession, m.OrganisationUnit, 'sourceUnitId', 'sourceUnit');
  userRefs(m.Accession, 'responsibleOfficerId', 'submittedById', 'approvedById', 'createdById', 'updatedById');
  belongs(m.AccessionItem, m.Accession, 'accessionId', 'accession');
  has(m.Accession, m.AccessionItem, 'accessionId', 'items');
  belongs(m.AccessionItem, m.TransferInventoryItem, 'inventoryItemId', 'inventoryItem');
  belongs(m.AccessionItem, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.AccessionItem, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  belongs(m.AccessionRecordLink, m.Accession, 'accessionId', 'accession');
  belongs(m.AccessionRecordLink, m.ArchivalRecord, 'recordId', 'record');
  has(m.Accession, m.AccessionRecordLink, 'accessionId', 'recordLinks');
  has(m.ArchivalRecord, m.AccessionRecordLink, 'recordId', 'accessionLinks');
  userRefs(m.TransferDocument, 'uploadedById');

  // Physical storage
  belongs(m.StorageLocation, m.StorageLocationType, 'typeId', 'type');
  belongs(m.StorageLocation, m.StorageLocation, 'parentId', 'parent');
  has(m.StorageLocation, m.StorageLocation, 'parentId', 'children');
  belongs(m.StorageLocation, m.Repository, 'repositoryId', 'repository');
  belongs(m.PhysicalItem, m.ArchivalRecord, 'recordId', 'record');
  has(m.ArchivalRecord, m.PhysicalItem, 'recordId', 'physicalItems');
  belongs(m.PhysicalItem, m.Accession, 'accessionId', 'accession');
  belongs(m.PhysicalItem, m.StorageLocation, 'currentLocationId', 'currentLocation');
  belongs(m.PhysicalItem, m.StorageLocation, 'homeLocationId', 'homeLocation');
  has(m.StorageLocation, m.PhysicalItem, 'currentLocationId', 'items');
  userRefs(m.PhysicalItem, 'createdById');
  belongs(m.PhysicalItemMovement, m.PhysicalItem, 'itemId', 'item');
  has(m.PhysicalItem, m.PhysicalItemMovement, 'itemId', 'movements');
  belongs(m.PhysicalItemMovement, m.StorageLocation, 'fromLocationId', 'fromLocation');
  belongs(m.PhysicalItemMovement, m.StorageLocation, 'toLocationId', 'toLocation');
  userRefs(m.PhysicalItemMovement, 'movedById', 'approvedById');
  belongs(m.ConditionAssessment, m.PhysicalItem, 'itemId', 'item');
  has(m.PhysicalItem, m.ConditionAssessment, 'itemId', 'conditionAssessments');
  userRefs(m.ConditionAssessment, 'assessedById');
  belongs(m.InventoryAudit, m.StorageLocation, 'locationId', 'location');
  userRefs(m.InventoryAudit, 'startedById', 'completedById');
  belongs(m.InventoryAuditLine, m.InventoryAudit, 'auditId', 'audit');
  has(m.InventoryAudit, m.InventoryAuditLine, 'auditId', 'lines');
  belongs(m.InventoryAuditLine, m.PhysicalItem, 'itemId', 'item');

  // Digital assets & preservation
  belongs(m.DigitalAsset, m.ArchivalRecord, 'recordId', 'record');
  has(m.ArchivalRecord, m.DigitalAsset, 'recordId', 'assets');
  belongs(m.DigitalAsset, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  belongs(m.DigitalAsset, m.DigitisationItem, 'digitisationItemId', 'digitisationItem');
  belongs(m.DigitalAsset, m.DigitalAsset, 'parentAssetId', 'parentAsset');
  has(m.DigitalAsset, m.DigitalAsset, 'parentAssetId', 'derivatives');
  belongs(m.DigitalAsset, m.DigitalAsset, 'supersededById', 'supersededBy');
  belongs(m.DigitalAsset, m.DigitalAsset, 'duplicateOfId', 'duplicateOf');
  userRefs(m.DigitalAsset, 'uploadedById', 'deletedById');
  belongs(m.AssetChecksum, m.DigitalAsset, 'assetId', 'asset');
  has(m.DigitalAsset, m.AssetChecksum, 'assetId', 'checksums');
  userRefs(m.BackgroundJob, 'requestedById');
  belongs(m.PreservationEvent, m.DigitalAsset, 'assetId', 'asset');
  has(m.DigitalAsset, m.PreservationEvent, 'assetId', 'preservationEvents');
  belongs(m.PreservationEvent, m.ArchivalRecord, 'recordId', 'record');
  userRefs(m.PreservationEvent, 'agentUserId');
  belongs(m.FixityCheck, m.DigitalAsset, 'assetId', 'asset');
  has(m.DigitalAsset, m.FixityCheck, 'assetId', 'fixityChecks');
  belongs(m.PreservationAlert, m.DigitalAsset, 'assetId', 'asset');
  belongs(m.PreservationAlert, m.FixityCheck, 'fixityCheckId', 'fixityCheck');
  userRefs(m.PreservationAlert, 'assignedToId', 'resolvedById');
  belongs(m.StorageReplica, m.DigitalAsset, 'assetId', 'asset');
  has(m.DigitalAsset, m.StorageReplica, 'assetId', 'replicas');

  // Digitisation & OCR
  belongs(m.DigitisationProject, m.ArchivalRecord, 'sourceRecordId', 'sourceRecord');
  belongs(m.DigitisationProject, m.QualityProfile, 'qualityProfileId', 'qualityProfile');
  userRefs(m.DigitisationProject, 'approvedById', 'createdById');
  belongs(m.DigitisationBatch, m.DigitisationProject, 'projectId', 'project');
  has(m.DigitisationProject, m.DigitisationBatch, 'projectId', 'batches');
  userRefs(m.DigitisationBatch, 'operatorId', 'qaReviewerId');
  belongs(m.DigitisationItem, m.DigitisationBatch, 'batchId', 'batch');
  has(m.DigitisationBatch, m.DigitisationItem, 'batchId', 'items');
  belongs(m.DigitisationItem, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.DigitisationItem, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  has(m.DigitisationItem, m.DigitalAsset, 'digitisationItemId', 'assets');
  belongs(m.QualityAssuranceReview, m.DigitisationBatch, 'batchId', 'batch');
  has(m.DigitisationBatch, m.QualityAssuranceReview, 'batchId', 'reviews');
  belongs(m.QualityAssuranceReview, m.DigitisationItem, 'itemId', 'item');
  belongs(m.QualityAssuranceReview, m.DigitalAsset, 'assetId', 'asset');
  userRefs(m.QualityAssuranceReview, 'reviewerId');
  belongs(m.OCRJob, m.DigitalAsset, 'assetId', 'asset');
  has(m.DigitalAsset, m.OCRJob, 'assetId', 'ocrJobs');
  userRefs(m.OCRJob, 'requestedById');
  belongs(m.OCRPage, m.OCRJob, 'ocrJobId', 'job');
  has(m.OCRJob, m.OCRPage, 'ocrJobId', 'pages');
  belongs(m.OCRPage, m.DigitalAsset, 'assetId', 'asset');
  has(m.DigitalAsset, m.OCRPage, 'assetId', 'ocrPages');
  userRefs(m.OCRPage, 'reviewedById');
  belongs(m.OCRRevision, m.OCRPage, 'pageId', 'page');
  has(m.OCRPage, m.OCRRevision, 'pageId', 'revisions');
  userRefs(m.OCRRevision, 'editedById');

  // Research services
  belongs(m.ResearchRequest, m.User, 'requesterId', 'requester');
  userRefs(m.ResearchRequest, 'assignedToId', 'decisionById', 'secondApproverId');
  belongs(m.ResearchRequestItem, m.ResearchRequest, 'requestId', 'request');
  has(m.ResearchRequest, m.ResearchRequestItem, 'requestId', 'items');
  belongs(m.ResearchRequestItem, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.ResearchRequestItem, m.DigitalAsset, 'assetId', 'asset');
  belongs(m.ResearchRequestItem, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  belongs(m.ReadingRoom, m.Repository, 'repositoryId', 'repository');
  belongs(m.ReadingRoomClosure, m.ReadingRoom, 'readingRoomId', 'readingRoom');
  has(m.ReadingRoom, m.ReadingRoomClosure, 'readingRoomId', 'closures');
  belongs(m.AppointmentSlot, m.ReadingRoom, 'readingRoomId', 'readingRoom');
  has(m.ReadingRoom, m.AppointmentSlot, 'readingRoomId', 'slots');
  belongs(m.ResearchAppointment, m.AppointmentSlot, 'slotId', 'slot');
  has(m.AppointmentSlot, m.ResearchAppointment, 'slotId', 'appointments');
  belongs(m.ResearchAppointment, m.ResearchRequest, 'requestId', 'request');
  has(m.ResearchRequest, m.ResearchAppointment, 'requestId', 'appointments');
  userRefs(m.ResearchAppointment, 'researcherId', 'checkedInById');
  belongs(m.CirculationTransaction, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  has(m.PhysicalItem, m.CirculationTransaction, 'physicalItemId', 'circulations');
  belongs(m.CirculationTransaction, m.ResearchRequest, 'requestId', 'request');
  has(m.ResearchRequest, m.CirculationTransaction, 'requestId', 'circulations');
  belongs(m.CirculationTransaction, m.ResearchAppointment, 'appointmentId', 'appointment');
  userRefs(m.CirculationTransaction, 'researcherId', 'issuedById', 'receivedById');
  belongs(m.ReproductionRequest, m.ResearchRequest, 'requestId', 'request');
  has(m.ResearchRequest, m.ReproductionRequest, 'requestId', 'reproductions');
  belongs(m.ReproductionRequest, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.ReproductionRequest, m.DigitalAsset, 'assetId', 'asset');
  belongs(m.ReproductionRequest, m.DigitalAsset, 'deliveredAssetId', 'deliveredAsset');
  belongs(m.ResearchListItem, m.User, 'userId', 'user');
  belongs(m.ResearchListItem, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.SavedSearch, m.User, 'userId', 'user');
  belongs(m.CatalogueFeedback, m.ArchivalRecord, 'recordId', 'record');
  userRefs(m.CatalogueFeedback, 'userId', 'reviewedById');

  // Governance
  userRefs(m.RetentionSchedule, 'approvedById');
  belongs(m.AppraisalCase, m.RetentionSchedule, 'scheduleId', 'schedule');
  userRefs(m.AppraisalCase, 'openedById', 'recommendedById', 'decidedById');
  belongs(m.AppraisalCaseItem, m.AppraisalCase, 'caseId', 'case');
  has(m.AppraisalCase, m.AppraisalCaseItem, 'caseId', 'items');
  belongs(m.AppraisalCaseItem, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.AppraisalCaseItem, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  belongs(m.AppraisalCaseItem, m.DigitalAsset, 'assetId', 'asset');
  userRefs(m.LegalHold, 'placedById', 'releasedById');
  belongs(m.LegalHoldItem, m.LegalHold, 'holdId', 'hold');
  has(m.LegalHold, m.LegalHoldItem, 'holdId', 'items');
  belongs(m.LegalHoldItem, m.ArchivalRecord, 'recordId', 'record');
  belongs(m.LegalHoldItem, m.DigitalAsset, 'assetId', 'asset');
  belongs(m.LegalHoldItem, m.PhysicalItem, 'physicalItemId', 'physicalItem');
  belongs(m.DisposalCase, m.AppraisalCase, 'appraisalCaseId', 'appraisalCase');
  has(m.AppraisalCase, m.DisposalCase, 'appraisalCaseId', 'disposalCases');
  userRefs(m.DisposalCase, 'executedById', 'createdById');
  belongs(m.DisposalCertificate, m.DisposalCase, 'disposalCaseId', 'disposalCase');
  has(m.DisposalCase, m.DisposalCertificate, 'disposalCaseId', 'certificates');
  userRefs(m.DisposalCertificate, 'issuedById');
  userRefs(m.Approval, 'approverId');
  userRefs(m.Comment, 'authorId');
  userRefs(m.WorkflowHistory, 'actorId');
  userRefs(m.WorkflowTask, 'assigneeId', 'delegatedFromId', 'completedById');
  userRefs(m.ImportJob, 'createdById', 'approvedById');
  belongs(m.ImportRowResult, m.ImportJob, 'jobId', 'job');
  has(m.ImportJob, m.ImportRowResult, 'jobId', 'rows');
  userRefs(m.ExportJob, 'requestedById');
  userRefs(m.SystemSetting, 'updatedById');
}

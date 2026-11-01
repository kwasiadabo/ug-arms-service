/**
 * Sequelize model definitions for the archival description domain.
 *
 * Defines the tables for repositories, hierarchical archival descriptions and their versions, authority records and
 * their relationships, controlled vocabularies and terms, creator and subject links, alternative identifiers,
 * related records, access restrictions, access exceptions, access grants and access change requests. Descriptions
 * follow ISAD(G) and authority records follow ISAAR(CPF). Each description stores its own access level and the
 * effective level inherited from its ancestors; the effective level is the strictest value on the path and is what
 * search, display and file delivery enforce.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { pk, fk, str, req, text, bool, int, date, dateOnly, status, json } from './_helpers.js';

export const LEVELS = ['fonds', 'collection', 'subfonds', 'series', 'subseries', 'file', 'item'];
export const DESCRIPTION_STATUSES = ['draft', 'in_review', 'approved', 'published', 'withdrawn', 'superseded'];
// Ordered from most permissive to most restrictive. Effective access is the strictest value on the path.
export const ACCESS_LEVELS = ['open', 'staff_only', 'restricted', 'embargoed', 'confidential', 'closed'];

/**
 * Defines the archival description models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineArchival(sequelize) {
  const Repository = sequelize.define(
    'Repository',
    {
      id: pk(),
      code: req(40),
      name: req(255),
      authorizedFormOfName: str(255),
      address: str(1000),
      contactEmail: str(320),
      contactPhone: str(60),
      description: text(),
      openingTimes: str(1000),
      accessConditions: text(),
      accessLevel: status(ACCESS_LEVELS, 'open'),
      isActive: bool(true),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  // A single table holds every level of description (fonds/collection down to item). Collections are
  // simply the top-level rows. This keeps the hierarchy, inheritance and versioning in one place.
  const ArchivalRecord = sequelize.define(
    'ArchivalRecord',
    {
      id: pk(),
      repositoryId: fk(false),
      parentId: fk(),
      rootId: fk(),
      path: str(2000),
      depth: int(0),
      sortOrder: int(0),
      level: status(LEVELS, 'fonds'),
      referenceCode: req(120),
      localIdentifier: str(120),
      title: req(1000),
      alternativeTitle: str(1000),
      collectionType: str(80),
      dateExpression: str(255),
      dateStart: dateOnly(),
      dateEnd: dateOnly(),
      bulkDateStart: dateOnly(),
      bulkDateEnd: dateOnly(),
      extentAndMedium: str(2000),
      creatorNote: str(1000),
      adminBiographicalHistory: text(),
      archivalHistory: text(),
      immediateSource: text(),
      scopeAndContent: text(),
      appraisalInfo: text(),
      accruals: text(),
      arrangement: text(),
      accessConditions: text(),
      reproductionConditions: text(),
      copyrightStatement: text(),
      languages: json('languages', []),
      scripts: json('scripts', []),
      physicalCharacteristics: text(),
      findingAids: text(),
      locationOfOriginals: text(),
      locationOfCopies: text(),
      relatedMaterials: text(),
      publicationNote: text(),
      archivistNote: text(),
      rulesConventions: str(1000),
      descriptionDate: dateOnly(),
      preferredCitation: str(1000),
      geographicCoverage: str(1000),
      preservationNote: text(),
      keywords: json('keywords', []),
      status: status(DESCRIPTION_STATUSES, 'draft'),
      accessLevel: status(ACCESS_LEVELS, 'staff_only'),
      embargoUntil: dateOnly(),
      // Denormalised results of the access policy (see services/accessPolicy.service.js). Recomputed for the
      // whole subtree whenever status, access level, restrictions or exceptions change.
      effectiveAccessLevel: status(ACCESS_LEVELS, 'staff_only'),
      effectiveFlags: json('effectiveFlags', []),
      publicVisibility: status(['hidden', 'metadata_only', 'full'], 'hidden'),
      isPermanent: bool(true),
      // 'departmental' = held on behalf of a unit under a retention schedule; 'accessioned' = formally in the Archives.
      custodyStatus: status(['accessioned', 'departmental'], 'accessioned'),
      retentionScheduleId: fk(),
      retentionTriggerDate: dateOnly(),
      isFeatured: bool(false),
      aiProcessingAllowed: bool(false),
      originatingUnitId: fk(),
      responsibleArchivistId: fk(),
      reviewDate: dateOnly(),
      submittedForReviewAt: date(),
      submittedForReviewById: fk(),
      approvedAt: date(),
      approvedById: fk(),
      publishedAt: date(),
      publishedById: fk(),
      withdrawnAt: date(),
      withdrawalReason: str(1000),
      searchText: text(),
      createdById: fk(),
      updatedById: fk(),
    },
    {
      version: true,
      indexes: [
        { unique: true, fields: ['referenceCode'] },
        { fields: ['parentId', 'sortOrder'] },
        { fields: ['rootId'] },
        { fields: ['repositoryId'] },
        { fields: ['status'] },
        { fields: ['accessLevel'] },
        { fields: ['publicVisibility', 'status'] },
        { fields: ['effectiveAccessLevel'] },
        { fields: ['level'] },
        { fields: ['dateStart', 'dateEnd'] },
        { fields: ['originatingUnitId'] },
      ],
    },
  );

  const ArchivalRecordVersion = sequelize.define(
    'ArchivalRecordVersion',
    {
      id: pk(),
      recordId: fk(false),
      versionNumber: int(1),
      status: str(40),
      snapshot: json('snapshot', {}),
      changeSummary: str(1000),
      changedFields: json('changedFields', []),
      changedById: fk(),
    },
    { updatedAt: false, indexes: [{ unique: true, fields: ['recordId', 'versionNumber'] }] },
  );

  const AuthorityRecord = sequelize.define(
    'AuthorityRecord',
    {
      id: pk(),
      entityType: status(
        ['person', 'family', 'corporate_body', 'university_unit', 'place', 'subject', 'function'],
        'person',
      ),
      authorizedName: req(500),
      otherNames: json('otherNames', []),
      historicalNames: json('historicalNames', []),
      identifier: str(120),
      datesOfExistence: str(255),
      history: text(),
      places: str(1000),
      legalStatus: str(500),
      functions: text(),
      mandates: text(),
      internalStructure: text(),
      generalContext: text(),
      sources: text(),
      externalIds: json('externalIds', []),
      verificationStatus: status(['unverified', 'provisional', 'verified'], 'provisional'),
      organisationUnitId: fk(),
      status: status(['draft', 'approved', 'deprecated', 'merged'], 'draft'),
      mergedIntoId: fk(),
      normalisedName: str(500),
      createdById: fk(),
      updatedById: fk(),
    },
    { version: true, indexes: [{ fields: ['entityType', 'normalisedName'] }, { fields: ['identifier'] }] },
  );

  const AuthorityRelationship = sequelize.define(
    'AuthorityRelationship',
    {
      id: pk(),
      sourceId: fk(false),
      targetId: fk(false),
      relationType: req(60),
      dates: str(255),
      note: str(1000),
    },
    { indexes: [{ fields: ['sourceId'] }, { fields: ['targetId'] }] },
  );

  const ControlledVocabulary = sequelize.define(
    'ControlledVocabulary',
    {
      id: pk(),
      code: req(60),
      name: req(200),
      description: str(1000),
      isHierarchical: bool(false),
      isSystem: bool(false),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const VocabularyTerm = sequelize.define(
    'VocabularyTerm',
    {
      id: pk(),
      vocabularyId: fk(false),
      parentId: fk(),
      code: req(80),
      label: req(255),
      altLabels: json('altLabels', []),
      scopeNote: str(1000),
      sortOrder: int(0),
      isActive: bool(true),
    },
    { indexes: [{ unique: true, fields: ['vocabularyId', 'code'] }] },
  );

  const RecordCreator = sequelize.define(
    'RecordCreator',
    {
      id: pk(),
      recordId: fk(false),
      authorityId: fk(false),
      role: str(80, { defaultValue: 'creator' }),
    },
    { indexes: [{ unique: true, fields: ['recordId', 'authorityId', 'role'] }] },
  );

  const RecordSubject = sequelize.define(
    'RecordSubject',
    {
      id: pk(),
      recordId: fk(false),
      termId: fk(),
      authorityId: fk(),
      subjectType: status(['subject', 'place', 'person', 'organisation', 'genre', 'function'], 'subject'),
    },
    { indexes: [{ fields: ['recordId'] }, { fields: ['termId'] }, { fields: ['authorityId'] }] },
  );

  const RecordIdentifier = sequelize.define(
    'RecordIdentifier',
    {
      id: pk(),
      recordId: fk(false),
      scheme: req(60),
      value: req(255),
    },
    { indexes: [{ unique: true, fields: ['scheme', 'value'] }] },
  );

  const RecordRelationship = sequelize.define(
    'RecordRelationship',
    {
      id: pk(),
      sourceId: fk(false),
      targetId: fk(false),
      relationType: status(
        ['related', 'associated_material', 'copy_of', 'original_of', 'continues', 'continued_by', 'see_also'],
        'related',
      ),
      note: str(1000),
    },
    { indexes: [{ unique: true, fields: ['sourceId', 'targetId', 'relationType'] }] },
  );

  // Detailed restrictions (Module 12). The record's accessLevel is the headline; these rows carry
  // basis, dates, approvals and nuances (on-site only, no download, reproduction by permission, ...).
  const AccessRestriction = sequelize.define(
    'AccessRestriction',
    {
      id: pk(),
      targetType: status(['repository', 'record', 'asset']),
      targetId: fk(false),
      restrictionType: status([
        'staff_only',
        'restricted',
        'embargoed',
        'confidential',
        'closed',
        'onsite_only',
        'view_only',
        'no_download',
        'reproduction_by_permission',
        'copyright',
        'personal_data',
      ]),
      legalBasis: str(1000),
      effectiveFrom: dateOnly(),
      expiresAt: dateOnly(),
      reviewDate: dateOnly(),
      publicExplanation: str(1000),
      internalNotes: text(),
      status: status(['pending_approval', 'active', 'expired_pending_review', 'lifted', 'rejected'], 'active'),
      requestedById: fk(),
      authorisedById: fk(),
      authorisedAt: date(),
      liftedById: fk(),
      liftedAt: date(),
    },
    { indexes: [{ fields: ['targetType', 'targetId', 'status'] }, { fields: ['expiresAt'] }] },
  );

  // An explicit, approved exception allowing a child to be more permissive than its parent.
  const AccessException = sequelize.define(
    'AccessException',
    {
      id: pk(),
      recordId: fk(false),
      grantedAccessLevel: status(ACCESS_LEVELS, 'open'),
      reason: req(1000),
      status: status(['pending_approval', 'active', 'revoked', 'rejected'], 'pending_approval'),
      requestedById: fk(),
      approvedById: fk(),
      approvedAt: date(),
      revokedById: fk(),
      revokedAt: date(),
    },
    { indexes: [{ fields: ['recordId', 'status'] }] },
  );

  // Time-limited, researcher-specific access grants (e.g. created by an approved research request).
  const AccessGrant = sequelize.define(
    'AccessGrant',
    {
      id: pk(),
      userId: fk(false),
      targetType: status(['record', 'asset']),
      targetId: fk(false),
      permissionLevel: status(['view', 'download'], 'view'),
      includeDescendants: bool(true),
      expiresAt: date(),
      grantedById: fk(),
      researchRequestId: fk(),
      revokedAt: date(),
      revokedById: fk(),
    },
    { indexes: [{ fields: ['userId', 'targetType', 'targetId'] }] },
  );

  // Any change that makes material MORE accessible (lower level, lifted restriction, exception) is a request
  // that a second, distinct authorised person must approve when two-person control is enabled.
  const AccessChangeRequest = sequelize.define(
    'AccessChangeRequest',
    {
      id: pk(),
      targetType: status(['record', 'asset']),
      targetId: fk(false),
      changeType: status(['set_level', 'lift_restriction', 'grant_exception']),
      fromLevel: str(40),
      toLevel: str(40),
      payload: json('payload', {}),
      reason: req(2000),
      status: status(['pending', 'approved', 'rejected', 'cancelled'], 'pending'),
      requestedById: fk(false),
      decidedById: fk(),
      decidedAt: date(),
      decisionReason: str(2000),
    },
    { indexes: [{ fields: ['status'] }, { fields: ['targetType', 'targetId'] }] },
  );

  return {
    AccessChangeRequest,
    Repository,
    ArchivalRecord,
    ArchivalRecordVersion,
    AuthorityRecord,
    AuthorityRelationship,
    ControlledVocabulary,
    VocabularyTerm,
    RecordCreator,
    RecordSubject,
    RecordIdentifier,
    RecordRelationship,
    AccessRestriction,
    AccessException,
    AccessGrant,
  };
}

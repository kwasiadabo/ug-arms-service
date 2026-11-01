/**
 * Business rules for archival descriptions: the hierarchy, cataloguing, versions, workflow and links to creators,
 * subjects, identifiers and related descriptions.
 *
 * The hierarchy follows ISAD(G) levels, and a child must sit at a lower level than its parent. Every change creates
 * a version that can be compared and restored. Approved and published descriptions can be edited only by reviewers,
 * and restoring an older version sends the description back through review. The fields required before review and
 * before publication depend on the level. The person who submitted a description cannot approve it, and
 * confidential or closed descriptions can never be published. After every change the search text, effective access
 * and search index are updated.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, conflict, validationError } from '../../utils/errors.js';
import { audit, diff, scrub } from '../../services/audit.service.js';
import {
  transition,
  assertTransition,
  assertSeparationOfDuties,
  availableActions,
} from '../../services/workflow.service.js';
import { refreshEffectiveAccess, pathIds, hasPerm } from '../../services/accessPolicy.service.js';
import { notifyPermissionHolders, notifyUsers } from '../../services/notification.service.js';
import { enqueue } from '../../services/queue.service.js';

const LEVEL_RANK = { fonds: 0, collection: 0, subfonds: 1, series: 2, subseries: 3, file: 4, item: 5 };
const NESTABLE = new Set(['subfonds', 'subseries']);

// Permission required for each description workflow action. Superseding happens only through other operations.
const ACTION_PERMISSION = {
  submit_for_review: 'records.update',
  return_to_draft: 'records.review',
  approve: 'records.approve',
  publish: 'records.publish',
  withdraw: 'records.withdraw',
  reinstate: 'records.withdraw',
};

// Minimum metadata per level, informed by ISAD(G) essential elements. Configurable in future via settings.
export const REQUIRED_FOR_REVIEW = {
  fonds: [
    'referenceCode',
    'title',
    'dates',
    'level',
    'extentAndMedium',
    'creator',
    'scopeAndContent',
    'adminBiographicalHistory',
  ],
  collection: ['referenceCode', 'title', 'dates', 'level', 'extentAndMedium', 'creator', 'scopeAndContent'],
  subfonds: ['referenceCode', 'title', 'dates', 'level', 'scopeAndContent'],
  series: ['referenceCode', 'title', 'dates', 'level', 'extentAndMedium', 'scopeAndContent'],
  subseries: ['referenceCode', 'title', 'dates', 'level'],
  file: ['referenceCode', 'title', 'dates', 'level'],
  item: ['referenceCode', 'title', 'dates', 'level'],
};
export const REQUIRED_FOR_PUBLICATION = ['accessConditions', 'reproductionConditions'];

export const VERSIONED_FIELDS = [
  'parentId',
  'level',
  'referenceCode',
  'localIdentifier',
  'title',
  'alternativeTitle',
  'collectionType',
  'dateExpression',
  'dateStart',
  'dateEnd',
  'bulkDateStart',
  'bulkDateEnd',
  'extentAndMedium',
  'creatorNote',
  'adminBiographicalHistory',
  'archivalHistory',
  'immediateSource',
  'scopeAndContent',
  'appraisalInfo',
  'accruals',
  'arrangement',
  'accessConditions',
  'reproductionConditions',
  'copyrightStatement',
  'languages',
  'scripts',
  'physicalCharacteristics',
  'findingAids',
  'locationOfOriginals',
  'locationOfCopies',
  'relatedMaterials',
  'publicationNote',
  'archivistNote',
  'rulesConventions',
  'descriptionDate',
  'preferredCitation',
  'geographicCoverage',
  'preservationNote',
  'keywords',
  'originatingUnitId',
  'responsibleArchivistId',
  'reviewDate',
  'isFeatured',
  'isPermanent',
  'custodyStatus',
  'retentionScheduleId',
  'retentionTriggerDate',
  'accessLevel',
  'embargoUntil',
  'status',
];
const RESTORABLE_FIELDS = VERSIONED_FIELDS.filter(
  (f) => !['parentId', 'level', 'status', 'accessLevel', 'embargoUntil', 'referenceCode'].includes(f),
);

/**
 * Checks that a level of description may be placed under a parent: top-level descriptions must be a fonds or a
 * collection, and a child must be at a lower level than its parent, except that sub-fonds and sub-series may be
 * nested within themselves.
 *
 * @param {string} level Level of the description.
 * @param {object|null} parent Parent description, or null for top level.
 * @throws {AppError} 400 when the placement is not allowed.
 */
export function validateLevel(level, parent) {
  if (!parent) {
    if (!['fonds', 'collection'].includes(level))
      throw badRequest('Top-level descriptions must be a fonds or a collection');
    return;
  }
  const ok = LEVEL_RANK[level] > LEVEL_RANK[parent.level] || (level === parent.level && NESTABLE.has(level));
  if (!ok) throw badRequest(`A ${level} cannot be placed under a ${parent.level}`);
}

/**
 * Lists the required fields that a description has not filled in. "dates" is satisfied by a date expression or a
 * start date, and "creator" by a creator note or a linked creator.
 *
 * @param {object} record The description, with its creators loaded when "creator" is required.
 * @param {string[]} required Field names to check.
 * @returns {string[]} The missing field names.
 */
export function missingFields(record, required) {
  const missing = [];
  for (const f of required) {
    if (f === 'dates') {
      if (!record.dateExpression && !record.dateStart) missing.push('dates');
    } else if (f === 'creator') {
      if (!record.creatorNote && !record.creators?.length) missing.push('creator');
    } else if (
      record[f] === null ||
      record[f] === undefined ||
      record[f] === '' ||
      (Array.isArray(record[f]) && !record[f].length)
    ) {
      missing.push(f);
    }
  }
  return missing;
}

/**
 * Builds the text that the SQL search matches against: reference code, titles, dates, scope and content, history,
 * creator note, places, keywords and the names of linked creators and subjects, limited to 200,000 characters.
 *
 * @param {object} record The description.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<string>}
 */
async function buildSearchText(record, transaction) {
  const creators = await models.RecordCreator.findAll({
    where: { recordId: record.id },
    include: [{ model: models.AuthorityRecord, as: 'authority', attributes: ['authorizedName'] }],
    transaction,
  });
  const subjects = await models.RecordSubject.findAll({
    where: { recordId: record.id },
    include: [
      { model: models.VocabularyTerm, as: 'term', attributes: ['label'] },
      { model: models.AuthorityRecord, as: 'authority', attributes: ['authorizedName'] },
    ],
    transaction,
  });
  return [
    record.referenceCode,
    record.title,
    record.alternativeTitle,
    record.dateExpression,
    record.scopeAndContent,
    record.adminBiographicalHistory,
    record.creatorNote,
    record.geographicCoverage,
    (record.keywords || []).join(' '),
    ...creators.map((c) => c.authority?.authorizedName),
    ...subjects.map((s) => s.term?.label || s.authority?.authorizedName),
  ]
    .filter(Boolean)
    .join(' \n ')
    .slice(0, 200000);
}

/**
 * Rebuilds and saves the search text of a description, without changing its last-modified time.
 *
 * @param {string} recordId Identifier of the description.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
export async function refreshSearchText(recordId, transaction) {
  const record = await models.ArchivalRecord.findByPk(recordId, { transaction });
  if (!record) return;
  const searchText = await buildSearchText(record, transaction);
  await models.ArchivalRecord.update({ searchText }, { where: { id: recordId }, transaction, silent: true });
}

/**
 * Saves the current values of all versioned fields as the next version of a description, with secrets removed.
 *
 * @param {object} record The description.
 * @param {{ changedById: string, changeSummary: string, changedFields?: string[] }} change Who changed it and what
 *   changed.
 * @param {import('sequelize').Transaction} transaction
 * @returns {Promise<object>} The new version.
 */
async function snapshot(record, { changedById, changeSummary, changedFields = [] }, transaction) {
  const last = await models.ArchivalRecordVersion.max('versionNumber', { where: { recordId: record.id }, transaction });
  const data = {};
  for (const f of VERSIONED_FIELDS) data[f] = record.get(f);
  return models.ArchivalRecordVersion.create(
    {
      recordId: record.id,
      versionNumber: (last || 0) + 1,
      status: record.status,
      snapshot: scrub(data),
      changeSummary,
      changedFields,
      changedById,
    },
    { transaction },
  );
}

/**
 * Queues a description for re-indexing once the transaction commits.
 *
 * @param {string} recordId Identifier of the description.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
async function enqueueIndex(recordId, transaction) {
  await enqueue(
    'indexing',
    'search.index_record',
    { recordId },
    { entityType: 'ArchivalRecord', entityId: recordId, transaction },
  );
}

/**
 * Lists the ancestors of a description from the top down, for breadcrumb navigation.
 *
 * @param {{ id: string, path: string }} record The description.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object[]>}
 */
export async function breadcrumbs(record, transaction) {
  const ids = pathIds(record.path).filter((id) => id !== record.id);
  if (!ids.length) return [];
  const rows = await models.ArchivalRecord.findAll({
    where: { id: ids },
    attributes: ['id', 'title', 'referenceCode', 'level', 'publicVisibility', 'status'],
    transaction,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => r.get({ plain: true }));
}

/**
 * Creates a draft description.
 *
 * The parent must exist and must not be withdrawn or superseded, and the level must fit under it. The repository is
 * inherited from the parent or defaults to the first active repository. Without an explicit reference code, one is
 * built from the parent's code (or the repository code) and the local identifier, and it must be unique. A new
 * description is no more open than its parent, or staff-only at top level, unless a level is given. The path, root,
 * effective access, search text and first version are recorded, and the description is queued for indexing.
 *
 * @param {object} data Validated description fields.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The new description.
 * @throws {AppError} When the parent, level, repository or reference code is invalid.
 */
export async function createRecord(data, user) {
  return sequelize.transaction(async (t) => {
    const parent = data.parentId ? await models.ArchivalRecord.findByPk(data.parentId, { transaction: t }) : null;
    if (data.parentId && !parent) throw notFound('Parent description');
    if (parent && ['withdrawn', 'superseded'].includes(parent.status))
      throw badRequest('Cannot add children to a withdrawn or superseded description');
    validateLevel(data.level, parent);
    const repositoryId =
      parent?.repositoryId ??
      data.repositoryId ??
      (await models.Repository.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']], transaction: t }))
        ?.id;
    if (!repositoryId) throw badRequest('No repository configured');
    const repo = await models.Repository.findByPk(repositoryId, { transaction: t });
    let { referenceCode } = data;
    if (!referenceCode) {
      if (!data.localIdentifier)
        throw validationError([{ path: 'localIdentifier', message: 'Provide a reference code or a local identifier' }]);
      referenceCode = `${parent ? parent.referenceCode : repo.code}/${data.localIdentifier}`;
    }
    if (await models.ArchivalRecord.findOne({ where: { referenceCode }, transaction: t, attributes: ['id'] }))
      throw conflict(`Reference code ${referenceCode} is already in use`);

    const record = await models.ArchivalRecord.create(
      {
        ...data,
        referenceCode,
        repositoryId,
        parentId: parent?.id ?? null,
        // Children start no more open than their parent; the effective level is still computed from the whole path.
        accessLevel: data.accessLevel ?? (parent ? parent.accessLevel : 'staff_only'),
        status: 'draft',
        createdById: user.id,
        updatedById: user.id,
        depth: parent ? parent.depth + 1 : 0,
      },
      { transaction: t },
    );
    record.path = `${parent ? parent.path : '/'}${record.id}/`;
    record.rootId = parent ? parent.rootId : record.id;
    await record.save({ transaction: t, silent: true });
    await refreshEffectiveAccess(record.id, t);
    await refreshSearchText(record.id, t);
    await snapshot(record, { changedById: user.id, changeSummary: 'Created' }, t);
    await audit(
      {
        action: 'record.create',
        resourceType: 'ArchivalRecord',
        resourceId: record.id,
        after: { referenceCode, title: record.title, level: record.level, parentId: record.parentId },
      },
      { transaction: t },
    );
    await enqueueIndex(record.id, t);
    return record;
  });
}

/**
 * Loads a description with its repository, originating unit, responsible archivist, creators, subjects, identifiers
 * and related descriptions.
 *
 * @param {string} id Identifier of the description.
 * @returns {Promise<object>}
 * @throws {AppError} 404 when it does not exist.
 */
export async function getRecordDetail(id) {
  const record = await models.ArchivalRecord.findByPk(id, {
    include: [
      { model: models.Repository, as: 'repository', attributes: ['id', 'code', 'name'] },
      { model: models.OrganisationUnit, as: 'originatingUnit', attributes: ['id', 'code', 'name'] },
      { model: models.User, as: 'responsibleArchivist', attributes: ['id', 'fullName'] },
      {
        model: models.RecordCreator,
        as: 'creators',
        include: [
          {
            model: models.AuthorityRecord,
            as: 'authority',
            attributes: ['id', 'authorizedName', 'entityType', 'datesOfExistence'],
          },
        ],
      },
      {
        model: models.RecordSubject,
        as: 'subjects',
        include: [
          { model: models.VocabularyTerm, as: 'term', attributes: ['id', 'label', 'vocabularyId'] },
          { model: models.AuthorityRecord, as: 'authority', attributes: ['id', 'authorizedName', 'entityType'] },
        ],
      },
      { model: models.RecordIdentifier, as: 'identifiers' },
      {
        model: models.RecordRelationship,
        as: 'relationships',
        include: [
          { model: models.ArchivalRecord, as: 'target', attributes: ['id', 'title', 'referenceCode', 'level'] },
        ],
      },
    ],
  });
  if (!record) throw notFound('Archival description');
  return record;
}

/**
 * Checks that a user may edit a description: withdrawn and superseded descriptions cannot be edited, and approved
 * or published ones only by reviewers holding "records.approve".
 *
 * @param {object} record The description.
 * @param {object} user Authenticated principal.
 * @throws {AppError} 403 when editing is not allowed.
 */
function assertEditable(record, user) {
  if (['withdrawn', 'superseded'].includes(record.status))
    throw forbidden('Withdrawn or superseded descriptions cannot be edited. Reinstate it first.');
  if (['approved', 'published'].includes(record.status) && !hasPerm(user, 'records.approve')) {
    throw forbidden('Approved or published descriptions can only be edited by a reviewer');
  }
}

/**
 * Updates a description.
 *
 * The client must send the version it loaded. If someone else has saved the description since, the update is
 * refused so neither person's changes are lost. The reference code of a published description cannot change, and
 * must stay unique otherwise. The end date must not be before the start date. If nothing actually changed, nothing
 * is saved. Otherwise a version, an audit record and a re-index are created.
 *
 * @param {string} id Identifier of the description.
 * @param {object} data Fields to change, with `version` and an optional `changeSummary`.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated description.
 * @throws {AppError} When the version is out of date, editing is not allowed or a value is invalid.
 */
export async function updateRecord(id, data, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!record) throw notFound('Archival description');
    if (record.version !== data.version)
      throw conflict('This description was changed by someone else. Reload to see the latest version.', {
        currentVersion: record.version,
      });
    assertEditable(record, user);
    const { version, changeSummary, ...changes } = data;
    if (changes.referenceCode && changes.referenceCode !== record.referenceCode) {
      if (record.status === 'published') throw forbidden('Reference codes of published descriptions cannot be changed');
      if (
        await models.ArchivalRecord.findOne({
          where: { referenceCode: changes.referenceCode, id: { [Op.ne]: id } },
          transaction: t,
        })
      )
        throw conflict('Reference code already in use');
    }
    if (changes.dateStart !== undefined || changes.dateEnd !== undefined) {
      const s = changes.dateStart !== undefined ? changes.dateStart : record.dateStart;
      const e = changes.dateEnd !== undefined ? changes.dateEnd : record.dateEnd;
      if (s && e && s > e)
        throw validationError([{ path: 'dateEnd', message: 'End date must be on or after start date' }]);
    }
    const before = record.get({ plain: true });
    record.set({ ...changes, updatedById: user.id });
    const d = diff(before, record.get({ plain: true }));
    if (!d.fields.filter((f) => f !== 'updatedById').length) return record;
    await record.save({ transaction: t });
    await refreshSearchText(record.id, t);
    await snapshot(
      record,
      {
        changedById: user.id,
        changeSummary: changeSummary || `Updated ${d.fields.filter((f) => f !== 'updatedById').join(', ')}`,
        changedFields: d.fields,
      },
      t,
    );
    await audit(
      {
        action: 'record.update',
        resourceType: 'ArchivalRecord',
        resourceId: record.id,
        before: d.before,
        after: d.after,
        reason: changeSummary,
      },
      { transaction: t },
    );
    await enqueueIndex(record.id, t);
    return record;
  });
}

/**
 * Moves a description, with its whole subtree, under a new parent (or to the top level).
 *
 * A description cannot be moved under itself or its descendants, or to another repository, and its level must fit
 * under the new parent. The paths, depths and root of the subtree are updated in one statement, effective access is
 * recalculated, and the move is versioned and audited.
 *
 * @param {string} id Identifier of the description.
 * @param {{ parentId: string|null, sortOrder?: number, reason?: string }} input New parent, position and reason.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The moved description.
 * @throws {AppError} When the move is not allowed.
 */
export async function moveRecord(id, { parentId, sortOrder, reason }, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!record) throw notFound('Archival description');
    assertEditable(record, user);
    const parent = parentId ? await models.ArchivalRecord.findByPk(parentId, { transaction: t }) : null;
    if (parentId && !parent) throw notFound('New parent');
    if (parent && (parent.id === record.id || pathIds(parent.path).includes(record.id)))
      throw badRequest('A description cannot be moved under itself or one of its descendants');
    if (parent && parent.repositoryId !== record.repositoryId)
      throw badRequest('Descriptions cannot be moved between repositories');
    validateLevel(record.level, parent);
    const oldPath = record.path;
    const oldParentId = record.parentId;
    const newPath = `${parent ? parent.path : '/'}${record.id}/`;
    const depthDelta = (parent ? parent.depth + 1 : 0) - record.depth;
    const newRoot = parent ? parent.rootId : record.id;
    await sequelize.query(
      `UPDATE ArchivalRecords SET path = :newPath + SUBSTRING(path, LEN(:oldPath) + 1, 4000), depth = depth + :depthDelta, rootId = :newRoot
       WHERE path LIKE :like`,
      { replacements: { newPath, oldPath, depthDelta, newRoot, like: `${oldPath}%` }, transaction: t },
    );
    await models.ArchivalRecord.update(
      { parentId: parent?.id ?? null, sortOrder: sortOrder ?? record.sortOrder, updatedById: user.id },
      { where: { id }, transaction: t },
    );
    await record.reload({ transaction: t });
    await refreshEffectiveAccess(record.id, t);
    await snapshot(
      record,
      { changedById: user.id, changeSummary: `Moved${reason ? `: ${reason}` : ''}`, changedFields: ['parentId'] },
      t,
    );
    await audit(
      {
        action: 'record.move',
        resourceType: 'ArchivalRecord',
        resourceId: id,
        before: { parentId: oldParentId, path: oldPath },
        after: { parentId: parent?.id ?? null, path: newPath },
        reason,
      },
      { transaction: t },
    );
    await enqueueIndex(record.id, t);
    return record;
  });
}

/**
 * Performs a workflow action on a description: draft, in review, approved, published and withdrawn.
 *
 * - Submitting for review requires the fields for the level.
 * - Approval must be done by someone other than the submitter.
 * - Publication requires the fields for the level plus access and reproduction conditions, and is refused for
 *   confidential or closed descriptions.
 * - Returning to draft and withdrawing require a reason.
 *
 * Decisions are stored as approvals. Effective access is recalculated, a version is saved, and publication or
 * withdrawal re-indexes the whole subtree, because discoverability of descendants depends on it. Reviewers are
 * notified of submissions and submitters of decisions.
 *
 * @param {string} id Identifier of the description.
 * @param {{ action: string, reason?: string }} input The action and an explanation.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated description.
 * @throws {AppError} When the action is not permitted or allowed, or required information is missing.
 */
export async function transitionRecord(id, { action, reason }, user) {
  if (action === 'supersede' || !hasPerm(user, ACTION_PERMISSION[action])) throw forbidden();
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: models.RecordCreator, as: 'creators' }],
    });
    if (!record) throw notFound('Archival description');
    assertTransition('description', record.status, action);

    if (action === 'submit_for_review') {
      const missing = missingFields(record, REQUIRED_FOR_REVIEW[record.level]);
      if (missing.length)
        throw validationError(
          missing.map((f) => ({ path: f, message: 'Required before review' })),
          'Complete the required fields before submitting for review',
        );
    }
    if (action === 'approve') {
      await assertSeparationOfDuties(
        user.id,
        [record.submittedForReviewById],
        'You cannot approve a description you submitted for review',
      );
    }
    if (action === 'publish') {
      const missing = missingFields(record, [...REQUIRED_FOR_REVIEW[record.level], ...REQUIRED_FOR_PUBLICATION]);
      if (missing.length)
        throw validationError(
          missing.map((f) => ({ path: f, message: 'Required before publication' })),
          'Complete the required fields before publishing',
        );
      if (['confidential', 'closed'].includes(record.effectiveAccessLevel))
        throw badRequest(
          'Confidential or closed descriptions cannot be published. Change the access level through an approved access change first.',
        );
    }
    if ((action === 'return_to_draft' || action === 'withdraw') && !reason)
      throw validationError([{ path: 'reason', message: 'A reason is required' }]);

    const now = new Date();
    await transition('description', record, action, {
      actor: user,
      reason,
      transaction: t,
      apply: (r) => {
        r.updatedById = user.id;
        if (action === 'submit_for_review')
          Object.assign(r, { submittedForReviewAt: now, submittedForReviewById: user.id });
        if (action === 'approve') Object.assign(r, { approvedAt: now, approvedById: user.id });
        if (action === 'publish')
          Object.assign(r, { publishedAt: now, publishedById: user.id, withdrawnAt: null, withdrawalReason: null });
        if (action === 'withdraw') Object.assign(r, { withdrawnAt: now, withdrawalReason: reason });
      },
    });
    if (['approve', 'publish', 'return_to_draft'].includes(action)) {
      await models.Approval.create(
        {
          entityType: 'ArchivalRecord',
          entityId: record.id,
          stage: action,
          approverId: user.id,
          decision: action === 'return_to_draft' ? 'returned' : 'approved',
          reason,
        },
        { transaction: t },
      );
    }
    await refreshEffectiveAccess(record.id, t);
    await snapshot(
      record,
      {
        changedById: user.id,
        changeSummary: `Workflow: ${action}${reason ? ` — ${reason}` : ''}`,
        changedFields: ['status'],
      },
      t,
    );
    await enqueueIndex(record.id, t);
    if (action === 'publish' || action === 'withdraw') {
      // Re-index the subtree: publication/withdrawal changes discoverability of every descendant.
      await enqueue(
        'indexing',
        'search.reindex_subtree',
        { recordId: record.id },
        { entityType: 'ArchivalRecord', entityId: record.id, transaction: t },
      );
    }
    if (action === 'submit_for_review') {
      await notifyPermissionHolders(
        ['records.approve'],
        {
          eventType: 'record.review_requested',
          title: `Description awaiting review: ${record.referenceCode}`,
          body: `${user.fullName} submitted "${record.title}" for review.`,
          link: `/admin/records/${record.id}`,
          entityType: 'ArchivalRecord',
          entityId: record.id,
        },
        { transaction: t },
      );
    }
    if (['approve', 'return_to_draft'].includes(action) && record.submittedForReviewById) {
      await notifyUsers(
        [record.submittedForReviewById],
        {
          eventType: 'record.review_decision',
          title: `Description ${action === 'approve' ? 'approved' : 'returned'}: ${record.referenceCode}`,
          body: reason || '',
          link: `/admin/records/${record.id}`,
          entityType: 'ArchivalRecord',
          entityId: record.id,
        },
        { transaction: t },
      );
    }
    return record;
  });
}

/**
 * Restores the descriptive content of an earlier version. The hierarchy, level, reference code, status and access
 * settings are not restored. An approved or published description returns to draft, so the restored content is
 * reviewed again. The restoration is versioned and audited.
 *
 * @param {string} id Identifier of the description.
 * @param {number} versionNumber Version to restore.
 * @param {object} user Authenticated principal.
 * @param {string} [reason] Explanation.
 * @returns {Promise<object>} The updated description.
 * @throws {AppError} When the description or version does not exist, or editing is not allowed.
 */
export async function restoreVersion(id, versionNumber, user, reason) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!record) throw notFound('Archival description');
    assertEditable(record, user);
    const v = await models.ArchivalRecordVersion.findOne({ where: { recordId: id, versionNumber }, transaction: t });
    if (!v) throw notFound('Version');
    const before = record.get({ plain: true });
    const patch = {};
    for (const f of RESTORABLE_FIELDS) if (f in v.snapshot) patch[f] = v.snapshot[f];
    record.set({ ...patch, updatedById: user.id });
    // Restoring content always sends a published/approved description back through review.
    if (['approved', 'published'].includes(record.status)) {
      await transition('description', record, 'return_to_draft', {
        actor: user,
        reason: `Restored version ${versionNumber}`,
        transaction: t,
      });
    } else {
      await record.save({ transaction: t });
    }
    await refreshEffectiveAccess(record.id, t);
    await refreshSearchText(record.id, t);
    const d = diff(before, record.get({ plain: true }));
    await snapshot(
      record,
      {
        changedById: user.id,
        changeSummary: `Restored from version ${versionNumber}${reason ? ` — ${reason}` : ''}`,
        changedFields: d.fields,
      },
      t,
    );
    await audit(
      {
        action: 'record.restore_version',
        resourceType: 'ArchivalRecord',
        resourceId: id,
        before: d.before,
        after: d.after,
        reason,
        metadata: { versionNumber },
      },
      { transaction: t },
    );
    await enqueueIndex(record.id, t);
    return record;
  });
}

/**
 * Compares two version snapshots field by field.
 *
 * @param {object} a Earlier snapshot.
 * @param {object} b Later snapshot.
 * @returns {Array<{ field: string, from: *, to: * }>} The fields whose values differ.
 */
export function compareSnapshots(a, b) {
  const fields = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const changes = [];
  for (const f of fields) {
    if (JSON.stringify(a?.[f] ?? null) !== JSON.stringify(b?.[f] ?? null))
      changes.push({ field: f, from: a?.[f] ?? null, to: b?.[f] ?? null });
  }
  return changes;
}

/**
 * Replaces all links of one kind (creators, subjects or identifiers) of a description, then refreshes its search
 * text, audits the before and after lists, and queues it for re-indexing.
 *
 * @param {import('sequelize').ModelStatic} Model Link model, for example RecordCreator.
 * @param {string} recordId Identifier of the description.
 * @param {object[]} rows The new links.
 * @param {object} user Authenticated principal.
 * @param {string} label Name used in the audit action, for example "creators".
 * @param {import('sequelize').Transaction} transaction
 * @returns {Promise<void>}
 */
async function replaceLinks(Model, recordId, rows, user, label, transaction) {
  const before = (await Model.findAll({ where: { recordId }, transaction })).map((r) => r.get({ plain: true }));
  await Model.destroy({ where: { recordId }, transaction });
  for (const row of rows) await Model.create({ ...row, recordId }, { transaction });
  await models.ArchivalRecord.update({ updatedById: user.id }, { where: { id: recordId }, transaction });
  await refreshSearchText(recordId, transaction);
  await audit(
    {
      action: `record.${label}_updated`,
      resourceType: 'ArchivalRecord',
      resourceId: recordId,
      before: { [label]: before.map(({ id, recordId: _r, createdAt, updatedAt, ...x }) => x) },
      after: { [label]: rows },
    },
    { transaction },
  );
  await enqueueIndex(recordId, transaction);
}

/**
 * Replaces the creators of a description; every authority record must exist.
 *
 * @param {string} id Identifier of the description.
 * @param {Array<{ authorityId: string, role?: string }>} creators The creators.
 * @param {object} user Authenticated principal.
 * @returns {Promise<void>}
 */
export async function setCreators(id, creators, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, { transaction: t });
    if (!record) throw notFound('Archival description');
    assertEditable(record, user);
    const ids = [...new Set(creators.map((c) => c.authorityId))];
    if ((await models.AuthorityRecord.count({ where: { id: ids }, transaction: t })) !== ids.length)
      throw badRequest('One or more authority records do not exist');
    await replaceLinks(models.RecordCreator, id, creators, user, 'creators', t);
  });
}

/**
 * Replaces the subjects of a description; vocabulary terms must exist and be active.
 *
 * @param {string} id Identifier of the description.
 * @param {Array<{ termId?: string, authorityId?: string, subjectType: string }>} subjects The subjects.
 * @param {object} user Authenticated principal.
 * @returns {Promise<void>}
 */
export async function setSubjects(id, subjects, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, { transaction: t });
    if (!record) throw notFound('Archival description');
    assertEditable(record, user);
    const termIds = subjects.map((s) => s.termId).filter(Boolean);
    if (
      termIds.length &&
      (await models.VocabularyTerm.count({ where: { id: termIds, isActive: true }, transaction: t })) !==
        new Set(termIds).size
    )
      throw badRequest('One or more vocabulary terms are invalid or inactive');
    await replaceLinks(models.RecordSubject, id, subjects, user, 'subjects', t);
  });
}

/**
 * Replaces the alternative identifiers of a description, such as legacy register numbers. An identifier may not
 * belong to another description.
 *
 * @param {string} id Identifier of the description.
 * @param {Array<{ scheme: string, value: string }>} identifiers The identifiers.
 * @param {object} user Authenticated principal.
 * @returns {Promise<void>}
 * @throws {AppError} 409 when an identifier is already in use.
 */
export async function setIdentifiers(id, identifiers, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(id, { transaction: t });
    if (!record) throw notFound('Archival description');
    assertEditable(record, user);
    for (const i of identifiers) {
      const clash = await models.RecordIdentifier.findOne({
        where: { scheme: i.scheme, value: i.value, recordId: { [Op.ne]: id } },
        transaction: t,
      });
      if (clash) throw conflict(`Identifier ${i.scheme}:${i.value} is already used by another description`);
    }
    await replaceLinks(models.RecordIdentifier, id, identifiers, user, 'identifiers', t);
  });
}

/**
 * Lists the workflow actions this user may take on a description now. "Supersede" is never offered directly.
 *
 * @param {object} record The description.
 * @param {object} user Authenticated principal.
 * @returns {string[]} The available action names.
 */
export function actionsFor(record, user) {
  return availableActions('description', record.status).filter(
    (a) => a !== 'supersede' && hasPerm(user, ACTION_PERMISSION[a]),
  );
}

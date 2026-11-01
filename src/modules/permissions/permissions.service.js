/**
 * Changes to access: access levels, restrictions, inheritance exceptions and individual grants.
 *
 * The two-person rule applies to anything that makes material more accessible. Loosening an access level, lifting a
 * restriction and granting an exception become requests that a different person with "permissions.approve" must
 * approve. Making access stricter takes effect immediately. After every change the effective access of the
 * description and its descendants is recalculated and they are queued for re-indexing, so search results reflect
 * the change. All changes are audited as sensitive.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, conflict } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { refreshEffectiveAccess, stricter, hasPerm, accessRank } from '../../services/accessPolicy.service.js';
import { getSetting } from '../../services/settings.service.js';
import { notifyPermissionHolders, notifyUsers } from '../../services/notification.service.js';
import { enqueue } from '../../services/queue.service.js';

/**
 * Recalculates the effective access of a description and its descendants and queues them for re-indexing.
 *
 * @param {string} recordId Identifier of the description.
 * @param {import('sequelize').Transaction} t Transaction of the change.
 * @returns {Promise<void>}
 */
async function afterAccessChange(recordId, t) {
  await refreshEffectiveAccess(recordId, t);
  await enqueue(
    'indexing',
    'search.reindex_subtree',
    { recordId },
    { entityType: 'ArchivalRecord', entityId: recordId, transaction: t },
  );
}

/**
 * Summarises the access situation of a description: its own and effective level, flags, public visibility and
 * embargo, the level inherited from its parent, and its restrictions, exceptions, active grants and recent change
 * requests.
 *
 * @param {string} recordId Identifier of the description.
 * @returns {Promise<object>}
 * @throws {AppError} 404 when the description does not exist.
 */
export async function accessSummary(recordId) {
  const record = await models.ArchivalRecord.findByPk(recordId, {
    attributes: [
      'id',
      'accessLevel',
      'effectiveAccessLevel',
      'effectiveFlags',
      'publicVisibility',
      'embargoUntil',
      'parentId',
      'path',
      'status',
    ],
  });
  if (!record) throw notFound('Archival description');
  const parent = record.parentId
    ? await models.ArchivalRecord.findByPk(record.parentId, {
        attributes: ['id', 'referenceCode', 'effectiveAccessLevel'],
      })
    : null;
  const [restrictions, exceptions, requests, grants] = await Promise.all([
    models.AccessRestriction.findAll({
      where: { targetType: 'record', targetId: recordId },
      order: [['createdAt', 'DESC']],
      include: [{ model: models.User, as: 'authorisedBy', attributes: ['id', 'fullName'] }],
    }),
    models.AccessException.findAll({ where: { recordId }, order: [['createdAt', 'DESC']] }),
    models.AccessChangeRequest.findAll({
      where: { targetType: 'record', targetId: recordId },
      order: [['createdAt', 'DESC']],
      limit: 20,
      include: [
        { model: models.User, as: 'requestedBy', attributes: ['id', 'fullName'] },
        { model: models.User, as: 'decidedBy', attributes: ['id', 'fullName'] },
      ],
    }),
    models.AccessGrant.findAll({
      where: { targetType: 'record', targetId: recordId, revokedAt: null },
      include: [{ model: models.User, as: 'user', attributes: ['id', 'fullName', 'email'] }],
    }),
  ]);
  return { record, inheritedFrom: parent, restrictions, exceptions, requests, grants };
}

/**
 * Changes the access level of a description.
 *
 * Making access stricter applies immediately. Making it looser, when the two-person rule is on, creates a request
 * that a different person must approve, and approvers are notified. Only one request per description can be
 * pending. An embargo needs an end date.
 *
 * @param {string} recordId Identifier of the description.
 * @param {{ accessLevel: string, embargoUntil?: string, reason: string }} input New level, embargo end date and
 *   reason.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ pendingApproval: boolean, request?: object, record?: object }>}
 * @throws {AppError} When the description does not exist, the embargo date is missing, or a request is already
 *   pending.
 */
export async function changeAccessLevel(recordId, { accessLevel, embargoUntil, reason }, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(recordId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!record) throw notFound('Archival description');
    if (accessLevel === 'embargoed' && !embargoUntil) throw badRequest('An embargo requires an end date');
    const loosening = accessRank(accessLevel) < accessRank(record.accessLevel);
    if (loosening && (await getSetting('workflow.twoPersonAccessChanges'))) {
      const pending = await models.AccessChangeRequest.findOne({
        where: { targetType: 'record', targetId: recordId, status: 'pending' },
        transaction: t,
      });
      if (pending) throw conflict('An access change for this description is already awaiting approval');
      const req = await models.AccessChangeRequest.create(
        {
          targetType: 'record',
          targetId: recordId,
          changeType: 'set_level',
          fromLevel: record.accessLevel,
          toLevel: accessLevel,
          payload: { embargoUntil: embargoUntil ?? null },
          reason,
          requestedById: user.id,
        },
        { transaction: t },
      );
      await audit(
        {
          action: 'access.change_requested',
          resourceType: 'ArchivalRecord',
          resourceId: recordId,
          before: { accessLevel: record.accessLevel },
          after: { accessLevel },
          reason,
          sensitive: true,
        },
        { transaction: t },
      );
      await notifyPermissionHolders(
        ['permissions.approve'],
        {
          eventType: 'record.review_requested',
          title: `Access change awaiting approval: ${record.referenceCode}`,
          body: `${user.fullName} requested ${record.accessLevel} → ${accessLevel}.`,
          link: `/admin/access-requests`,
          entityType: 'AccessChangeRequest',
          entityId: req.id,
        },
        { transaction: t },
      );
      return { pendingApproval: true, request: req };
    }
    const before = { accessLevel: record.accessLevel, embargoUntil: record.embargoUntil };
    await record.update(
      { accessLevel, embargoUntil: accessLevel === 'embargoed' ? embargoUntil : null, updatedById: user.id },
      { transaction: t },
    );
    await afterAccessChange(recordId, t);
    await audit(
      {
        action: 'access.level_changed',
        resourceType: 'ArchivalRecord',
        resourceId: recordId,
        before,
        after: { accessLevel, embargoUntil },
        reason,
        sensitive: true,
      },
      { transaction: t },
    );
    return { pendingApproval: false, record };
  });
}

/**
 * Adds a restriction, such as personal data, an embargo or a no-download rule, to a description or file.
 * Restrictions only ever make access stricter, so they apply immediately. An embargo needs an expiry date.
 *
 * @param {'record'|'asset'} targetType What is restricted.
 * @param {string} targetId Identifier of the description or file.
 * @param {object} data Restriction details: type, legal basis, expiry and notes.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The restriction.
 * @throws {AppError} When the target does not exist or the embargo date is missing.
 */
export async function addRestriction(targetType, targetId, data, user) {
  return sequelize.transaction(async (t) => {
    const Model = targetType === 'record' ? models.ArchivalRecord : models.DigitalAsset;
    if (!(await Model.findByPk(targetId, { transaction: t, attributes: ['id'] })))
      throw notFound(targetType === 'record' ? 'Archival description' : 'Digital asset');
    if (data.restrictionType === 'embargoed' && !data.expiresAt) throw badRequest('An embargo requires an expiry date');
    const r = await models.AccessRestriction.create(
      {
        ...data,
        targetType,
        targetId,
        status: 'active',
        requestedById: user.id,
        authorisedById: user.id,
        authorisedAt: new Date(),
      },
      { transaction: t },
    );
    if (targetType === 'record') await afterAccessChange(targetId, t);
    await audit(
      {
        action: 'access.restriction_added',
        resourceType: targetType === 'record' ? 'ArchivalRecord' : 'DigitalAsset',
        resourceId: targetId,
        after: { restrictionType: data.restrictionType, legalBasis: data.legalBasis, expiresAt: data.expiresAt },
        reason: data.internalNotes,
        sensitive: true,
      },
      { transaction: t },
    );
    return r;
  });
}

/**
 * Requests that a restriction be lifted. With the two-person rule on, this creates a request for another person to
 * approve; otherwise the restriction is lifted at once.
 *
 * @param {string} restrictionId Identifier of the restriction.
 * @param {string} reason Why it should be lifted.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ pendingApproval: boolean, request?: object }>}
 * @throws {AppError} 404 when the restriction is not active.
 */
export async function requestLiftRestriction(restrictionId, reason, user) {
  return sequelize.transaction(async (t) => {
    const r = await models.AccessRestriction.findByPk(restrictionId, { transaction: t });
    if (!r || !['active', 'expired_pending_review'].includes(r.status)) throw notFound('Active restriction');
    if (!(await getSetting('workflow.twoPersonAccessChanges'))) {
      await liftRestriction(r, user, reason, t);
      return { pendingApproval: false };
    }
    const req = await models.AccessChangeRequest.create(
      {
        targetType: r.targetType,
        targetId: r.targetId,
        changeType: 'lift_restriction',
        fromLevel: r.restrictionType,
        payload: { restrictionId: r.id },
        reason,
        requestedById: user.id,
      },
      { transaction: t },
    );
    await audit(
      { action: 'access.lift_requested', resourceType: 'AccessRestriction', resourceId: r.id, reason, sensitive: true },
      { transaction: t },
    );
    await notifyPermissionHolders(
      ['permissions.approve'],
      {
        eventType: 'record.review_requested',
        title: 'Restriction lift awaiting approval',
        body: `${user.fullName} requested lifting a ${r.restrictionType} restriction.`,
        link: '/admin/access-requests',
        entityType: 'AccessChangeRequest',
        entityId: req.id,
      },
      { transaction: t },
    );
    return { pendingApproval: true, request: req };
  });
}

/**
 * Lifts a restriction, recalculates access for its description and audits the change.
 *
 * @param {object} r The restriction.
 * @param {object} user Person lifting it.
 * @param {string} [reason] Explanation.
 * @param {import('sequelize').Transaction} t Current transaction.
 * @returns {Promise<void>}
 */
async function liftRestriction(r, user, reason, t) {
  await r.update({ status: 'lifted', liftedById: user.id, liftedAt: new Date() }, { transaction: t });
  if (r.targetType === 'record') await afterAccessChange(r.targetId, t);
  await audit(
    {
      action: 'access.restriction_lifted',
      resourceType: 'AccessRestriction',
      resourceId: r.id,
      before: { status: 'active' },
      after: { status: 'lifted' },
      reason,
      sensitive: true,
    },
    { transaction: t },
  );
}

/**
 * Requests an inheritance exception for a description, so that it can be more open than its parent. The granted
 * level is never looser than the description's own level, and the request must be approved by another person.
 *
 * @param {string} recordId Identifier of the description; it must have a parent.
 * @param {{ grantedAccessLevel: string, reason: string }} input Requested level and justification.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ exception: object, request: object }>}
 * @throws {AppError} When the description does not exist or has no parent.
 */
export async function requestException(recordId, { grantedAccessLevel, reason }, user) {
  return sequelize.transaction(async (t) => {
    const record = await models.ArchivalRecord.findByPk(recordId, { transaction: t });
    if (!record) throw notFound('Archival description');
    if (!record.parentId) throw badRequest('Exceptions apply only to descriptions with a parent');
    const exc = await models.AccessException.create(
      {
        recordId,
        grantedAccessLevel: stricter(grantedAccessLevel, record.accessLevel),
        reason,
        status: 'pending_approval',
        requestedById: user.id,
      },
      { transaction: t },
    );
    const req = await models.AccessChangeRequest.create(
      {
        targetType: 'record',
        targetId: recordId,
        changeType: 'grant_exception',
        toLevel: exc.grantedAccessLevel,
        payload: { exceptionId: exc.id },
        reason,
        requestedById: user.id,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'access.exception_requested',
        resourceType: 'ArchivalRecord',
        resourceId: recordId,
        after: { grantedAccessLevel: exc.grantedAccessLevel },
        reason,
        sensitive: true,
      },
      { transaction: t },
    );
    await notifyPermissionHolders(
      ['permissions.approve'],
      {
        eventType: 'record.review_requested',
        title: `Access exception awaiting approval: ${record.referenceCode}`,
        body: `${user.fullName} requested an inheritance exception.`,
        link: '/admin/access-requests',
        entityType: 'AccessChangeRequest',
        entityId: req.id,
      },
      { transaction: t },
    );
    return { exception: exc, request: req };
  });
}

/**
 * Approves or rejects a pending access change. The approver must hold "permissions.approve" and must not be the
 * person who made the request.
 *
 * On approval the change is applied: a new access level, a lifted restriction or an activated exception, followed
 * by recalculation of effective access. A rejected exception is marked rejected. The decision is stored as a second
 * approval and the requester is notified.
 *
 * @param {string} requestId Identifier of the request.
 * @param {{ decision: 'approve'|'reject', reason?: string }} input The decision and its reason.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The decided request.
 * @throws {AppError} 403 when the user may not decide, 404 when the request is not pending.
 */
export async function decideRequest(requestId, { decision, reason }, user) {
  if (!hasPerm(user, 'permissions.approve')) throw forbidden();
  return sequelize.transaction(async (t) => {
    const req = await models.AccessChangeRequest.findByPk(requestId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!req || req.status !== 'pending') throw notFound('Pending access request');
    if (req.requestedById === user.id) throw forbidden('A second person must approve access changes you requested');
    await req.update(
      {
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedById: user.id,
        decidedAt: new Date(),
        decisionReason: reason,
      },
      { transaction: t },
    );
    await models.Approval.create(
      {
        entityType: 'AccessChangeRequest',
        entityId: req.id,
        stage: 'second_approval',
        approverId: user.id,
        decision: decision === 'approve' ? 'approved' : 'rejected',
        reason,
      },
      { transaction: t },
    );
    if (decision === 'approve') {
      if (req.changeType === 'set_level') {
        const record = await models.ArchivalRecord.findByPk(req.targetId, { transaction: t, lock: t.LOCK.UPDATE });
        await record.update(
          { accessLevel: req.toLevel, embargoUntil: req.toLevel === 'embargoed' ? req.payload.embargoUntil : null },
          { transaction: t },
        );
        await afterAccessChange(record.id, t);
      } else if (req.changeType === 'lift_restriction') {
        const r = await models.AccessRestriction.findByPk(req.payload.restrictionId, { transaction: t });
        if (r && ['active', 'expired_pending_review'].includes(r.status)) await liftRestriction(r, user, reason, t);
      } else if (req.changeType === 'grant_exception') {
        await models.AccessException.update(
          { status: 'active', approvedById: user.id, approvedAt: new Date() },
          { where: { id: req.payload.exceptionId }, transaction: t },
        );
        await afterAccessChange(req.targetId, t);
      }
    } else if (req.changeType === 'grant_exception') {
      await models.AccessException.update(
        { status: 'rejected' },
        { where: { id: req.payload.exceptionId }, transaction: t },
      );
    }
    await audit(
      {
        action: `access.request_${decision === 'approve' ? 'approved' : 'rejected'}`,
        resourceType: 'AccessChangeRequest',
        resourceId: req.id,
        after: { changeType: req.changeType, fromLevel: req.fromLevel, toLevel: req.toLevel },
        reason,
        sensitive: true,
      },
      { transaction: t },
    );
    await notifyUsers(
      [req.requestedById],
      {
        eventType: 'record.review_decision',
        title: `Access change ${decision === 'approve' ? 'approved' : 'rejected'}`,
        body: reason || '',
        link: req.targetType === 'record' ? `/admin/records/${req.targetId}` : '/admin/access-requests',
      },
      { transaction: t },
    );
    return req;
  });
}

/**
 * Revokes an active inheritance exception, so the description inherits its parent's access again.
 *
 * @param {string} exceptionId Identifier of the exception.
 * @param {string} reason Why it is revoked.
 * @param {object} user Authenticated principal.
 * @returns {Promise<void>}
 * @throws {AppError} 404 when the exception is not active.
 */
export async function revokeException(exceptionId, reason, user) {
  return sequelize.transaction(async (t) => {
    const exc = await models.AccessException.findByPk(exceptionId, { transaction: t });
    if (!exc || exc.status !== 'active') throw notFound('Active exception');
    await exc.update({ status: 'revoked', revokedById: user.id, revokedAt: new Date() }, { transaction: t });
    await afterAccessChange(exc.recordId, t);
    await audit(
      {
        action: 'access.exception_revoked',
        resourceType: 'AccessException',
        resourceId: exc.id,
        reason,
        sensitive: true,
      },
      { transaction: t },
    );
  });
}

/**
 * Grants an individual user access to a description (and, by default, its descendants) or to a file, for example
 * after an approved research request.
 *
 * @param {{ userId: string, targetType: string, targetId: string, permissionLevel: string, expiresAt?: string,
 *   researchRequestId?: string, includeDescendants?: boolean }} grant The grant.
 * @param {object} user Person granting access.
 * @param {import('sequelize').Transaction} [transaction] Existing transaction, if any.
 * @returns {Promise<object>} The grant.
 */
export async function grantAccess(
  { userId, targetType, targetId, permissionLevel, expiresAt, researchRequestId, includeDescendants = true },
  user,
  transaction,
) {
  /**
   * Performs the grant inside the given transaction.
   *
   * @param {import('sequelize').Transaction} t Transaction to use.
   * @returns {Promise<object>}
   */
  const run = async (t) => {
    const g = await models.AccessGrant.create(
      {
        userId,
        targetType,
        targetId,
        permissionLevel,
        expiresAt,
        includeDescendants,
        grantedById: user.id,
        researchRequestId,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'access.grant_created',
        resourceType: 'AccessGrant',
        resourceId: g.id,
        after: { userId, targetType, targetId, permissionLevel, expiresAt },
        sensitive: true,
      },
      { transaction: t },
    );
    return g;
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/**
 * Revokes an individual access grant. The change takes effect on the user's next request, including links already
 * issued.
 *
 * @param {string} grantId Identifier of the grant.
 * @param {string} reason Why it is revoked.
 * @param {object} user Authenticated principal.
 * @returns {Promise<void>}
 * @throws {AppError} 404 when the grant is not active.
 */
export async function revokeGrant(grantId, reason, user) {
  const g = await models.AccessGrant.findByPk(grantId);
  if (!g || g.revokedAt) throw notFound('Active grant');
  await sequelize.transaction(async (t) => {
    await g.update({ revokedAt: new Date(), revokedById: user.id }, { transaction: t });
    await audit(
      { action: 'access.grant_revoked', resourceType: 'AccessGrant', resourceId: g.id, reason, sensitive: true },
      { transaction: t },
    );
  });
}

/**
 * Scheduled job: deals with restrictions and embargoes that have reached their end date.
 *
 * Unless the "embargo.autoLiftOnExpiry" setting is on, expired restrictions are only flagged for review and never
 * lifted automatically. Staff who manage restrictions are notified of restrictions and embargoed descriptions that
 * need review.
 *
 * @returns {Promise<{ expiredRestrictions: number, embargoedRecordsDue: number }>}
 */
export async function reviewExpiredRestrictions() {
  const today = new Date().toISOString().slice(0, 10);
  const autoLift = await getSetting('embargo.autoLiftOnExpiry');
  const expired = await models.AccessRestriction.findAll({
    where: { status: 'active', expiresAt: { [Op.lte]: today } },
  });
  const records = await models.ArchivalRecord.findAll({
    where: { accessLevel: 'embargoed', embargoUntil: { [Op.lte]: today } },
    attributes: ['id', 'referenceCode'],
  });
  for (const r of expired) {
    await sequelize.transaction(async (t) => {
      await r.update(
        { status: autoLift ? 'lifted' : 'expired_pending_review', liftedAt: autoLift ? new Date() : null },
        { transaction: t },
      );
      if (autoLift && r.targetType === 'record') await afterAccessChange(r.targetId, t);
      await audit(
        {
          action: autoLift ? 'access.restriction_auto_lifted' : 'access.restriction_expired',
          resourceType: 'AccessRestriction',
          resourceId: r.id,
          actorType: 'system',
        },
        { transaction: t },
      );
    });
  }
  if (expired.length || records.length) {
    await notifyPermissionHolders(['records.restrict'], {
      eventType: 'embargo.review',
      title: 'Embargoes due for review',
      body: `${expired.length} restriction(s) and ${records.length} embargoed description(s) have reached their review date.`,
      link: '/admin/access-requests?tab=review',
    });
  }
  return { expiredRestrictions: expired.length, embargoedRecordsDue: records.length };
}

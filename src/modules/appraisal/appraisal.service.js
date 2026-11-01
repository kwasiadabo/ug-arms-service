/**
 * Appraisal and disposal of records under retention schedules.
 *
 * Disposal is irreversible, so it is protected by several independent safeguards:
 * - Every item is checked for legal holds, permanent archival status, active research requests and current loans
 *   whenever a case moves on. An elapsed retention period is never enough on its own.
 * - The person who opened or recommended an appraisal cannot decide it.
 * - A disposal case lists exactly what would be affected in a dry run identified by a fingerprint. Approvals are
 *   bound to that fingerprint, so a changed list needs fresh approvals.
 * - The configured number of different approvers (two by default) is required, and the case author cannot approve.
 * - Execution requires typing the case number and re-checks eligibility first. Any change, such as a new legal
 *   hold, blocks the case and nothing is destroyed.
 * - Descriptions are kept and annotated, and a certificate with a SHA-256 of its content is stored as evidence.
 *   Stored files are removed only after that evidence has been committed.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, validationError, conflict } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import {
  transition,
  assertTransition,
  assertSeparationOfDuties,
  availableActions,
} from '../../services/workflow.service.js';
import { generateReference } from '../../services/referenceCode.service.js';
import { getSetting } from '../../services/settings.service.js';
import { notifyPermissionHolders } from '../../services/notification.service.js';
import { hasPerm } from '../../services/accessPolicy.service.js';
import { storage, buildKey } from '../../services/storage/index.js';
import { recordEvent } from '../../services/preservation.service.js';
import { holdsFor } from '../retention/holds.service.js';
import { BRAND, stampCrest } from '../../services/branding.js';

// Permission required for each appraisal workflow action.
const CASE_ACTION_PERMISSION = {
  start_review: 'appraisal.create',
  place_on_hold: 'appraisal.create',
  release_hold: 'appraisal.create',
  recommend: 'appraisal.create',
  request_approval: 'appraisal.create',
  approve: 'appraisal.approve',
  reject: 'appraisal.approve',
  mark_executed: 'disposal.execute',
  close: 'appraisal.approve',
};

/**
 * Decides whether one record, physical item or digital file may be disposed of.
 *
 * Checks, in order: an active legal hold on it or an ancestor; permanent archival holdings that have been
 * accessioned (and their preservation masters); records that are the subject of an active research request; and
 * physical items that are currently issued.
 *
 * @param {{ recordId?: string, physicalItemId?: string, assetId?: string }} target The thing to check.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<{ eligibility: 'eligible'|'blocked_legal_hold'|'blocked_permanent'|'blocked_active_request',
 *   blockReason: string|null }>}
 */
export async function eligibility({ recordId, physicalItemId, assetId }, transaction) {
  const holds = await holdsFor({ recordId, physicalItemId, assetId }, transaction);
  if (holds.length)
    return { eligibility: 'blocked_legal_hold', blockReason: `Legal hold ${holds.map((h) => h.reference).join(', ')}` };
  const record = recordId ? await models.ArchivalRecord.findByPk(recordId, { transaction }) : null;
  const viaRecord =
    record ??
    (physicalItemId
      ? await models.PhysicalItem.findByPk(physicalItemId, {
          include: [{ model: models.ArchivalRecord, as: 'record' }],
          transaction,
        }).then((p) => p?.record)
      : null) ??
    (assetId
      ? await models.DigitalAsset.findByPk(assetId, {
          include: [{ model: models.ArchivalRecord, as: 'record' }],
          transaction,
        }).then((a) => a?.record)
      : null);
  if (viaRecord && viaRecord.isPermanent && viaRecord.custodyStatus === 'accessioned') {
    return {
      eligibility: 'blocked_permanent',
      blockReason: 'Permanent archival holding — excluded from routine disposal',
    };
  }
  if (assetId) {
    const asset = await models.DigitalAsset.findByPk(assetId, { attributes: ['role'], transaction });
    if (asset && ['preservation_master', 'original_upload'].includes(asset.role) && viaRecord?.isPermanent) {
      return { eligibility: 'blocked_permanent', blockReason: 'Preservation master of a permanent holding' };
    }
  }
  if (viaRecord) {
    const active = await models.ResearchRequestItem.count({
      where: { recordId: viaRecord.id },
      include: [
        {
          model: models.ResearchRequest,
          as: 'request',
          where: {
            status: {
              [Op.in]: [
                'submitted',
                'under_review',
                'awaiting_researcher',
                'awaiting_approval',
                'approved',
                'scheduled',
                'in_progress',
              ],
            },
          },
        },
      ],
      transaction,
    });
    if (active) return { eligibility: 'blocked_active_request', blockReason: 'Subject of an active research request' };
  }
  if (physicalItemId) {
    const out = await models.CirculationTransaction.count({
      where: { physicalItemId, status: ['issued', 'overdue'] },
      transaction,
    });
    if (out) return { eligibility: 'blocked_active_request', blockReason: 'Item is currently issued' };
  }
  return { eligibility: 'eligible', blockReason: null };
}

/**
 * Opens an appraisal case for a set of records, items or files and records the eligibility of each. A retention
 * schedule, if given, must be approved.
 *
 * @param {{ title: string, scheduleId?: string, items: Array<{ recordId?: string, physicalItemId?: string,
 *   assetId?: string }> }} input Case details.
 * @param {object} user Authenticated principal; recorded as the person who opened the case.
 * @returns {Promise<object>} The new case with its allocated case number.
 * @throws {AppError} 422 when no items are given, 400 when the schedule is not approved.
 */
export async function createCase({ title, scheduleId, items }, user) {
  if (!items?.length) throw validationError([{ path: 'items', message: 'Add at least one record, item or file' }]);
  return sequelize.transaction(async (t) => {
    if (scheduleId) {
      const s = await models.RetentionSchedule.findByPk(scheduleId, { transaction: t });
      if (!s || s.status !== 'approved') throw badRequest('Use an approved retention schedule');
    }
    const c = await models.AppraisalCase.create(
      {
        caseNumber: await generateReference('appraisal_case', t),
        title,
        scheduleId,
        openedById: user.id,
        status: 'open',
      },
      { transaction: t },
    );
    for (const it of items) {
      const e = await eligibility(it, t);
      await models.AppraisalCaseItem.create({ caseId: c.id, ...it, ...e }, { transaction: t });
    }
    await audit(
      {
        action: 'appraisal.case_opened',
        resourceType: 'AppraisalCase',
        resourceId: c.id,
        after: { caseNumber: c.caseNumber, items: items.length },
      },
      { transaction: t },
    );
    return c;
  });
}

/**
 * Re-checks the eligibility of every item in a case that has not been excluded, so decisions are always based on
 * the current situation.
 *
 * @param {string} caseId Identifier of the appraisal case.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object[]>} The case items with their updated eligibility.
 */
export async function refreshEligibility(caseId, transaction) {
  const items = await models.AppraisalCaseItem.findAll({ where: { caseId }, transaction });
  for (const it of items) {
    if (it.eligibility === 'excluded') continue;
    const e = await eligibility(
      { recordId: it.recordId, physicalItemId: it.physicalItemId, assetId: it.assetId },
      transaction,
    );
    await it.update(e, { transaction });
  }
  return items;
}

/**
 * Produces and stores an appraisal report: current eligibility counts and the retention schedule applied.
 *
 * @param {string} caseId Identifier of the appraisal case.
 * @returns {Promise<{ generatedAt: string, schedule: object|null, counts: Record<string, number>, total: number }>}
 * @throws {AppError} 404 when the case does not exist.
 */
export async function report(caseId) {
  const c = await models.AppraisalCase.findByPk(caseId, {
    include: [{ model: models.RetentionSchedule, as: 'schedule' }],
  });
  if (!c) throw notFound('Appraisal case');
  const items = await refreshEligibility(caseId);
  const counts = items.reduce((acc, i) => ({ ...acc, [i.eligibility]: (acc[i.eligibility] || 0) + 1 }), {});
  const summary = {
    generatedAt: new Date().toISOString(),
    schedule: c.schedule
      ? {
          code: c.schedule.code,
          title: c.schedule.title,
          retentionYears: c.schedule.retentionYears,
          finalAction: c.schedule.finalAction,
        }
      : null,
    counts,
    total: items.length,
  };
  await c.update({ reportSummary: summary });
  return summary;
}

/**
 * Performs a workflow action on an appraisal case.
 *
 * A recommendation needs a decision and a rationale, and a recommendation to dispose is refused while any item is
 * under legal hold. Approving or rejecting needs a rationale and must be done by someone other than the person who
 * opened or recommended the case; the decision is stored as an approval. Approvers are notified when a decision is
 * requested.
 *
 * @param {string} id Identifier of the appraisal case.
 * @param {{ action: string, reason?: string, recommendation?: string, rationale?: string }} input The action and
 *   its details.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated case.
 * @throws {AppError} When the action is not permitted or allowed, or required information is missing.
 */
export async function transitionCase(id, { action, reason, recommendation, rationale }, user) {
  if (!hasPerm(user, CASE_ACTION_PERMISSION[action])) throw forbidden();
  return sequelize.transaction(async (t) => {
    const c = await models.AppraisalCase.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c) throw notFound('Appraisal case');
    assertTransition('appraisal', c.status, action);
    if (action === 'recommend') {
      if (!recommendation || recommendation === 'undecided' || !rationale)
        throw validationError([{ path: 'rationale', message: 'Give a recommendation and rationale' }]);
      const items = await refreshEligibility(id, t);
      if (recommendation === 'dispose' && items.some((i) => i.eligibility === 'blocked_legal_hold'))
        throw conflict('Items are under legal hold. Remove them or place the case on hold.');
    }
    if (['approve', 'reject'].includes(action)) {
      await assertSeparationOfDuties(
        user.id,
        [c.recommendedById, c.openedById],
        'An appraisal must be decided by someone other than its author',
      );
      if (!reason) throw validationError([{ path: 'reason', message: 'Record the decision rationale' }]);
    }
    await transition('appraisal', c, action, {
      actor: user,
      reason,
      transaction: t,
      apply: (x) => {
        if (action === 'recommend')
          Object.assign(x, { recommendation, rationale, recommendedById: user.id, recommendedAt: new Date() });
        if (['approve', 'reject'].includes(action))
          Object.assign(x, { decidedById: user.id, decidedAt: new Date(), decisionNote: reason });
        if (action === 'place_on_hold') x.holdReason = reason;
      },
    });
    if (['approve', 'reject'].includes(action))
      await models.Approval.create(
        {
          entityType: 'AppraisalCase',
          entityId: c.id,
          stage: 'appraisal_decision',
          approverId: user.id,
          decision: action === 'approve' ? 'approved' : 'rejected',
          reason,
        },
        { transaction: t },
      );
    if (action === 'request_approval')
      await notifyPermissionHolders(
        ['appraisal.approve'],
        {
          eventType: 'retention.review',
          title: `Appraisal awaiting decision: ${c.caseNumber}`,
          body: c.title,
          link: `/admin/appraisal/${c.id}`,
        },
        { transaction: t },
      );
    return c;
  });
}

// ---------------------------------------------------------------- disposal

/**
 * Lists exactly what a disposal action would affect, without changing anything.
 *
 * For each eligible case item, the affected digital files (for digital deletion, including access copies and
 * thumbnails made from them) or physical items (for physical actions) are listed, plus a note that the related description will be kept and annotated. Blocked items are
 * listed separately with the reason. The fingerprint is a SHA-256 of the action and targets, so any change to the
 * list produces a different fingerprint.
 *
 * @param {object} appraisalCase The approved appraisal case.
 * @param {string} action Disposal action, for example "delete_digital" or "destroy_physical".
 * @param {import('sequelize').Transaction} t Current transaction.
 * @returns {Promise<{ action: string, generatedAt: string, targets: object[], blocked: object[], fingerprint:
 *   string }>}
 */
async function buildDryRun(appraisalCase, action, t) {
  const items = await refreshEligibility(appraisalCase.id, t);
  const targets = [];
  const blocked = [];
  for (const it of items) {
    const base = { caseItemId: it.id, recordId: it.recordId, physicalItemId: it.physicalItemId, assetId: it.assetId };
    if (it.eligibility !== 'eligible') {
      blocked.push({ ...base, reason: it.blockReason, eligibility: it.eligibility });
      continue;
    }
    if (action === 'delete_digital') {
      const scope = it.assetId ? { id: it.assetId } : it.recordId ? { recordId: it.recordId } : null;
      const assets = scope
        ? await models.DigitalAsset.findAll({ where: { ...scope, status: { [Op.ne]: 'deleted' } }, transaction: t })
        : [];
      // Access copies and thumbnails made from a file go with it.
      if (it.assetId)
        assets.push(
          ...(await models.DigitalAsset.findAll({
            where: { parentAssetId: it.assetId, status: { [Op.ne]: 'deleted' } },
            transaction: t,
          })),
        );
      for (const a of assets)
        targets.push({
          type: 'digital_asset',
          id: a.id,
          label: a.originalFilename,
          sha256: a.sha256,
          sizeBytes: Number(a.sizeBytes),
          role: a.role,
        });
    } else {
      const scope = it.physicalItemId
        ? { id: it.physicalItemId }
        : it.recordId
          ? { recordId: it.recordId, status: { [Op.ne]: 'disposed' } }
          : null;
      const physical = scope ? await models.PhysicalItem.findAll({ where: scope, transaction: t }) : [];
      for (const p of physical)
        targets.push({ type: 'physical_item', id: p.id, label: `${p.barcode} — ${p.title}`, status: p.status });
    }
    if (it.recordId) {
      const r = await models.ArchivalRecord.findByPk(it.recordId, {
        attributes: ['id', 'referenceCode', 'title'],
        transaction: t,
      });
      targets.push({
        type: 'description_note',
        id: r.id,
        label: `${r.referenceCode} — ${r.title}`,
        effect: 'Description retained and annotated with the disposal certificate',
      });
    }
  }
  const body = { action, generatedAt: new Date().toISOString(), targets, blocked };
  return {
    ...body,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify({ action, targets })).digest('hex'),
  };
}

/**
 * Creates a draft disposal case from an approved appraisal whose recommendation involves disposal, with an initial
 * dry run and the configured number of required approvals.
 *
 * @param {string} appraisalCaseId Identifier of the approved appraisal case.
 * @param {string} action Disposal action.
 * @param {object} user Authenticated principal; recorded as the case author.
 * @returns {Promise<object>} The new disposal case.
 * @throws {AppError} 400 when the appraisal is not approved, does not recommend disposal, or nothing is eligible.
 */
export async function createDisposal(appraisalCaseId, action, user) {
  return sequelize.transaction(async (t) => {
    const c = await models.AppraisalCase.findByPk(appraisalCaseId, { transaction: t });
    if (!c || c.status !== 'approved') throw badRequest('A disposal case needs an approved appraisal case');
    if (!['dispose', 'return_to_department', 'transfer_to_archives'].includes(c.recommendation))
      throw badRequest('The approved recommendation does not involve disposal');
    const dryRun = await buildDryRun(c, action, t);
    if (!dryRun.targets.filter((x) => x.type !== 'description_note').length)
      throw badRequest('Nothing is eligible for this action');
    const d = await models.DisposalCase.create(
      {
        caseNumber: await generateReference('disposal_case', t),
        appraisalCaseId,
        action,
        status: 'draft',
        dryRunSnapshot: dryRun,
        dryRunAt: new Date(),
        requiredApprovals: await getSetting('workflow.disposalApprovals'),
        createdById: user.id,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'disposal.case_created',
        resourceType: 'DisposalCase',
        resourceId: d.id,
        after: {
          caseNumber: d.caseNumber,
          action,
          targets: dryRun.targets.length,
          blocked: dryRun.blocked.length,
          fingerprint: dryRun.fingerprint,
        },
      },
      { transaction: t },
    );
    return d;
  });
}

/**
 * Rebuilds the dry run of a disposal case before approval. If the list of targets has changed, a case awaiting
 * approval returns to draft, because earlier approvals were given for a different list.
 *
 * @param {string} id Identifier of the disposal case.
 * @returns {Promise<object>} The updated case.
 * @throws {AppError} 400 once the case has been approved.
 */
export async function regenerateDryRun(id) {
  return sequelize.transaction(async (t) => {
    const d = await models.DisposalCase.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: models.AppraisalCase, as: 'appraisalCase' }],
    });
    if (!d || !['draft', 'pending_approval'].includes(d.status))
      throw badRequest('The dry run can only be regenerated before approval');
    const dryRun = await buildDryRun(d.appraisalCase, d.action, t);
    const changed = dryRun.fingerprint !== d.dryRunSnapshot?.fingerprint;
    await d.update(
      {
        dryRunSnapshot: dryRun,
        dryRunAt: new Date(),
        ...(changed && d.status === 'pending_approval' && { status: 'draft' }),
      },
      { transaction: t },
    );
    // Approvals are bound to a fingerprint, so a changed target list automatically needs fresh approvals.
    await audit(
      {
        action: 'disposal.dry_run',
        resourceType: 'DisposalCase',
        resourceId: d.id,
        metadata: { fingerprint: dryRun.fingerprint, changed },
      },
      { transaction: t },
    );
    return d;
  });
}

/**
 * Submits a disposal case for approval and notifies everyone who may approve disposals.
 *
 * @param {string} id Identifier of the disposal case.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated case.
 */
export async function requestApproval(id, user) {
  return sequelize.transaction(async (t) => {
    const d = await models.DisposalCase.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!d) throw notFound('Disposal case');
    await transition('disposal', d, 'request_approval', { actor: user, transaction: t });
    await notifyPermissionHolders(
      ['disposal.approve'],
      {
        eventType: 'disposal.approval',
        title: `Disposal awaiting approval: ${d.caseNumber}`,
        body: `${d.dryRunSnapshot.targets.length} target(s). Review the dry run before approving.`,
        link: `/admin/disposal/${d.id}`,
      },
      { transaction: t },
    );
    return d;
  });
}

/**
 * Records one approval of a disposal case.
 *
 * The approver must hold "disposal.approve", must not be the case author, may approve only once, and must send the
 * fingerprint of the dry run they reviewed, which must still be current. When the required number of approvals for
 * that fingerprint is reached, the case becomes approved.
 *
 * @param {string} id Identifier of the disposal case.
 * @param {{ fingerprint: string, reason?: string }} input The reviewed fingerprint and an optional comment.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ status: string, approvals: number, required: number }>}
 * @throws {AppError} When the case is not awaiting approval, the dry run has changed, or the approver is not
 *   eligible.
 */
export async function approveDisposal(id, { fingerprint, reason }, user) {
  if (!hasPerm(user, 'disposal.approve')) throw forbidden();
  return sequelize.transaction(async (t) => {
    const d = await models.DisposalCase.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!d || d.status !== 'pending_approval') throw badRequest('This case is not awaiting approval');
    if (fingerprint !== d.dryRunSnapshot?.fingerprint)
      throw conflict('The dry run has changed since you reviewed it. Review it again.');
    await assertSeparationOfDuties(user.id, [d.createdById], 'The author of a disposal case cannot approve it');
    if (
      await models.Approval.findOne({
        where: { entityType: 'DisposalCase', entityId: d.id, approverId: user.id },
        transaction: t,
      })
    )
      throw conflict('You have already approved this case');
    await models.Approval.create(
      {
        entityType: 'DisposalCase',
        entityId: d.id,
        stage: `approval:${fingerprint}`,
        approverId: user.id,
        decision: 'approved',
        reason,
      },
      { transaction: t },
    );
    const count = await models.Approval.count({
      where: { entityType: 'DisposalCase', entityId: d.id, decision: 'approved', stage: `approval:${fingerprint}` },
      transaction: t,
    });
    await audit(
      {
        action: 'disposal.approval',
        resourceType: 'DisposalCase',
        resourceId: d.id,
        metadata: { fingerprint, approvals: count, required: d.requiredApprovals },
        reason,
      },
      { transaction: t },
    );
    if (count >= d.requiredApprovals)
      await transition('disposal', d, 'approve', {
        actor: user,
        transaction: t,
        reason: `${count} approvals recorded`,
      });
    return { status: d.status, approvals: count, required: d.requiredApprovals };
  });
}

/**
 * Carries out an approved disposal on exactly the approved targets.
 *
 * The case number must be typed as confirmation. Eligibility is rebuilt first; if anything has changed since
 * approval (for example a new legal hold), the case is blocked and nothing is touched. Otherwise, in one
 * transaction:
 * - digital files are marked deleted and a deletion event is recorded;
 * - physical items are moved out and marked disposed or withdrawn;
 * - descriptions are annotated;
 * - a certificate is generated, hashed, stored and recorded;
 * - the disposal and appraisal cases are closed and the execution is audited.
 *
 * Stored file content, with every earlier version and every replica, is destroyed only after the transaction has
 * committed; metadata and checksums remain as evidence. The returned `destruction` counts show whether every file
 * was destroyed.
 *
 * @param {string} id Identifier of the disposal case.
 * @param {{ confirmation: string }} input The typed case number.
 * @param {object} user Authenticated principal with "disposal.execute".
 * @returns {Promise<{ executed: true, results: object[], destruction: { files: number, destroyed: number, failed:
 *   number } }>}
 * @throws {AppError} When not permitted, not approved, not confirmed, or eligibility has changed (409, and the case
 *   is blocked).
 */
export async function executeDisposal(id, { confirmation }, user) {
  if (!hasPerm(user, 'disposal.execute')) throw forbidden();
  const d = await models.DisposalCase.findByPk(id, { include: [{ model: models.AppraisalCase, as: 'appraisalCase' }] });
  if (!d) throw notFound('Disposal case');
  assertTransition('disposal', d.status, 'execute');
  if (confirmation !== d.caseNumber)
    throw badRequest(`Type the case number (${d.caseNumber}) to confirm this irreversible action`);
  const fresh = await sequelize.transaction((t) => buildDryRun(d.appraisalCase, d.action, t));
  if (fresh.fingerprint !== d.dryRunSnapshot.fingerprint) {
    await sequelize.transaction(async (t) => {
      await transition('disposal', d, 'block', {
        actor: user,
        transaction: t,
        reason: 'Targets changed after approval (new hold, request or status change)',
      });
      await d.update({ blockReason: 'Targets changed after approval; re-appraisal required' }, { transaction: t });
    });
    throw conflict('Eligibility changed since approval (for example a new legal hold). The case has been blocked.');
  }
  const results = [];
  const deletedAssetIds = [];
  await sequelize.transaction(async (t) => {
    const certificateNumber = await generateReference('disposal_certificate', t);
    for (const target of d.dryRunSnapshot.targets) {
      if (target.type === 'digital_asset') {
        const a = await models.DigitalAsset.findByPk(target.id, { transaction: t, lock: t.LOCK.UPDATE });
        await a.update(
          {
            status: 'deleted',
            isPublished: false,
            deletedAt: new Date(),
            deletedById: user.id,
            deletionReason: `Authorised disposal ${d.caseNumber} (${certificateNumber})`,
          },
          { transaction: t },
        );
        await recordEvent(
          {
            assetId: a.id,
            recordId: a.recordId,
            eventType: 'deletion',
            detail: `Authorised disposal under ${certificateNumber}`,
            technicalDetail: { sha256: a.sha256, disposalCase: d.caseNumber },
          },
          { transaction: t },
        );
        deletedAssetIds.push(a.id);
        results.push({ ...target, outcome: 'deleted' });
      } else if (target.type === 'physical_item') {
        const p = await models.PhysicalItem.findByPk(target.id, { transaction: t, lock: t.LOCK.UPDATE });
        await models.PhysicalItemMovement.create(
          {
            itemId: p.id,
            fromLocationId: p.currentLocationId,
            toLocationId: null,
            movementType: 'disposal',
            reason: `${d.action.replace(/_/g, ' ')} under ${certificateNumber}`,
            movedById: user.id,
            movedAt: new Date(),
          },
          { transaction: t },
        );
        await p.update(
          { status: d.action === 'destroy_physical' ? 'disposed' : 'withdrawn', currentLocationId: null },
          { transaction: t },
        );
        results.push({ ...target, outcome: d.action });
      } else if (target.type === 'description_note') {
        const r = await models.ArchivalRecord.findByPk(target.id, { transaction: t });
        const note = `${r.appraisalInfo ? `${r.appraisalInfo}\n` : ''}Disposal: ${d.action.replace(/_/g, ' ')} executed ${new Date().toISOString().slice(0, 10)} under certificate ${certificateNumber}.`;
        await models.ArchivalRecord.update({ appraisalInfo: note }, { where: { id: r.id }, transaction: t });
        results.push({ ...target, outcome: 'annotated' });
      }
    }
    const approvals = await models.Approval.findAll({
      where: { entityType: 'DisposalCase', entityId: d.id },
      include: [{ model: models.User, as: 'approver', attributes: ['fullName', 'email'] }],
      transaction: t,
    });
    const content = {
      certificateNumber,
      disposalCase: d.caseNumber,
      appraisalCase: d.appraisalCase.caseNumber,
      action: d.action,
      executedAt: new Date().toISOString(),
      executedBy: { id: user.id, name: user.fullName },
      approvals: approvals.map((a) => ({ name: a.approver.fullName, at: a.createdAt, reason: a.reason })),
      dryRunFingerprint: d.dryRunSnapshot.fingerprint,
      results,
    };
    const sha = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const pdf = await certificatePdf(content, sha);
    const key = buildKey('disposal-certificates', `${certificateNumber.replace(/[^\w-]+/g, '_')}.pdf`);
    await storage.put(key, pdf, { contentType: 'application/pdf' });
    await models.DisposalCertificate.create(
      {
        disposalCaseId: d.id,
        certificateNumber,
        issuedAt: new Date(),
        content,
        sha256: sha,
        storageKey: key,
        issuedById: user.id,
      },
      { transaction: t },
    );
    await d.update(
      {
        executionConfirmation: confirmation,
        executedById: user.id,
        executedAt: new Date(),
        executionResult: { results: results.length },
      },
      { transaction: t },
    );
    await transition('disposal', d, 'execute', {
      actor: user,
      transaction: t,
      reason: `Certificate ${certificateNumber}`,
    });
    if (d.appraisalCase.status === 'approved')
      await transition('appraisal', d.appraisalCase, 'mark_executed', { actor: user, transaction: t });
    await audit(
      {
        action: 'disposal.executed',
        resourceType: 'DisposalCase',
        resourceId: d.id,
        after: { certificateNumber, results: results.length, certificateSha256: sha },
        sensitive: true,
      },
      { transaction: t },
    );
  });
  // Files are destroyed only after the evidence has been committed; metadata and checksums remain.
  const destruction = await destroyDisposedFiles(d, deletedAssetIds, user);
  return { executed: true, results, destruction };
}

/**
 * Destroys the stored content of digitally disposed assets: every version of each file and of its replicas, using
 * the disposal storage credential, which can bypass governance retention. Each deletion is confirmed by the storage
 * driver. The outcome is kept on the case (`executionResult.destruction`) and audited; on any failure the people
 * who can execute disposals are notified so they can retry with `retryFileDestruction`.
 *
 * A file under an S3 legal hold cannot be destroyed by any credential; disposal eligibility already excludes held
 * material, so such a failure means the hold was placed after execution.
 *
 * @param {object} d The executed disposal case.
 * @param {string[]} assetIds Identifiers of the assets marked deleted by the disposal.
 * @param {{ id: string }} user Person executing the disposal.
 * @returns {Promise<{ files: number, destroyed: number, failed: number }>}
 */
async function destroyDisposedFiles(d, assetIds, user) {
  const outcome = { files: 0, destroyed: 0, failed: 0 };
  const failures = [];
  for (const assetId of assetIds) {
    const asset = await models.DigitalAsset.findByPk(assetId, { attributes: ['id', 'storageKey'] });
    const replicas = await models.StorageReplica.findAll({ where: { assetId }, attributes: ['storageKey'] });
    for (const key of [asset?.storageKey, ...replicas.map((r) => r.storageKey)].filter(Boolean)) {
      outcome.files += 1;
      try {
        await storage.destroy(key);
        outcome.destroyed += 1;
      } catch (err) {
        outcome.failed += 1;
        failures.push({ assetId, error: err.message.slice(0, 300) });
      }
    }
  }
  await d.update({ executionResult: { ...d.executionResult, destruction: outcome } });
  await audit({
    action: outcome.failed ? 'disposal.file_destruction_failed' : 'disposal.files_destroyed',
    outcome: outcome.failed ? 'failure' : 'success',
    resourceType: 'DisposalCase',
    resourceId: d.id,
    actor: user,
    metadata: { ...outcome, failures },
    sensitive: true,
  });
  if (outcome.failed)
    await notifyPermissionHolders(['disposal.execute'], {
      eventType: 'disposal.approval',
      title: `Disposal ${d.caseNumber}: ${outcome.failed} file(s) not destroyed`,
      body: 'The records were disposed of, but some stored files could not be destroyed. Retry from the case page.',
      link: `/admin/disposal/${d.id}`,
    });
  return outcome;
}

/**
 * Retries the destruction of stored files for an executed disposal, for example after a storage outage or once
 * the disposal storage credential has been configured. Files already destroyed are skipped without error.
 *
 * @param {string} id Identifier of the executed disposal case.
 * @param {object} user Authenticated principal with "disposal.execute".
 * @returns {Promise<{ files: number, destroyed: number, failed: number }>}
 * @throws {AppError} When not permitted, not found, or the case has not been executed.
 */
export async function retryFileDestruction(id, user) {
  if (!hasPerm(user, 'disposal.execute')) throw forbidden();
  const d = await models.DisposalCase.findByPk(id);
  if (!d) throw notFound('Disposal case');
  if (d.status !== 'executed') throw badRequest('Files can only be destroyed for an executed disposal');
  const certificate = await models.DisposalCertificate.findOne({ where: { disposalCaseId: d.id } });
  const assetIds = (certificate?.content?.results || [])
    .filter((r) => r.type === 'digital_asset' && r.outcome === 'deleted')
    .map((r) => r.id);
  return destroyDisposedFiles(d, assetIds, user);
}

/**
 * Renders the certificate of authorised disposal as a PDF bearing the crest: the certificate, case and appraisal
 * numbers, the action, who executed it and when, every approval, every item affected with its SHA-256 where
 * applicable, the dry-run fingerprint and the SHA-256 of the certificate content.
 *
 * @param {object} content The certificate content.
 * @param {string} sha SHA-256 of the certificate content.
 * @returns {Promise<Buffer>} The PDF file.
 */
async function certificatePdf(content, sha) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  stampCrest(doc);
  doc.fillColor(BRAND.indigo).fontSize(10).text('UNIVERSITY OF GHANA ARCHIVES');
  doc.fillColor('#111').fontSize(18).text('Certificate of Authorised Disposal');
  doc
    .moveDown(0.5)
    .fontSize(10)
    .fillColor('#444')
    .text(
      `Certificate ${content.certificateNumber} · Disposal case ${content.disposalCase} · Appraisal ${content.appraisalCase}`,
    );
  doc.text(
    `Action: ${content.action.replace(/_/g, ' ')} · Executed ${content.executedAt} by ${content.executedBy.name}`,
  );
  doc.moveDown().fillColor(BRAND.indigo).fontSize(11).text('Approvals');
  for (const a of content.approvals)
    doc
      .fillColor('#111')
      .fontSize(9)
      .text(`• ${a.name} — ${new Date(a.at).toISOString()}${a.reason ? ` — ${a.reason}` : ''}`);
  doc.moveDown().fillColor(BRAND.indigo).fontSize(11).text('Items');
  for (const r of content.results)
    doc
      .fillColor('#111')
      .fontSize(8)
      .text(`• [${r.type.replace(/_/g, ' ')}] ${r.label}${r.sha256 ? ` (SHA-256 ${r.sha256})` : ''} — ${r.outcome}`);
  doc.moveDown().fillColor('#666').fontSize(7).text(`Dry-run fingerprint: ${content.dryRunFingerprint}`);
  doc.text(`Certificate content SHA-256: ${sha}`);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/**
 * Lists the workflow actions this user may take on an appraisal case now. "Mark executed" is never offered by hand;
 * it happens automatically when a disposal is executed.
 *
 * @param {object} c The appraisal case.
 * @param {object} user Authenticated principal.
 * @returns {string[]} The available action names.
 */
export function caseActions(c, user) {
  return availableActions('appraisal', c.status).filter(
    (a) => a !== 'mark_executed' && hasPerm(user, CASE_ACTION_PERMISSION[a]),
  );
}

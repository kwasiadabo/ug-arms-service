/**
 * Business rules for research requests: enquiries, consultation of material, access to restricted material, and
 * copies.
 *
 * Requesters see only their own requests, and a restricted description can be requested only if its existence is
 * already publicly discoverable. Requests for restricted material need a second approval by a different person
 * holding "research.approve" when the two-person rule is on. Approved restricted access is granted for a limited
 * time (90 days). Approving a copy request does not clear copyright: each copy needs an explicit rights decision
 * before it can be delivered. Notes for the requester are kept separate from internal notes.
 *
 * @author Kwasi Adabo Boakye
 */

import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, validationError } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import {
  transition,
  assertTransition,
  assertSeparationOfDuties,
  availableActions,
} from '../../services/workflow.service.js';
import { generateReference } from '../../services/referenceCode.service.js';
import { notifyPermissionHolders, notifyUsers, notifyEmailOnly } from '../../services/notification.service.js';
import { evaluateRecord, hasPerm } from '../../services/accessPolicy.service.js';
import { grantAccess } from '../permissions/permissions.service.js';
import { getSetting } from '../../services/settings.service.js';

const GRANT_DAYS = 90;

/**
 * Tells whether a user made a request.
 *
 * @param {object|null} user Authenticated principal.
 * @param {{ requesterId: string|null }} r The request.
 * @returns {boolean}
 */
export function isOwner(user, r) {
  return Boolean(user && r.requesterId === user.id);
}

/**
 * Loads a request the user may see: staff with "research.manage" see all requests, and requesters see their own.
 * Anything else is reported as not found.
 *
 * @param {string} id Identifier of the request.
 * @param {object} user Authenticated principal.
 * @param {object} [opts={}] Sequelize options such as a transaction or lock.
 * @returns {Promise<object>}
 * @throws {AppError} 404 when not found or not visible.
 */
export async function loadVisible(id, user, opts = {}) {
  const r = await models.ResearchRequest.findByPk(id, opts);
  if (!r) throw notFound('Research request');
  if (!hasPerm(user, 'research.manage') && !isOwner(user, r)) throw notFound('Research request');
  return r;
}

/**
 * Creates a research request and, by default, submits it.
 *
 * Visitors without an account may send only enquiries and consultation requests, and only when the setting allows
 * it. Restricted-access requests need the access conditions to be acknowledged. A description listed twice is kept
 * once. Every requested description must be discoverable by the requester. A restricted-access request that
 * includes restricted, embargoed, confidential or closed material is marked as needing a second approval.
 *
 * @param {object} data Validated request details and items.
 * @param {object|null} user Requester, or null for an anonymous enquiry.
 * @param {{ submit?: boolean }} [options] Whether to submit immediately (default true).
 * @returns {Promise<object>} The request.
 * @throws {AppError} When the request is not allowed or a description cannot be requested.
 */
export async function createRequest(data, user, { submit = true } = {}) {
  if (!user && !(await getSetting('research.allowAnonymousEnquiries')))
    throw forbidden('Please sign in to submit a request');
  if (!user && data.requestType !== 'enquiry' && data.requestType !== 'consultation')
    throw forbidden('Sign in to request restricted access or copies');
  if (data.requestType === 'restricted_access' && !data.restrictionsAcknowledged)
    throw validationError([{ path: 'restrictionsAcknowledged', message: 'Acknowledge the access conditions' }]);
  // The same description requested twice is one item (keeps the first occurrence and its notes).
  if (data.items?.length)
    data = {
      ...data,
      items: data.items.filter(
        (it, i, all) =>
          all.findIndex((x) => x.recordId === it.recordId && (x.assetId ?? null) === (it.assetId ?? null)) === i,
      ),
    };
  const records = data.items?.length
    ? await models.ArchivalRecord.findAll({ where: { id: data.items.map((i) => i.recordId) } })
    : [];
  if (records.length !== new Set((data.items || []).map((i) => i.recordId)).size)
    throw notFound('One or more requested descriptions');
  let sensitive = false;
  for (const rec of records) {
    const d = await evaluateRecord(user, rec);
    if (!d.canDiscover) throw notFound('One or more requested descriptions');
    if (['restricted', 'embargoed', 'confidential', 'closed'].includes(rec.effectiveAccessLevel)) sensitive = true;
  }
  if (data.requestType !== 'enquiry' && !records.length)
    throw validationError([{ path: 'items', message: 'Select at least one record' }]);
  return sequelize.transaction(async (t) => {
    const r = await models.ResearchRequest.create(
      {
        requesterId: user?.id ?? null,
        contactName: data.contactName || user?.fullName,
        contactEmail: data.contactEmail || user?.email,
        contactPhone: data.contactPhone,
        affiliation: data.affiliation,
        requestType: data.requestType,
        purpose: data.purpose,
        preferredDate: data.preferredDate,
        deliveryPreference: data.deliveryPreference,
        restrictionsAcknowledged: Boolean(data.restrictionsAcknowledged),
        status: 'draft',
        requiresSecondApproval:
          sensitive &&
          (await getSetting('workflow.twoPersonAccessChanges')) &&
          data.requestType === 'restricted_access',
      },
      { transaction: t },
    );
    for (const it of data.items || []) {
      await models.ResearchRequestItem.create(
        { requestId: r.id, recordId: it.recordId, physicalItemId: it.physicalItemId ?? null, notes: it.notes },
        { transaction: t },
      );
    }
    await audit(
      {
        action: 'research.request_created',
        resourceType: 'ResearchRequest',
        resourceId: r.id,
        actor: user,
        actorType: user ? 'user' : 'anonymous',
        actorLabel: r.contactEmail,
        after: { requestType: r.requestType, items: records.length },
      },
      { transaction: t },
    );
    if (submit) await submitRequest(r, user, t);
    return r;
  });
}

/**
 * Submits a request: allocates its request number, notifies research staff and emails the requester a confirmation.
 *
 * @param {object} r The request.
 * @param {object|null} user Requester.
 * @param {import('sequelize').Transaction} t Current transaction.
 * @returns {Promise<void>}
 */
async function submitRequest(r, user, t) {
  await transition('research_request', r, 'submit', {
    actor: user,
    transaction: t,
    apply: async (x) => {
      x.requestNumber = x.requestNumber || (await generateReference('research_request', t));
      x.submittedAt = new Date();
    },
  });
  await notifyPermissionHolders(
    ['research.manage'],
    {
      eventType: 'research.submitted',
      title: `New ${r.requestType.replace(/_/g, ' ')} request ${r.requestNumber}`,
      body: `${r.contactName}`,
      link: `/admin/research-requests/${r.id}`,
      entityType: 'ResearchRequest',
      entityId: r.id,
    },
    { transaction: t },
  );
  await notifyEmailOnly(
    r.contactEmail,
    {
      subject: `Request received: ${r.requestNumber}`,
      body: `Dear ${r.contactName},\n\nWe have received your request (${r.requestNumber}). An archivist will review it and contact you.`,
    },
    { transaction: t },
  );
}

/**
 * Tells the requester about a decision or message: in the application if they have an account, otherwise by email.
 *
 * @param {object} r The request.
 * @param {string} title Notification title.
 * @param {string} body Notification text; must not contain internal notes.
 * @param {import('sequelize').Transaction} [t]
 * @returns {Promise<void>}
 */
async function notifyRequester(r, title, body, t) {
  if (r.requesterId)
    await notifyUsers(
      [r.requesterId],
      {
        eventType: 'research.decision',
        title,
        body,
        link: `/my/requests/${r.id}`,
        entityType: 'ResearchRequest',
        entityId: r.id,
      },
      { transaction: t },
    );
  else await notifyEmailOnly(r.contactEmail, { subject: title, body }, { transaction: t });
}

/**
 * Performs an action on a request by staff or by the requester.
 *
 * Requesters may submit, respond to a question or cancel their own requests; every other action is for research
 * staff. Rejecting and asking for clarification need a note for the requester. Approval records a decision per item
 * and needs at least one approved item. When a second approval is required, the first approval moves the request to
 * "awaiting approval", and a different person with "research.approve" must then approve it. Approval of restricted
 * access issues time-limited grants, and approval of copies creates reproduction orders. Messages, notes for the
 * requester and internal notes are kept as separate comments, and the requester is told the outcome.
 *
 * @param {string} id Identifier of the request.
 * @param {{ action: string, publicNote?: string, internalNote?: string, itemDecisions?: object[], conditions?:
 *   string, message?: string }} payload The action and its details.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated request.
 * @throws {AppError} When the action is not permitted or allowed, or required information is missing.
 */
export async function act(id, payload, user) {
  const { action, publicNote, internalNote, itemDecisions, conditions, message } = payload;
  const requesterActions = ['submit', 'respond', 'cancel'];
  return sequelize.transaction(async (t) => {
    const r = await loadVisible(id, user, { transaction: t, lock: t.LOCK.UPDATE });
    const staff = hasPerm(user, 'research.manage');
    if (!requesterActions.includes(action) && !staff) throw forbidden();
    if (requesterActions.includes(action) && !staff && !isOwner(user, r)) throw forbidden();
    assertTransition('research_request', r.status, action);
    if (action === 'submit') {
      await submitRequest(r, user, t);
      return r;
    }
    if (['reject', 'request_clarification'].includes(action) && !publicNote)
      throw validationError([{ path: 'publicNote', message: 'Give the requester an explanation' }]);
    if (action === 'respond' && !message) throw validationError([{ path: 'message', message: 'Enter your response' }]);

    let effective = action;
    if (action === 'approve') {
      const items = await models.ResearchRequestItem.findAll({ where: { requestId: r.id }, transaction: t });
      const decisions = new Map((itemDecisions || []).map((d) => [d.itemId, d]));
      for (const it of items) {
        const d = decisions.get(it.id);
        await it.update({ decision: d?.decision ?? 'approved', decisionNote: d?.note ?? null }, { transaction: t });
      }
      if (!items.length || items.every((i) => i.decision === 'rejected'))
        throw badRequest('Approve at least one item, or reject the request');
      if (r.requiresSecondApproval) {
        if (!hasPerm(user, 'research.approve') && r.status === 'awaiting_approval')
          throw forbidden('A second approver with research.approve must decide');
        if (r.status === 'under_review') {
          effective = 'escalate_for_approval';
        } else {
          await assertSeparationOfDuties(
            user.id,
            [r.decisionById],
            'The second approval must come from a different person',
          );
        }
      }
    }
    await transition('research_request', r, effective, {
      actor: user,
      reason: internalNote || publicNote || message,
      transaction: t,
      metadata: itemDecisions ? { itemDecisions } : undefined,
      apply: (x) => {
        if (action === 'start_review') x.assignedToId = x.assignedToId || user.id;
        if (effective === 'escalate_for_approval')
          Object.assign(x, {
            decisionById: user.id,
            decisionAt: new Date(),
            internalDecisionNote: internalNote ?? x.internalDecisionNote,
            publicDecisionNote: publicNote ?? x.publicDecisionNote,
            conditions: conditions ?? x.conditions,
          });
        if (['approve', 'reject'].includes(effective)) {
          if (r.requiresSecondApproval && effective === 'approve')
            Object.assign(x, { secondApproverId: user.id, secondApprovedAt: new Date() });
          else Object.assign(x, { decisionById: user.id, decisionAt: new Date() });
          Object.assign(x, {
            publicDecisionNote: publicNote ?? x.publicDecisionNote,
            internalDecisionNote: internalNote ?? x.internalDecisionNote,
            conditions: conditions ?? x.conditions,
          });
        }
        if (['fulfil', 'close'].includes(effective)) x.completedAt = new Date();
      },
    });
    if (['approve', 'reject', 'escalate_for_approval'].includes(effective)) {
      await models.Approval.create(
        {
          entityType: 'ResearchRequest',
          entityId: r.id,
          stage: effective === 'approve' && r.requiresSecondApproval ? 'second_approval' : 'first_decision',
          approverId: user.id,
          decision: effective === 'reject' ? 'rejected' : 'approved',
          reason: internalNote || publicNote,
        },
        { transaction: t },
      );
    }
    if (message || (publicNote && ['request_clarification', 'reject', 'approve'].includes(action))) {
      await models.Comment.create(
        {
          entityType: 'ResearchRequest',
          entityId: r.id,
          authorId: user?.id ?? null,
          body: message || publicNote,
          visibility: 'shared',
        },
        { transaction: t },
      );
    }
    if (internalNote)
      await models.Comment.create(
        {
          entityType: 'ResearchRequest',
          entityId: r.id,
          authorId: user.id,
          body: internalNote,
          visibility: 'internal',
        },
        { transaction: t },
      );

    if (effective === 'approve') await onApproved(r, user, t);
    if (effective === 'escalate_for_approval') {
      await notifyPermissionHolders(
        ['research.approve'],
        {
          eventType: 'research.submitted',
          title: `Second approval needed: ${r.requestNumber}`,
          body: 'A restricted-access request needs a second decision.',
          link: `/admin/research-requests/${r.id}`,
          entityType: 'ResearchRequest',
          entityId: r.id,
        },
        { transaction: t },
      );
    }
    const outcome = { approve: 'approved', reject: 'not approved', request_clarification: 'needs more information' }[
      effective
    ];
    if (outcome)
      await notifyRequester(
        r,
        `Your request ${r.requestNumber} has been ${outcome}`,
        [publicNote, r.conditions && effective === 'approve' ? `Conditions: ${r.conditions}` : null]
          .filter(Boolean)
          .join('\n\n'),
        t,
      );
    return r;
  });
}

/**
 * Carries out the consequences of an approved request: grants the requester 90 days of view access to each approved
 * description and its descendants (restricted access and digital copies), and creates a pending reproduction order
 * for each approved item (copies), which still needs rights clearance.
 *
 * @param {object} r The request.
 * @param {object} user Approver.
 * @param {import('sequelize').Transaction} t Current transaction.
 * @returns {Promise<void>}
 */
async function onApproved(r, user, t) {
  const items = await models.ResearchRequestItem.findAll({
    where: { requestId: r.id, decision: 'approved' },
    transaction: t,
  });
  const expiresAt = new Date(Date.now() + GRANT_DAYS * 86400_000);
  if (r.requesterId && ['restricted_access', 'digital_copy'].includes(r.requestType)) {
    for (const it of items) {
      await grantAccess(
        {
          userId: r.requesterId,
          targetType: 'record',
          targetId: it.recordId,
          permissionLevel: 'view',
          expiresAt,
          researchRequestId: r.id,
          includeDescendants: true,
        },
        user,
        t,
      );
    }
  }
  if (['digital_copy', 'reproduction'].includes(r.requestType)) {
    // Approval does not clear copyright: each copy needs an explicit rights decision before delivery.
    for (const it of items)
      await models.ReproductionRequest.create(
        {
          requestId: r.id,
          recordId: it.recordId,
          assetId: it.assetId,
          format: r.deliveryPreference,
          rightsCleared: false,
          status: 'pending',
        },
        { transaction: t },
      );
  }
}

/**
 * Adds a message to a request. Staff may write internal notes or messages shared with the requester, who is
 * notified of shared messages. Requesters can only write shared messages, and the assigned staff member is
 * notified.
 *
 * @param {string} id Identifier of the request.
 * @param {{ body: string, visibility?: 'shared'|'internal' }} input The message.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The comment.
 */
export async function addComment(id, { body, visibility }, user) {
  const r = await loadVisible(id, user);
  const staff = hasPerm(user, 'research.manage');
  const c = await models.Comment.create({
    entityType: 'ResearchRequest',
    entityId: r.id,
    authorId: user.id,
    body,
    visibility: staff ? visibility : 'shared',
  });
  if (staff && visibility === 'shared') await notifyRequester(r, `New message about ${r.requestNumber}`, body);
  if (!staff)
    await notifyUsers([r.assignedToId].filter(Boolean), {
      eventType: 'research.clarification',
      title: `Researcher replied: ${r.requestNumber}`,
      body: '',
      link: `/admin/research-requests/${r.id}`,
    });
  return c;
}

/**
 * Updates a reproduction (copy) order. A copy can be marked delivered only after rights clearance has been recorded
 * and the delivered file attached. The requester then receives a 90-day download grant for that file.
 *
 * @param {string} id Identifier of the reproduction order.
 * @param {object} data Fields to change.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated order.
 * @throws {AppError} When delivery conditions are not met.
 */
export async function updateReproduction(id, data, user) {
  return sequelize.transaction(async (t) => {
    const rep = await models.ReproductionRequest.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!rep) throw notFound('Reproduction request');
    if (data.status === 'delivered' && !(rep.rightsCleared || data.rightsCleared))
      throw badRequest('Record a rights clearance before delivering a copy');
    if (data.status === 'delivered' && !(data.deliveredAssetId || rep.deliveredAssetId))
      throw badRequest('Attach the delivered file');
    const before = rep.get({ plain: true });
    await rep.update({ ...data, ...(data.status === 'delivered' && { deliveredAt: new Date() }) }, { transaction: t });
    if (data.status === 'delivered') {
      const req = await models.ResearchRequest.findByPk(rep.requestId, { transaction: t });
      if (req.requesterId)
        await grantAccess(
          {
            userId: req.requesterId,
            targetType: 'asset',
            targetId: rep.deliveredAssetId,
            permissionLevel: 'download',
            expiresAt: new Date(Date.now() + GRANT_DAYS * 86400_000),
            researchRequestId: req.id,
            includeDescendants: false,
          },
          user,
          t,
        );
    }
    await audit(
      {
        action: 'research.reproduction_updated',
        resourceType: 'ReproductionRequest',
        resourceId: id,
        before: { status: before.status, rightsCleared: before.rightsCleared },
        after: data,
      },
      { transaction: t },
    );
    return rep;
  });
}

/**
 * Lists the actions this user may take on a request now. The second approval is offered only to holders of
 * "research.approve" who did not make the first decision.
 *
 * @param {object} r The request.
 * @param {object} user Authenticated principal.
 * @returns {string[]} The available action names.
 */
export function actionsFor(r, user) {
  const staff = hasPerm(user, 'research.manage');
  const own = isOwner(user, r);
  return availableActions('research_request', r.status).filter((a) => {
    if (['submit', 'respond', 'cancel'].includes(a)) return own || (staff && a === 'cancel');
    if (a === 'escalate_for_approval') return false;
    if (a === 'approve' && r.status === 'awaiting_approval')
      return hasPerm(user, 'research.approve') && r.decisionById !== user.id;
    return staff;
  });
}

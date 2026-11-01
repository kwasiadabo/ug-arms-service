/**
 * Server-side workflow state machines.
 *
 * Defines, for every workflow (transfers, accessions, catalogue descriptions, digitisation batches, research
 * requests, appraisal, disposal and imports), which actions are allowed from which states and which state each
 * action leads to. The frontend may display the available actions, but only these definitions decide whether a
 * transition is valid. Every transition is saved together with a workflow history entry and an audit event in the
 * same transaction.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../database/models/index.js';
import { invalidTransition, forbidden } from '../utils/errors.js';
import { audit } from './audit.service.js';
import { getSetting } from './settings.service.js';

export const WORKFLOWS = {
  transfer: {
    entityType: 'TransferSubmission',
    transitions: {
      submit: { from: ['draft'], to: 'submitted' },
      start_review: { from: ['submitted', 'resubmitted'], to: 'under_review' },
      raise_query: { from: ['submitted', 'under_review', 'resubmitted'], to: 'query_raised' },
      resubmit: { from: ['query_raised'], to: 'resubmitted' },
      accept: { from: ['under_review'], to: 'accepted' },
      partially_accept: { from: ['under_review'], to: 'partially_accepted' },
      reject: { from: ['submitted', 'under_review', 'resubmitted'], to: 'rejected' },
      cancel: { from: ['draft', 'submitted', 'query_raised'], to: 'cancelled' },
    },
  },
  accession: {
    entityType: 'Accession',
    transitions: {
      submit: { from: ['draft', 'queried'], to: 'submitted' },
      start_review: { from: ['submitted'], to: 'under_review' },
      query: { from: ['submitted', 'under_review'], to: 'queried' },
      approve: { from: ['under_review'], to: 'approved' },
      reject: { from: ['submitted', 'under_review'], to: 'rejected' },
      close: { from: ['approved', 'rejected'], to: 'closed' },
    },
  },
  description: {
    entityType: 'ArchivalRecord',
    transitions: {
      submit_for_review: { from: ['draft'], to: 'in_review' },
      return_to_draft: { from: ['in_review', 'approved'], to: 'draft' },
      approve: { from: ['in_review'], to: 'approved' },
      publish: { from: ['approved'], to: 'published' },
      withdraw: { from: ['published', 'approved'], to: 'withdrawn' },
      reinstate: { from: ['withdrawn'], to: 'draft' },
      supersede: { from: ['published', 'approved', 'withdrawn'], to: 'superseded' },
    },
  },
  digitisation_batch: {
    entityType: 'DigitisationBatch',
    transitions: {
      start: { from: ['planned', 'rework_required'], to: 'in_progress' },
      submit_capture: { from: ['in_progress'], to: 'processing' },
      processing_complete: { from: ['processing'], to: 'quality_review' },
      request_rework: { from: ['quality_review'], to: 'rework_required' },
      approve: { from: ['quality_review'], to: 'approved' },
      complete: { from: ['approved'], to: 'completed' },
      fail: { from: ['in_progress', 'processing', 'quality_review'], to: 'failed' },
    },
  },
  research_request: {
    entityType: 'ResearchRequest',
    transitions: {
      submit: { from: ['draft'], to: 'submitted' },
      start_review: { from: ['submitted'], to: 'under_review' },
      request_clarification: { from: ['submitted', 'under_review', 'awaiting_approval'], to: 'awaiting_researcher' },
      respond: { from: ['awaiting_researcher'], to: 'under_review' },
      escalate_for_approval: { from: ['under_review'], to: 'awaiting_approval' },
      approve: { from: ['under_review', 'awaiting_approval'], to: 'approved' },
      reject: { from: ['submitted', 'under_review', 'awaiting_approval'], to: 'rejected' },
      schedule: { from: ['approved'], to: 'scheduled' },
      start_fulfilment: { from: ['approved', 'scheduled'], to: 'in_progress' },
      fulfil: { from: ['approved', 'scheduled', 'in_progress'], to: 'fulfilled' },
      close: { from: ['fulfilled', 'rejected'], to: 'closed' },
      cancel: {
        from: [
          'draft',
          'submitted',
          'under_review',
          'awaiting_researcher',
          'awaiting_approval',
          'approved',
          'scheduled',
        ],
        to: 'cancelled',
      },
    },
  },
  appraisal: {
    entityType: 'AppraisalCase',
    transitions: {
      start_review: { from: ['open'], to: 'under_review' },
      place_on_hold: { from: ['open', 'under_review', 'recommended', 'awaiting_approval'], to: 'on_hold' },
      release_hold: { from: ['on_hold'], to: 'under_review' },
      recommend: { from: ['under_review'], to: 'recommended' },
      request_approval: { from: ['recommended'], to: 'awaiting_approval' },
      approve: { from: ['awaiting_approval'], to: 'approved' },
      reject: { from: ['recommended', 'awaiting_approval'], to: 'rejected' },
      mark_executed: { from: ['approved'], to: 'executed' },
      close: { from: ['approved', 'rejected', 'executed'], to: 'closed' },
    },
  },
  disposal: {
    entityType: 'DisposalCase',
    transitions: {
      request_approval: { from: ['draft'], to: 'pending_approval' },
      approve: { from: ['pending_approval'], to: 'approved' },
      block: { from: ['draft', 'pending_approval', 'approved'], to: 'blocked' },
      execute: { from: ['approved'], to: 'executed' },
      cancel: { from: ['draft', 'pending_approval', 'approved', 'blocked'], to: 'cancelled' },
    },
  },
  import: {
    entityType: 'ImportJob',
    transitions: {
      validate: { from: ['uploaded', 'ready', 'completed_with_errors', 'failed'], to: 'validating' },
      validated: { from: ['validating'], to: 'ready' },
      run: { from: ['ready', 'completed_with_errors'], to: 'running' },
      complete: { from: ['running'], to: 'completed' },
      complete_with_errors: { from: ['running'], to: 'completed_with_errors' },
      fail: { from: ['validating', 'running'], to: 'failed' },
      cancel: { from: ['uploaded', 'ready', 'completed_with_errors', 'failed'], to: 'cancelled' },
    },
  },
};

/**
 * Lists the actions that are allowed from a given state, so the interface can offer only valid buttons.
 *
 * @param {string} workflowKey Workflow name, for example "accession".
 * @param {string} state Current state.
 * @returns {string[]} The allowed action names.
 */
export function availableActions(workflowKey, state) {
  const wf = WORKFLOWS[workflowKey];
  return Object.entries(wf.transitions)
    .filter(([, t]) => t.from.includes(state))
    .map(([a]) => a);
}

/**
 * Checks that an action is allowed from the current state and returns the state it leads to.
 *
 * @param {string} workflowKey Workflow name.
 * @param {string} state Current state.
 * @param {string} action Requested action.
 * @returns {string} The target state.
 * @throws {AppError} 409 INVALID_TRANSITION when the action is not allowed from this state.
 */
export function assertTransition(workflowKey, state, action) {
  const t = WORKFLOWS[workflowKey]?.transitions[action];
  if (!t || !t.from.includes(state)) throw invalidTransition(state, action);
  return t.to;
}

/**
 * Enforces separation of duties: the person acting must not be one of the people who created or submitted the item.
 *
 * The rule can be switched off with the "workflow.separationOfDuties" setting; it is on by default.
 *
 * @param {string} actorId Identifier of the user performing the action.
 * @param {Array<string|null|undefined>} conflictingUserIds Users who may not perform it, such as the creator and
 *   the submitter.
 * @param {string} [message] Explanation shown when the action is refused.
 * @returns {Promise<void>}
 * @throws {AppError} 403 when the actor is one of the conflicting users.
 */
export async function assertSeparationOfDuties(actorId, conflictingUserIds, message) {
  if (!(await getSetting('workflow.separationOfDuties'))) return;
  if (conflictingUserIds.filter(Boolean).includes(actorId)) {
    throw forbidden(message || 'Separation of duties: you cannot approve an item you created or submitted');
  }
}

/**
 * Validates and applies a workflow transition.
 *
 * The new state is set, the optional `apply` callback can set related fields (for example who approved and when),
 * and the instance is saved. A workflow history entry and an audit event are written in the same transaction, so a
 * state change is never recorded without its history or vice versa.
 *
 * @param {string} workflowKey Workflow name.
 * @param {import('sequelize').Model} instance The item whose state changes; must have a `status` field.
 * @param {string} action Requested action.
 * @param {{ actor?: object, reason?: string, transaction?: import('sequelize').Transaction, metadata?: object,
 *   apply?: (instance: object) => (void|Promise<void>) }} [options]
 * @returns {Promise<import('sequelize').Model>} The saved instance.
 * @throws {AppError} 409 when the transition is not allowed.
 */
export async function transition(workflowKey, instance, action, { actor, reason, transaction, metadata, apply } = {}) {
  const wf = WORKFLOWS[workflowKey];
  const from = instance.status;
  const to = assertTransition(workflowKey, from, action);
  instance.status = to;
  if (apply) await apply(instance);
  await instance.save({ transaction });
  await models.WorkflowHistory.create(
    {
      entityType: wf.entityType,
      entityId: instance.id,
      action,
      fromState: from,
      toState: to,
      actorId: actor?.id ?? null,
      reason: reason ?? null,
      metadata: metadata ?? null,
    },
    { transaction },
  );
  await audit(
    {
      action: `${workflowKey}.${action}`,
      resourceType: wf.entityType,
      resourceId: instance.id,
      before: { status: from },
      after: { status: to },
      reason,
      metadata,
      actor,
    },
    { transaction },
  );
  return instance;
}

/**
 * Loads the workflow history of an item in chronological order, with the name and email of the person who performed
 * each step.
 *
 * @param {string} entityType Model name, for example "Accession".
 * @param {string} entityId Identifier of the item.
 * @returns {Promise<object[]>}
 */
export async function history(entityType, entityId) {
  return models.WorkflowHistory.findAll({
    where: { entityType, entityId },
    include: [{ model: models.User, as: 'actor', attributes: ['id', 'fullName', 'email'] }],
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Records one approval decision for an item, used by multi-stage and two-person approval rules.
 *
 * @param {string} entityType Model name of the item being approved.
 * @param {string} entityId Identifier of the item.
 * @param {string} stage Name of the approval stage, for example "second_approval".
 * @param {{ id: string }} approver User making the decision.
 * @param {string} decision The decision, for example "approved" or "rejected".
 * @param {string} [reason] Explanation given by the approver.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object>} The stored approval.
 */
export async function recordApproval(entityType, entityId, stage, approver, decision, reason, transaction) {
  return models.Approval.create(
    { entityType, entityId, stage, approverId: approver.id, decision, reason },
    { transaction },
  );
}

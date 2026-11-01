/**
 * Work queues ("Needs your attention") and escalation of work that has waited too long.
 *
 * Queues are derived directly from workflow states, for example descriptions in review or transfers submitted, so
 * they can never drift from the real situation. Each queue is shown only to users holding the permission needed to
 * act on it.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { hasPerm } from '../../services/accessPolicy.service.js';
import { getSetting } from '../../services/settings.service.js';
import { notifyPermissionHolders } from '../../services/notification.service.js';

export const QUEUES = [
  {
    key: 'records_review',
    label: 'Descriptions awaiting review',
    perm: 'records.approve',
    model: 'ArchivalRecord',
    where: { status: 'in_review' },
    link: '/admin/records?status=in_review',
    since: 'submittedForReviewAt',
  },
  {
    key: 'records_publish',
    label: 'Approved descriptions to publish',
    perm: 'records.publish',
    model: 'ArchivalRecord',
    where: { status: 'approved' },
    link: '/admin/records?status=approved',
    since: 'approvedAt',
  },
  {
    key: 'transfers',
    label: 'Transfers to review',
    perm: 'transfer.review',
    model: 'TransferSubmission',
    where: { status: ['submitted', 'resubmitted', 'under_review'] },
    link: '/admin/transfers?status=submitted',
    since: 'submittedAt',
  },
  {
    key: 'accessions',
    label: 'Accessions awaiting decision',
    perm: 'accession.approve',
    model: 'Accession',
    where: { status: ['submitted', 'under_review'] },
    link: '/admin/accessions?status=submitted',
    since: 'submittedAt',
  },
  {
    key: 'research',
    label: 'Research requests to action',
    perm: 'research.manage',
    model: 'ResearchRequest',
    where: { status: ['submitted', 'under_review'] },
    link: '/admin/research-requests',
    since: 'submittedAt',
  },
  {
    key: 'research_second',
    label: 'Requests needing second approval',
    perm: 'research.approve',
    model: 'ResearchRequest',
    where: { status: 'awaiting_approval' },
    link: '/admin/research-requests?status=awaiting_approval',
    since: 'decisionAt',
  },
  {
    key: 'access_changes',
    label: 'Access changes awaiting approval',
    perm: 'permissions.approve',
    model: 'AccessChangeRequest',
    where: { status: 'pending' },
    link: '/admin/access-requests',
    since: 'createdAt',
  },
  {
    key: 'qa',
    label: 'Digitisation batches in QA',
    perm: 'digitisation.qa',
    model: 'DigitisationBatch',
    where: { status: 'quality_review' },
    link: '/admin/digitisation?status=quality_review',
    since: 'updatedAt',
  },
  {
    key: 'ocr',
    label: 'OCR output awaiting review',
    perm: 'ocr.review',
    model: 'DigitalAsset',
    where: { ocrStatus: 'succeeded' },
    link: '/admin/ocr',
    since: 'updatedAt',
  },
  {
    key: 'preservation',
    label: 'Open preservation alerts',
    perm: 'preservation.manage',
    model: 'PreservationAlert',
    where: { status: ['open', 'investigating'] },
    link: '/admin/preservation',
    since: 'createdAt',
  },
  {
    key: 'appraisal',
    label: 'Appraisals awaiting decision',
    perm: 'appraisal.approve',
    model: 'AppraisalCase',
    where: { status: 'awaiting_approval' },
    link: '/admin/appraisal',
    since: 'updatedAt',
  },
  {
    key: 'disposal',
    label: 'Disposals awaiting approval',
    perm: 'disposal.approve',
    model: 'DisposalCase',
    where: { status: 'pending_approval' },
    link: '/admin/disposal',
    since: 'updatedAt',
  },
  {
    key: 'overdue',
    label: 'Overdue reading-room items',
    perm: 'circulation.return',
    model: 'CirculationTransaction',
    where: { status: 'overdue' },
    link: '/admin/circulation?status=overdue',
    since: 'expectedReturnAt',
  },
  {
    key: 'embargo',
    label: 'Embargoes due for review',
    perm: 'records.restrict',
    model: 'AccessRestriction',
    where: { status: 'expired_pending_review' },
    link: '/admin/access-requests?tab=review',
    since: 'expiresAt',
  },
];

/**
 * Counts the items waiting in each queue the user can act on. Departmental liaisons also see the queries raised on
 * their own unit's transfers.
 *
 * @param {object} user Authenticated principal.
 * @returns {Promise<Array<{ key: string, label: string, count: number, link: string }>>}
 */
export async function pendingWork(user) {
  const out = [];
  for (const queue of QUEUES) {
    if (!hasPerm(user, queue.perm)) continue;
    const count = await models[queue.model].count({ where: queue.where });
    out.push({ key: queue.key, label: queue.label, count, link: queue.link });
  }
  // Departmental liaisons: their submissions needing a response.
  if (hasPerm(user, 'transfer.submit') && user.organisationUnitId) {
    out.push({
      key: 'my_queries',
      label: 'Transfer queries to answer',
      count: await models.TransferSubmission.count({
        where: { originatingUnitId: user.organisationUnitId, status: 'query_raised' },
      }),
      link: '/admin/transfers?status=query_raised',
    });
  }
  return out;
}

/**
 * Scheduled job: escalates items that have waited longer than the configured number of hours.
 *
 * A task is opened once per waiting item and assigned to the Chief Archivist role. An item still waiting at the
 * next run has its escalation level raised. Tasks whose items have left the queue are completed. Approvers are
 * notified when new items are escalated.
 *
 * @returns {Promise<{ escalated: number }>} Number of items newly escalated.
 */
export async function escalate() {
  const hours = await getSetting('workflow.taskEscalationHours');
  const cutoff = new Date(Date.now() - hours * 3600_000);
  let escalated = 0;
  for (const queue of QUEUES) {
    const stale = await models[queue.model].findAll({
      where: { ...queue.where, [queue.since]: { [Op.lt]: cutoff } },
      attributes: ['id'],
      limit: 200,
    });
    for (const item of stale) {
      const [task, created] = await models.WorkflowTask.findOrCreate({
        where: { entityType: queue.model, entityId: item.id, taskType: `escalation:${queue.key}`, status: 'open' },
        defaults: {
          entityType: queue.model,
          entityId: item.id,
          taskType: `escalation:${queue.key}`,
          title: queue.label,
          assigneeRole: 'chief_archivist',
          escalatedAt: new Date(),
          escalationLevel: 1,
        },
      });
      if (created) escalated += 1;
      else if (task.escalatedAt < cutoff)
        await task.update({ escalationLevel: task.escalationLevel + 1, escalatedAt: new Date() });
    }
    // Close escalation tasks whose items have left the queue.
    const open = await models.WorkflowTask.findAll({ where: { taskType: `escalation:${queue.key}`, status: 'open' } });
    const stillQueued = new Set(
      (
        await models[queue.model].findAll({
          where: { ...queue.where, id: open.map((o) => o.entityId) },
          attributes: ['id'],
        })
      ).map((x) => x.id),
    );
    for (const t of open)
      if (!stillQueued.has(t.entityId)) await t.update({ status: 'completed', completedAt: new Date() });
  }
  if (escalated)
    await notifyPermissionHolders(['records.approve'], {
      eventType: 'task.escalated',
      title: `${escalated} item(s) escalated`,
      body: `Items have waited more than ${hours} hours for action.`,
      link: '/admin',
    });
  return { escalated };
}

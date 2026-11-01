/**
 * In-app notifications and notification emails.
 *
 * Each user's delivery preferences are respected per event type. Emails are queued, not sent within the request, so
 * a slow mail server never delays the user. Notification text must never contain restricted content: messages name
 * the item and link to it, and the access rules apply when the link is opened.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models } from '../database/models/index.js';
import { enqueue } from './queue.service.js';
import { env } from '../config/env.js';

export const EVENT_TYPES = [
  'transfer.submitted',
  'transfer.decision',
  'transfer.query',
  'accession.submitted',
  'accession.decision',
  'record.review_requested',
  'record.review_decision',
  'digitisation.assigned',
  'ocr.completed',
  'qa.failed',
  'preservation.alert',
  'research.submitted',
  'research.decision',
  'research.clarification',
  'appointment.confirmed',
  'appointment.reminder',
  'circulation.overdue',
  'embargo.review',
  'retention.review',
  'disposal.approval',
  'integration.failed',
  'system.error',
  'task.assigned',
  'task.escalated',
  'import.completed',
  'export.ready',
];

/**
 * Reads how a user wants to be told about one type of event. Without a stored preference, both in-app and email
 * notifications are enabled.
 *
 * @param {string} userId Identifier of the user.
 * @param {string} eventType Event type, for example "transfer.submitted".
 * @returns {Promise<{ inApp: boolean, email: boolean }>}
 */
async function deliveryPreference(userId, eventType) {
  const pref = await models.NotificationPreference.findOne({ where: { userId, eventType } });
  return { inApp: pref ? pref.inApp : true, email: pref ? pref.email : true };
}

/**
 * Notifies the given users about an event.
 *
 * Only active accounts are notified, each user at most once. An in-app notification is created and an email is
 * queued for each user according to their preferences. Pass the caller's transaction so the notifications are
 * created only if the change they describe is committed; queued emails are dispatched after the commit.
 *
 * @param {Array<string|null|undefined>} userIds Users to notify; empty values and duplicates are ignored.
 * @param {{ eventType: string, title: string, body?: string, link?: string, entityType?: string, entityId?: string,
 *   email?: boolean }} payload The notification; `link` is a path within the application.
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<void>}
 */
export async function notifyUsers(
  userIds,
  { eventType, title, body, link, entityType, entityId, email = true },
  { transaction } = {},
) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const users = await models.User.findAll({
    where: { id: unique, status: 'active' },
    attributes: ['id', 'email', 'fullName'],
    transaction,
  });
  for (const u of users) {
    const pref = await deliveryPreference(u.id, eventType);
    const sendEmail = email && pref.email;
    if (pref.inApp) {
      await models.Notification.create(
        {
          userId: u.id,
          eventType,
          title,
          body,
          link,
          entityType,
          entityId: entityId ? String(entityId) : null,
          emailStatus: sendEmail ? 'pending' : 'not_required',
        },
        { transaction },
      );
    }
    if (sendEmail) {
      await enqueue(
        'notifications',
        'email.send',
        {
          to: u.email,
          subject: title,
          body,
          actionUrl: link ? `${env.PUBLIC_APP_URL}${link}` : undefined,
          actionLabel: 'Open in UG-ARMS',
        },
        { transaction },
      );
    }
  }
}

/**
 * Notifies every active user who holds at least one of the given permissions, for example everyone who can review
 * transfers.
 *
 * @param {string[]} permissionCodes Permission codes.
 * @param {object} payload The notification, as for `notifyUsers`.
 * @param {{ transaction?: import('sequelize').Transaction }} [opts]
 * @returns {Promise<void>}
 */
export async function notifyPermissionHolders(permissionCodes, payload, opts) {
  const users = await models.User.findAll({
    where: { status: 'active' },
    attributes: ['id'],
    include: [
      {
        model: models.Role,
        as: 'roles',
        attributes: [],
        required: true,
        through: { attributes: [] },
        include: [
          {
            model: models.Permission,
            as: 'permissions',
            attributes: [],
            required: true,
            where: { code: { [Op.in]: permissionCodes } },
            through: { attributes: [] },
          },
        ],
      },
    ],
    transaction: opts?.transaction,
  });
  return notifyUsers(
    users.map((u) => u.id),
    payload,
    opts,
  );
}

/**
 * Queues an email to an address that may not belong to an account, such as a visitor who sent an enquiry or a new
 * researcher activating their account.
 *
 * @param {string} to Recipient email address.
 * @param {{ subject: string, body: string, actionUrl?: string, actionLabel?: string }} message Content of the
 *   email.
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<string>} Identifier of the background job.
 */
export async function notifyEmailOnly(to, { subject, body, actionUrl, actionLabel }, { transaction } = {}) {
  return enqueue('notifications', 'email.send', { to, subject, body, actionUrl, actionLabel }, { transaction });
}

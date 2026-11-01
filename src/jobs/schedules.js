/**
 * Repeatable maintenance jobs and when they run (cron expressions, in UTC).
 *
 * Each schedule is registered with BullMQ by a stable identifier, so restarting the worker updates the schedule
 * instead of creating duplicates. Every scheduled handler is idempotent, so overlapping runs are safe.
 *
 * @author Kwasi Adabo Boakye
 */

import { getQueue } from '../services/queue.service.js';

export const SCHEDULES = [
  { id: 'fixity-sweep', queue: 'maintenance', jobType: 'preservation.fixity_sweep', cron: '15 1 * * *' },
  { id: 'object-lock-sweep', queue: 'maintenance', jobType: 'preservation.object_lock_sweep', cron: '45 1 * * *' },
  { id: 'embargo-review', queue: 'maintenance', jobType: 'access.embargo_review', cron: '0 6 * * *' },
  { id: 'overdue-sweep', queue: 'maintenance', jobType: 'circulation.overdue_sweep', cron: '*/15 * * * *' },
  { id: 'workflow-escalation', queue: 'maintenance', jobType: 'workflow.escalate', cron: '30 7 * * *' },
  { id: 'privacy-retention', queue: 'maintenance', jobType: 'privacy.retention', cron: '0 2 * * 0' },
  { id: 'disk-check', queue: 'maintenance', jobType: 'operations.disk_check', cron: '*/30 * * * *' },
  { id: 'appointment-reminders', queue: 'notifications', jobType: 'appointments.reminders', cron: '0 * * * *' },
];

/**
 * Creates or updates the BullMQ job scheduler for every entry in `SCHEDULES`.
 *
 * @returns {Promise<void>}
 */
export async function registerSchedules() {
  for (const s of SCHEDULES) {
    await getQueue(s.queue).upsertJobScheduler(s.id, { pattern: s.cron, tz: 'UTC' }, { name: s.jobType, data: {} });
  }
}

/**
 * Background job handlers, keyed by job type.
 *
 * The same handlers are used by the BullMQ worker and by the inline mode used when queues are disabled (for example
 * in tests). They cover email delivery, asset ingest, OCR, fixity checking and replication, search indexing, report
 * generation, imports, and the scheduled sweeps for fixity, Object Lock retention, expired embargoes, overdue loans,
 * appointment reminders, workflow escalation, privacy retention and disk capacity. Every handler is idempotent, so a
 * retried or overlapping job does no harm.
 *
 * @author Kwasi Adabo Boakye
 */

import { registerInlineHandler, enqueue } from '../services/queue.service.js';
import { sendMail } from '../services/mail.service.js';
import { processAsset } from '../modules/digital-assets/assets.service.js';
import { executeOcrJob } from '../modules/digitisation/ocr.service.js';
import { runFixityCheck, dueForFixity, replicate } from '../services/preservation.service.js';
import { reconcileObjectLocks } from '../services/objectLock.service.js';
import { reviewExpiredRestrictions } from '../modules/permissions/permissions.service.js';
import { searchHandlers } from '../modules/search/search.indexer.js';
import { flagOverdue, sendReminders } from '../modules/circulation/circulation.service.js';
import { escalate } from '../modules/dashboard/tasks.service.js';
import { generateQueued } from '../modules/reports/reports.service.js';
import { runJob } from '../modules/imports/imports.service.js';
import { applyPrivacyRetention } from '../modules/privacy/privacy.service.js';
import { checkDiskCapacity } from '../services/disk.service.js';

export const handlers = {
  ...searchHandlers,
  'email.send': async ({ to, subject, body, actionUrl, actionLabel }) => {
    await sendMail({ to, subject, body, actionUrl, actionLabel });
    return { sent: true };
  },
  'asset.process': ({ assetId }) => processAsset(assetId),
  'ocr.run': ({ ocrJobId }) => executeOcrJob(ocrJobId),
  'preservation.fixity': ({ assetId, triggeredBy }) => runFixityCheck(assetId, triggeredBy),
  'preservation.replicate': ({ assetId }) => replicate(assetId),
  // Scheduled sweeps
  'preservation.fixity_sweep': async () => {
    const due = await dueForFixity(500);
    for (const a of due)
      await enqueue(
        'fixity',
        'preservation.fixity',
        { assetId: a.id, triggeredBy: 'schedule' },
        { entityType: 'DigitalAsset', entityId: a.id },
      );
    return { queued: due.length };
  },
  // Also queued straight after a legal hold is placed or released.
  'preservation.object_lock_sweep': () => reconcileObjectLocks(),
  'access.embargo_review': () => reviewExpiredRestrictions(),
  'circulation.overdue_sweep': () => flagOverdue(),
  'appointments.reminders': () => sendReminders(),
  'workflow.escalate': () => escalate(),
  'report.generate': ({ exportJobId }) => generateQueued(exportJobId),
  'import.run': ({ importJobId }) => runJob(importJobId),
  'privacy.retention': () => applyPrivacyRetention(),
  'operations.disk_check': () => checkDiskCapacity(),
};

/**
 * Registers every job handler for inline execution, so jobs still run when Redis queues are disabled.
 *
 * Called once at start-up by the API server and the worker.
 */
export function registerHandlers() {
  for (const [type, fn] of Object.entries(handlers)) registerInlineHandler(type, fn);
}

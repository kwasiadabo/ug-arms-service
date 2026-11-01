/**
 * Digital preservation: preservation events, fixity checking, replication and recovery.
 *
 * Events are recorded in a PREMIS-inspired form (what happened, to which file, when, by which agent, with what
 * outcome). The SHA-256 checksum recorded when a file was ingested is never changed: a failed check raises an alert
 * and the file stays flagged until it is recovered from a copy whose checksum matches the recorded value.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { models, sequelize } from '../database/models/index.js';
import { storage, buildKey } from './storage/index.js';
import { getSetting } from './settings.service.js';
import { protectAsset } from './objectLock.service.js';
import { notifyPermissionHolders } from './notification.service.js';
import { audit } from './audit.service.js';
import { getContext } from '../utils/context.js';
import { badRequest, notFound } from '../utils/errors.js';

/**
 * Records a preservation event for a digital asset. The agent is the signed-in user when there is one, otherwise
 * the system worker.
 *
 * @param {{ assetId: string, recordId?: string, eventType: string, outcome?: string, detail?: string,
 *   technicalDetail?: object, agentName?: string }} event What happened; `detail` is shortened to 2,000 characters.
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<object>} The stored event.
 */
export async function recordEvent(
  { assetId, recordId, eventType, outcome = 'success', detail, technicalDetail, agentName },
  { transaction } = {},
) {
  const user = getContext().user;
  return models.PreservationEvent.create(
    {
      assetId,
      recordId,
      eventType,
      eventAt: new Date(),
      outcome,
      detail: detail?.slice(0, 2000),
      technicalDetail,
      agentType: user ? 'user' : 'system',
      agentUserId: user?.id ?? null,
      agentName: agentName ?? (user ? user.email : 'ug-arms-worker'),
    },
    { transaction },
  );
}

/**
 * Calculates the SHA-256 checksum and size of a stored object by streaming it, without loading it fully into
 * memory.
 *
 * @param {string} key Storage key.
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function hashObject(key) {
  const { body } = await storage.get(key);
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    h.update(chunk);
    size += chunk.length;
  }
  return { sha256: h.digest('hex'), size };
}

/**
 * Calculates when the next fixity check of a file is due, using the configured interval in days.
 *
 * @returns {Promise<Date>}
 */
async function nextFixityDate() {
  const days = await getSetting('preservation.fixityIntervalDays');
  return new Date(Date.now() + days * 86400_000);
}

/**
 * Creates a preservation alert and notifies everyone who manages preservation.
 *
 * The notification names the asset identifier and the problem only, never the file's content or restricted
 * metadata.
 *
 * @param {{ asset: object, check?: object, alertType: string, severity: string, message: string }} details The
 *   affected asset, the fixity check that found the problem (if any), the kind of problem, its severity and a
 *   description.
 * @returns {Promise<object>} The created alert.
 */
async function raiseAlert({ asset, check, alertType, severity, message }) {
  const alert = await models.PreservationAlert.create({
    assetId: asset.id,
    fixityCheckId: check?.id,
    alertType,
    severity,
    message,
  });
  // The alert deliberately names the asset id only – never its contents or restricted metadata.
  await notifyPermissionHolders(['preservation.manage'], {
    eventType: 'preservation.alert',
    title: `Preservation alert: ${alertType.replace(/_/g, ' ')}`,
    body: `Asset ${asset.id}: ${message}`,
    link: `/admin/preservation/alerts/${alert.id}`,
    entityType: 'PreservationAlert',
    entityId: alert.id,
  });
  return alert;
}

/**
 * Verifies a stored file against the SHA-256 recorded at ingest.
 *
 * The check is recorded with its result and duration, and a preservation event is written. On success the next
 * check is scheduled and a pending or recovered file is marked as OK. If the file is missing or its checksum
 * differs, the asset is flagged and an alert is raised (critical for preservation masters). The expected value is
 * never altered.
 *
 * @param {string} assetId Identifier of the digital asset.
 * @param {string} [triggeredBy='schedule'] What started the check, for example "schedule", "manual" or "recovery".
 * @returns {Promise<{ status: 'passed'|'failed', checkId: string }|{ skipped: true }>} The result, or `skipped`
 *   when the asset has no stored file or has been deleted.
 */
export async function runFixityCheck(assetId, triggeredBy = 'schedule') {
  const asset = await models.DigitalAsset.findByPk(assetId);
  if (!asset || asset.status === 'deleted' || !asset.storageKey) return { skipped: true };
  const check = await models.FixityCheck.create({
    assetId,
    expectedSha256: asset.sha256,
    status: 'running',
    triggeredBy,
  });
  const started = Date.now();
  let status;
  let actual = null;
  let error = null;
  try {
    const head = await storage.head(asset.storageKey);
    if (!head.exists) {
      status = 'failed';
      error = 'Stored object is missing';
    } else {
      ({ sha256: actual } = await hashObject(asset.storageKey));
      status = actual === asset.sha256 ? 'passed' : 'failed';
      if (status === 'failed') error = 'Checksum mismatch';
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
  }
  await check.update({ status, actualSha256: actual, checkedAt: new Date(), durationMs: Date.now() - started, error });
  await recordEvent({
    assetId,
    recordId: asset.recordId,
    eventType: 'fixity_check',
    outcome: status === 'passed' ? 'success' : 'failure',
    detail: error || 'SHA-256 matches recorded value',
    technicalDetail: { expected: asset.sha256, actual, algorithm: 'SHA-256', checkId: check.id },
    agentName: 'fixity-worker',
  });
  if (status === 'passed') {
    await asset.update(
      {
        lastFixityAt: new Date(),
        nextFixityAt: await nextFixityDate(),
        preservationStatus: ['pending', 'recovered'].includes(asset.preservationStatus)
          ? 'ok'
          : asset.preservationStatus,
      },
      { hooks: false },
    );
  } else {
    const missing = error === 'Stored object is missing';
    await asset.update({ lastFixityAt: new Date(), preservationStatus: missing ? 'missing' : 'fixity_failed' });
    await raiseAlert({
      asset,
      check,
      alertType: missing ? 'missing_file' : 'fixity_failure',
      severity: asset.role === 'preservation_master' ? 'critical' : 'high',
      message: error,
    });
  }
  return { status, checkId: check.id };
}

/**
 * Selects the files whose next fixity check is due, oldest first. Safe to run repeatedly.
 *
 * @param {number} [limit=500] Maximum number of files to return.
 * @returns {Promise<Array<{ id: string }>>}
 */
export async function dueForFixity(limit = 500) {
  return models.DigitalAsset.findAll({
    where: {
      status: { [Op.in]: ['available', 'processing', 'quarantined'] },
      storageKey: { [Op.ne]: null },
      [Op.or]: [{ nextFixityAt: null }, { nextFixityAt: { [Op.lte]: new Date() } }],
    },
    attributes: ['id'],
    order: [['nextFixityAt', 'ASC']],
    limit,
  });
}

/**
 * Copies a file to a replica area and verifies the copy against the recorded checksum.
 *
 * The replica is recorded as verified or failed, and a preservation event is written. A verified replica is placed
 * under the same retention as the original; a failed copy raises an alert, and an error is also rethrown so the job
 * can be retried.
 *
 * @param {string} assetId Identifier of the digital asset.
 * @param {string} [target='replica-1'] Name of the replica area.
 * @returns {Promise<{ status: string }|{ skipped: true }>}
 */
export async function replicate(assetId, target = 'replica-1') {
  const asset = await models.DigitalAsset.findByPk(assetId);
  if (!asset?.storageKey) return { skipped: true };
  const key = `replicas/${target}/${asset.storageKey}`;
  const replica =
    (await models.StorageReplica.findOne({ where: { assetId, target } })) ||
    (await models.StorageReplica.create({ assetId, target, storageKey: key }));
  try {
    const head = await storage.head(key);
    if (!head.exists) await storage.copy(asset.storageKey, key);
    const { sha256 } = await hashObject(key);
    const ok = sha256 === asset.sha256;
    await replica.update({
      status: ok ? 'verified' : 'failed',
      sha256,
      verifiedAt: new Date(),
      error: ok ? null : 'Replica checksum mismatch',
    });
    await recordEvent({
      assetId,
      recordId: asset.recordId,
      eventType: 'replication',
      outcome: ok ? 'success' : 'failure',
      detail: `Replica ${target}`,
      technicalDetail: { target, sha256 },
    });
    if (!ok)
      await raiseAlert({
        asset,
        alertType: 'replication_failure',
        severity: 'high',
        message: `Replica ${target} checksum mismatch`,
      });
    else await protectAsset(assetId);
    return { status: replica.status };
  } catch (err) {
    await replica.update({ status: 'failed', error: err.message });
    await raiseAlert({
      asset,
      alertType: 'replication_failure',
      severity: 'medium',
      message: `Replication to ${target} failed: ${err.message}`,
    });
    throw err;
  }
}

/**
 * Restores a damaged or missing file from a verified source, in response to a preservation alert.
 *
 * The source is either a replica or an uploaded replacement, and its checksum must equal the value recorded at
 * ingest. The recorded value is never changed to make a check pass. The source is copied to a new key and verified
 * again; the asset is then pointed at the restored copy, the alert is closed, and an event and an audit record are
 * written in one transaction. The restored copy is placed under retention, and recovery always ends with a fresh
 * fixity check.
 *
 * @param {string} alertId Identifier of the open preservation alert.
 * @param {{ replicaId?: string, uploadedKey?: string, uploadedSha256?: string, note?: string }} source Where to
 *   recover from, and a note for the record.
 * @param {{ id: string }} user Person performing the recovery.
 * @returns {Promise<{ recovered: true, verification: object }>}
 * @throws {AppError} When the alert is not open, no source is given, or the source does not match the recorded
 *   checksum.
 */
export async function recoverAsset(alertId, { replicaId, uploadedKey, uploadedSha256, note }, user) {
  const alert = await models.PreservationAlert.findByPk(alertId, {
    include: [{ model: models.DigitalAsset, as: 'asset' }],
  });
  if (!alert?.asset) throw notFound('Alert');
  if (!['open', 'investigating'].includes(alert.status)) throw badRequest('This alert is not open');
  const asset = alert.asset;
  let sourceKey;
  let sourceLabel;
  if (replicaId) {
    const replica = await models.StorageReplica.findOne({ where: { id: replicaId, assetId: asset.id } });
    if (!replica) throw notFound('Replica');
    const { sha256 } = await hashObject(replica.storageKey);
    if (sha256 !== asset.sha256)
      throw badRequest('The replica does not match the recorded checksum and cannot be used for recovery');
    sourceKey = replica.storageKey;
    sourceLabel = `replica ${replica.target}`;
  } else if (uploadedKey) {
    if (uploadedSha256 !== asset.sha256) {
      await storage.remove(uploadedKey).catch(() => {});
      throw badRequest('The uploaded file does not match the recorded checksum. Recovery must use a verified copy.');
    }
    sourceKey = uploadedKey;
    sourceLabel = 'uploaded verified copy';
  } else {
    throw badRequest('Provide a replica or a verified replacement file');
  }
  const newKey = buildKey('restored', asset.originalFilename);
  await storage.copy(sourceKey, newKey);
  const verify = await hashObject(newKey);
  if (verify.sha256 !== asset.sha256) throw badRequest('Restored copy failed verification');
  await sequelize.transaction(async (t) => {
    const oldKey = asset.storageKey;
    await asset.update({ storageKey: newKey, preservationStatus: 'recovered' }, { transaction: t });
    await alert.update(
      {
        status: 'recovered',
        recoverySource: sourceLabel,
        resolution: note,
        resolvedById: user.id,
        resolvedAt: new Date(),
      },
      { transaction: t },
    );
    await recordEvent(
      {
        assetId: asset.id,
        recordId: asset.recordId,
        eventType: 'restoration',
        detail: `Restored from ${sourceLabel}`,
        technicalDetail: { previousKeyRetained: Boolean(oldKey), sha256: verify.sha256, alertId },
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'preservation.recover',
        resourceType: 'DigitalAsset',
        resourceId: asset.id,
        reason: note,
        metadata: { alertId, source: sourceLabel },
      },
      { transaction: t },
    );
  });
  if (uploadedKey) await storage.remove(uploadedKey).catch(() => {});
  await protectAsset(asset.id);
  // A successful recovery always ends with a fresh integrity check.
  const check = await runFixityCheck(asset.id, 'recovery');
  return { recovered: true, verification: check };
}

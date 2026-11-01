/**
 * Write-once protection of preservation files with S3 Object Lock.
 *
 * Preservation masters, original uploads and migrated versions, and their replicas, are placed under governance
 * retention for a rolling period (the "preservation.objectLockYears" setting, five years by default). The nightly
 * sweep extends the retention of every live file well before it runs out, so the files stay protected for as long as
 * the archive keeps them. While retention lasts, the storage service refuses any deletion by the application's own
 * credential; only authorised disposal, using the separate disposal credential, can bypass it.
 *
 * Legal holds recorded in UG-ARMS are mirrored onto the files they cover as S3 legal holds, which block deletion by
 * every credential, including the disposal credential, until the hold is released.
 *
 * Nothing here deletes or shortens anything: the storage service refuses to shorten governance retention, and every
 * step only extends retention or switches a legal hold to match the database. Every function is safe to repeat. On
 * storage without Object Lock (the local driver, or a bucket without Object Lock) the functions do nothing.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models } from '../database/models/index.js';
import { logger } from '../config/logger.js';
import { storage } from './storage/index.js';
import { getSetting } from './settings.service.js';
import { holdsFor } from '../modules/retention/holds.service.js';

/** Asset roles whose files are placed under retention. Derivatives can be regenerated and are not locked. */
export const PROTECTED_ROLES = ['preservation_master', 'original_upload', 'migrated_version'];

/** Retention is extended once less than the full period minus this margin remains, so roughly once a month. */
const REFRESH_MARGIN_DAYS = 30;

/** Assets examined per database query by the sweep. */
const PAGE_SIZE = 500;

/** Largest IN list sent to SQL Server in one query (its limit is 2,100 parameters). */
const IN_CHUNK = 1000;

/**
 * Reads the retention period from settings, kept between 1 and 100 years whatever has been stored.
 *
 * @returns {Promise<number>} Whole years.
 */
export async function lockYears() {
  const years = Math.trunc(Number(await getSetting('preservation.objectLockYears')));
  return Number.isFinite(years) ? Math.min(Math.max(years, 1), 100) : 5;
}

/**
 * Works out the retention dates for a run: the date to retain until, and the date below which an existing
 * retention is extended.
 *
 * @param {number} years Retention period in years.
 * @param {Date} [now=new Date()] Current time.
 * @returns {{ retainUntil: Date, refreshBefore: Date }}
 */
export function retentionWindow(years, now = new Date()) {
  const retainUntil = new Date(now);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + years);
  const refreshBefore = new Date(retainUntil.getTime() - REFRESH_MARGIN_DAYS * 86_400_000);
  return { retainUntil, refreshBefore };
}

/**
 * Brings the protection of one stored file into line: extends its retention when it is missing or due for renewal,
 * and switches its legal hold on or off to match the database.
 *
 * @param {string} key Storage key.
 * @param {{ retainUntil: Date, refreshBefore: Date, hold: boolean }} wanted The retention dates and whether the
 *   file is under a legal hold.
 * @returns {Promise<{ missing?: true, extended: boolean, holdChanged: boolean }>} What was changed.
 */
async function applyToKey(key, { retainUntil, refreshBefore, hold }) {
  const current = await storage.lockStatus(key);
  if (!current.exists) return { missing: true, extended: false, holdChanged: false };
  const extended = !current.retainUntil || current.retainUntil < refreshBefore;
  if (extended) await storage.retain(key, retainUntil);
  const holdChanged = current.legalHold !== hold;
  if (holdChanged) await storage.setLegalHold(key, hold);
  return { extended, holdChanged };
}

/**
 * Lists the storage keys that hold a copy of an asset: its own file and its replicas.
 *
 * @param {object} asset The digital asset.
 * @returns {Promise<string[]>}
 */
async function keysOf(asset) {
  const replicas = await models.StorageReplica.findAll({ where: { assetId: asset.id }, attributes: ['storageKey'] });
  return [asset.storageKey, ...replicas.map((r) => r.storageKey)].filter(Boolean);
}

/**
 * Places one asset's files under retention, and under legal hold if a hold covers it. Called after ingest, after a
 * replica is made and after recovery; the nightly sweep catches anything missed.
 *
 * Failures are logged rather than thrown, so storage problems never interrupt ingest.
 *
 * @param {string} assetId Identifier of the digital asset.
 * @returns {Promise<{ protected: number }|{ skipped: string }>} How many files were brought into line, or why
 *   nothing was done.
 */
export async function protectAsset(assetId) {
  try {
    if (!(await storage.objectLockEnabled())) return { skipped: 'Object Lock is not enabled' };
    const asset = await models.DigitalAsset.findByPk(assetId, {
      attributes: ['id', 'role', 'status', 'storageKey'],
    });
    if (!asset?.storageKey || asset.status === 'deleted' || !PROTECTED_ROLES.includes(asset.role))
      return { skipped: 'Not a protected file' };
    const wanted = { ...retentionWindow(await lockYears()), hold: (await holdsFor({ assetId })).length > 0 };
    const keys = await keysOf(asset);
    for (const key of keys) await applyToKey(key, wanted);
    return { protected: keys.length };
  } catch (err) {
    logger.warn({ err: err.message, assetId }, 'Could not apply Object Lock; the nightly sweep will retry');
    return { skipped: err.message };
  }
}

/**
 * Finds every digital asset covered by an active legal hold, with the same rules as `holdsFor`: a hold on the asset
 * itself, on its record, or on an ancestor record with "include descendants".
 *
 * @returns {Promise<Set<string>>} Identifiers of the held assets.
 */
export async function heldAssetIds() {
  const items = await models.LegalHoldItem.findAll({
    attributes: ['assetId', 'recordId', 'includeDescendants'],
    include: [{ model: models.LegalHold, as: 'hold', where: { status: 'active' }, attributes: [] }],
  });
  const held = new Set(items.filter((i) => i.assetId).map((i) => i.assetId));
  const recordIds = new Set(items.filter((i) => i.recordId).map((i) => i.recordId));
  for (const item of items.filter((i) => i.recordId && i.includeDescendants)) {
    const rec = await models.ArchivalRecord.findByPk(item.recordId, { attributes: ['path'] });
    if (!rec?.path) continue;
    const below = await models.ArchivalRecord.findAll({
      where: { path: { [Op.like]: `${rec.path}%` } },
      attributes: ['id'],
    });
    for (const r of below) recordIds.add(r.id);
  }
  const ids = [...recordIds];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const assets = await models.DigitalAsset.findAll({
      where: { recordId: ids.slice(i, i + IN_CHUNK) },
      attributes: ['id'],
    });
    for (const a of assets) held.add(a.id);
  }
  return held;
}

/**
 * Nightly sweep: brings the retention and legal hold of every live protected file, and its replicas, into line
 * with the database. Also run straight after a legal hold is placed or released.
 *
 * A file that cannot be updated is logged and counted, and the sweep carries on; the counts are kept as the job
 * result on the System health page.
 *
 * @returns {Promise<{ files: number, extended: number, holdsChanged: number, missing: number, failed: number,
 *   retainUntil: string }|{ skipped: string }>}
 */
export async function reconcileObjectLocks() {
  if (!(await storage.objectLockEnabled())) return { skipped: 'Object Lock is not enabled on the storage bucket' };
  const window = retentionWindow(await lockYears());
  const held = await heldAssetIds();
  const totals = { files: 0, extended: 0, holdsChanged: 0, missing: 0, failed: 0 };
  let lastId = null;
  for (;;) {
    const assets = await models.DigitalAsset.findAll({
      where: {
        role: PROTECTED_ROLES,
        status: { [Op.ne]: 'deleted' },
        storageKey: { [Op.ne]: null },
        ...(lastId ? { id: { [Op.gt]: lastId } } : {}),
      },
      attributes: ['id', 'storageKey'],
      order: [['id', 'ASC']],
      limit: PAGE_SIZE,
    });
    if (!assets.length) break;
    lastId = assets.at(-1).id;
    const replicas = await models.StorageReplica.findAll({
      where: { assetId: assets.map((a) => a.id) },
      attributes: ['assetId', 'storageKey'],
    });
    for (const asset of assets) {
      const keys = [asset.storageKey, ...replicas.filter((r) => r.assetId === asset.id).map((r) => r.storageKey)];
      for (const key of keys) {
        totals.files += 1;
        try {
          const r = await applyToKey(key, { ...window, hold: held.has(asset.id) });
          if (r.missing) totals.missing += 1;
          if (r.extended) totals.extended += 1;
          if (r.holdChanged) totals.holdsChanged += 1;
        } catch (err) {
          totals.failed += 1;
          logger.warn({ err: err.message, assetId: asset.id }, 'Object Lock sweep could not update a file');
        }
      }
    }
  }
  return { ...totals, retainUntil: window.retainUntil.toISOString() };
}

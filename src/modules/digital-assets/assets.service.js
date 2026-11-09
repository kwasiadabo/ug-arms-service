/**
 * Digital asset lifecycle: upload, background ingest, derivatives, OCR queueing, metadata updates, publication,
 * deletion and secure delivery.
 *
 * Each upload is checked by content signature, scanned for malware, given a SHA-256 checksum and stored privately
 * before its database row exists, and every step is recorded as a preservation event. Preservation masters are
 * never published or deleted outside an approved disposal; only access copies can be published, and only after a
 * clean malware scan, passed quality assurance and publication of the description.
 *
 * Files are delivered through short-lived signed links, and access is checked both when a link is issued and again
 * when the file is fetched. A withdrawal or new restriction therefore takes effect immediately, even for links
 * already handed out.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { env } from '../../config/env.js';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { storage, buildKey } from '../../services/storage/index.js';
import { ingestTempFile, cleanupFiles } from '../../services/upload.service.js';
import { enqueue } from '../../services/queue.service.js';
import { recordEvent } from '../../services/preservation.service.js';
import { protectAsset } from '../../services/objectLock.service.js';
import { evaluateAsset } from '../../services/accessPolicy.service.js';
import { loadPrincipal } from '../../middleware/auth.js';
import { isRaster, imageMetadata, makeDerivatives } from '../../integrations/imaging.js';
import { pdfInfo } from '../../integrations/pdf.js';
import { probe } from '../../integrations/ffprobe.js';
import { extractMetadata } from '../../integrations/tika.js';
import { sha256 } from '../../utils/crypto.js';

// Internal storage fields that are never sent to clients.
export const PUBLIC_ATTRS = { exclude: ['storageKey', 'storageDriver', 'idempotencyKey'] };

/**
 * Converts an asset to a plain object without its internal storage fields, ready to send to a client.
 *
 * @param {object} a Sequelize instance or plain object.
 * @returns {object}
 */
export const presentAsset = (a) => {
  const p = typeof a.get === 'function' ? a.get({ plain: true }) : { ...a };
  for (const field of PUBLIC_ATTRS.exclude) delete p[field];
  return p;
};

/**
 * Uploads one or more files as new digital assets.
 *
 * For each file:
 * - It is validated, scanned, hashed and stored; files that fail are reported in `rejected` while the others
 *   continue.
 * - Identical content already attached to the same description is rejected unless duplicates are allowed. Identical
 *   content elsewhere is accepted but linked as a possible duplicate.
 * - The asset row, its checksum and its ingest, validation, malware-scan and checksum events are created in one
 *   transaction. A file whose scan could not complete is quarantined; otherwise processing is queued after the
 *   commit.
 * - A migrated version is linked to its source with a format-migration event on both. A migration never replaces
 *   the master.
 *
 * Repeating a request with the same idempotency key returns the assets created the first time instead of uploading
 * again. Temporary files are always removed.
 *
 * @param {Array<object>} files Temporary files from Multer.
 * @param {{ recordId?: string, physicalItemId?: string, digitisationItemId?: string, role?: string, title?: string,
 *   idempotencyKey?: string, allowDuplicate?: boolean, parentAssetId?: string }} opts Where the files belong and how
 *   to treat them.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ assets: object[], rejected: object[], replayed: boolean }>}
 * @throws {AppError} 404 when the description or migration source does not exist.
 */
export async function uploadAssets(files, opts, user) {
  const {
    recordId,
    physicalItemId,
    digitisationItemId,
    role = 'preservation_master',
    title,
    idempotencyKey,
    allowDuplicate = false,
    parentAssetId,
  } = opts;
  if (recordId && !(await models.ArchivalRecord.findByPk(recordId, { attributes: ['id', 'status'] }))) {
    await cleanupFiles(files);
    throw notFound('Archival description');
  }
  if (idempotencyKey) {
    const prior = await models.DigitalAsset.findAll({ where: { idempotencyKey, uploadedById: user.id } });
    if (prior.length) {
      await cleanupFiles(files);
      return { assets: prior.map(presentAsset), replayed: true };
    }
  }
  const created = [];
  const rejected = [];
  try {
    for (const [i, file] of files.entries()) {
      let r;
      try {
        r = await ingestTempFile(file, { area: 'assets' });
      } catch (err) {
        rejected.push({ filename: file.originalname, error: err.message });
        await audit({
          action: 'asset.upload_rejected',
          outcome: 'failure',
          resourceType: 'ArchivalRecord',
          resourceId: recordId,
          metadata: { filename: file.originalname, error: err.message },
        });
        continue;
      }
      const duplicate = await models.DigitalAsset.findOne({
        where: { sha256: r.sha256, status: { [Op.ne]: 'deleted' } },
        attributes: ['id', 'recordId', 'role'],
      });
      if (duplicate && duplicate.recordId === recordId && !allowDuplicate) {
        await storage.remove(r.storageKey).catch(() => {});
        rejected.push({
          filename: file.originalname,
          error: 'Identical content is already attached to this description',
          duplicateOfId: duplicate.id,
        });
        continue;
      }
      const asset = await sequelize.transaction(async (t) => {
        const a = await models.DigitalAsset.create(
          {
            recordId,
            physicalItemId,
            digitisationItemId,
            parentAssetId,
            role,
            title: files.length === 1 ? title : null,
            originalFilename: file.originalname.slice(0, 500),
            declaredMediaType: file.mimetype,
            mediaType: r.mediaType,
            extension: r.ext,
            sizeBytes: r.size,
            sha256: r.sha256,
            storageKey: r.storageKey,
            storageDriver: storage.name,
            status: r.malwareStatus === 'error' ? 'quarantined' : 'processing',
            malwareStatus: r.malwareStatus,
            formatRisk: r.format.riskLevel,
            duplicateOfId: duplicate?.id ?? null,
            uploadedById: user.id,
            idempotencyKey: idempotencyKey ? (files.length > 1 ? `${idempotencyKey}:${i}` : idempotencyKey) : null,
            qaStatus: digitisationItemId ? 'pending' : 'not_required',
            ocrStatus: r.format.ocrEligible ? 'pending' : 'not_applicable',
          },
          { transaction: t },
        );
        await models.AssetChecksum.create(
          { assetId: a.id, algorithm: 'SHA-256', value: r.sha256, source: 'ingest' },
          { transaction: t },
        );
        await recordEvent(
          {
            assetId: a.id,
            recordId,
            eventType: 'ingest',
            detail: `Ingested ${file.originalname}`,
            technicalDetail: { size: r.size, mediaType: r.mediaType, declaredMediaType: file.mimetype },
          },
          { transaction: t },
        );
        await recordEvent(
          {
            assetId: a.id,
            recordId,
            eventType: 'validation',
            detail: `File signature identified as ${r.mediaType}`,
            technicalDetail: { extension: r.ext },
          },
          { transaction: t },
        );
        await recordEvent(
          {
            assetId: a.id,
            recordId,
            eventType: 'malware_scan',
            outcome: r.malwareStatus === 'clean' ? 'success' : r.malwareStatus === 'skipped' ? 'warning' : 'failure',
            detail:
              r.malwareStatus === 'skipped' ? 'Malware scanning is not enabled' : `Scan result: ${r.malwareStatus}`,
            technicalDetail: r.scan,
          },
          { transaction: t },
        );
        await recordEvent(
          {
            assetId: a.id,
            recordId,
            eventType: 'checksum_calculation',
            detail: 'SHA-256 calculated at ingest',
            technicalDetail: { sha256: r.sha256 },
          },
          { transaction: t },
        );
        if (role === 'migrated_version' && parentAssetId) {
          // A migration never replaces the master: the new object is linked to its source with provenance.
          const source = await models.DigitalAsset.findByPk(parentAssetId, { transaction: t });
          if (!source) throw notFound('Source asset for migration');
          await a.update({ versionNumber: (source.versionNumber || 1) + 1 }, { transaction: t });
          await recordEvent(
            {
              assetId: a.id,
              recordId,
              eventType: 'format_migration',
              detail: `Migrated version of ${source.originalFilename}`,
              technicalDetail: {
                sourceAssetId: source.id,
                sourceMediaType: source.mediaType,
                sourceSha256: source.sha256,
                targetMediaType: r.mediaType,
                targetSha256: r.sha256,
              },
            },
            { transaction: t },
          );
          await recordEvent(
            {
              assetId: source.id,
              recordId: source.recordId,
              eventType: 'format_migration',
              detail: `New migrated version created: ${a.originalFilename}`,
              technicalDetail: { derivedAssetId: a.id },
            },
            { transaction: t },
          );
        }
        await audit(
          {
            action: 'asset.upload',
            resourceType: 'DigitalAsset',
            resourceId: a.id,
            after: { recordId, filename: a.originalFilename, sha256: r.sha256, mediaType: r.mediaType, role },
          },
          { transaction: t },
        );
        if (a.status === 'processing')
          await enqueue(
            'ingest',
            'asset.process',
            { assetId: a.id },
            { entityType: 'DigitalAsset', entityId: a.id, requestedById: user.id, transaction: t },
          );
        return a;
      });
      created.push(presentAsset(asset));
    }
  } finally {
    await cleanupFiles(files);
  }
  return { assets: created, rejected, replayed: false };
}

/**
 * Copies a stored object into a new private temporary folder so that tools needing a file path (sharp, pdf.js,
 * ffprobe) can read it.
 *
 * @param {string} key Storage key.
 * @param {string} name Original file name; reduced to safe characters.
 * @returns {Promise<{ dir: string, file: string }>} The temporary folder, which the caller must delete, and the
 *   file path.
 */
async function downloadToTemp(key, name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-'));
  const file = path.join(dir, path.basename(name).replace(/[^\w.-]+/g, '_') || 'object');
  const { body } = await storage.get(key);
  await pipeline(body, fs.createWriteStream(file));
  return { dir, file };
}

/**
 * Stores a generated access copy or thumbnail as a new asset linked to its master.
 *
 * The derivative inherits the master's description, access level, download setting and malware status, receives its
 * own checksum, and a derivative-creation event is recorded on the master.
 *
 * @param {object} parent The master asset.
 * @param {string} role "access_derivative" or "thumbnail".
 * @param {Buffer} buffer Image content.
 * @param {string} mediaType Media type of the image.
 * @param {string} ext File extension.
 * @param {object} [extra] Additional fields, such as width and height.
 * @returns {Promise<object>} The derivative asset.
 */
async function storeDerivative(parent, role, buffer, mediaType, ext, extra) {
  const key = buildKey(`derivatives/${role}`, `${path.parse(parent.originalFilename).name}.${ext}`);
  await storage.put(key, buffer, { contentType: mediaType });
  const hash = sha256(buffer);
  const d = await models.DigitalAsset.create({
    recordId: parent.recordId,
    physicalItemId: parent.physicalItemId,
    digitisationItemId: parent.digitisationItemId,
    parentAssetId: parent.id,
    role,
    originalFilename: `${path.parse(parent.originalFilename).name}.${ext}`,
    mediaType,
    extension: ext,
    sizeBytes: buffer.length,
    sha256: hash,
    storageKey: key,
    storageDriver: storage.name,
    status: 'available',
    malwareStatus: parent.malwareStatus,
    preservationStatus: 'ok',
    accessLevel: parent.accessLevel,
    downloadAllowed: parent.downloadAllowed,
    ocrStatus: 'not_applicable',
    formatRisk: 'low',
    uploadedById: parent.uploadedById,
    ...extra,
  });
  await models.AssetChecksum.create({ assetId: d.id, algorithm: 'SHA-256', value: hash, source: 'ingest' });
  await recordEvent({
    assetId: parent.id,
    recordId: parent.recordId,
    eventType: 'derivative_creation',
    detail: `${role.replace(/_/g, ' ')} created`,
    technicalDetail: { derivativeId: d.id, mediaType, size: buffer.length },
    agentName: 'ingest-worker',
  });
  return d;
}

/**
 * Runs a function while holding an exclusive SQL Server application lock for one asset.
 *
 * If another process already holds the lock (a retried or stalled queue job, or an inline call), the function is
 * not run and `{ skipped: true }` is returned at once. The lock lives in its own transaction; the function's writes
 * are not part of it.
 *
 * @param {string} assetId Identifier of the asset.
 * @param {() => Promise<*>} fn The work to perform.
 * @returns {Promise<*>} The function's result, or `{ skipped: true, reason: 'in_progress' }`.
 */
async function withAssetLock(assetId, fn) {
  return sequelize.transaction(async (t) => {
    const [row] = await sequelize.query(
      "DECLARE @r int; EXEC @r = sp_getapplock @Resource = :res, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0; SELECT @r AS result;",
      { replacements: { res: `asset_ingest:${assetId}` }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    if (row.result < 0) return { skipped: true, reason: 'in_progress' };
    return fn();
  });
}

/**
 * Background ingest job for an uploaded asset. Safe to run more than once and concurrently: only one run processes
 * the asset at a time.
 *
 * @param {string} assetId Identifier of the asset.
 * @returns {Promise<object>} The outcome, for example `{ status: 'available' }` or `{ skipped: true }`.
 */
export async function processAsset(assetId) {
  return withAssetLock(assetId, () => ingestAsset(assetId));
}

/**
 * Performs the ingest processing of one asset that is waiting to be processed, or whose earlier attempt failed.
 *
 * - Technical metadata is extracted according to the type (image, PDF or audio/video), plus Tika metadata when
 *   enabled; extraction problems are recorded as a warning rather than failing the ingest.
 * - Raster masters get an access copy and a thumbnail unless they already have them.
 * - The asset becomes available with a fixity check due immediately.
 * - OCR is queued when the format is eligible, OCR is enabled and, for digitised items, the batch has OCR switched
 *   on.
 * - A preservation file is placed under write-once retention (S3 Object Lock).
 * - Replication is queued.
 *
 * Any other error marks the asset as failed and is rethrown so the job can be retried. The temporary copy is always
 * deleted.
 *
 * @param {string} assetId Identifier of the asset.
 * @returns {Promise<object>} `{ status: 'available' }`, or `{ skipped: true }` when the asset is neither waiting to be
 *   processed nor failed.
 */
async function ingestAsset(assetId) {
  const asset = await models.DigitalAsset.findByPk(assetId);
  if (!asset || !['processing', 'failed'].includes(asset.status)) return { skipped: true };
  // A retry of a failed attempt counts as processing again, so a batch cannot move on while it runs.
  if (asset.status === 'failed') await asset.update({ status: 'processing', ingestError: null });
  let tmp;
  try {
    tmp = await downloadToTemp(asset.storageKey, asset.originalFilename);
    const tech = { mediaType: asset.mediaType, size: Number(asset.sizeBytes) };
    const patch = {};
    try {
      if (isRaster(asset.mediaType)) {
        Object.assign(tech, await imageMetadata(tmp.file));
        Object.assign(patch, { width: tech.width, height: tech.height, pageCount: tech.pages });
      } else if (asset.mediaType === 'application/pdf') {
        Object.assign(tech, await pdfInfo(tmp.file));
        patch.pageCount = tech.pageCount;
      } else if (/^(audio|video)\//.test(asset.mediaType)) {
        const av = await probe(tmp.file);
        Object.assign(tech, av);
        if (av?.durationSeconds) patch.durationSeconds = av.durationSeconds;
        if (av?.video) Object.assign(patch, { width: av.video.width, height: av.video.height });
      }
    } catch (err) {
      tech.extractionError = err.message;
    }
    const tika = await extractMetadata(tmp.file, asset.mediaType);
    if (tika) patch.extractedMetadata = tika;
    await recordEvent({
      assetId,
      recordId: asset.recordId,
      eventType: 'metadata_extraction',
      outcome: tech.extractionError ? 'warning' : 'success',
      detail: tech.extractionError || 'Technical metadata extracted',
      technicalDetail: tech,
      agentName: 'ingest-worker',
    });

    const existingDerivs = await models.DigitalAsset.count({
      where: { parentAssetId: assetId, role: ['access_derivative', 'thumbnail'] },
    });
    if (
      isRaster(asset.mediaType) &&
      !existingDerivs &&
      ['preservation_master', 'original_upload', 'migrated_version'].includes(asset.role)
    ) {
      try {
        const d = await makeDerivatives(tmp.file);
        await storeDerivative(asset, 'access_derivative', d.access.buffer, 'image/jpeg', 'jpg', {
          width: d.access.width,
          height: d.access.height,
        });
        await storeDerivative(asset, 'thumbnail', d.thumbnail.buffer, 'image/jpeg', 'jpg', {
          width: d.thumbnail.width,
          height: d.thumbnail.height,
        });
      } catch (err) {
        await recordEvent({
          assetId,
          recordId: asset.recordId,
          eventType: 'derivative_creation',
          outcome: 'failure',
          detail: err.message,
          agentName: 'ingest-worker',
        });
      }
    }
    await asset.update({
      ...patch,
      technicalMetadata: tech,
      status: 'available',
      preservationStatus: 'pending',
      nextFixityAt: new Date(),
    });
    await protectAsset(assetId);
    // OCR runs on the preservation master (or on the access copy for PDFs); failure never affects the stored file.
    if (asset.ocrStatus === 'pending' && env.OCR_ENABLED) {
      const batch = asset.digitisationItemId
        ? await models.DigitisationBatch.findOne({
            include: [
              { model: models.DigitisationItem, as: 'items', where: { id: asset.digitisationItemId }, attributes: [] },
            ],
          })
        : null;
      if (!batch || batch.ocrEnabled) await queueOcr(asset, batch?.ocrLanguage || 'eng', null);
    }
    await enqueue('fixity', 'preservation.replicate', { assetId }, { entityType: 'DigitalAsset', entityId: assetId });
    return { status: 'available' };
  } catch (err) {
    await asset.update({ status: 'failed', ingestError: err.message.slice(0, 2000) });
    await recordEvent({
      assetId,
      recordId: asset.recordId,
      eventType: 'ingest',
      outcome: 'failure',
      detail: err.message,
      agentName: 'ingest-worker',
    });
    throw err;
  } finally {
    if (tmp) await fsp.rm(tmp.dir, { recursive: true, force: true });
  }
}

/**
 * Creates an OCR job for an asset and queues it. OCR failures never affect the stored file.
 *
 * @param {{ id: string }} asset The asset.
 * @param {string} language Tesseract language code, for example "eng".
 * @param {object|null} user Person who asked for OCR, or null when queued automatically.
 * @returns {Promise<object>} The OCR job.
 */
export async function queueOcr(asset, language, user) {
  const job = await models.OCRJob.create({
    assetId: asset.id,
    language,
    status: 'queued',
    requestedById: user?.id ?? null,
  });
  await models.DigitalAsset.update({ ocrStatus: 'queued' }, { where: { id: asset.id } });
  await enqueue(
    'ocr',
    'ocr.run',
    { ocrJobId: job.id },
    { entityType: 'DigitalAsset', entityId: asset.id, requestedById: user?.id },
  );
  return job;
}

/**
 * Updates an asset's metadata, description link or access settings.
 *
 * Changes to the description link, access level or download setting are copied to the asset's access copy and
 * thumbnail so derivatives always follow their master. A metadata-modification event and an audit record list the
 * changed fields.
 *
 * @param {string} id Identifier of the asset.
 * @param {object} data Validated fields to change.
 * @returns {Promise<object>} The updated asset.
 * @throws {AppError} 404 when the asset or the new description does not exist.
 */
export async function updateAsset(id, data) {
  return sequelize.transaction(async (t) => {
    const a = await models.DigitalAsset.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a || a.status === 'deleted') throw notFound('Digital asset');
    if (data.recordId && !(await models.ArchivalRecord.findByPk(data.recordId, { transaction: t, attributes: ['id'] })))
      throw notFound('Archival description');
    const before = a.get({ plain: true });
    await a.update(data, { transaction: t });
    // Derivatives follow their master's link and access settings.
    if (data.recordId || data.accessLevel || data.downloadAllowed !== undefined) {
      const sync = {};
      for (const k of ['recordId', 'accessLevel', 'downloadAllowed']) if (data[k] !== undefined) sync[k] = data[k];
      await models.DigitalAsset.update(sync, {
        where: { parentAssetId: a.id, role: ['access_derivative', 'thumbnail'] },
        transaction: t,
      });
    }
    const d = diff(before, a);
    await recordEvent(
      {
        assetId: a.id,
        recordId: a.recordId,
        eventType: 'metadata_modification',
        detail: `Changed ${d.fields.join(', ')}`,
      },
      { transaction: t },
    );
    await audit(
      { action: 'asset.update', resourceType: 'DigitalAsset', resourceId: a.id, before: d.before, after: d.after },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Publishes or withdraws a single asset.
 *
 * Publication of a file is separate from publication of its description. To publish, the asset must not be a
 * preservation master, must be available, must have passed the malware scan and, if it came from digitisation,
 * quality assurance, and its description must already be published. Withdrawal is always allowed and takes effect
 * immediately.
 *
 * @param {string} id Identifier of the asset.
 * @param {boolean} publish True to publish, false to withdraw.
 * @param {object} user Authenticated principal.
 * @param {string} [reason] Explanation recorded with the event.
 * @returns {Promise<object>} The updated asset.
 * @throws {AppError} 400 when a publication condition is not met.
 */
export async function setPublished(id, publish, user, reason) {
  return sequelize.transaction(async (t) => {
    const a = await models.DigitalAsset.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: models.ArchivalRecord, as: 'record' }],
    });
    if (!a || a.status === 'deleted') throw notFound('Digital asset');
    if (publish) {
      if (a.role === 'preservation_master')
        throw badRequest('Preservation masters are never published. Publish an access derivative instead.');
      if (a.status !== 'available') throw badRequest('Only available assets can be published');
      if (a.malwareStatus !== 'clean') throw badRequest('Assets must pass a malware scan before publication');
      if (a.qaStatus === 'pending' || a.qaStatus === 'failed')
        throw badRequest('Assets from digitisation must pass quality assurance before publication');
      if (!a.record || a.record.status !== 'published')
        throw badRequest('Publish the description before publishing its files');
    }
    await a.update({ isPublished: publish }, { transaction: t });
    await recordEvent(
      {
        assetId: a.id,
        recordId: a.recordId,
        eventType: publish ? 'publication' : 'withdrawal',
        detail: reason || (publish ? 'Published' : 'Withdrawn from public access'),
      },
      { transaction: t },
    );
    await audit(
      { action: publish ? 'asset.publish' : 'asset.unpublish', resourceType: 'DigitalAsset', resourceId: a.id, reason },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Removes a derivative or other non-master asset (for example a failed access copy) by marking it deleted.
 *
 * Preservation masters, original uploads and migrated versions can only leave the system through an approved
 * disposal case, and an asset under legal hold cannot be deleted.
 *
 * @param {string} id Identifier of the asset.
 * @param {string} reason Why the asset is removed.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The deleted asset.
 * @throws {AppError} 403 for masters or held assets, 404 when not found.
 */
export async function deleteAsset(id, reason, user) {
  return sequelize.transaction(async (t) => {
    const a = await models.DigitalAsset.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a || a.status === 'deleted') throw notFound('Digital asset');
    if (['preservation_master', 'original_upload', 'migrated_version'].includes(a.role))
      throw forbidden('Preservation masters and originals can only be removed through an approved disposal case');
    if (
      await models.LegalHoldItem.count({
        where: { assetId: a.id },
        include: [{ model: models.LegalHold, as: 'hold', where: { status: 'active' } }],
        transaction: t,
      })
    )
      throw forbidden('This asset is under legal hold');
    await a.update(
      { status: 'deleted', isPublished: false, deletedAt: new Date(), deletedById: user.id, deletionReason: reason },
      { transaction: t },
    );
    await recordEvent(
      { assetId: a.id, recordId: a.recordId, eventType: 'deletion', detail: reason },
      { transaction: t },
    );
    await audit({ action: 'asset.delete', resourceType: 'DigitalAsset', resourceId: a.id, reason }, { transaction: t });
    return a;
  });
}

// ------------------------------------------------------------------ delivery
const FILE_AUD = 'ug-arms-file';

/**
 * Issues a short-lived link through which an asset can be viewed or downloaded.
 *
 * Access is evaluated now; an asset the user may not view is reported as not found, and a download link requires
 * download permission. The signed token names the asset, the user and the disposition, and expires after
 * SIGNED_URL_TTL_SECONDS.
 *
 * @param {string} assetId Identifier of the asset.
 * @param {object|null} user Authenticated principal, or null for a public visitor.
 * @param {{ disposition?: 'inline'|'attachment' }} [options]
 * @returns {Promise<{ url: string, expiresInSeconds: number, canDownload: boolean }>}
 * @throws {AppError} 404 when not viewable, 403 when downloading is not permitted.
 */
export async function issueDeliveryToken(assetId, user, { disposition = 'inline' } = {}) {
  const asset = await models.DigitalAsset.findByPk(assetId, {
    include: [{ model: models.ArchivalRecord, as: 'record' }],
  });
  if (!asset) throw notFound('Digital asset');
  const decision = await evaluateAsset(user, asset, asset.record);
  if (!decision.canView) throw notFound('Digital asset');
  if (disposition === 'attachment' && !decision.canDownload) throw forbidden('Downloading this file is not permitted');
  const token = jwt.sign({ aid: asset.id, uid: user?.id ?? null, disp: disposition }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    audience: FILE_AUD,
    expiresIn: env.SIGNED_URL_TTL_SECONDS,
  });
  return {
    url: `/api/v1/files/${token}`,
    expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
    canDownload: decision.canDownload,
  };
}

/**
 * Streams the file named by a delivery token.
 *
 * The token is verified and access is evaluated again, so a withdrawal, restriction or account suspension made
 * after the link was issued takes effect immediately; any failure is reported as not found. Byte ranges are
 * supported for media playback. Downloads are always audited, and views are audited for anything that is not open
 * access. The response is sent with no-store caching, `nosniff` and a sandboxing Content Security Policy, so a
 * malicious file cannot run scripts in the application's origin.
 *
 * @param {string} token Delivery token from the URL.
 * @param {import('express').Request} req Incoming request (for the Range header).
 * @param {import('express').Response} res Response to stream into.
 * @returns {Promise<void>}
 * @throws {AppError} 404 when the token is invalid or access is no longer permitted.
 */
export async function streamByToken(token, req, res) {
  let claims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], audience: FILE_AUD });
  } catch {
    throw notFound('File');
  }
  const user = claims.uid ? await loadPrincipal(claims.uid) : null;
  if (claims.uid && (!user || user.status !== 'active')) throw notFound('File');
  const asset = await models.DigitalAsset.findByPk(claims.aid, {
    include: [{ model: models.ArchivalRecord, as: 'record' }],
  });
  if (!asset) throw notFound('File');
  // Re-check at fetch time so withdrawal or restriction changes take effect immediately.
  const decision = await evaluateAsset(user, asset, asset.record);
  if (!decision.canView || (claims.disp === 'attachment' && !decision.canDownload)) throw notFound('File');
  const range = req.get('range');
  const obj = await storage.get(asset.storageKey, range ? { range } : {});
  // Downloads are always audited; views are audited for anything that is not open access.
  if (claims.disp === 'attachment' || asset.record?.effectiveAccessLevel !== 'open') {
    await audit({
      action: claims.disp === 'attachment' ? 'asset.download' : 'asset.view',
      resourceType: 'DigitalAsset',
      resourceId: asset.id,
      actor: user,
      actorType: user ? 'user' : 'anonymous',
      metadata: { role: asset.role },
    });
  }
  res.status(range && obj.contentRange ? 206 : 200);
  res.setHeader('Content-Type', asset.mediaType || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  if (obj.contentRange) res.setHeader('Content-Range', obj.contentRange);
  if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
  res.setHeader(
    'Content-Disposition',
    `${claims.disp === 'attachment' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(asset.originalFilename)}"`,
  );
  await pipeline(obj.body, res);
}

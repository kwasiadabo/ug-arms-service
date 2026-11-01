/**
 * OCR processing and review.
 *
 * OCR output is stored separately from the file, page by page, with a confidence value and a full revision history.
 * It is machine output, not an authoritative transcription, and it becomes searchable only after an authorised
 * person has checked and approved it. An OCR failure never affects the stored file.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { models, sequelize } from '../../database/models/index.js';
import { storage } from '../../services/storage/index.js';
import { runOcr } from '../../integrations/ocr.js';
import { recordEvent } from '../../services/preservation.service.js';
import { getSetting } from '../../services/settings.service.js';
import { audit } from '../../services/audit.service.js';
import { enqueue } from '../../services/queue.service.js';
import { notifyPermissionHolders } from '../../services/notification.service.js';
import { notFound, badRequest } from '../../utils/errors.js';

/**
 * Runs a queued OCR job in the background worker.
 *
 * The file is copied to a temporary folder and recognised. Each page is stored with its confidence (pages below the
 * configured threshold, or without a confidence, are flagged for review) and a first revision taken from the
 * engine. Earlier OCR results for the file are kept as history. Reviewers are notified in the application only. A
 * failure marks the job and file as failed, is recorded as a preservation event and is rethrown so the job can be
 * retried.
 *
 * @param {string} ocrJobId Identifier of the OCR job.
 * @returns {Promise<{ pages: number }|{ skipped: true }>} Number of pages recognised, or skipped when the job is
 *   not waiting to run.
 */
export async function executeOcrJob(ocrJobId) {
  const job = await models.OCRJob.findByPk(ocrJobId, { include: [{ model: models.DigitalAsset, as: 'asset' }] });
  if (!job || !['queued', 'failed'].includes(job.status)) return { skipped: true };
  const asset = job.asset;
  await job.update({ status: 'running', startedAt: new Date(), attempts: job.attempts + 1, error: null });
  await models.DigitalAsset.update({ ocrStatus: 'running' }, { where: { id: asset.id } });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  try {
    const file = path.join(dir, `source.${asset.extension || 'bin'}`);
    const { body } = await storage.get(asset.storageKey);
    await pipeline(body, fs.createWriteStream(file));
    const result = await runOcr(file, asset.mediaType, job.language);
    const threshold = await getSetting('ocr.lowConfidenceThreshold');
    await sequelize.transaction(async (t) => {
      // Previous OCR output for this asset is kept (its pages remain linked to the older job).
      for (const p of result.pages) {
        const confidence =
          p.confidence === null || p.confidence === undefined ? null : Number(Number(p.confidence).toFixed(2));
        const page = await models.OCRPage.create(
          {
            ocrJobId: job.id,
            assetId: asset.id,
            pageNumber: p.pageNumber,
            text: p.text,
            confidence,
            needsReview: confidence === null || confidence < threshold,
            reviewStatus: 'pending',
            approvedForSearch: false,
          },
          { transaction: t },
        );
        await models.OCRRevision.create(
          { pageId: page.id, revision: 1, text: p.text, source: 'engine' },
          { transaction: t },
        );
      }
      const confs = result.pages.map((p) => p.confidence).filter((c) => c !== null && c !== undefined);
      const mean = confs.length ? confs.reduce((a, b) => a + Number(b), 0) / confs.length : null;
      await job.update(
        {
          status: 'succeeded',
          engine: result.engine,
          engineVersion: result.engineVersion,
          meanConfidence: mean === null ? null : mean.toFixed(2),
          pageCount: result.pages.length,
          finishedAt: new Date(),
        },
        { transaction: t },
      );
      await models.DigitalAsset.update({ ocrStatus: 'succeeded' }, { where: { id: asset.id }, transaction: t });
      await recordEvent(
        {
          assetId: asset.id,
          recordId: asset.recordId,
          eventType: 'ocr',
          detail: `OCR completed (${result.pages.length} page(s))`,
          technicalDetail: {
            engine: result.engine,
            engineVersion: result.engineVersion,
            language: job.language,
            meanConfidence: mean,
          },
          agentName: 'ocr-worker',
        },
        { transaction: t },
      );
    });
    await notifyPermissionHolders(['ocr.review'], {
      eventType: 'ocr.completed',
      title: 'OCR ready for review',
      body: `${asset.originalFilename}: ${result.pages.length} page(s).`,
      link: `/admin/ocr/${asset.id}`,
      entityType: 'DigitalAsset',
      entityId: asset.id,
      email: false,
    });
    return { pages: result.pages.length };
  } catch (err) {
    await job.update({ status: 'failed', error: err.message.slice(0, 4000), finishedAt: new Date() });
    await models.DigitalAsset.update({ ocrStatus: 'failed' }, { where: { id: asset.id } });
    await recordEvent({
      assetId: asset.id,
      recordId: asset.recordId,
      eventType: 'ocr',
      outcome: 'failure',
      detail: err.message,
      agentName: 'ocr-worker',
    });
    throw err;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Saves a corrected transcription of a page as a new revision; earlier revisions are kept.
 *
 * If `approve` is set the page becomes searchable immediately; otherwise it is marked as corrected and still needs
 * review. The description is queued for re-indexing.
 *
 * @param {string} pageId Identifier of the OCR page.
 * @param {{ text: string, note?: string, approve?: boolean }} input The corrected text, a note and whether to
 *   approve.
 * @param {object} user Reviewer.
 * @returns {Promise<object>} The updated page.
 * @throws {AppError} 404 when the page does not exist.
 */
export async function correctPage(pageId, { text, note, approve }, user) {
  return sequelize.transaction(async (t) => {
    const page = await models.OCRPage.findByPk(pageId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!page) throw notFound('OCR page');
    const revision = page.currentRevision + 1;
    await models.OCRRevision.create(
      { pageId, revision, text, source: 'manual', editedById: user.id, note },
      { transaction: t },
    );
    await page.update(
      {
        text,
        currentRevision: revision,
        reviewStatus: approve ? 'approved' : 'corrected',
        approvedForSearch: Boolean(approve),
        needsReview: !approve,
        reviewedById: user.id,
        reviewedAt: new Date(),
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'ocr.page_corrected',
        resourceType: 'OCRPage',
        resourceId: pageId,
        metadata: { revision, approved: Boolean(approve) },
      },
      { transaction: t },
    );
    const asset = await models.DigitalAsset.findByPk(page.assetId, { attributes: ['id', 'recordId'], transaction: t });
    if (asset?.recordId)
      await enqueue(
        'indexing',
        'search.index_record',
        { recordId: asset.recordId },
        { entityType: 'ArchivalRecord', entityId: asset.recordId, transaction: t },
      );
    return page;
  });
}

/**
 * Approves OCR pages of a file for search (all pages, or only those listed) and queues the description for
 * re-indexing.
 *
 * @param {string} assetId Identifier of the file.
 * @param {string[]} [pageIds] Pages to approve; all pages when omitted.
 * @param {object} user Reviewer.
 * @returns {Promise<number>} Number of pages approved.
 */
export async function approvePages(assetId, pageIds, user) {
  return sequelize.transaction(async (t) => {
    const where = { assetId, ...(pageIds?.length ? { id: pageIds } : {}) };
    const [count] = await models.OCRPage.update(
      {
        reviewStatus: 'approved',
        approvedForSearch: true,
        needsReview: false,
        reviewedById: user.id,
        reviewedAt: new Date(),
      },
      { where, transaction: t },
    );
    await models.DigitalAsset.update({ ocrStatus: 'reviewed' }, { where: { id: assetId }, transaction: t });
    await audit(
      { action: 'ocr.pages_approved', resourceType: 'DigitalAsset', resourceId: assetId, metadata: { count } },
      { transaction: t },
    );
    const asset = await models.DigitalAsset.findByPk(assetId, { attributes: ['recordId'], transaction: t });
    if (asset?.recordId)
      await enqueue(
        'indexing',
        'search.index_record',
        { recordId: asset.recordId },
        { entityType: 'ArchivalRecord', entityId: asset.recordId, transaction: t },
      );
    return count;
  });
}

/**
 * Returns the pages of the most recent successful OCR job for a file. Pages from older jobs are kept as history but
 * are not returned.
 *
 * @param {string} assetId Identifier of the file.
 * @returns {Promise<{ job: object|null, pages: object[] }>}
 */
export async function latestPages(assetId) {
  const job = await models.OCRJob.findOne({ where: { assetId, status: 'succeeded' }, order: [['finishedAt', 'DESC']] });
  if (!job) return { job: null, pages: [] };
  const pages = await models.OCRPage.findAll({ where: { ocrJobId: job.id }, order: [['pageNumber', 'ASC']] });
  return { job, pages };
}

const OCR_MEDIA_TYPES = ['image/tiff', 'image/jpeg', 'image/png', 'image/jp2', 'application/pdf'];

/**
 * Checks that a file is a type OCR can process (TIFF, JPEG, PNG, JPEG 2000 or PDF).
 *
 * @param {{ mediaType: string }} asset The file.
 * @throws {AppError} 400 when the type is not eligible.
 */
export function assertOcrEligible(asset) {
  if (!OCR_MEDIA_TYPES.includes(asset.mediaType)) throw badRequest('This file type is not eligible for OCR');
}

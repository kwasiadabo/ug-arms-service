/**
 * Supporting documents for transfers and accessions, such as deposit agreements, inventories and deeds of gift.
 *
 * Documents go through the same safe upload pipeline as archival files, but only document formats are accepted.
 * Storage keys are never returned to clients, and documents are delivered as downloads with content sniffing
 * disabled.
 *
 * @author Kwasi Adabo Boakye
 */

import { models, sequelize } from '../../database/models/index.js';
import { notFound, conflict } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { ingestTempFile, cleanupFiles } from '../../services/upload.service.js';
import { storage } from '../../services/storage/index.js';

const DOC_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/**
 * Validates, scans and stores uploaded supporting documents against a transfer or accession, and audits each one.
 * Temporary upload files are always deleted.
 *
 * @param {string} ownerType "transfer_submission" or "accession".
 * @param {string} ownerId Identifier of the owner.
 * @param {Array<object>} files Temporary files from Multer.
 * @param {string} [documentType] Kind of document, for example "deposit_agreement".
 * @param {{ id: string }} user Person uploading.
 * @returns {Promise<object[]>} The stored documents, without their storage keys.
 */
export async function storeDocuments(ownerType, ownerId, files, documentType, user) {
  const saved = [];
  try {
    for (const file of files) {
      const r = await ingestTempFile(file, { area: `documents/${ownerType}`, allowed: DOC_TYPES });
      const doc = await sequelize.transaction(async (t) => {
        const d = await models.TransferDocument.create(
          {
            ownerType,
            ownerId,
            documentType,
            originalFilename: file.originalname.slice(0, 500),
            mediaType: r.mediaType,
            sizeBytes: r.size,
            sha256: r.sha256,
            storageKey: r.storageKey,
            malwareStatus: r.malwareStatus,
            uploadedById: user.id,
          },
          { transaction: t },
        );
        await audit(
          {
            action: 'document.upload',
            resourceType: ownerType,
            resourceId: ownerId,
            after: { documentId: d.id, filename: d.originalFilename, sha256: r.sha256, mediaType: r.mediaType },
          },
          { transaction: t },
        );
        return d;
      });
      saved.push(doc);
    }
  } finally {
    await cleanupFiles(files);
  }
  return saved.map((d) => {
    const plain = d.get({ plain: true });
    delete plain.storageKey;
    return plain;
  });
}

/**
 * Lists the supporting documents of a transfer or accession in upload order, without storage keys.
 *
 * @param {string} ownerType "transfer_submission" or "accession".
 * @param {string} ownerId Identifier of the owner.
 * @returns {Promise<object[]>}
 */
export async function listDocuments(ownerType, ownerId) {
  return models.TransferDocument.findAll({
    where: { ownerType, ownerId },
    attributes: { exclude: ['storageKey'] },
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Streams a supporting document to the client, as a download or, with `preview`, inline for the preview dialog.
 *
 * Infected documents are reported as not found. A document whose malware scan could not be completed is held until
 * it has been re-scanned and is never served unscanned. Every download and preview is audited.
 *
 * @param {string} ownerType "transfer_submission" or "accession".
 * @param {string} ownerId Identifier of the owner.
 * @param {string} docId Document identifier.
 * @param {import('express').Response} res Response to stream into.
 * @param {{ preview?: boolean }} [options] Serve inline for previewing instead of as a download.
 * @returns {Promise<void>}
 * @throws {AppError} 404 when not found or infected, 409 when held for re-scanning.
 */
export async function streamDocument(ownerType, ownerId, docId, res, { preview = false } = {}) {
  const doc = await models.TransferDocument.findOne({ where: { id: docId, ownerType, ownerId } });
  if (!doc) throw notFound('Document');
  if (doc.malwareStatus === 'infected') throw notFound('Document');
  // A file whose scan could not complete is held until it can be re-scanned; it is never served unscanned.
  if (doc.malwareStatus === 'error')
    throw conflict('This document could not be scanned for malware and is held until it is re-scanned');
  const obj = await storage.get(doc.storageKey);
  await audit({
    action: preview ? 'document.preview' : 'document.download',
    resourceType: ownerType,
    resourceId: ownerId,
    metadata: { documentId: doc.id },
  });
  res.setHeader('Content-Type', doc.mediaType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${preview ? 'inline' : 'attachment'}; filename="${encodeURIComponent(doc.originalFilename)}"`,
  );
  // A preview is read by the page as data and never rendered as a page of its own.
  if (preview) res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
  obj.body.pipe(res);
}

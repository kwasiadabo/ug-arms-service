/**
 * Export of BagIt-style preservation packages (ZIP files) that let a receiving repository verify every file it
 * receives.
 *
 * @author Kwasi Adabo Boakye
 */

import archiver from 'archiver';
import { models } from '../../database/models/index.js';
import { storage } from '../../services/storage/index.js';
import { evaluateRecord, staffReadableLevels, assetLevel } from '../../services/accessPolicy.service.js';
import { audit } from '../../services/audit.service.js';
import { notFound } from '../../utils/errors.js';
import { sha256 } from '../../utils/crypto.js';

/**
 * Reduces a name to characters that are safe in a file name, keeping the last 150 characters.
 *
 * @param {*} s The name.
 * @returns {string}
 */
const safe = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .slice(-150);

/**
 * Streams a preservation package for one description as a ZIP download.
 *
 * The package contains bagit.txt, bag-info.txt, the files under data/, metadata files (the description,
 * PREMIS-style events, recorded checksums and the list of objects) and manifest-sha256.txt. The manifest lists the
 * recorded SHA-256 of every file and the SHA-256 of every metadata file, so the receiver can verify integrity. Only
 * masters, originals and migrated versions that the user is cleared to read are included. The export is audited,
 * and flagged as sensitive for anything that is not open access.
 *
 * @param {string} recordId Identifier of the description.
 * @param {object} user Authenticated principal.
 * @param {import('express').Response} res Response to stream into.
 * @returns {Promise<void>}
 * @throws {AppError} 404 when the description does not exist or the user cannot see its full content.
 */
export async function streamPackage(recordId, user, res) {
  const record = await models.ArchivalRecord.findByPk(recordId);
  if (!record) throw notFound('Archival description');
  const decision = await evaluateRecord(user, record);
  if (decision.mode !== 'full') throw notFound('Archival description');
  const levels = staffReadableLevels(user);
  const assets = (
    await models.DigitalAsset.findAll({
      where: { recordId, status: 'available', role: ['preservation_master', 'original_upload', 'migrated_version'] },
      order: [['createdAt', 'ASC']],
    })
  ).filter((a) => levels.includes(assetLevel(a, record)));
  const events = await models.PreservationEvent.findAll({
    where: { assetId: assets.map((a) => a.id) },
    order: [['eventAt', 'ASC']],
  });
  const checksums = await models.AssetChecksum.findAll({ where: { assetId: assets.map((a) => a.id) } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safe(record.referenceCode)}-preservation-package.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('warning', () => {});
  zip.pipe(res);

  const manifest = [];
  const names = new Set();
  for (const a of assets) {
    let name = `data/${safe(a.originalFilename)}`;
    if (names.has(name)) name = `data/${a.id}-${safe(a.originalFilename)}`;
    names.add(name);
    manifest.push(`${a.sha256}  ${name}`);
    const { body } = await storage.get(a.storageKey);
    zip.append(body, { name });
  }
  const description = record.get({ plain: true });
  delete description.searchText;
  const meta = {
    'metadata/description.json': JSON.stringify(description, null, 2),
    'metadata/premis-events.json': JSON.stringify(
      events.map((e) => ({
        eventIdentifier: e.id,
        eventType: e.eventType,
        eventDateTime: e.eventAt,
        eventOutcome: e.outcome,
        eventDetail: e.detail,
        linkingObjectIdentifier: e.assetId,
        linkingAgent: { type: e.agentType, name: e.agentName },
        technicalDetail: e.technicalDetail,
      })),
      null,
      2,
    ),
    'metadata/checksums.json': JSON.stringify(
      checksums.map((c) => ({
        assetId: c.assetId,
        algorithm: c.algorithm,
        value: c.value,
        source: c.source,
        recordedAt: c.createdAt,
      })),
      null,
      2,
    ),
    'metadata/objects.json': JSON.stringify(
      assets.map((a) => ({
        id: a.id,
        role: a.role,
        originalFilename: a.originalFilename,
        mediaType: a.mediaType,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
        parentAssetId: a.parentAssetId,
        formatRisk: a.formatRisk,
        technicalMetadata: a.technicalMetadata,
      })),
      null,
      2,
    ),
  };
  for (const [name, content] of Object.entries(meta)) {
    zip.append(content, { name });
    manifest.push(`${sha256(content)}  ${name}`);
  }
  zip.append('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n', { name: 'bagit.txt' });
  zip.append(
    `Source-Organization: University of Ghana Archives (UG-ARMS)\nExternal-Identifier: ${record.referenceCode}\nBagging-Date: ${new Date().toISOString().slice(0, 10)}\nPayload-Oxum: ${assets.reduce((n, a) => n + Number(a.sizeBytes || 0), 0)}.${assets.length}\n`,
    { name: 'bag-info.txt' },
  );
  zip.append(`${manifest.join('\n')}\n`, { name: 'manifest-sha256.txt' });
  await audit({
    action: 'preservation.package_exported',
    resourceType: 'ArchivalRecord',
    resourceId: record.id,
    metadata: { assets: assets.length },
    sensitive: record.effectiveAccessLevel !== 'open',
  });
  await zip.finalize();
}

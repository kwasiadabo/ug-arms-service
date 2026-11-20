/**
 * Integration tests for staged uploads: the request answers once a file is checked, checksummed and staged, and a
 * background job scans it and copies it to storage. Covers a storage failure followed by reprocessing (and delivery
 * of a file that has not reached storage yet), and an infected file.
 *
 * The malware scanner is replaced in this file so that a scan can report an infection.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import sharp from 'sharp';
import { loginAs, publishedFonds, waitFor } from './helpers.js';
import { models } from '../src/database/models/index.js';
import { storage } from '../src/services/storage/index.js';
import { stagingPath } from '../src/services/upload.service.js';
import { scanFile } from '../src/integrations/clamav.js';

vi.mock('../src/integrations/clamav.js', () => ({
  scanFile: vi.fn(async () => ({ status: 'skipped' })),
}));

let archivist, chief, fonds;
beforeAll(async () => {
  [archivist, chief] = await Promise.all([loginAs('archivist'), loginAs('chief')]);
  fonds = await publishedFonds(archivist, chief, { title: 'Staged upload fonds' });
});
afterEach(() => vi.restoreAllMocks());

/**
 * Makes a small, distinct TIFF so that no two tests upload identical content.
 *
 * @param {string} colour Background colour.
 * @returns {Promise<Buffer>}
 */
const tiff = (colour) =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: colour } })
    .tiff()
    .toBuffer();

const upload = async (buf, name) =>
  archivist.post('/api/v1/digital-assets').field('recordId', fonds.id).attach('files', buf, name);

const eventsOf = async (assetId) =>
  (await models.PreservationEvent.findAll({ where: { assetId } })).map((e) => e.eventType);

describe('staged uploads', () => {
  it('answers before the file is stored, then scans and stores it in the background', async () => {
    const res = await upload(await tiff('#224466'), 'staged.tif');
    expect(res.status).toBe(201);
    const a = res.body.data[0];
    expect(a.status).toBe('uploaded');
    expect(a.malwareStatus).toBe('pending');
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);

    await waitFor(async () => (await models.DigitalAsset.findByPk(a.id)).status === 'available');
    const stored = await models.DigitalAsset.findByPk(a.id);
    expect(stored.storageKey).toBeTruthy();
    expect(stored.malwareStatus).toBe('skipped');
    expect(fs.existsSync(stagingPath(a.id))).toBe(false);
    expect(await eventsOf(a.id)).toEqual(
      expect.arrayContaining(['ingest', 'validation', 'checksum_calculation', 'malware_scan']),
    );
  });

  it('keeps the staged file when storage fails, and stores it when the upload is reprocessed', async () => {
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    const res = await upload(await tiff('#664422'), 'retry.tif');
    expect(res.status).toBe(201);
    const id = res.body.data[0].id;

    await waitFor(async () => (await models.DigitalAsset.findByPk(id)).status === 'failed');
    let asset = await models.DigitalAsset.findByPk(id);
    expect(asset.storageKey).toBeNull();
    expect(asset.ingestError).toMatch(/storage unavailable/);
    expect(fs.existsSync(stagingPath(id))).toBe(true);
    // Staff may see the asset, but there is no stored file to deliver yet.
    const early = await archivist.post(`/api/v1/digital-assets/${id}/link`).send({});
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/still being received/);

    const re = await chief.post(`/api/v1/digital-assets/${id}/reprocess`);
    expect(re.status).toBe(202);
    await waitFor(async () => (await models.DigitalAsset.findByPk(id)).status === 'available');
    asset = await models.DigitalAsset.findByPk(id);
    expect(asset.storageKey).toBeTruthy();
    expect(asset.ingestError).toBeNull();
    expect(fs.existsSync(stagingPath(id))).toBe(false);
  });

  it('rejects an infected file without storing it', async () => {
    scanFile.mockResolvedValueOnce({ status: 'infected', signature: 'Eicar-Test-Signature' });
    const res = await upload(await tiff('#446622'), 'infected.tif');
    expect(res.status).toBe(201);
    const id = res.body.data[0].id;

    await waitFor(async () => (await models.DigitalAsset.findByPk(id)).status === 'rejected');
    const asset = await models.DigitalAsset.findByPk(id);
    expect(asset.malwareStatus).toBe('infected');
    expect(asset.storageKey).toBeNull();
    expect(asset.ingestError).toMatch(/malware scan/);
    expect(fs.existsSync(stagingPath(id))).toBe(false);
    expect(await eventsOf(id)).toContain('malware_scan');
    expect(await models.AuditEvent.count({ where: { action: 'asset.upload_rejected', resourceId: id } })).toBe(1);

    // An infected file is hidden from everyone, staff included.
    expect((await archivist.post(`/api/v1/digital-assets/${id}/link`).send({})).status).toBe(404);
  });
});

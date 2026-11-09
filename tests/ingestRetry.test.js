/**
 * Integration test for retrying a failed ingest: a failed attempt marks the file as failed, and the next attempt
 * processes it again instead of skipping it.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import sharp from 'sharp';
import { loginAs, publishedFonds, waitFor } from './helpers.js';
import { models } from '../src/database/models/index.js';
import { storage } from '../src/services/storage/index.js';
import { processAsset } from '../src/modules/digital-assets/assets.service.js';

let archivist, chief;
beforeAll(async () => {
  [archivist, chief] = await Promise.all([loginAs('archivist'), loginAs('chief')]);
});
afterEach(() => vi.restoreAllMocks());

describe('retrying a failed ingest', () => {
  it('marks the file failed when storage cannot be read, then recovers on the next attempt', async () => {
    const fonds = await publishedFonds(archivist, chief, { title: 'Ingest retry fonds' });
    const img = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#553377' } })
      .tiff()
      .toBuffer();
    const up = await archivist.post('/api/v1/digital-assets').field('recordId', fonds.id).attach('files', img, 'r.tif');
    expect(up.status).toBe(201);
    const id = up.body.data[0].id;
    // Replication is the last job the upload starts; once it has finished, nothing else is reading storage.
    await waitFor(async () => (await models.StorageReplica.findOne({ where: { assetId: id } }))?.status === 'verified');

    await models.DigitalAsset.update({ status: 'processing' }, { where: { id } });
    vi.spyOn(storage, 'get').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(processAsset(id)).rejects.toThrow('storage unavailable');
    let asset = await models.DigitalAsset.findByPk(id);
    expect(asset.status).toBe('failed');
    expect(asset.ingestError).toBe('storage unavailable');

    await expect(processAsset(id)).resolves.toEqual({ status: 'available' });
    asset = await models.DigitalAsset.findByPk(id);
    expect(asset.status).toBe('available');
    expect(asset.ingestError).toBeNull();
    // The earlier run's access copy and thumbnail are reused, not duplicated.
    expect(await models.DigitalAsset.count({ where: { parentAssetId: id } })).toBe(2);
  });
});

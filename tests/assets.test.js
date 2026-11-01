/**
 * Integration tests for digital assets: signature checks, hashing, private storage and background derivatives;
 * publication rules and secure, re-checked delivery; and preservation events and fixity.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loginAs, anon, waitFor, publishedFonds, createCompleteFonds } from './helpers.js';
import { models } from '../src/database/models/index.js';
import { runFixityCheck, replicate } from '../src/services/preservation.service.js';

let archivist, chief, png, png2;
beforeAll(async () => {
  [archivist, chief] = await Promise.all([loginAs('archivist'), loginAs('chief')]);
  png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 15, g: 92, b: 77 } } })
    .png()
    .toBuffer();
  png2 = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 200, g: 160, b: 40 } } })
    .png()
    .toBuffer();
});

/**
 * Uploads one file to a description through the API, as the given user.
 *
 * @param {object} client Logged-in test client.
 * @param {string} recordId Description to attach the file to.
 * @param {Buffer} buf File content.
 * @param {string} name File name.
 * @param {Record<string, string>} [headers={}] Extra request headers, such as an idempotency key.
 * @returns {object} The pending Supertest request.
 */
const upload = (client, recordId, buf, name, headers = {}) => {
  let req = client.post('/api/v1/digital-assets');
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.field('recordId', recordId).attach('files', buf, name);
};

describe('digital asset ingest', () => {
  it('validates signatures, hashes, stores privately and creates derivatives in the background', async () => {
    const fonds = await createCompleteFonds(archivist);
    const res = await upload(archivist, fonds.id, png, 'campus.png');
    expect(res.status).toBe(201);
    const a = res.body.data[0];
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.storageKey).toBeUndefined();
    const done = await waitFor(async () => {
      const d = await archivist.get(`/api/v1/digital-assets/${a.id}`);
      return d.body.data.status === 'available' && d.body.data;
    });
    expect(done.width).toBe(800);
    expect(done.derivatives.map((d) => d.role).sort()).toEqual(['access_derivative', 'thumbnail']);
    expect(done.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        'ingest',
        'validation',
        'malware_scan',
        'checksum_calculation',
        'metadata_extraction',
        'derivative_creation',
      ]),
    );
  });

  it('rejects files whose content does not match an accepted format', async () => {
    const fonds = await createCompleteFonds(archivist);
    const res = await upload(archivist, fonds.id, Buffer.from('MZ\x90\x00 this is not really a pdf'), 'report.pdf');
    expect(res.status).toBe(422);
    expect(res.body.meta.rejected[0].error).toMatch(/not a recognised or permitted|not an accepted format/);
  });

  it('supports idempotent retries and blocks duplicate content on the same description', async () => {
    const fonds = await createCompleteFonds(archivist);
    const r1 = await upload(archivist, fonds.id, png2, 'a.png', { 'Idempotency-Key': `k-${fonds.id}` });
    const r2 = await upload(archivist, fonds.id, png2, 'a.png', { 'Idempotency-Key': `k-${fonds.id}` });
    expect(r2.status).toBe(200);
    expect(r2.body.meta.replayed).toBe(true);
    expect(r2.body.data[0].id).toBe(r1.body.data[0].id);
    const dup = await upload(archivist, fonds.id, png2, 'b.png');
    expect(dup.status).toBe(422);
    expect(dup.body.meta.rejected[0].duplicateOfId).toBe(r1.body.data[0].id);
  });
});

describe('publication and secure delivery', () => {
  it('never publishes masters, re-checks access on every fetch, and honours withdrawal', async () => {
    const fonds = await publishedFonds(archivist, chief, { accessLevel: 'open' });
    // Loosening to open needs approval; set via the approved path quickly for the test.
    await models.ArchivalRecord.update({ accessLevel: 'open' }, { where: { id: fonds.id } });
    const { refreshEffectiveAccess } = await import('../src/services/accessPolicy.service.js');
    await refreshEffectiveAccess(fonds.id);
    const up = await upload(archivist, fonds.id, png, 'photo.png');
    expect(up.status).toBe(201);
    const master = up.body.data[0];
    await waitFor(async () => (await models.DigitalAsset.findByPk(master.id)).status === 'available');
    expect((await chief.post(`/api/v1/digital-assets/${master.id}/publish`).send({ publish: true })).status).toBe(400);
    const deriv = await models.DigitalAsset.findOne({ where: { parentAssetId: master.id, role: 'access_derivative' } });
    const unscanned = await chief.post(`/api/v1/digital-assets/${deriv.id}/publish`).send({ publish: true });
    expect(unscanned.status).toBe(400);
    expect(unscanned.body.error.message).toMatch(/malware/);
    // Simulate a clean scan result (ClamAV is disabled in the test environment).
    await models.DigitalAsset.update({ malwareStatus: 'clean' }, { where: { id: [deriv.id, master.id] } });
    expect((await chief.post(`/api/v1/digital-assets/${deriv.id}/publish`).send({ publish: true })).status).toBe(200);

    const masterLink = await anon().post(`/api/v1/digital-assets/${master.id}/link`).send({});
    expect(masterLink.status).toBe(404);
    const link = await anon().post(`/api/v1/digital-assets/${deriv.id}/link`).send({});
    expect(link.status).toBe(200);
    const file = await anon().get(link.body.data.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    const ranged = await anon().get(link.body.data.url).set('Range', 'bytes=0-9');
    expect(ranged.status).toBe(206);
    expect(Number(ranged.headers['content-length'])).toBe(10);

    await chief.post(`/api/v1/records/${fonds.id}/transition`).send({ action: 'withdraw', reason: 'Rights query' });
    expect((await anon().get(link.body.data.url)).status).toBe(404);
  });
});

describe('preservation', () => {
  it('detects corruption, never rewrites the expected checksum, and recovers from a verified replica', async () => {
    const fonds = await createCompleteFonds(archivist);
    const res = await upload(archivist, fonds.id, png2, 'fixity.png');
    const id = res.body.data[0].id;
    await waitFor(async () => (await models.DigitalAsset.findByPk(id)).status === 'available');
    expect((await runFixityCheck(id, 'manual')).status).toBe('passed');
    await replicate(id);
    const asset = await models.DigitalAsset.findByPk(id);
    const original = asset.sha256;
    await fs.writeFile(path.resolve('storage-test', asset.storageKey), 'corrupted bytes');
    expect((await runFixityCheck(id, 'manual')).status).toBe('failed');
    const after = await models.DigitalAsset.findByPk(id);
    expect(after.sha256).toBe(original);
    expect(after.preservationStatus).toBe('fixity_failed');
    const alert = await models.PreservationAlert.findOne({ where: { assetId: id, status: 'open' } });
    expect(alert.alertType).toBe('fixity_failure');
    const closeEarly = await chief
      .post(`/api/v1/preservation/alerts/${alert.id}/status`)
      .send({ status: 'closed', note: 'nothing to see' });
    expect(closeEarly.status).toBe(400);
    const replica = await models.StorageReplica.findOne({ where: { assetId: id } });
    const rec = await chief
      .post(`/api/v1/preservation/alerts/${alert.id}/recover`)
      .field('replicaId', replica.id)
      .field('note', 'Restored from replica after corruption');
    expect(rec.status).toBe(200);
    expect(rec.body.data.verification.status).toBe('passed');
    expect((await models.PreservationAlert.findByPk(alert.id)).status).toBe('recovered');
  });
});

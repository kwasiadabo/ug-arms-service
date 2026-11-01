/**
 * Integration tests for Journey H: appraisal, legal holds and authorised disposal, including the dry run, two
 * distinct approvals, typed confirmation, blocking by a legal hold, destruction of every stored copy of a disposed
 * file, and the legal holds that the Object Lock sweep mirrors onto stored files.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { loginAs, createCompleteFonds, uniq, waitFor } from './helpers.js';
import { models } from '../src/database/models/index.js';
import { storage } from '../src/services/storage/index.js';
import { heldAssetIds } from '../src/services/objectLock.service.js';

let archivist, chief, records, approver2;
beforeAll(async () => {
  [archivist, chief, records] = await Promise.all([loginAs('archivist'), loginAs('chief'), loginAs('records')]);
  // A second disposal approver (distinct person) for the two-approval rule; seeded with the demo accounts.
  expect(await models.User.count({ where: { email: 'deputy.archivist@ugarms.local', status: 'active' } })).toBe(1);
  approver2 = await loginAs('deputy.archivist@ugarms.local');
});

/**
 * Creates a non-permanent departmental fonds with one box in a new storage room, as material that may become
 * eligible for disposal.
 *
 * @returns {Promise<{ rec: object, box: object }>}
 */
async function departmentalRecordWithBox() {
  const rec = await createCompleteFonds(archivist, { custodyStatus: 'departmental', isPermanent: false });
  const types = (await archivist.get('/api/v1/locations/types')).body.data;
  const loc = await archivist
    .post('/api/v1/locations')
    .send({ code: uniq('DL'), name: 'Records centre', typeId: types.find((t) => t.code === 'room').id });
  const box = await archivist
    .post('/api/v1/physical-items')
    .send({ barcode: uniq('DB'), title: 'Expired finance vouchers', recordId: rec.id, locationId: loc.body.data.id });
  return { rec, box: box.body.data };
}

/**
 * Opens an appraisal case for a description and takes it through review and a recommendation to dispose (by the
 * records officer) to approval (by the chief archivist).
 *
 * @param {string} recordId Description to appraise.
 * @param {object[]} [items] Case items, when the case should cover something other than the whole description.
 * @returns {Promise<string>} Identifier of the approved case.
 */
async function approvedAppraisal(recordId, items = [{ recordId }]) {
  const c = await records.post('/api/v1/appraisal/cases').send({ title: 'Finance vouchers review', items });
  const id = c.body.data.id;
  await records.post(`/api/v1/appraisal/cases/${id}/transition`).send({ action: 'start_review' });
  await records
    .post(`/api/v1/appraisal/cases/${id}/transition`)
    .send({ action: 'recommend', recommendation: 'dispose', rationale: 'Retention period met; no archival value' });
  await records.post(`/api/v1/appraisal/cases/${id}/transition`).send({ action: 'request_approval' });
  const ok = await chief.post(`/api/v1/appraisal/cases/${id}/transition`).send({ action: 'approve', reason: 'Agreed' });
  expect(ok.status).toBe(200);
  return id;
}

describe('Journey H: appraisal, legal hold and authorised disposal', () => {
  it('protects permanent archival holdings from disposal', async () => {
    const permanent = await createCompleteFonds(archivist);
    const c = await records
      .post('/api/v1/appraisal/cases')
      .send({ title: 'Should be blocked', items: [{ recordId: permanent.id }] });
    const detail = await records.get(`/api/v1/appraisal/cases/${c.body.data.id}`);
    expect(detail.body.data.items[0].eligibility).toBe('blocked_permanent');
  });

  it('requires dry run, two distinct approvals of the same fingerprint, typed confirmation, and issues a certificate', async () => {
    const { rec, box } = await departmentalRecordWithBox();
    const caseId = await approvedAppraisal(rec.id);
    const d = await records
      .post('/api/v1/disposal/cases')
      .send({ appraisalCaseId: caseId, action: 'destroy_physical' });
    expect(d.status).toBe(201);
    const did = d.body.data.id;
    expect(d.body.data.dryRunSnapshot.targets.map((t) => t.id)).toContain(box.id);
    await records.post(`/api/v1/disposal/cases/${did}/request-approval`).send({});
    const fp = d.body.data.dryRunSnapshot.fingerprint;
    expect((await records.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: fp })).status).toBe(403);
    expect(
      (await chief.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: 'f'.repeat(64) })).status,
    ).toBe(409);
    const a1 = await chief
      .post(`/api/v1/disposal/cases/${did}/approve`)
      .send({ fingerprint: fp, reason: 'Reviewed list' });
    expect(a1.body.data.status).toBe('pending_approval');
    expect((await chief.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: fp })).status).toBe(409);
    const a2 = await approver2
      .post(`/api/v1/disposal/cases/${did}/approve`)
      .send({ fingerprint: fp, reason: 'Second approval' });
    expect(a2.body.data.status).toBe('approved');
    expect((await chief.post(`/api/v1/disposal/cases/${did}/execute`).send({ confirmation: 'yes' })).status).toBe(400);
    const exec = await chief
      .post(`/api/v1/disposal/cases/${did}/execute`)
      .send({ confirmation: d.body.data.caseNumber });
    expect(exec.status).toBe(200);
    expect((await models.PhysicalItem.findByPk(box.id)).status).toBe('disposed');
    const after = await chief.get(`/api/v1/disposal/cases/${did}`);
    expect(after.body.data.status).toBe('executed');
    expect(after.body.data.certificates[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await chief.get(`/api/v1/disposal/certificates/${after.body.data.certificates[0].id}/pdf`)).status).toBe(
      200,
    );
    // The description itself is retained as evidence.
    expect(await models.ArchivalRecord.findByPk(rec.id)).not.toBeNull();
  });

  it('a legal hold placed after approval blocks execution', async () => {
    const { rec } = await departmentalRecordWithBox();
    const caseId = await approvedAppraisal(rec.id);
    const d = await records
      .post('/api/v1/disposal/cases')
      .send({ appraisalCaseId: caseId, action: 'destroy_physical' });
    const did = d.body.data.id;
    await records.post(`/api/v1/disposal/cases/${did}/request-approval`).send({});
    const fp = d.body.data.dryRunSnapshot.fingerprint;
    await chief.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: fp });
    await approver2.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: fp });
    const hold = await chief
      .post('/api/v1/legal-holds')
      .send({ title: 'Audit investigation 2026', items: [{ recordId: rec.id }] });
    expect(hold.status).toBe(201);
    expect((await chief.get(`/api/v1/disposal/cases/${did}`)).body.data.status).toBe('blocked');
    expect(
      (await chief.post(`/api/v1/disposal/cases/${did}/execute`).send({ confirmation: d.body.data.caseNumber })).status,
    ).toBe(409);
    // The person who placed the hold cannot release it alone.
    expect(
      (await chief.post(`/api/v1/legal-holds/${hold.body.data.id}/release`).send({ reason: 'Investigation closed' }))
        .status,
    ).toBe(403);
  });

  it('digital disposal destroys the file with its access copies and replicas, and records the outcome', async () => {
    const rec = await createCompleteFonds(archivist, { custodyStatus: 'departmental', isPermanent: false });
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 30, b: 20 } } })
      .png()
      .toBuffer();
    const up = await archivist
      .post('/api/v1/digital-assets')
      .field('recordId', rec.id)
      .attach('files', png, 'voucher.png');
    expect(up.status).toBe(201);
    const masterId = up.body.data[0].id;
    await waitFor(
      async () => (await models.StorageReplica.count({ where: { assetId: masterId, status: 'verified' } })) > 0,
    );
    const master = await models.DigitalAsset.findByPk(masterId);
    const derivatives = await models.DigitalAsset.findAll({ where: { parentAssetId: masterId } });
    const replicas = await models.StorageReplica.findAll({ where: { assetId: masterId } });
    expect(derivatives.map((d) => d.role).sort()).toEqual(['access_derivative', 'thumbnail']);
    const keys = [master.storageKey, ...derivatives.map((d) => d.storageKey), ...replicas.map((r) => r.storageKey)];
    for (const key of keys) expect((await storage.head(key)).exists).toBe(true);

    // The case names only the master; its access copy and thumbnail must be listed in the dry run too.
    const caseId = await approvedAppraisal(rec.id, [{ assetId: masterId }]);
    const d = await records.post('/api/v1/disposal/cases').send({ appraisalCaseId: caseId, action: 'delete_digital' });
    expect(d.status).toBe(201);
    const did = d.body.data.id;
    const targetIds = d.body.data.dryRunSnapshot.targets.filter((t) => t.type === 'digital_asset').map((t) => t.id);
    expect(targetIds.sort()).toEqual([masterId, ...derivatives.map((x) => x.id)].sort());
    await records.post(`/api/v1/disposal/cases/${did}/request-approval`).send({});
    const fp = d.body.data.dryRunSnapshot.fingerprint;
    await chief.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: fp });
    await approver2.post(`/api/v1/disposal/cases/${did}/approve`).send({ fingerprint: fp });
    const exec = await chief
      .post(`/api/v1/disposal/cases/${did}/execute`)
      .send({ confirmation: d.body.data.caseNumber });
    expect(exec.status).toBe(200);
    expect(exec.body.data.destruction).toEqual({ files: keys.length, destroyed: keys.length, failed: 0 });
    for (const key of keys) expect((await storage.head(key)).exists).toBe(false);
    const saved = (await chief.get(`/api/v1/disposal/cases/${did}`)).body.data.executionResult;
    expect(saved.destruction).toEqual({ files: keys.length, destroyed: keys.length, failed: 0 });
    const statuses = await models.DigitalAsset.findAll({ where: { id: targetIds }, attributes: ['status'] });
    expect(statuses.every((a) => a.status === 'deleted')).toBe(true);
    expect(await models.AuditEvent.count({ where: { action: 'disposal.files_destroyed', resourceId: did } })).toBe(1);
    // A retry is harmless once everything has been destroyed.
    const retry = await chief.post(`/api/v1/disposal/cases/${did}/destroy-files`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.data.failed).toBe(0);
    // Only an executed disposal can have its files destroyed.
    expect((await records.post(`/api/v1/disposal/cases/${did}/destroy-files`).send({})).status).toBe(403);
  });

  it('works out which files a legal hold covers, including descendants of a held description', async () => {
    const parent = await createCompleteFonds(archivist, { custodyStatus: 'departmental', isPermanent: false });
    const childId = (
      await createCompleteFonds(archivist, {
        parentId: parent.id,
        level: 'series',
        title: 'Payment vouchers',
        custodyStatus: 'departmental',
        isPermanent: false,
      })
    ).id;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const up = await archivist.post('/api/v1/digital-assets').field('recordId', childId).attach('files', png, 'v.png');
    const assetId = up.body.data[0].id;
    expect((await heldAssetIds()).has(assetId)).toBe(false);
    const hold = await chief
      .post('/api/v1/legal-holds')
      .send({ title: 'Procurement audit', items: [{ recordId: parent.id, includeDescendants: true }] });
    expect(hold.status).toBe(201);
    expect((await heldAssetIds()).has(assetId)).toBe(true);
    const released = await approver2
      .post(`/api/v1/legal-holds/${hold.body.data.id}/release`)
      .send({ reason: 'Audit closed' });
    expect(released.status).toBe(200);
    expect((await heldAssetIds()).has(assetId)).toBe(false);
    // Placing and releasing the hold each queued the sweep that mirrors holds onto stored files.
    expect(
      await models.BackgroundJob.count({
        where: { jobType: 'preservation.object_lock_sweep', entityId: hold.body.data.id },
      }),
    ).toBe(2);
  });
});

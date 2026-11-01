/**
 * Integration tests for Journeys B and C: departmental transfers (own-unit restriction, inventory validation,
 * submission, line-by-line decisions), accession approval and receipts, and physical storage with capacity checks.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loginAs, uniq } from './helpers.js';
import { models } from '../src/database/models/index.js';

let liaison, records, chief, archivist, histUnit, physUnit;
beforeAll(async () => {
  [liaison, records, chief, archivist] = await Promise.all([
    loginAs('liaison'),
    loginAs('records'),
    loginAs('chief'),
    loginAs('archivist'),
  ]);
  histUnit = await models.OrganisationUnit.findOne({ where: { code: 'HIST' } });
  physUnit = await models.OrganisationUnit.findOne({ where: { code: 'PHYS' } });
});

/**
 * Creates a draft transfer for the Department of History.
 *
 * @param {object} [client=liaison] Logged-in client creating the transfer.
 * @returns {Promise<object>} The transfer.
 */
async function draftTransfer(client = liaison) {
  const res = await client.post('/api/v1/transfers').send({
    title: 'History department correspondence',
    originatingUnitId: histUnit.id,
    contactName: 'Kwame Addo',
    proposedTransferDate: '2026-11-15',
    transferAuthority: 'Head of Department memo 12/2026',
  });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('Journey B: departmental transfer', () => {
  it('liaison can only prepare transfers for their own unit', async () => {
    const res = await liaison.post('/api/v1/transfers').send({
      title: 'Not mine',
      originatingUnitId: physUnit.id,
      contactName: 'Someone Else',
      proposedTransferDate: '2026-11-15',
      transferAuthority: 'Memo',
    });
    expect(res.status).toBe(403);
  });

  it('validates the inventory and blocks submission until it is complete', async () => {
    const t = await draftTransfer();
    expect((await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'submit' })).status).toBe(422);
    const bad = await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'A', sourceIdentifier: 'X1', dateStart: '1999-13-45' },
        { title: 'B', sourceIdentifier: 'X1' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d) => d.message).join(' ')).toMatch(/Duplicate identifier/);
  });

  it('runs submit → query → resubmit → partial acceptance → accession, preserving revisions', async () => {
    const t = await draftTransfer();
    await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'Staff minutes 1960-1965', sourceIdentifier: 'H/1', dateStart: '1960', dateEnd: '1965', quantity: 2 },
        { title: 'Duplicate copies', sourceIdentifier: 'H/2' },
      ],
    });
    const sub = await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'submit' });
    expect(sub.status).toBe(200);
    expect(sub.body.data.referenceNumber).toMatch(/^UGA\/TRF\/\d{4}\/\d{4}$/);
    // Liaison cannot review.
    expect((await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'start_review' })).status).toBe(
      403,
    );
    expect((await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'raise_query' })).status).toBe(
      422,
    );
    expect(
      (
        await records
          .post(`/api/v1/transfers/${t.id}/transition`)
          .send({ action: 'raise_query', reason: 'Please give the date range for line 2' })
      ).status,
    ).toBe(200);
    await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'Staff minutes 1960-1965', sourceIdentifier: 'H/1', dateStart: '1960', dateEnd: '1965', quantity: 2 },
        { title: 'Duplicate copies', sourceIdentifier: 'H/2', dateExpression: '1970s' },
      ],
    });
    expect((await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'resubmit' })).status).toBe(200);
    await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'start_review' });
    const detail = await records.get(`/api/v1/transfers/${t.id}`);
    const [l1, l2] = detail.body.data.items;
    const noDecisions = await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'partially_accept' });
    expect(noDecisions.status).toBe(422);
    const partial = await records.post(`/api/v1/transfers/${t.id}/transition`).send({
      action: 'partially_accept',
      reason: 'Duplicates not retained',
      itemDecisions: [
        { itemId: l1.id, decision: 'accepted' },
        { itemId: l2.id, decision: 'rejected', note: 'Duplicates' },
      ],
    });
    expect(partial.status).toBe(200);
    const after = await liaison.get(`/api/v1/transfers/${t.id}`);
    expect(after.body.data.revisions.length).toBe(2);
    expect(after.body.data.comments.length).toBeGreaterThan(0);
    // Liaison cannot accession; records officer can, and repeat calls do not duplicate.
    expect((await liaison.post(`/api/v1/transfers/${t.id}/create-accession`).send({})).status).toBe(403);
    const acc1 = await records.post(`/api/v1/transfers/${t.id}/create-accession`).send({});
    expect(acc1.status).toBe(201);
    const acc2 = await records.post(`/api/v1/transfers/${t.id}/create-accession`).send({});
    expect(acc2.status).toBe(200);
    expect(acc2.body.data.id).toBe(acc1.body.data.id);
    const acc = await records.get(`/api/v1/accessions/${acc1.body.data.id}`);
    expect(acc.body.data.items.map((i) => i.description)).toEqual(['Staff minutes 1960-1965']);
  });
});

describe('Journey C: accession approval', () => {
  it('flags missing information, enforces separation of duties and issues a receipt', async () => {
    const created = await archivist
      .post('/api/v1/accessions')
      .send({ title: 'Donated photographs', sourceType: 'donor', donorName: 'Estate of a former lecturer' });
    expect(created.status).toBe(201);
    expect(created.body.data.accessionNumber).toMatch(/^UGA\/ACC\//);
    const id = created.body.data.id;
    await archivist.put(`/api/v1/accessions/${id}/items`).send({
      items: [
        { description: 'Album of campus photographs', quantity: 1 },
        { description: 'Loose prints', quantity: 40 },
      ],
    });
    const sub = await archivist.post(`/api/v1/accessions/${id}/transition`).send({ action: 'submit' });
    expect(sub.status).toBe(200);
    const d = await chief.get(`/api/v1/accessions/${id}`);
    expect(d.body.data.missing).toEqual(expect.arrayContaining(['transferAuthorityOrLegalBasis', 'rightsStatement']));
    await chief.post(`/api/v1/accessions/${id}/transition`).send({ action: 'start_review' });
    expect((await archivist.post(`/api/v1/accessions/${id}/transition`).send({ action: 'approve' })).status).toBe(403);
    expect((await chief.get(`/api/v1/accessions/${id}/receipt`)).status).toBe(400);
    await chief.post(`/api/v1/accessions/${id}/quarantine`).send({ quarantine: true, reason: 'Mould suspected' });
    expect((await chief.post(`/api/v1/accessions/${id}/transition`).send({ action: 'approve' })).status).toBe(400);
    await chief
      .post(`/api/v1/accessions/${id}/quarantine`)
      .send({ quarantine: false, reason: 'Cleared by conservator' });
    const items = d.body.data.items;
    const ok = await chief.post(`/api/v1/accessions/${id}/transition`).send({
      action: 'approve',
      itemDecisions: [
        { itemId: items[0].id, decision: 'accepted' },
        { itemId: items[1].id, decision: 'rejected' },
      ],
    });
    expect(ok.status).toBe(200);
    const receipt = await chief.get(`/api/v1/accessions/${id}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');
    const col = await archivist
      .post(`/api/v1/accessions/${id}/create-collection`)
      .send({ localIdentifier: uniq('PH'), level: 'collection' });
    expect(col.status).toBe(201);
    expect(col.body.data.status).toBe('draft');
  });
});

describe('physical storage', () => {
  it('enforces capacity with an authorised, audited override and records every movement', async () => {
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const room = types.find((t) => t.code === 'room');
    const shelf = types.find((t) => t.code === 'shelf');
    const r = await archivist.post('/api/v1/locations').send({ code: uniq('RM'), name: 'Strongroom', typeId: room.id });
    const tmpShelf = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'S', typeId: shelf.id, parentId: r.body.data.id });
    expect(
      (
        await archivist
          .post('/api/v1/locations')
          .send({ code: uniq('BAD'), name: 'Room in shelf', typeId: room.id, parentId: tmpShelf.body.data.id })
      ).status,
    ).toBe(400);
    const s = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'Shelf A', typeId: shelf.id, parentId: r.body.data.id, capacity: 1 });
    const s2 = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'Shelf B', typeId: shelf.id, parentId: r.body.data.id });
    const b1 = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('BX'), title: 'Box 1', locationId: s.body.data.id });
    expect(b1.status).toBe(201);
    const full = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('BX'), title: 'Box 2', locationId: s.body.data.id });
    expect(full.status).toBe(409);
    const noPerm = await archivist.post('/api/v1/physical-items').send({
      barcode: uniq('BX'),
      title: 'Box 2',
      locationId: s.body.data.id,
      override: true,
      overrideReason: 'Temporary',
    });
    expect(noPerm.status).toBe(403);
    const over = await chief.post('/api/v1/physical-items').send({
      barcode: uniq('BX'),
      title: 'Box 2',
      locationId: s.body.data.id,
      override: true,
      overrideReason: 'Temporary while shelving is installed',
    });
    expect(over.status).toBe(201);
    const mv = await archivist
      .post(`/api/v1/physical-items/${b1.body.data.id}/move`)
      .send({ toLocationId: s2.body.data.id, movementType: 'permanent', reason: 'Re-shelving' });
    expect(mv.status).toBe(200);
    const item = await archivist.get(`/api/v1/physical-items/${b1.body.data.id}`);
    expect(item.body.data.movements.map((m) => m.movementType)).toEqual(['permanent', 'initial_placement']);
    expect(item.body.data.homeLocation.id).toBe(s2.body.data.id);
    const labels = await archivist.post('/api/v1/locations/labels').send({ itemIds: [b1.body.data.id] });
    expect(labels.status).toBe(200);
  });

  it('reconciles an inventory audit', async () => {
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const loc = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('AU'), name: 'Audit room', typeId: types.find((t) => t.code === 'room').id });
    const a = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('A'), title: 'Present', locationId: loc.body.data.id });
    const b = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('A'), title: 'Absent', locationId: loc.body.data.id });
    const audit = await archivist.post(`/api/v1/locations/${loc.body.data.id}/audits`).send({});
    await archivist.post(`/api/v1/locations/audits/${audit.body.data.id}/scan`).send({ barcode: a.body.data.barcode });
    await archivist.post(`/api/v1/locations/audits/${audit.body.data.id}/scan`).send({ barcode: 'NOT-A-REAL-CODE' });
    const done = await archivist
      .post(`/api/v1/locations/audits/${audit.body.data.id}/complete`)
      .send({ markMissing: true });
    expect(done.body.data.summary).toMatchObject({ expected: 2, found: 1, unexpected: 1, missing: 1 });
    expect((await archivist.get(`/api/v1/physical-items/${b.body.data.id}`)).body.data.status).toBe('missing');
  });
});

/**
 * Integration tests for Journey E (a restricted request through two approvals, booking, check-in, issue and
 * return), Journey D (digitisation with quality review and rework), and de-duplication of request items.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { loginAs, anon, publishedFonds, uniq, waitFor } from './helpers.js';
import { models } from '../src/database/models/index.js';

let archivist, chief, researcher, readingRoom, digitisation;
beforeAll(async () => {
  [archivist, chief, researcher, readingRoom, digitisation] = await Promise.all([
    loginAs('archivist'),
    loginAs('chief'),
    loginAs('researcher'),
    loginAs('readingRoom'),
    loginAs('digitisation'),
  ]);
});

describe('Journey E: restricted request to supervised consultation', () => {
  it('runs two-person approval, grants time-limited access, books capacity, and guards circulation', async () => {
    const fonds = await publishedFonds(archivist, chief, {
      accessLevel: 'restricted',
      title: 'Council confidential minutes',
    });
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const loc = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('RR'), name: 'Strongroom B', typeId: types.find((t) => t.code === 'room').id });
    const box = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('BOX'), title: 'Minutes box 1', recordId: fonds.id, locationId: loc.body.data.id });

    // Researcher sees only metadata before approval.
    expect((await researcher.get(`/api/v1/public/records/${fonds.id}`)).body.data.access.mode).toBe('metadata_only');
    const noAck = await researcher.post('/api/v1/research-requests').send({
      requestType: 'restricted_access',
      purpose: 'Doctoral research on university governance',
      items: [{ recordId: fonds.id }],
    });
    expect(noAck.status).toBe(422);
    const created = await researcher.post('/api/v1/research-requests').send({
      requestType: 'restricted_access',
      purpose: 'Doctoral research on university governance',
      restrictionsAcknowledged: true,
      items: [{ recordId: fonds.id }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.requiresSecondApproval).toBe(true);

    await archivist.post(`/api/v1/research-requests/${id}/actions`).send({ action: 'start_review' });
    const first = await archivist.post(`/api/v1/research-requests/${id}/actions`).send({
      action: 'approve',
      publicNote: 'Approved subject to conditions',
      internalNote: 'Checked donor agreement',
      conditions: 'No photography',
    });
    expect(first.body.data.status).toBe('awaiting_approval');
    expect((await archivist.post(`/api/v1/research-requests/${id}/actions`).send({ action: 'approve' })).status).toBe(
      403,
    );
    const second = await chief
      .post(`/api/v1/research-requests/${id}/actions`)
      .send({ action: 'approve', publicNote: 'Approved' });
    expect(second.body.data.status).toBe('approved');

    const mine = await researcher.get(`/api/v1/research-requests/${id}`);
    expect(mine.body.data.internalDecisionNote).toBeUndefined();
    expect(JSON.stringify(mine.body.data.comments)).not.toMatch(/donor agreement/);
    expect((await researcher.get(`/api/v1/public/records/${fonds.id}`)).body.data.access.mode).toBe('full');

    const room = await readingRoom.post('/api/v1/reading-rooms').send({ name: uniq('Reading Room '), capacity: 1 });
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await readingRoom
      .post(`/api/v1/reading-rooms/${room.body.data.id}/slots/generate`)
      .send({ from: tomorrow, to: tomorrow, times: ['09:00'], durationMinutes: 180, capacity: 1, skipWeekends: false });
    const avail = await researcher.get(
      `/api/v1/reading-rooms/${room.body.data.id}/availability?from=${tomorrow}&to=${tomorrow}`,
    );
    const slotId = avail.body.data.slots[0].id;
    const booking = await researcher.post('/api/v1/appointments').send({ slotId, requestId: id });
    expect(booking.status).toBe(201);
    expect((await researcher.post('/api/v1/appointments').send({ slotId, requestId: id })).status).toBe(409);

    // Issue requires check-in and a recorded condition.
    const early = await readingRoom.post('/api/v1/circulation/issue').send({
      physicalItemId: box.body.data.id,
      requestId: id,
      appointmentId: booking.body.data.id,
      conditionBefore: 'good',
    });
    expect(early.status).toBe(400);
    await readingRoom
      .post(`/api/v1/appointments/${booking.body.data.id}/check_in`)
      .send({ identityMethod: 'University ID card' });
    const issued = await readingRoom.post('/api/v1/circulation/issue').send({
      physicalItemId: box.body.data.id,
      requestId: id,
      appointmentId: booking.body.data.id,
      conditionBefore: 'good',
    });
    expect(issued.status).toBe(201);
    expect(
      (
        await readingRoom.post('/api/v1/circulation/issue').send({
          physicalItemId: box.body.data.id,
          requestId: id,
          appointmentId: booking.body.data.id,
          conditionBefore: 'good',
        })
      ).status,
    ).toBe(409);

    // Ending the appointment does not make the item available.
    await readingRoom.post(`/api/v1/appointments/${booking.body.data.id}/complete`).send({});
    expect((await models.PhysicalItem.findByPk(box.body.data.id)).status).toBe('issued');
    const ret = await readingRoom
      .post(`/api/v1/circulation/${issued.body.data.id}/return`)
      .send({ conditionAfter: 'good' });
    expect(ret.status).toBe(200);
    expect((await models.PhysicalItem.findByPk(box.body.data.id)).status).toBe('available');

    const anonDenied = await anon()
      .post('/api/v1/research-requests/public')
      .send({
        requestType: 'restricted_access',
        purpose: 'Trying anonymously here',
        contactName: 'Anon',
        contactEmail: 'a@example.com',
        items: [{ recordId: fonds.id }],
      });
    expect(anonDenied.status).toBe(403);
  });

  it('records damage on return and refers the item to conservation', async () => {
    const fonds = await publishedFonds(archivist, chief, { accessLevel: 'restricted' });
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const loc = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('RR'), name: 'Room', typeId: types.find((t) => t.code === 'room').id });
    const box = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('BOX'), title: 'Fragile box', recordId: fonds.id, locationId: loc.body.data.id });
    const r = await researcher.post('/api/v1/research-requests').send({
      requestType: 'consultation',
      purpose: 'Reviewing campus planning history',
      items: [{ recordId: fonds.id }],
    });
    await archivist.post(`/api/v1/research-requests/${r.body.data.id}/actions`).send({ action: 'start_review' });
    await archivist
      .post(`/api/v1/research-requests/${r.body.data.id}/actions`)
      .send({ action: 'approve', publicNote: 'Welcome' });
    const tx = await readingRoom
      .post('/api/v1/circulation/issue')
      .send({ physicalItemId: box.body.data.id, requestId: r.body.data.id, conditionBefore: 'good' });
    const back = await readingRoom
      .post(`/api/v1/circulation/${tx.body.data.id}/return`)
      .send({ conditionAfter: 'poor', incidentNotes: 'Torn page 4' });
    expect(back.body.data.status).toBe('damaged');
    expect((await models.PhysicalItem.findByPk(box.body.data.id)).status).toBe('in_conservation');
  });
});

describe('Journey D: digitisation with QA and rework', () => {
  it('requires capture of every item, separates operator and reviewer, and tracks rework', async () => {
    const fonds = await publishedFonds(archivist, chief);
    const project = await archivist
      .post('/api/v1/digitisation/projects')
      .send({ title: 'Convocation photographs', sourceRecordId: fonds.id });
    expect(
      (
        await archivist
          .post(`/api/v1/digitisation/projects/${project.body.data.id}/status`)
          .send({ status: 'approved' })
      ).status,
    ).toBe(403);
    expect(
      (await chief.post(`/api/v1/digitisation/projects/${project.body.data.id}/status`).send({ status: 'approved' }))
        .status,
    ).toBe(200);
    const batch = await archivist
      .post(`/api/v1/digitisation/projects/${project.body.data.id}/batches`)
      .send({ operatorId: digitisation.user.id, resolutionDpi: 600, ocrEnabled: false });
    const bid = batch.body.data.id;
    const items = await archivist
      .post(`/api/v1/digitisation/batches/${bid}/items`)
      .send({ items: [{ label: 'Photo 1', recordId: fonds.id, expectedPages: 1 }] });
    const itemId = items.body.data[0].id;
    await digitisation.post(`/api/v1/digitisation/batches/${bid}/transition`).send({ action: 'start' });
    expect(
      (await digitisation.post(`/api/v1/digitisation/batches/${bid}/transition`).send({ action: 'submit_capture' }))
        .status,
    ).toBe(422);
    expect(
      (await digitisation.post(`/api/v1/digitisation/items/${itemId}/captured`).send({ capturedPages: 1 })).status,
    ).toBe(400);
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#335577' } })
      .tiff()
      .toBuffer();
    const up = await digitisation
      .post('/api/v1/digital-assets')
      .field('recordId', fonds.id)
      .field('digitisationItemId', itemId)
      .attach('files', img, 'photo-0001.tif');
    expect(up.status).toBe(201);
    expect(up.body.data[0].qaStatus).toBe('pending');
    await waitFor(async () => (await models.DigitalAsset.findByPk(up.body.data[0].id)).status === 'available');
    await digitisation.post(`/api/v1/digitisation/items/${itemId}/captured`).send({ capturedPages: 1 });
    await digitisation.post(`/api/v1/digitisation/batches/${bid}/transition`).send({ action: 'submit_capture' });
    await digitisation.post(`/api/v1/digitisation/batches/${bid}/transition`).send({ action: 'processing_complete' });
    // The operator cannot review their own capture.
    expect(
      (await digitisation.post(`/api/v1/digitisation/items/${itemId}/review`).send({ outcome: 'pass' })).status,
    ).toBe(403);
    expect(
      (
        await archivist
          .post(`/api/v1/digitisation/items/${itemId}/review`)
          .send({ outcome: 'rework', checks: { orientation: false } })
      ).status,
    ).toBe(422);
    await archivist
      .post(`/api/v1/digitisation/items/${itemId}/review`)
      .send({ outcome: 'rework', checks: { orientation: false }, comments: 'Rotated 90 degrees' });
    expect(
      (await archivist.post(`/api/v1/digitisation/batches/${bid}/transition`).send({ action: 'approve' })).status,
    ).toBe(422);
    await archivist
      .post(`/api/v1/digitisation/batches/${bid}/transition`)
      .send({ action: 'request_rework', reason: 'Fix orientation of photo 1' });
    // The rejected master is kept; a replacement is uploaded as a new asset.
    expect((await models.DigitalAsset.findByPk(up.body.data[0].id)).status).toBe('available');
    const batchDetail = await archivist.get(`/api/v1/digitisation/batches/${bid}`);
    expect(batchDetail.body.data.status).toBe('rework_required');
    expect(batchDetail.body.data.reviews.length).toBe(1);
    expect(batchDetail.body.data.history.map((h) => h.action)).toContain('request_rework');
  });
});

describe('boxes going out for digitisation', () => {
  it('takes the boxes of a batch out of storage at the start and returns them when the batch ends', async () => {
    const fonds = await publishedFonds(archivist, chief, { title: 'Boxes for scanning' });
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const shelf = (
      await archivist
        .post('/api/v1/locations')
        .send({ code: uniq('SH'), name: 'Shelf', typeId: types.find((x) => x.code === 'shelf').id })
    ).body.data;
    const box = async (title) =>
      (await archivist.post('/api/v1/physical-items').send({ barcode: uniq('BX'), title, locationId: shelf.id })).body
        .data;
    const [a, b, c] = [await box('Box A'), await box('Box B'), await box('Box C')];
    await archivist.post(`/api/v1/physical-items/${c.id}/report-missing`).send({ reason: 'Not on the shelf' });

    const project = (
      await archivist.post('/api/v1/digitisation/projects').send({ title: 'Scan boxes', sourceRecordId: fonds.id })
    ).body.data;
    await chief.post(`/api/v1/digitisation/projects/${project.id}/status`).send({ status: 'approved' });
    const batch = async (items) => {
      const id = (
        await archivist
          .post(`/api/v1/digitisation/projects/${project.id}/batches`)
          .send({ operatorId: digitisation.user.id, ocrEnabled: false })
      ).body.data.id;
      await archivist.post(`/api/v1/digitisation/batches/${id}/items`).send({ items });
      return id;
    };
    const go = (id, action, extra = {}) =>
      digitisation.post(`/api/v1/digitisation/batches/${id}/transition`).send({ action, ...extra });
    const status = async (x) => (await models.PhysicalItem.findByPk(x.id)).status;

    // A batch holding a missing box cannot start, and nothing leaves storage.
    const blocked = await batch([
      { label: 'B', physicalItemId: b.id },
      { label: 'C', physicalItemId: c.id },
    ]);
    const refused = await go(blocked, 'start');
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.map((d) => d.message).join(' ')).toMatch(/is missing and cannot leave storage/);
    expect(await status(b)).toBe('available');

    // Starting takes the box out; its shelf stays recorded as where it returns.
    const first = await batch([
      { label: 'A', physicalItemId: a.id, recordId: fonds.id },
      { label: 'Loose sheet', recordId: fonds.id },
    ]);
    expect((await go(first, 'start')).status).toBe(200);
    const out = (await archivist.get(`/api/v1/physical-items/${a.id}`)).body.data;
    expect(out.status).toBe('in_digitisation');
    expect(out.currentLocation.id).toBe(shelf.id);
    expect(out.movements[0]).toMatchObject({ movementType: 'digitisation', toLocationId: null });
    expect(out.movements[0].reason).toMatch(/Out for digitisation in batch/);

    // While out, it cannot be moved by hand or taken into a second batch.
    const other = (
      await archivist.post('/api/v1/locations').send({ code: uniq('SH'), name: 'Other shelf', typeId: shelf.typeId })
    ).body.data;
    const move = await archivist
      .post(`/api/v1/physical-items/${a.id}/move`)
      .send({ toLocationId: other.id, movementType: 'permanent', reason: 'Re-shelving' });
    expect(move.status).toBe(409);
    const second = await batch([{ label: 'A again', physicalItemId: a.id }]);
    expect((await go(second, 'start')).body.error.details[0].message).toMatch(/out for digitisation in batch/);

    // A box added while capture is under way leaves storage at once.
    await archivist
      .post(`/api/v1/digitisation/batches/${first}/items`)
      .send({ items: [{ label: 'B', physicalItemId: b.id }] });
    expect(await status(b)).toBe('in_digitisation');

    // When the batch ends, both boxes return to their shelf.
    expect(
      (
        await archivist
          .post(`/api/v1/digitisation/batches/${first}/transition`)
          .send({ action: 'fail', reason: 'Scanner fault' })
      ).status,
    ).toBe(200);
    expect([await status(a), await status(b)]).toEqual(['available', 'available']);
    const back = (await archivist.get(`/api/v1/physical-items/${a.id}`)).body.data;
    expect(back.movements[0]).toMatchObject({ movementType: 'return', toLocationId: shelf.id });
  });
});

describe('digitisation planned from an accession', () => {
  it('links projects and batches to the accession and plans only material not yet digitised', async () => {
    const fonds = await publishedFonds(archivist, chief, { title: 'Accessioned papers for scanning' });
    const created = await archivist.post('/api/v1/accessions').send({
      title: 'Faculty board papers',
      sourceType: 'donor',
      donorName: 'A donor',
      accessionDate: '2026-11-06',
      legalBasis: 'Deed of gift',
      extent: '2 boxes',
      physicalCondition: 'Good',
      provenance: 'Kept by the donor',
      rightsStatement: 'University of Ghana',
    });
    const accId = created.body.data.id;
    await archivist.put(`/api/v1/accessions/${accId}/items`).send({
      items: [
        { description: 'Board minutes', quantity: 1 },
        { description: 'Framed photograph', quantity: 1 },
      ],
    });
    const summary = async () => (await archivist.get(`/api/v1/accessions/${accId}/digitisation`)).body.data;

    // Not before approval.
    expect((await summary()).canPlan).toBe(false);
    expect((await archivist.post(`/api/v1/digitisation/accessions/${accId}/projects`).send({})).status).toBe(400);
    await archivist.post(`/api/v1/accessions/${accId}/transition`).send({ action: 'submit' });
    await chief.post(`/api/v1/accessions/${accId}/transition`).send({ action: 'start_review' });
    expect((await chief.post(`/api/v1/accessions/${accId}/transition`).send({ action: 'approve' })).status).toBe(200);

    // Two registered boxes, and a described photograph that is not in a box.
    await models.AccessionRecordLink.create({ accessionId: accId, recordId: fonds.id });
    const photo = await models.AccessionItem.findOne({
      where: { accessionId: accId, description: 'Framed photograph' },
    });
    await photo.update({ recordId: fonds.id, status: 'accepted' });
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const shelf = (
      await archivist
        .post('/api/v1/locations')
        .send({ code: uniq('SH'), name: 'Shelf', typeId: types.find((x) => x.code === 'shelf').id })
    ).body.data;
    const box = async (title) =>
      (
        await archivist
          .post('/api/v1/physical-items')
          .send({ barcode: uniq('BX'), title, locationId: shelf.id, accessionId: accId })
      ).body.data;
    const [a, b] = [await box('Box 1'), await box('Box 2')];
    expect((await summary()).counts).toEqual({ total: 3, digitised: 0, inBatch: 0, notStarted: 3 });

    // A project proposed from the accession is linked to it and to its only description; it needs approval first.
    const project = (await archivist.post(`/api/v1/digitisation/accessions/${accId}/projects`).send({})).body.data;
    expect(project).toMatchObject({ accessionId: accId, sourceRecordId: fonds.id, status: 'proposed' });
    expect(project.title).toMatch(/Faculty board papers/);
    const plan = (body) => archivist.post(`/api/v1/digitisation/accessions/${accId}/batches`).send(body);
    expect((await plan({ projectId: project.id })).status).toBe(400);
    await chief.post(`/api/v1/digitisation/projects/${project.id}/status`).send({ status: 'approved' });

    // The first batch takes box 1 and the unboxed photograph, each linked to the accession.
    const first = await plan({ projectId: project.id, physicalItemIds: [a.id], operatorId: digitisation.user.id });
    expect(first.status).toBe(201);
    expect(first.body.data.items.map((i) => [i.physicalItemId, i.recordId, i.accessionId])).toEqual([
      [a.id, fonds.id, accId],
      [null, fonds.id, accId],
    ]);
    let s1 = await summary();
    expect(s1.counts).toMatchObject({ inBatch: 2, notStarted: 1 });
    expect(s1.projects[0]).toMatchObject({ id: project.id, linked: true });
    expect(s1.projects[0].batches[0]).toMatchObject({ items: 2, status: 'planned' });

    // The next batch takes only what is left, and then nothing remains to plan.
    const second = await plan({ projectId: project.id });
    expect(second.body.data.items.map((i) => i.physicalItemId)).toEqual([b.id]);
    expect((await plan({ projectId: project.id })).status).toBe(400);

    // A completed batch whose items passed quality review counts as digitised.
    const firstBatch = await models.DigitisationBatch.findByPk(first.body.data.batch.id);
    await models.DigitisationItem.update({ status: 'qa_passed' }, { where: { batchId: firstBatch.id } });
    await firstBatch.update({ status: 'completed' });
    s1 = await summary();
    expect(s1.counts).toEqual({ total: 3, digitised: 2, inBatch: 1, notStarted: 0 });
    expect(s1.boxes.find((x) => x.physicalItemId === a.id)).toMatchObject({ state: 'digitised' });

    // A project for other material cannot be used to plan this accession's batches.
    const other = (
      await archivist
        .post('/api/v1/digitisation/projects')
        .send({ title: 'Unrelated project', sourceRecordId: fonds.id })
    ).body.data;
    await chief.post(`/api/v1/digitisation/projects/${other.id}/status`).send({ status: 'approved' });
    expect((await plan({ projectId: other.id })).status).toBe(404);
  });
});

describe('research request items', () => {
  it('stores a description requested twice as a single item', async () => {
    const fonds = await publishedFonds(archivist, chief, { title: 'Duplicate request check', accessLevel: 'open' });
    const res = await researcher.post('/api/v1/research-requests').send({
      requestType: 'consultation',
      purpose: 'Checking duplicate handling in requests',
      items: [{ recordId: fonds.id }, { recordId: fonds.id }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await models.ResearchRequestItem.count({ where: { requestId: res.body.data.id } })).toBe(1);
  });
});

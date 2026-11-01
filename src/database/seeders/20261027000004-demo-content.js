/**
 * Seeder: demonstration content for development and training only.
 *
 * Skipped in production, in automated tests and whenever SEED_DEMO_DATA is false. Every description states in its
 * notes that it is fictional ("FICTIONAL DEMONSTRATION RECORD"), and generated images and PDFs are marked as
 * demonstration material: nothing here describes real holdings of the University of Ghana, and no real personal
 * information is used. Images and PDFs are generated while seeding.
 *
 * Each workflow step is performed through the real services (records, accessioning, digital assets, digitisation,
 * research requests and access control), so the workflow history, preservation events and audit records are
 * produced exactly as they would be in normal use.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import { models } from '../models/index.js';
import { loadPrincipal } from '../../middleware/auth.js';
import { createRecord, setCreators, setSubjects, transitionRecord } from '../../modules/records/records.service.js';
import { refreshEffectiveAccess } from '../../services/accessPolicy.service.js';
import { normaliseName } from '../../modules/cataloguing/authority.routes.js';
import {
  createSubmission,
  replaceItems as replaceTransferItems,
  transitionSubmission,
} from '../../modules/accessioning/transfers.service.js';
import {
  createAccession,
  replaceItems as replaceAccessionItems,
  transitionAccession,
  linkRecords,
} from '../../modules/accessioning/accessions.service.js';
import { uploadAssets, processAsset, setPublished } from '../../modules/digital-assets/assets.service.js';
import { runFixityCheck } from '../../services/preservation.service.js';
import {
  createProject,
  setProjectStatus,
  createBatch,
  addItems,
  transitionBatch,
} from '../../modules/digitisation/digitisation.service.js';
import { createRequest, act as researchAct } from '../../modules/research-requests/research.service.js';
import { book } from '../../modules/research-requests/reading-room.service.js';
import { addRestriction } from '../../modules/permissions/permissions.service.js';

const FICTION =
  'FICTIONAL DEMONSTRATION RECORD — created for training and testing. It does not describe a real holding of the University of Ghana Archives.';

/**
 * Writes generated content to a temporary upload file, in the same form Multer produces for a real upload.
 *
 * @param {Buffer} buffer File content.
 * @param {string} name Original file name to report.
 * @returns {Promise<{ path: string, originalname: string, size: number, mimetype: string }>} An object shaped like
 *   a Multer file.
 */
async function tempFile(buffer, name) {
  const dir = path.resolve('uploads/tmp');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${crypto.randomUUID()}.upload`);
  await fs.writeFile(p, buffer);
  return { path: p, originalname: name, size: buffer.length, mimetype: 'application/octet-stream' };
}

/**
 * Generates a clearly labelled demonstration image as a TIFF file.
 *
 * The image shows the caption and the words "DEMONSTRATION IMAGE — not an archival original", so it can never be
 * mistaken for a real holding.
 *
 * @param {string} caption Text displayed on the image.
 * @param {number} hue Background hue (0–360), so different demo images are easy to tell apart.
 * @returns {Promise<Buffer>} The TIFF image.
 */
async function demoImage(caption, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100">
    <rect width="100%" height="100%" fill="hsl(${hue},28%,86%)"/>
    <rect x="60" y="60" width="1480" height="980" fill="none" stroke="hsl(${hue},30%,40%)" stroke-width="6"/>
    <text x="120" y="480" font-size="72" font-family="Helvetica" fill="#1f2933">${caption}</text>
    <text x="120" y="600" font-size="40" font-family="Helvetica" fill="#52606d">DEMONSTRATION IMAGE — not an archival original</text>
  </svg>`;
  return sharp(Buffer.from(svg)).tiff({ compression: 'lzw' }).toBuffer();
}

/**
 * Generates a short demonstration PDF document marked as fictional training content.
 *
 * @param {string[]} lines The first line is the title; the remaining lines form the body.
 * @returns {Promise<Buffer>} The PDF file.
 */
async function demoPdf(lines) {
  const doc = new PDFDocument({ size: 'A4', margin: 72 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  doc.fontSize(9).fillColor('#8a6a0c').text('DEMONSTRATION DOCUMENT — fictional content for training');
  doc.moveDown(2).fontSize(18).fillColor('#111').text(lines[0]);
  doc.moveDown().fontSize(12);
  for (const l of lines.slice(1)) doc.text(l).moveDown(0.6);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/**
 * Runs the ingest pipeline for an asset and waits until it has finished.
 *
 * If a background worker is already processing the same asset, the call waits for that run instead of processing it
 * twice, checking once per second for up to two minutes.
 *
 * @param {string} assetId Identifier of the digital asset.
 * @returns {Promise<void>}
 * @throws {Error} When the asset is still processing after two minutes.
 */
async function ensureProcessed(assetId) {
  await processAsset(assetId);
  for (let i = 0; i < 120; i++) {
    const a = await models.DigitalAsset.findByPk(assetId, { attributes: ['status'] });
    if (a.status !== 'processing') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Asset ${assetId} is still processing after 2 minutes`);
}

/**
 * Creates the demonstration data set: authority records, a hierarchy of fictional collections, a transfer and
 * accession, storage locations and boxes, digital files, a digitisation project, research requests, a reading-room
 * booking and a draft retention schedule.
 *
 * Does nothing if the demonstration content already exists.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  // Tests build their own fixtures; production never receives demo content.
  if (!env.SEED_DEMO_DATA || ['production', 'test'].includes(env.NODE_ENV)) return;
  if (await models.ArchivalRecord.findOne({ where: { referenceCode: 'UGA/DEMO-REG' } })) return;

  /**
   * Loads a demonstration account as an authenticated principal, as the services expect.
   *
   * @param {string} email Sign-in email of the account.
   * @returns {Promise<object>} The principal with its roles and permissions.
   */
  const userByEmail = async (email) => loadPrincipal((await models.User.findOne({ where: { email } })).id);
  const [archivist, archivist2, chief, records, digitiser, liaison, researcher] = await Promise.all(
    [
      'archivist',
      'archivist2',
      'chief.archivist',
      'records.officer',
      'digitisation',
      'liaison.history',
      'researcher',
    ].map((u) => userByEmail(`${u}@ugarms.local`)),
  );

  /**
   * Looks up an organisation unit's identifier by its code.
   *
   * @param {string} code Unit code, for example "HIST".
   * @returns {Promise<string|undefined>} The unit identifier, or undefined if it does not exist.
   */
  const unit = async (code) => (await models.OrganisationUnit.findOne({ where: { code } }))?.id;

  /**
   * Looks up a controlled vocabulary term's identifier by its label.
   *
   * @param {string} label Term label, for example "Student records".
   * @returns {Promise<string|undefined>} The term identifier, or undefined if it does not exist.
   */
  const term = async (label) => (await models.VocabularyTerm.findOne({ where: { label } }))?.id;

  /**
   * Creates an approved demonstration authority record.
   *
   * @param {string} entityType Kind of entity, for example "corporate_body" or "person".
   * @param {string} authorizedName The authorised form of the name.
   * @param {object} [extra={}] Additional authority fields, such as dates of existence or history.
   * @returns {Promise<object>} The created authority record.
   */
  const authority = (entityType, authorizedName, extra = {}) =>
    models.AuthorityRecord.create({
      entityType,
      authorizedName,
      normalisedName: normaliseName(authorizedName),
      status: 'approved',
      verificationStatus: 'provisional',
      createdById: archivist.id,
      updatedById: archivist.id,
      sources: 'Demonstration authority record.',
      ...extra,
    });

  /**
   * Takes a description through the normal publication workflow: the archivist submits it for review, then the
   * chief archivist approves and publishes it.
   *
   * @param {object} rec The description to publish.
   * @returns {Promise<void>}
   */
  const publishFlow = async (rec) => {
    await transitionRecord(rec.id, { action: 'submit_for_review' }, archivist);
    await transitionRecord(rec.id, { action: 'approve', reason: 'Demo review' }, chief);
    await transitionRecord(rec.id, { action: 'publish' }, chief);
  };

  /**
   * Sets a description's access level to open and recalculates the effective access of it and its descendants.
   *
   * @param {object} rec The description to open.
   * @returns {Promise<void>}
   */
  const setOpen = async (rec) => {
    await models.ArchivalRecord.update({ accessLevel: 'open' }, { where: { id: rec.id } });
    await refreshEffectiveAccess(rec.id);
  };

  // ---------------------------------------------------------------- authorities
  const registrar = await authority('university_unit', 'University of Ghana. Office of the Registrar', {
    datesOfExistence: '1948–',
    history: 'Central administrative office (description simplified for demonstration).',
    organisationUnitId: await unit('REG'),
  });
  const council = await authority('corporate_body', 'University of Ghana. University Council', {
    datesOfExistence: '1961–',
  });
  const photographer = await authority('person', 'Mensah, Yaw (fictional photographer)', {
    datesOfExistence: '1930–2001',
    history: 'Fictional person created for demonstration.',
    verificationStatus: 'unverified',
  });

  // ---------------------------------------------------------------- descriptions
  const common = {
    accessConditions: 'Open for research (demonstration).',
    reproductionConditions: 'Demonstration content; no reproduction restrictions.',
    archivistNote: FICTION,
    rulesConventions: 'ISAD(G) 2nd edition (demonstration)',
  };
  const reg = await createRecord(
    {
      ...common,
      level: 'fonds',
      referenceCode: 'UGA/DEMO-REG',
      title: 'Records of a central registry',
      dateExpression: '1948–1995',
      dateStart: '1948-01-01',
      dateEnd: '1995-12-31',
      extentAndMedium: '412 boxes (demonstration figure)',
      creatorNote: 'Office of the Registrar (demonstration)',
      collectionType: 'Institutional records',
      originatingUnitId: await unit('REG'),
      adminBiographicalHistory: `${FICTION}\n\nIllustrates how an administrative history is recorded.`,
      scopeAndContent: `${FICTION}\n\nMinutes, correspondence, admissions registers and campus development files, used to demonstrate hierarchical description.`,
      arrangement: 'Series by function: governance, students, estates.',
      languages: ['English'],
      isFeatured: true,
    },
    archivist,
  );
  await setCreators(reg.id, [{ authorityId: registrar.id, role: 'creator' }], archivist);
  await setSubjects(
    reg.id,
    [await term('University governance'), await term('Academic programmes')]
      .filter(Boolean)
      .map((termId) => ({ termId, subjectType: 'subject' })),
    archivist,
  );
  const gov = await createRecord(
    {
      ...common,
      parentId: reg.id,
      level: 'series',
      localIdentifier: 'GOV',
      title: 'Council minutes and papers',
      dateExpression: '1961–1995',
      dateStart: '1961-01-01',
      dateEnd: '1995-12-31',
      extentAndMedium: '48 volumes (demonstration)',
      scopeAndContent: `${FICTION} Council minutes series used to demonstrate series-level description.`,
    },
    archivist,
  );
  await setCreators(gov.id, [{ authorityId: council.id, role: 'creator' }], archivist);
  const minutes = await createRecord(
    {
      ...common,
      parentId: gov.id,
      level: 'file',
      localIdentifier: '1961',
      title: 'Council minutes, first session',
      dateExpression: '1961–1962',
      dateStart: '1961-10-01',
      dateEnd: '1962-12-31',
      extentAndMedium: '1 volume',
      scopeAndContent: `${FICTION} A file used to demonstrate OCR of a generated PDF.`,
    },
    archivist,
  );
  const students = await createRecord(
    {
      ...common,
      parentId: reg.id,
      level: 'series',
      localIdentifier: 'STU',
      title: 'Student files and admissions registers',
      dateExpression: '1948–1995',
      dateStart: '1948-01-01',
      dateEnd: '1995-12-31',
      extentAndMedium: '120 boxes (demonstration)',
      scopeAndContent: `${FICTION} Demonstrates a restricted series containing personal information.`,
      accessConditions: 'Restricted: would contain personal information about living individuals.',
      accessLevel: 'restricted',
    },
    archivist,
  );
  const estates = await createRecord(
    {
      ...common,
      parentId: reg.id,
      level: 'series',
      localIdentifier: 'EST',
      title: 'Campus development plans',
      dateExpression: '1949–1975',
      dateStart: '1949-01-01',
      dateEnd: '1975-12-31',
      extentAndMedium: '210 plans (demonstration)',
      scopeAndContent: `${FICTION} Architectural plans series.`,
      accessLevel: 'open',
    },
    archivist,
  );
  await setSubjects(
    estates.id,
    [await term('Campus development')].filter(Boolean).map((termId) => ({ termId, subjectType: 'subject' })),
    archivist,
  );

  const photos = await createRecord(
    {
      ...common,
      level: 'collection',
      referenceCode: 'UGA/DEMO-PHOTO',
      title: 'Photographs of university life',
      dateExpression: 'c. 1950–1990',
      dateStart: '1950-01-01',
      dateEnd: '1990-12-31',
      extentAndMedium: 'c. 6,500 prints (demonstration figure)',
      creatorNote: 'Various (demonstration)',
      collectionType: 'Photographs',
      originatingUnitId: await unit('VCO'),
      scopeAndContent: `${FICTION}\n\nGenerated images stand in for photographs of ceremonies and campus life.`,
      adminBiographicalHistory: `${FICTION}`,
      languages: ['English'],
      isFeatured: true,
    },
    archivist,
  );
  await setCreators(photos.id, [{ authorityId: photographer.id, role: 'photographer' }], archivist);
  await setSubjects(
    photos.id,
    [await term('Student life'), await term('Convocation and congregation')]
      .filter(Boolean)
      .map((termId) => ({ termId, subjectType: 'subject' })),
    archivist,
  );
  const cong = await createRecord(
    {
      ...common,
      parentId: photos.id,
      level: 'series',
      localIdentifier: 'CONG',
      title: 'Congregation ceremonies',
      dateExpression: '1962–1988',
      dateStart: '1962-01-01',
      dateEnd: '1988-12-31',
      extentAndMedium: '640 prints (demonstration)',
      scopeAndContent: `${FICTION} Series with generated digitised images.`,
      accessLevel: 'open',
    },
    archivist,
  );

  const ias = await createRecord(
    {
      ...common,
      level: 'fonds',
      referenceCode: 'UGA/DEMO-IAS',
      title: 'Research institute oral history records',
      dateExpression: '1961–2005',
      dateStart: '1961-01-01',
      dateEnd: '2005-12-31',
      extentAndMedium: '96 boxes; 310 cassettes (demonstration)',
      creatorNote: 'Institute of African Studies (demonstration)',
      collectionType: 'Oral histories',
      originatingUnitId: await unit('IAS'),
      scopeAndContent: `${FICTION} Demonstrates restricted oral history material.`,
      adminBiographicalHistory: FICTION,
      accessConditions: 'Some interviews restricted by interviewee agreements (demonstration).',
      languages: ['English', 'Twi', 'Ga', 'Ewe'],
      accessLevel: 'restricted',
    },
    archivist2,
  );
  await setSubjects(
    ias.id,
    [await term('African studies'), await term('Ghanaian history')]
      .filter(Boolean)
      .map((termId) => ({ termId, subjectType: 'subject' })),
    archivist2,
  );

  const vouchers = await createRecord(
    {
      ...common,
      level: 'fonds',
      referenceCode: 'UGA/DEMO-FIN',
      title: 'Payment vouchers held for a department',
      dateExpression: '2005–2012',
      dateStart: '2005-01-01',
      dateEnd: '2012-12-31',
      extentAndMedium: '6 boxes (demonstration)',
      creatorNote: 'Finance office (demonstration)',
      scopeAndContent: `${FICTION} Departmental records under a retention schedule; used to demonstrate appraisal and legal holds.`,
      adminBiographicalHistory: FICTION,
      custodyStatus: 'departmental',
      isPermanent: false,
    },
    records,
  );

  // Publication through the real review workflow (archivist submits, chief archivist approves and publishes).
  for (const r of [reg, gov, minutes, estates, photos, cong]) await publishFlow(r);
  for (const r of [reg, gov, minutes, photos]) await setOpen(r);
  for (const r of [students, ias]) await publishFlow(r);
  await addRestriction(
    'record',
    students.id,
    {
      restrictionType: 'personal_data',
      legalBasis:
        'Personal information about living individuals (demonstration basis; to be confirmed by the University).',
      publicExplanation:
        'These files would contain personal information and are closed to general access. Researchers may apply.',
    },
    chief,
  );

  // ---------------------------------------------------------------- transfer and accession
  const transfer = await createSubmission(
    {
      title: 'Department of History correspondence, 1970–1985',
      originatingUnitId: await unit('HIST'),
      contactName: 'Kwame Addo',
      contactEmail: 'liaison.history@ugarms.local',
      proposedTransferDate: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
      transferAuthority: 'Head of Department memo (demonstration)',
      reason: 'Office relocation (demonstration).',
      totalExtent: '3 boxes',
    },
    liaison,
  );
  await replaceTransferItems(
    transfer.id,
    [
      {
        sourceIdentifier: 'HIS/1',
        title: 'Correspondence with external examiners',
        dateStart: '1970',
        dateEnd: '1978',
        quantity: 1,
        format: 'Paper',
      },
      {
        sourceIdentifier: 'HIS/2',
        title: 'Departmental board minutes',
        dateStart: '1975',
        dateEnd: '1985',
        quantity: 1,
        format: 'Paper',
      },
      {
        sourceIdentifier: 'HIS/3',
        title: 'Seminar programmes',
        dateExpression: '1970s',
        quantity: 1,
        format: 'Printed',
      },
    ],
    liaison,
  );
  await transitionSubmission(transfer.id, { action: 'submit' }, liaison);

  const acc = await createAccession(
    {
      title: 'Donated photographs of congregations',
      sourceType: 'donor',
      donorName: 'A fictional former lecturer (demonstration)',
      accessionDate: new Date().toISOString().slice(0, 10),
      transferDate: new Date().toISOString().slice(0, 10),
      transferAuthority: 'Deed of gift (demonstration)',
      legalBasis: 'Deed of gift (demonstration)',
      extent: '1 album; 40 loose prints',
      quantity: 41,
      physicalCondition: 'Good; some foxing on loose prints.',
      provenance: 'Kept by the donor since the 1960s (fictional).',
      rightsStatement: 'Copyright assigned to the University (demonstration).',
      restrictionsNote: 'None.',
    },
    records,
  );
  await replaceAccessionItems(
    acc.id,
    [
      { description: 'Album of congregation photographs', quantity: 1 },
      { description: 'Loose prints', quantity: 40 },
    ],
    records,
  );
  await transitionAccession(acc.id, { action: 'submit' }, records);
  await transitionAccession(acc.id, { action: 'start_review' }, chief);
  await transitionAccession(acc.id, { action: 'approve', reason: 'Accepted (demonstration)' }, chief);
  await linkRecords(acc.id, [photos.id, cong.id], records);

  // ---------------------------------------------------------------- storage
  const types = Object.fromEntries((await models.StorageLocationType.findAll()).map((t) => [t.code, t.id]));
  const repo = await models.Repository.findOne({ where: { code: 'UGA' } });

  /**
   * Creates a demonstration storage location under a parent location and records its materialised path.
   *
   * @param {string} code Location code.
   * @param {string} name Display name.
   * @param {string} type Location type code, for example "shelf".
   * @param {object|null} parent Parent location, or null for a top-level location.
   * @param {number} [capacity] Number of items the location can hold.
   * @returns {Promise<object>} The created location.
   */
  const mk = async (code, name, type, parent, capacity) => {
    const l = await models.StorageLocation.create({
      code,
      name,
      typeId: types[type],
      parentId: parent?.id ?? null,
      repositoryId: repo.id,
      capacity,
    });
    l.path = `${parent ? parent.path : '/'}${l.id}/`;
    await l.save();
    return l;
  };
  const building = await mk('DEMO-BLD', 'Archives building', 'building', null);
  const strong = await mk('DEMO-S1', 'Strongroom 1', 'room', building);
  const shelfA = await mk('DEMO-S1-A01', 'Shelf A01', 'shelf', strong, 12);
  const shelfB = await mk('DEMO-S1-A02', 'Shelf A02', 'shelf', strong, 12);

  /**
   * Creates a demonstration archive box at a location and records its first placement as a movement.
   *
   * @param {string} barcode Barcode printed on the box label.
   * @param {string} title Description of the box contents.
   * @param {string} recordId Description the box belongs to.
   * @param {object} loc Location where the box is shelved.
   * @param {string} [accessionId] Accession through which the box was received.
   * @returns {Promise<object>} The created physical item.
   */
  const box = async (barcode, title, recordId, loc, accessionId) => {
    const i = await models.PhysicalItem.create({
      barcode,
      title,
      recordId,
      accessionId,
      currentLocationId: loc.id,
      homeLocationId: loc.id,
      itemType: 'box',
      createdById: archivist.id,
      conditionRating: 'good',
    });
    await models.PhysicalItemMovement.create({
      itemId: i.id,
      toLocationId: loc.id,
      movementType: 'initial_placement',
      reason: 'Demonstration placement',
      movedById: archivist.id,
      movedAt: new Date(),
    });
    return i;
  };
  const minutesBox = await box('DEMO-0001', 'Council minutes (box 1)', minutes.id, shelfA);
  await box('DEMO-0002', 'Admissions registers', students.id, shelfA);
  await box('DEMO-0003', 'Campus plans', estates.id, shelfB);
  await box('DEMO-0004', 'Congregation prints', cong.id, shelfB, acc.id);
  await box('DEMO-0005', 'Payment vouchers 2005–2008', vouchers.id, shelfB);

  // ---------------------------------------------------------------- digital assets (generated)
  const images = [];
  for (const [i, caption] of ['Congregation procession', 'Honorary graduands', 'Great Hall interior'].entries()) {
    const file = await tempFile(await demoImage(caption, 150 + i * 40), `demo-congregation-${i + 1}.tif`);
    const { assets } = await uploadAssets(
      [file],
      { recordId: cong.id, role: 'preservation_master', title: caption },
      digitiser,
    );
    if (assets[0]) {
      await ensureProcessed(assets[0].id);
      images.push(assets[0]);
    }
  }
  // Publish access derivatives only when the malware scan genuinely returned clean.
  for (const master of images) {
    const derivs = await models.DigitalAsset.findAll({ where: { parentAssetId: master.id } });
    for (const d of derivs) {
      if (d.malwareStatus === 'clean') {
        await models.DigitalAsset.update({ downloadAllowed: d.role === 'access_derivative' }, { where: { id: d.id } });
        await setPublished(d.id, true, chief, 'Demonstration publication');
      }
    }
  }
  if (images[0]) await runFixityCheck(images[0].id, 'manual');
  const pdf = await tempFile(
    await demoPdf([
      'Minutes of the first session (demonstration)',
      'This generated document illustrates OCR and full-text search.',
      'Members present: fictional names only.',
      'Item 1. Adoption of the agenda.',
      'Item 2. Appointment of committees.',
    ]),
    'demo-council-minutes.pdf',
  );
  const { assets: pdfAssets } = await uploadAssets(
    [pdf],
    {
      recordId: minutes.id,
      physicalItemId: minutesBox.id,
      role: 'original_upload',
      title: 'Council minutes (generated PDF)',
    },
    digitiser,
  );
  if (pdfAssets[0]) await ensureProcessed(pdfAssets[0].id);

  // ---------------------------------------------------------------- digitisation
  const profile = await models.QualityProfile.findOne({ where: { materialType: 'photograph' } });
  const project = await createProject(
    {
      title: 'Digitisation of congregation photographs',
      sourceRecordId: photos.id,
      qualityProfileId: profile?.id,
      priority: 'normal',
    },
    archivist,
  );
  await setProjectStatus(project.id, 'approved', chief, 'Demonstration approval');
  const batch = await createBatch(
    project.id,
    {
      operatorId: digitiser.id,
      resolutionDpi: 600,
      colourProfile: 'Adobe RGB (1998)',
      captureDevice: 'Demonstration scanner',
      ocrEnabled: false,
    },
    archivist,
  );
  await addItems(
    batch.id,
    [
      { label: 'Album page 1', recordId: cong.id, expectedPages: 1 },
      { label: 'Album page 2', recordId: cong.id, expectedPages: 1 },
    ],
    archivist,
  );
  await transitionBatch(batch.id, { action: 'start' }, digitiser);

  // ---------------------------------------------------------------- research services
  const room = await models.ReadingRoom.create({
    repositoryId: repo.id,
    name: 'Archives Reading Room',
    location: 'Ground floor (demonstration)',
    capacity: 8,
    rules: 'Bring photo identification. Pencils only. No food or drink.',
  });
  for (let d = 1; d <= 21; d += 1) {
    const day = new Date(Date.now() + d * 86400_000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    for (const h of ['09:00', '13:00']) {
      const startsAt = new Date(`${day.toISOString().slice(0, 10)}T${h}:00Z`);
      await models.AppointmentSlot.create({
        readingRoomId: room.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * 3600_000),
        capacity: 4,
      });
    }
  }
  await createRequest(
    {
      requestType: 'restricted_access',
      purpose: 'Demonstration: study of admissions patterns (fictional research).',
      restrictionsAcknowledged: true,
      items: [{ recordId: students.id }],
    },
    researcher,
  );
  const consult = await createRequest(
    {
      requestType: 'consultation',
      purpose: 'Demonstration: history of campus architecture (fictional research).',
      items: [{ recordId: estates.id }],
    },
    researcher,
  );
  await researchAct(consult.id, { action: 'start_review' }, archivist);
  await researchAct(
    consult.id,
    { action: 'approve', publicNote: 'Approved for supervised consultation (demonstration).' },
    archivist,
  );
  const slot = await models.AppointmentSlot.findOne({
    where: { readingRoomId: room.id },
    order: [['startsAt', 'ASC']],
  });
  await book({ slotId: slot.id, requestId: consult.id }, researcher);
  await createRequest(
    {
      requestType: 'enquiry',
      purpose: 'Demonstration enquiry about photographs of the 1960s.',
      contactName: 'Visitor',
      contactEmail: 'visitor@example.invalid',
    },
    null,
  );

  // ---------------------------------------------------------------- governance
  await models.RetentionSchedule.create({
    code: 'DEMO-FIN-01',
    title: 'Payment vouchers and supporting documents',
    recordCategory: 'Finance',
    triggerEvent: 'End of financial year',
    retentionYears: 7,
    finalAction: 'review',
    legalBasis: 'Placeholder — to be confirmed against approved University policy.',
    status: 'draft',
  });
}

/**
 * Reverses this seeder. Intentionally does nothing: seeded reference data and accounts may already be referenced by
 * real records and audit events, so they are never deleted automatically. Use `npm run db:reset` to rebuild a
 * development database from scratch.
 *
 * @returns {Promise<void>}
 */
export async function down() {}

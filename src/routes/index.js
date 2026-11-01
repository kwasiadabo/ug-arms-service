/**
 * The versioned API router (/api/v1).
 *
 * `MOUNTS` lists every mount point and its router in one place. The API router is built from it, and the OpenAPI
 * document uses the same list to describe every implemented route, so the routes and the documentation cannot drift
 * apart.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import health from '../modules/health/health.routes.js';
import auth from '../modules/auth/auth.routes.js';
import users from '../modules/users/users.routes.js';
import roles from '../modules/roles/roles.routes.js';
import organisation from '../modules/organisation/organisation.routes.js';
import settings from '../modules/settings/settings.routes.js';
import notifications from '../modules/notifications/notifications.routes.js';
import auditRoutes from '../modules/audit/audit.routes.js';
import jobs from '../modules/jobs/jobs.routes.js';
import repositories from '../modules/collections/repositories.routes.js';
import records from '../modules/records/records.routes.js';
import permissions from '../modules/permissions/permissions.routes.js';
import authority from '../modules/cataloguing/authority.routes.js';
import vocabularies from '../modules/cataloguing/vocabulary.routes.js';
import transfers from '../modules/accessioning/transfers.routes.js';
import accessions from '../modules/accessioning/accessions.routes.js';
import { locationsRouter, itemsRouter } from '../modules/locations/locations.routes.js';
import { assetsRouter, filesRouter } from '../modules/digital-assets/assets.routes.js';
import preservation from '../modules/preservation/preservation.routes.js';
import ocr from '../modules/digitisation/ocr.routes.js';
import searchRoutes from '../modules/search/search.routes.js';
import digitisation from '../modules/digitisation/digitisation.routes.js';
import {
  researchRouter,
  readingRoomRouter,
  appointmentsRouter,
  meRouter,
} from '../modules/research-requests/research.routes.js';
import circulation from '../modules/circulation/circulation.routes.js';
import { retentionRouter, holdsRouter } from '../modules/retention/retention.routes.js';
import { appraisalRouter, disposalRouter } from '../modules/appraisal/appraisal.routes.js';
import dashboard from '../modules/dashboard/dashboard.routes.js';
import reports from '../modules/reports/reports.routes.js';
import imports from '../modules/imports/imports.routes.js';
import clientErrors from '../modules/client-errors/client-errors.routes.js';
import ai from '../modules/ai/ai.routes.js';
import publicRoutes from '../modules/public/public.routes.js';

export const MOUNTS = [
  ['/health', health],
  ['/auth', auth],
  ['/users', users],
  ['/roles', roles],
  ['/organisation-units', organisation],
  ['/settings', settings],
  ['/notifications', notifications],
  ['/audit', auditRoutes],
  ['/jobs', jobs],
  ['/repositories', repositories],
  ['/records', records],
  ['/permissions', permissions],
  ['/authority-records', authority],
  ['/vocabularies', vocabularies],
  ['/transfers', transfers],
  ['/accessions', accessions],
  ['/locations', locationsRouter],
  ['/physical-items', itemsRouter],
  ['/digital-assets', assetsRouter],
  ['/files', filesRouter],
  ['/preservation', preservation],
  ['/ocr', ocr],
  ['/search', searchRoutes],
  ['/digitisation', digitisation],
  ['/research-requests', researchRouter],
  ['/reading-rooms', readingRoomRouter],
  ['/appointments', appointmentsRouter],
  ['/circulation', circulation],
  ['/me', meRouter],
  ['/retention', retentionRouter],
  ['/legal-holds', holdsRouter],
  ['/appraisal', appraisalRouter],
  ['/disposal', disposalRouter],
  ['/dashboard', dashboard],
  ['/reports', reports],
  ['/imports', imports],
  ['/client-errors', clientErrors],
  ['/ai', ai],
  ['/public', publicRoutes],
];

const router = Router();
for (const [prefix, mountedRouter] of MOUNTS) router.use(prefix, mountedRouter);

export default router;

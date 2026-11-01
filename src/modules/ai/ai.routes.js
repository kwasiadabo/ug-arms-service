/**
 * HTTP route for optional AI metadata suggestions, mounted at /api/v1/ai.
 *
 * POST /records/:id/suggestions asks the configured AI service to suggest values for a few descriptive fields of
 * one description. Requires "records.update". The feature is disabled by default, suggestions are never saved
 * automatically, and requests for restricted material are refused.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { suggestMetadata } from './ai.service.js';

const router = Router();
router.use(authenticate, requirePermission('records.update'));

/**
 * @openapi
 * /ai/records/{id}/suggestions:
 *   post: { tags: [AI assistance], summary: Optional AI metadata suggestions. Disabled by default; never applied automatically; refused for restricted material., responses: { 200: { description: Suggestions }, 403: { description: Not permitted }, 503: { description: AI disabled or unavailable } } }
 */
router.post('/records/:id/suggestions', validate({ params: idParams }), async (req, res) => {
  res.json({ data: await suggestMetadata(req.params.id, req.user) });
});

export default router;

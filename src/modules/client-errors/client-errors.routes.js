/**
 * HTTP route through which the frontend reports browser errors, mounted at /api/v1/client-errors.
 *
 * POST / accepts only an error message, stack trace, route and release version, never form data, and forwards them
 * to error tracking. It works with or without a session and is rate-limited to 20 reports per minute per client.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { optionalAuth } from '../../middleware/auth.js';
import { captureException } from '../../services/errorTracking.service.js';

const router = Router();
const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

/**
 * @openapi
 * /client-errors:
 *   post: { tags: [Health], security: [], summary: Report a browser error (message, stack, route only; no form data), responses: { 202: { description: Accepted } } }
 */
router.post(
  '/',
  limiter,
  optionalAuth,
  validate({
    body: z.object({
      message: z.string().max(500),
      stack: z.string().max(4000).optional(),
      route: z.string().max(300).optional(),
      release: z.string().max(60).optional(),
    }),
  }),
  async (req, res) => {
    const err = Object.assign(new Error(req.body.message), { name: 'ClientError', stack: req.body.stack });
    captureException(err, { source: 'browser', route: req.body.route, requestId: req.id });
    res.status(202).json({ data: { ok: true } });
  },
);

export default router;

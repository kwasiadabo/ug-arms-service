/**
 * Request rate limiters.
 *
 * `apiLimiter` applies a general per-client limit to the whole API (health checks excluded) to blunt scraping and
 * accidental request floods. `publicSearchLimiter` applies a stricter limit to the anonymous public search, and
 * `anonymousFormLimiter` an even stricter one to anonymous forms that send email to an address the visitor types.
 * Limits are effectively disabled in the test environment. The counters are kept per process; a deployment with
 * several API instances should plug a Redis store into these limiters.
 *
 * @author Kwasi Adabo Boakye
 */

import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 100000 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/health'),
});

export const publicSearchLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 100000 : 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

/**
 * Limits anonymous form submissions that send email to an address typed by the visitor (research enquiries), so the
 * form cannot be used to flood someone's inbox: 10 submissions per hour per client address.
 */
export const anonymousFormLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: env.NODE_ENV === 'test' ? 100000 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

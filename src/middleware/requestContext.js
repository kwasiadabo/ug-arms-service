/**
 * Middleware that gives every request a correlation ID and a per-request context.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import { requestContext } from '../utils/context.js';

/**
 * Assigns a correlation ID to the request and runs the rest of the pipeline inside a new request context.
 *
 * A well-formed X-Request-Id header supplied by a trusted proxy is reused; otherwise a random UUID is generated.
 * The ID is returned in the X-Request-Id response header and recorded in logs and audit events, so all records
 * produced by one request can be linked together. The client IP address and user agent are also stored for the
 * audit trail.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues to the next handler.
 */
export function requestContextMiddleware(req, res, next) {
  const incoming = req.get('x-request-id');
  const correlationId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.id = correlationId;
  res.setHeader('X-Request-Id', correlationId);
  requestContext.run({ correlationId, ip: req.ip, userAgent: req.get('user-agent') }, () => next());
}

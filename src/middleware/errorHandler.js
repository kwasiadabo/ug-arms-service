/**
 * Final Express handlers for unknown routes and for errors thrown anywhere in the request pipeline.
 *
 * Known error types (validation, application, optimistic-locking, unique-constraint, upload and body-size errors)
 * are translated into the standard JSON error envelope with an appropriate status code. Unexpected errors are
 * reported to the error-tracking service and answered with a generic message in production, so internal details
 * such as SQL or stack traces never reach the client.
 *
 * @author Kwasi Adabo Boakye
 */

import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { isProd } from '../config/env.js';
import { captureException } from '../services/errorTracking.service.js';

/**
 * Responds with 404 and the standard error envelope for any request that did not match a route.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

/**
 * Converts an error into an HTTP response.
 *
 * - Zod validation errors and Sequelize validation errors become 422 with one entry per invalid field.
 * - AppError instances use their own status and code; 5xx errors are also logged.
 * - Optimistic-locking conflicts become 409 STALE_VERSION, asking the user to reload, so two people cannot
 *   overwrite each other's edits.
 * - Unique-constraint violations become 409 DUPLICATE.
 * - Upload errors become 400 and oversized bodies 413.
 * - Anything else is reported to error tracking and returned as 500, with the real message hidden in production.
 *
 * Every error response includes the request ID so a user's report can be matched to the server logs. Express
 * recognises error handlers by their four parameters, so `next` must stay in the signature even though it is not
 * used.
 *
 * @param {Error} err The error that was thrown or passed to `next`.
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Unused; required by Express.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      requestId: req.id,
    });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, requestId: req.id }, err.message);
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
  }
  if (err?.name === 'SequelizeOptimisticLockError') {
    return res.status(409).json({
      error: { code: 'STALE_VERSION', message: 'This item was changed by someone else. Reload and try again.' },
      requestId: req.id,
    });
  }
  if (err?.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: 'A record with the same unique value already exists',
        details: err.errors?.map((e) => ({ path: e.path, message: e.message })),
      },
      requestId: req.id,
    });
  }
  if (err?.name === 'SequelizeValidationError') {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.errors?.map((e) => ({ path: e.path, message: e.message })),
      },
      requestId: req.id,
    });
  }
  if (err?.name === 'MulterError') {
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message }, requestId: req.id });
  }
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }, requestId: req.id });
  }
  captureException(err, { requestId: req.id, route: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}` });
  if (process.env.DEBUG_ERRORS) console.error(err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: isProd ? 'An unexpected error occurred' : err.message },
    requestId: req.id,
  });
}

/**
 * Request validation middleware based on Zod schemas.
 *
 * @author Kwasi Adabo Boakye
 */

/**
 * Creates middleware that validates and normalises the request parameters, query string and body.
 *
 * Each supplied schema parses its part of the request and the parsed result replaces the original, so route
 * handlers only ever see typed, trimmed and defaulted values, and unknown fields are stripped. Invalid input throws
 * a ZodError, which the error handler turns into a 422 response listing each problem.
 *
 * @param {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 *   Schemas for the parts of the request to validate.
 * @returns {import('express').RequestHandler} The middleware.
 */
export const validate = (schemas) => (req, res, next) => {
  if (schemas.params) req.params = schemas.params.parse(req.params);
  if (schemas.query) {
    const parsed = schemas.query.parse(req.query);
    Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
  }
  if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
  next();
};

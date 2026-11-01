/**
 * Express application factory for the UG-ARMS API.
 *
 * Assembles the HTTP pipeline in a fixed, security-relevant order: request context (correlation ID), structured
 * request logging, security headers (Helmet with a strict Content Security Policy), CORS restricted to the
 * configured origins, cookie and body parsing with size limits, the OpenAPI documentation, rate limiting, CSRF
 * protection and finally the versioned API router. Unknown routes and errors are handled last so every response
 * uses the same JSON envelope.
 *
 * @author Kwasi Adabo Boakye
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { openapiSpec, withDiscoveredRoutes } from './config/swagger.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { csrfProtection } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import apiRouter, { MOUNTS } from './routes/index.js';

/**
 * Builds and returns a fully configured Express application without starting a listener.
 *
 * Keeping construction separate from listening lets the test suite mount the same application in memory with
 * Supertest, and lets the server entry point decide when to bind the port. The OpenAPI document is only served when
 * SWAGGER_ENABLED is true; it combines the JSDoc annotations with every route that is actually mounted, so no
 * implemented endpoint is left undocumented.
 *
 * @returns {import('express').Express} The configured application, ready to be passed to `listen` or Supertest.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(requestContextMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url.startsWith('/api/v1/health') },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          frameAncestors: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // The served spec = JSDoc annotations + every route actually mounted (so nothing implemented is undocumented).
  if (env.SWAGGER_ENABLED) {
    const spec = withDiscoveredRoutes(openapiSpec, MOUNTS);
    app.get('/api/v1/openapi.json', (req, res) => res.json(spec));
    app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'UG-ARMS API' }));
  }

  app.use('/api/v1', apiLimiter, csrfProtection, apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * HTTP server entry point for the UG-ARMS API (`npm start`).
 *
 * Verifies the database connection before accepting traffic, registers the background job handlers used when queues
 * run in-process, starts listening on the configured port and installs graceful shutdown handlers for SIGTERM and
 * SIGINT. Unhandled promise rejections are reported to the error-tracking service instead of crashing silently.
 *
 * @author Kwasi Adabo Boakye
 */

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { sequelize } from './database/models/index.js';
import { createApp } from './app.js';
import { registerHandlers } from './jobs/handlers.js';
import { captureException } from './services/errorTracking.service.js';

process.on('unhandledRejection', (err) => captureException(err, { source: 'unhandledRejection' }));

await sequelize.authenticate();
registerHandlers();
const app = createApp();
const server = app.listen(env.PORT, () =>
  logger.info(`UG-ARMS API listening on http://localhost:${env.PORT} (docs at /api/v1/docs)`),
);

/**
 * Stops the server gracefully when the process receives a termination signal.
 *
 * New connections are refused immediately; in-flight requests are allowed to finish, after which the database pool
 * is closed and the process exits with code 0. If shutdown has not completed within ten seconds the process is
 * forced to exit with code 1 so that orchestrators such as Docker do not wait indefinitely.
 *
 * @param {string} signal Name of the signal received, for example "SIGTERM"; recorded in the log.
 * @returns {Promise<void>}
 */
const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await sequelize.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

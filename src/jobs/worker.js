/**
 * Background worker entry point (`npm run worker`).
 *
 * Starts one BullMQ worker per queue with a concurrency suited to the work: OCR runs one job at a time because it
 * is CPU-heavy, while notification delivery runs several in parallel. Jobs linked to a BackgroundJob row are
 * tracked, so their status, attempts and errors appear on the System health page and failed jobs can be retried
 * safely. The worker also registers the repeatable maintenance schedules and shuts down gracefully on SIGTERM and
 * SIGINT.
 *
 * @author Kwasi Adabo Boakye
 */

import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sequelize } from '../database/models/index.js';
import { QUEUES, redisConnection, runTracked } from '../services/queue.service.js';
import { handlers, registerHandlers } from './handlers.js';
import { registerSchedules } from './schedules.js';

await sequelize.authenticate();
registerHandlers();

const concurrency = {
  ingest: 2,
  ocr: 1,
  fixity: 2,
  indexing: 4,
  reports: 2,
  notifications: 5,
  maintenance: 1,
  imports: 1,
};

const workers = QUEUES.map(
  (name) =>
    new Worker(
      name,
      async (job) => {
        const handler = handlers[job.name];
        if (!handler) throw new Error(`No handler for job type ${job.name}`);
        const attempt = job.attemptsMade + 1;
        const final = attempt >= (job.opts.attempts || 1);

        /**
         * Runs the handler for the current job with the job's payload.
         *
         * @returns {Promise<*>} Whatever the handler returns; stored by BullMQ as the job result.
         */
        const run = () => handler(job.data, job);
        return job.data.backgroundJobId ? runTracked(job.data.backgroundJobId, run, { attempt, final }) : run();
      },
      { connection: redisConnection(), concurrency: concurrency[name] || 1 },
    ),
);

for (const w of workers) {
  w.on('failed', (job, err) => logger.warn({ queue: w.name, job: job?.name, err: err.message }, 'Job failed'));
}
await registerSchedules();
logger.info(`UG-ARMS worker started for queues: ${QUEUES.join(', ')} (redis ${env.REDIS_URL})`);

/**
 * Stops all queue workers, letting running jobs finish, then closes the database connection and exits.
 *
 * @returns {Promise<void>}
 */
const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await sequelize.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

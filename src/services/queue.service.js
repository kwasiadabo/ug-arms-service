/**
 * Background job queueing with BullMQ and Redis, with status tracking in the database.
 *
 * Every job is first recorded as a BackgroundJob row, so its status, attempts and last error are visible on the
 * System health page and a failed job can be retried from there. Jobs requested inside a database transaction are
 * dispatched only after that transaction commits, so a worker never picks up work for data that was rolled back.
 * When queues are disabled (in tests and minimal installations) jobs run in-process with the same handlers.
 *
 * @author Kwasi Adabo Boakye
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { models } from '../database/models/index.js';

export const QUEUES = ['ingest', 'ocr', 'fixity', 'indexing', 'reports', 'notifications', 'maintenance', 'imports'];

let connection;

/**
 * Returns the shared Redis connection used by all queues, creating it on first use.
 *
 * @returns {import('ioredis').Redis}
 */
export function redisConnection() {
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return connection;
}

const queues = new Map();

/**
 * Returns the BullMQ queue with the given name, creating it on first use.
 *
 * Jobs are attempted up to three times with exponential back-off starting at ten seconds. Completed and failed jobs
 * are pruned automatically to bound Redis memory.
 *
 * @param {string} name Queue name, one of `QUEUES`.
 * @returns {import('bullmq').Queue}
 */
export function getQueue(name) {
  if (!queues.has(name))
    queues.set(
      name,
      new Queue(name, {
        connection: redisConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    );
  return queues.get(name);
}

// Inline handlers used when queues are disabled (tests, minimal deployments). Registered by jobs/handlers.js.
const inlineHandlers = new Map();

/**
 * Registers the function that runs a job type in-process when queues are disabled.
 *
 * @param {string} jobType Job type, for example "asset.process".
 * @param {(payload: object) => Promise<*>} fn The handler.
 */
export function registerInlineHandler(jobType, fn) {
  inlineHandlers.set(jobType, fn);
}

/**
 * Requests background work.
 *
 * A BackgroundJob row is created first and its identifier is used as the BullMQ job identifier, so the same job can
 * be found in both places. If Redis is unreachable the row stays queued with the error recorded, so the work is not
 * lost and can be retried.
 *
 * @param {string} queue Queue name.
 * @param {string} jobType Job type, which selects the handler.
 * @param {object} [payload={}] Data for the handler.
 * @param {{ entityType?: string, entityId?: string, requestedById?: string, delay?: number, transaction?:
 *   import('sequelize').Transaction }} [options] The related item, who asked for the job, an optional delay in
 *   milliseconds, and the transaction after which to dispatch.
 * @returns {Promise<string>} Identifier of the background job.
 */
export async function enqueue(
  queue,
  jobType,
  payload = {},
  { entityType, entityId, requestedById, delay, transaction } = {},
) {
  const job = await models.BackgroundJob.create(
    { queue, jobType, payload, entityType, entityId: entityId ? String(entityId) : null, requestedById },
    { transaction },
  );

  /**
   * Hands the job to its queue, or schedules the inline handler when queues are disabled.
   *
   * @returns {Promise<void>}
   */
  const dispatch = async () => {
    if (env.QUEUES_ENABLED) {
      try {
        await getQueue(queue).add(jobType, { backgroundJobId: job.id, ...payload }, { jobId: job.id, delay });
        return;
      } catch (err) {
        logger.error({ err: err.message, queue, jobType }, 'Queue unavailable; job stays queued for retry');
        await models.BackgroundJob.update(
          { lastError: `Queue unavailable: ${err.message}` },
          { where: { id: job.id } },
        );
        return;
      }
    }
    const handler = inlineHandlers.get(jobType);
    if (handler)
      setImmediate(() => runTracked(job.id, () => handler({ backgroundJobId: job.id, ...payload })).catch(() => {}));
  };
  if (transaction) transaction.afterCommit(dispatch);
  else await dispatch();
  return job.id;
}

/**
 * Runs a job handler while keeping its BackgroundJob row up to date.
 *
 * The row is marked running with the attempt number, then succeeded with the result, or failed with the error
 * message. A failure that will be retried leaves the job queued; only the last attempt marks it failed. The error
 * is rethrown so the queue can apply its retry policy.
 *
 * @param {string} backgroundJobId Identifier of the background job.
 * @param {() => Promise<*>} fn The work to run.
 * @param {{ attempt?: number, final?: boolean }} [options] Current attempt number and whether it is the last one.
 * @returns {Promise<*>} The handler's result.
 */
export async function runTracked(backgroundJobId, fn, { attempt = 1, final = true } = {}) {
  await models.BackgroundJob.update(
    { status: 'running', startedAt: new Date(), attempts: attempt },
    { where: { id: backgroundJobId } },
  );
  try {
    const result = await fn();
    await models.BackgroundJob.update(
      {
        status: 'succeeded',
        finishedAt: new Date(),
        progress: 100,
        result: JSON.stringify(result ?? {}),
        lastError: null,
      },
      { where: { id: backgroundJobId } },
    );
    return result;
  } catch (err) {
    await models.BackgroundJob.update(
      {
        status: final ? 'failed' : 'queued',
        lastError: String(err?.message || err).slice(0, 4000),
        finishedAt: final ? new Date() : null,
      },
      { where: { id: backgroundJobId } },
    );
    throw err;
  }
}

/**
 * Runs a failed or stuck background job again with its original payload. Any previous BullMQ job with the same
 * identifier is removed first.
 *
 * @param {string} backgroundJobId Identifier of the background job.
 * @returns {Promise<object|null>} The job, or null if it does not exist.
 */
export async function retryJob(backgroundJobId) {
  const job = await models.BackgroundJob.findByPk(backgroundJobId);
  if (!job) return null;
  await job.update({ status: 'queued', lastError: null, attempts: 0 });
  if (env.QUEUES_ENABLED) {
    const q = getQueue(job.queue);
    const existing = await q.getJob(job.id);
    if (existing) await existing.remove().catch(() => {});
    await q.add(job.jobType, { backgroundJobId: job.id, ...job.payload }, { jobId: job.id });
  } else {
    const handler = inlineHandlers.get(job.jobType);
    if (handler)
      setImmediate(() =>
        runTracked(job.id, () => handler({ backgroundJobId: job.id, ...job.payload })).catch(() => {}),
      );
  }
  return job;
}

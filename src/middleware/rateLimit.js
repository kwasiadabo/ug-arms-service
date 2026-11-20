/**
 * Request rate limiters.
 *
 * `apiLimiter` applies a general per-client limit to the whole API (health checks excluded) to blunt scraping and
 * accidental request floods. `publicSearchLimiter` applies a stricter limit to the anonymous public search, and
 * `anonymousFormLimiter` an even stricter one to anonymous forms that send email to an address the visitor types.
 * Limits are effectively disabled in the test environment.
 *
 * When queues are enabled (so Redis is available), every limiter keeps its counters in Redis through `sharedStore`,
 * so several API instances behind a load balancer share one count per client instead of each allowing the full
 * limit. Each limiter needs its own store with its own key prefix. If Redis cannot be reached, requests are let
 * through rather than refused (the per-account sign-in lockout, kept in the database, still applies), and the API's
 * readiness check reports Redis as down. Without queues (tests, minimal installs) the counters stay in memory.
 *
 * @author Kwasi Adabo Boakye
 */

import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let client;

/**
 * Wraps a store so that a failure lets the request through quietly. express-rate-limit's own `passOnStoreError`
 * would print a stack trace for every request during a Redis outage; the outage is logged once by the connection
 * instead. RedisStore reloads its script on the next request once Redis is back, so nothing else is needed.
 */
class FailOpenStore {
  /** @param {RedisStore} inner The store to protect. */
  constructor(inner) {
    this.inner = inner;
    this.prefix = inner.prefix;
  }

  /** @param {object} options The limiter's configuration. */
  async init(options) {
    await this.inner.init(options).catch(() => {});
  }

  /** @param {string} key Client key. @returns {Promise<object|undefined>} Hit count and reset time, if known. */
  async get(key) {
    return this.inner.get(key).catch(() => undefined);
  }

  /** @param {string} key Client key. @returns {Promise<{ totalHits: number, resetTime?: Date }>} The new count. */
  async increment(key) {
    return this.inner.increment(key).catch(() => ({ totalHits: 0, resetTime: undefined }));
  }

  /** @param {string} key Client key. */
  async decrement(key) {
    await this.inner.decrement(key).catch(() => {});
  }

  /** @param {string} key Client key. */
  async resetKey(key) {
    await this.inner.resetKey(key).catch(() => {});
  }
}

/**
 * Returns the options that make a limiter count in Redis, shared by every API instance, or nothing (in-memory
 * counters) when queues are disabled or in tests.
 *
 * @param {string} name Short unique name of the limiter, used as its Redis key prefix.
 * @returns {{ store?: FailOpenStore }} Options to spread into `rateLimit()`.
 */
export function sharedStore(name) {
  if (!env.QUEUES_ENABLED || env.NODE_ENV === 'test') return {};
  if (!client) {
    // A connection of its own that fails commands at once while Redis is unreachable (no offline queue), so an
    // outage lets requests through straight away instead of holding each one while the client reconnects.
    client = new IORedis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    let down = false;
    client.on('error', (err) => {
      if (!down) logger.warn({ err: err.message }, 'Rate-limit store unreachable; requests are not being counted');
      down = true;
    });
    client.on('ready', () => {
      if (down) logger.info('Rate-limit store reachable again');
      down = false;
    });
  }
  const store = new RedisStore({
    prefix: `rl:${name}:`,
    sendCommand: (command, ...args) => client.call(command, ...args),
  });
  return { store: new FailOpenStore(store) };
}

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 100000 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/health'),
  ...sharedStore('api'),
});

export const publicSearchLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 100000 : 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ...sharedStore('public-search'),
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
  ...sharedStore('anonymous-form'),
});

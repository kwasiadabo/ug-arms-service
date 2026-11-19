/**
 * Application-wide structured logger (Pino).
 *
 * Logs are JSON in production and pretty-printed in development unless LOG_FORMAT says otherwise; logging is
 * silenced during automated tests. Pretty printing needs the pino-pretty development package, which the container
 * images do not include, so when it is not installed the logs stay JSON instead of the process failing to start.
 * Authorization headers, cookies, passwords, password hashes and tokens are redacted wherever they appear in a log
 * object, so credentials never reach log files or log aggregation services.
 *
 * @author Kwasi Adabo Boakye
 */

import { createRequire } from 'node:module';
import pino from 'pino';
import { env, isProd, isTest } from './env.js';

/**
 * Tells whether the pino-pretty package is installed (it is a development dependency).
 *
 * @returns {boolean}
 */
function prettyPrinterInstalled() {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const wantsPretty = !isTest && (env.LOG_FORMAT ?? (isProd ? 'json' : 'pretty')) === 'pretty';
const pretty = wantsPretty && prettyPrinterInstalled();

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  transport: pretty ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } : undefined,
});

if (wantsPretty && !pretty)
  logger.info(
    'pino-pretty is not installed (container image); logging JSON instead. Set LOG_FORMAT=json to silence this.',
  );

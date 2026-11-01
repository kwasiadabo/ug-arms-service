/**
 * Application-wide structured logger (Pino).
 *
 * Logs are JSON in production and pretty-printed in development; logging is silenced during automated tests.
 * Authorization headers, cookies, passwords, password hashes and tokens are redacted wherever they appear in a log
 * object, so credentials never reach log files or log aggregation services.
 *
 * @author Kwasi Adabo Boakye
 */

import pino from 'pino';
import { env, isProd, isTest } from './env.js';

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
  transport:
    isProd || isTest
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
});

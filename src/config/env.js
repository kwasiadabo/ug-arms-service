/**
 * Loads, validates and exports the runtime configuration.
 *
 * Every environment variable the backend uses is declared once in a Zod schema with its type and safe default, so
 * the rest of the code reads typed values from `env` instead of `process.env`. Deployment-specification names (for
 * example OBJECT_STORAGE_BUCKET or FRONTEND_ORIGIN) are accepted as aliases of the internal names.
 *
 * The process exits at start-up when the configuration is invalid. In production it also refuses to start with
 * insecure settings: placeholder or short JWT secrets, identical access and refresh secrets, non-secure cookies,
 * demo data enabled, placeholder database and storage credentials, or a disposal storage credential that
 * is the development secret or the same as the application credential.
 *
 * @author Kwasi Adabo Boakye
 */

import 'dotenv/config';
import { z } from 'zod';

const bool = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === 'true' || v === '1');

// Accept the variable names from the deployment specification as aliases for the internal names.
const ALIASES = {
  FRONTEND_ORIGIN: ['CORS_ORIGINS', 'PUBLIC_APP_URL'],
  OBJECT_STORAGE_ENDPOINT: ['S3_ENDPOINT'],
  OBJECT_STORAGE_BUCKET: ['S3_BUCKET'],
  OBJECT_STORAGE_ACCESS_KEY: ['S3_ACCESS_KEY'],
  OBJECT_STORAGE_SECRET_KEY: ['S3_SECRET_KEY'],
  OBJECT_STORAGE_REGION: ['S3_REGION'],
};
for (const [alias, targets] of Object.entries(ALIASES)) {
  if (process.env[alias])
    for (const t of targets)
      if (!process.env[t])
        process.env[t] =
          alias === 'FRONTEND_ORIGIN' && t === 'PUBLIC_APP_URL'
            ? process.env[alias].split(',')[0].trim()
            : process.env[alias];
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4200),
  APP_NAME: z.string().default('UG-ARMS'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5190'),
  CORS_ORIGINS: z.string().default('http://localhost:5190'),
  TRUST_PROXY: bool.default(false),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(1433),
  DB_NAME: z.string().default('ug_arms'),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_ENCRYPT: bool.default(false),
  DB_TRUST_SERVER_CERT: bool.default(true),
  DB_LOGGING: bool.default(false),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  QUEUES_ENABLED: bool.default(true),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  COOKIE_SECURE: bool.default(false),
  COOKIE_DOMAIN: z.string().optional().default(''),

  LOCKOUT_MAX_ATTEMPTS: z.coerce.number().default(5),
  LOCKOUT_MINUTES: z.coerce.number().default(15),

  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage-local'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('ug-arms-objects'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  // Used only by authorised disposal to delete files under governance retention. Never give it to the worker.
  S3_DISPOSAL_ACCESS_KEY: z.string().optional(),
  S3_DISPOSAL_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),
  MAX_UPLOAD_MB: z.coerce.number().default(2048),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  MAIL_FROM: z.string().default('UG Archives <no-reply@localhost>'),

  CLAMAV_ENABLED: bool.default(false),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  TIKA_ENABLED: bool.default(false),
  TIKA_URL: z.string().default('http://localhost:9998'),
  OCR_ENABLED: bool.default(true),
  // OCR jobs each worker process runs at once. Each job uses about one CPU core.
  OCR_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  TESSERACT_PATH: z.string().default('tesseract'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  OPENSEARCH_ENABLED: bool.default(false),
  OPENSEARCH_URL: z.string().default('http://localhost:9200'),
  AI_ENABLED: bool.default(false),
  AI_PROVIDER: z.enum(['none', 'http']).default('none'),
  AI_SERVICE_URL: z.string().url().optional(),
  AI_SERVICE_TOKEN: z.string().optional(),
  OCR_SERVICE_URL: z.string().url().optional(),
  OCR_SERVICE_TOKEN: z.string().optional(),
  ERROR_WEBHOOK_URL: z.string().url().optional(),
  // Interactive API documentation. Defaults to on in development and off in production (it maps every endpoint).
  SWAGGER_ENABLED: bool.optional(),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(5).max(10000).default(20),
  DISK_FREE_ALERT_PERCENT: z.coerce.number().min(1).max(90).default(10),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@ugarms.local'),
  // Required only when the seeder creates the initial administrator. Never defaulted.
  SEED_ADMIN_PASSWORD: z.string().min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters').optional(),
  SEED_DEMO_DATA: bool.default(true),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
env.SWAGGER_ENABLED ??= env.NODE_ENV !== 'production';

// Production safety checks: refuse to start with placeholder or insecure configuration.
if (env.NODE_ENV === 'production') {
  const problems = [];
  const placeholder = /change-?me|placeholder|example|<.*>/i;
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (placeholder.test(env[k]) || env[k].length < 48)
      problems.push(`${k} must be a unique random value of at least 48 characters`);
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET)
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true (serve over HTTPS)');
  if (env.SEED_DEMO_DATA) problems.push('SEED_DEMO_DATA must be false');
  if (placeholder.test(env.DB_PASSWORD)) problems.push('DB_PASSWORD looks like a placeholder');
  // Credentials published in this repository for local development must never reach production.
  if (env.DB_PASSWORD === 'UgArms_Dev#2026') problems.push('DB_PASSWORD is the published development password');
  if (env.S3_SECRET_KEY === 'ugarms-dev-secret') problems.push('S3_SECRET_KEY is the published development secret');
  if (env.S3_SECRET_KEY && placeholder.test(env.S3_SECRET_KEY)) problems.push('S3_SECRET_KEY looks like a placeholder');
  if (env.S3_DISPOSAL_SECRET_KEY === 'ugarms-disposal-dev-secret')
    problems.push('S3_DISPOSAL_SECRET_KEY is the published development secret');
  if (env.S3_DISPOSAL_SECRET_KEY && placeholder.test(env.S3_DISPOSAL_SECRET_KEY))
    problems.push('S3_DISPOSAL_SECRET_KEY looks like a placeholder');
  if (env.S3_DISPOSAL_ACCESS_KEY && env.S3_DISPOSAL_ACCESS_KEY === env.S3_ACCESS_KEY)
    problems.push('S3_DISPOSAL_ACCESS_KEY must be a separate credential from S3_ACCESS_KEY');
  if (env.SEED_ADMIN_PASSWORD && /changeme/i.test(env.SEED_ADMIN_PASSWORD.replace(/\W/g, '')))
    problems.push('SEED_ADMIN_PASSWORD must not be a well-known default');
  if (problems.length) {
    console.error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

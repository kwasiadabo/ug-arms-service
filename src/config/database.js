/**
 * Sequelize connection factory for Microsoft SQL Server.
 *
 * All timestamps are stored and read in UTC, the connection pool is sized for a single API or worker process, and
 * SQL statement logging is only enabled when DB_LOGGING is set. The default export `sequelize` is the shared
 * connection used by the models; `buildSequelize` is also used by tooling that must connect to a different
 * database, such as the restore verification script.
 *
 * @author Kwasi Adabo Boakye
 */

import { Sequelize } from 'sequelize';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Creates a new Sequelize instance connected to the given SQL Server database using the credentials and TLS options
 * from the validated environment.
 *
 * @param {string} [database=env.DB_NAME] Name of the database to connect to. Defaults to the application database.
 * @returns {import('sequelize').Sequelize} A configured, not yet authenticated, Sequelize instance.
 */
export function buildSequelize(database = env.DB_NAME) {
  return new Sequelize(database, env.DB_USER, env.DB_PASSWORD, {
    host: env.DB_HOST,
    port: env.DB_PORT,
    dialect: 'mssql',
    logging: env.DB_LOGGING ? (sql) => logger.debug(sql) : false,
    timezone: '+00:00',
    pool: { max: 20, min: 0, idle: 10000, acquire: 30000 },
    define: { freezeTableName: false, timestamps: true },
    dialectOptions: {
      options: {
        encrypt: env.DB_ENCRYPT,
        trustServerCertificate: env.DB_TRUST_SERVER_CERT,
        useUTC: true,
        requestTimeout: 60000,
      },
    },
  });
}

export const sequelize = buildSequelize();

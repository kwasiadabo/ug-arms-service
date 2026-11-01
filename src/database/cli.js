/**
 * Command-line tool for database administration, used by the `db:*` npm scripts.
 *
 * - `create` creates the database if it does not exist.
 * - `up` applies pending migrations; `down` rolls back the most recent one.
 * - `seed` runs pending seeders.
 * - `reset` drops and recreates the database, then migrates and seeds it. It is refused in production.
 *
 * Migrations and seeders are run by Umzug, which records what has been applied in the SequelizeMeta and
 * SequelizeData tables, so each step runs only once.
 *
 * @author Kwasi Adabo Boakye
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Umzug, SequelizeStorage } from 'umzug';
import { env } from '../config/env.js';
import { buildSequelize } from '../config/database.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Creates the application database on the SQL Server instance if it does not already exist.
 *
 * Connects to the `master` database because the target database may not exist yet. The database name is reduced to
 * letters, digits and underscores before it is placed in the SQL statement.
 *
 * @returns {Promise<void>}
 */
export async function createDatabaseIfMissing() {
  const master = buildSequelize('master');
  const name = env.DB_NAME.replace(/[^A-Za-z0-9_]/g, '');
  await master.query(`IF DB_ID(N'${name}') IS NULL CREATE DATABASE [${name}]`);
  await master.close();
}

/**
 * Creates an Umzug runner for the migration or seeder scripts in a folder.
 *
 * Each script is imported on demand and its `up` or `down` function is called with the query interface and the
 * Sequelize instance.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to run the scripts against.
 * @param {string} folder Folder name relative to this file, "migrations" or "seeders".
 * @param {string} tableName Table in which Umzug records the scripts that have been applied.
 * @returns {Umzug} The configured runner.
 */
function buildUmzug(sequelize, folder, tableName) {
  return new Umzug({
    migrations: {
      glob: ['*.js', { cwd: path.join(here, folder) }],
      resolve: ({ name, path: file, context }) => ({
        name,
        up: async () => (await import(pathToFileURL(file).href)).up(context),
        down: async () => (await import(pathToFileURL(file).href)).down?.(context),
      }),
    },
    context: { queryInterface: sequelize.getQueryInterface(), sequelize },
    storage: new SequelizeStorage({ sequelize, tableName }),
    logger: console,
  });
}

/**
 * Applies every migration that has not yet been run, in file-name order.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to migrate.
 * @returns {Promise<object[]>} The migrations that were applied.
 */
export async function migrate(sequelize) {
  return buildUmzug(sequelize, 'migrations', 'SequelizeMeta').up();
}

/**
 * Runs every seeder that has not yet been run, in file-name order.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to seed.
 * @returns {Promise<object[]>} The seeders that were applied.
 */
export async function seed(sequelize) {
  return buildUmzug(sequelize, 'seeders', 'SequelizeData').up();
}

/**
 * Entry point: performs the command given as the first command-line argument.
 *
 * @returns {Promise<void>}
 * @throws {Error} When `reset` is attempted in production.
 */
async function main() {
  const cmd = process.argv[2];
  if (cmd === 'create') {
    await createDatabaseIfMissing();
    console.log(`Database ${env.DB_NAME} ready`);
    return;
  }
  if (cmd === 'reset') {
    if (env.NODE_ENV === 'production') throw new Error('db:reset is disabled in production');
    const master = buildSequelize('master');
    const name = env.DB_NAME.replace(/[^A-Za-z0-9_]/g, '');
    await master.query(
      `IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END`,
    );
    await master.close();
    await createDatabaseIfMissing();
  }
  const { sequelize } = await import('./models/index.js');
  try {
    if (cmd === 'up' || cmd === 'reset') await migrate(sequelize);
    if (cmd === 'down') await buildUmzug(sequelize, 'migrations', 'SequelizeMeta').down();
    if (cmd === 'seed' || cmd === 'reset') await seed(sequelize);
  } finally {
    await sequelize.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Exit explicitly: seeders may open a Redis connection (queued jobs) that would keep the process alive.
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

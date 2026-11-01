/**
 * Runs the Object Lock sweep immediately (`npm run storage:lock`), instead of waiting for the nightly schedule.
 *
 * Places every live preservation file and its replicas under governance retention, extends retention that is due
 * for renewal, and mirrors active legal holds onto the files. Use it after enabling Object Lock on an existing
 * bucket and after restoring files from a backup. Safe to repeat: it only ever extends retention or brings legal
 * holds into line with the database.
 *
 * Exits with status 1 if any file could not be updated.
 *
 * @author Kwasi Adabo Boakye
 */

import { sequelize } from '../src/database/models/index.js';
import { reconcileObjectLocks } from '../src/services/objectLock.service.js';

const result = await reconcileObjectLocks();
await sequelize.close();
console.log(JSON.stringify(result, null, 2));
process.exit(result.failed ? 1 : 0);

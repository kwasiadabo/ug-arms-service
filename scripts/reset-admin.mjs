/**
 * Command-line script that creates or resets the initial administrator (`npm run admin:reset -- --email
 * <address>`).
 *
 * A random temporary password is printed once, and the account must change it at first sign-in. The account is
 * activated, unlocked and given the System Administrator role. All existing sessions of the account are revoked,
 * and the action is recorded in the audit trail as a sensitive event.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import { models, sequelize } from '../src/database/models/index.js';
import { hashPassword, revokeAllSessions } from '../src/modules/auth/auth.service.js';
import { audit } from '../src/services/audit.service.js';

const i = process.argv.indexOf('--email');
const email = (i > -1 ? process.argv[i + 1] : process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run admin:reset -- --email <address>');
  process.exit(1);
}
const temp = `${crypto.randomBytes(12).toString('base64url')}7k`;
const role = await models.Role.findOne({ where: { code: 'system_administrator' } });
if (!role) {
  console.error('Roles are not seeded. Run npm run db:seed first.');
  process.exit(1);
}
await sequelize.transaction(async (t) => {
  const [user, created] = await models.User.findOrCreate({
    where: { email },
    defaults: {
      email,
      fullName: 'System Administrator',
      status: 'active',
      userType: 'staff',
      emailVerifiedAt: new Date(),
    },
    transaction: t,
  });
  await user.update(
    {
      passwordHash: await hashPassword(temp),
      status: 'active',
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
    },
    { transaction: t },
  );
  await models.UserRole.findOrCreate({
    where: { userId: user.id, roleId: role.id },
    defaults: { userId: user.id, roleId: role.id },
    transaction: t,
  });
  if (!created) await revokeAllSessions(user.id, 'admin_reset', t);
  await audit(
    {
      action: created ? 'admin.created_by_cli' : 'admin.reset_by_cli',
      resourceType: 'User',
      resourceId: user.id,
      actorType: 'system',
      actorLabel: 'cli',
      sensitive: true,
    },
    { transaction: t },
  );
});
console.log(`Administrator ${email} is ready. Temporary password (shown once): ${temp}`);
console.log('Sign in and change the password immediately.');
await sequelize.close();
process.exit(0);

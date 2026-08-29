/* Create an admin account:  npm run admin:create -- <username> <password> [role] [name] */
import 'dotenv/config';
import { createAdmin, adminCount, ROLES } from './lib/admin-auth.js';
import { connect } from './lib/db.js';

const [username, password, role = 'owner', ...nameParts] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run admin:create -- <username> <password> [owner|admin|viewer] [display name]');
  process.exit(1);
}
if (!ROLES.includes(role)) { console.error('Role must be one of:', ROLES.join(', ')); process.exit(1); }

await connect();
try {
  const a = await createAdmin({ username, password, role, name: nameParts.join(' ') || username });
  console.log(`Created ${a.role} "${a.username}" (id ${a.id}). Total admins: ${await adminCount()}`);
} catch (e) {
  console.error('Failed:', e.message);
  process.exit(1);
}
process.exit(0);

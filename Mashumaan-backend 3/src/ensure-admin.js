// ============================================================
// Safe admin-account bootstrap — creates the default admin login
// ONLY if it doesn't already exist. Unlike `npm run seed`, this
// script never touches products, variants, stock, orders, FAQs,
// or reviews — it is safe to run against a live production database
// at any time, including one that already has real customer data.
//
// Usage:
//   node src/ensure-admin.js
//   (or, on Render: open a Shell on the backend service and run the
//   same command — it uses the same DATABASE_URL/env the service has)
//
// Configure with env vars (optional, same ones seed.js uses):
//   SEED_ADMIN_EMAIL      (default: admin@mashumaan.pk)
//   SEED_ADMIN_PASSWORD   (default: ChangeMe123! — CHANGE THIS after first login)
// ============================================================
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

async function ensureAdmin() {
  await db.initSchema(); // idempotent — safe even if schema already exists
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@mashumaan.pk').toLowerCase();
  const existing = await db.query('SELECT id, is_admin FROM users WHERE email = $1', [adminEmail]);

  if (existing.rows[0]) {
    if (existing.rows[0].is_admin) {
      console.log(`Account ${adminEmail} already exists and is already an admin. Nothing to do.`);
    } else {
      // Account exists (e.g. registered as a normal customer) but isn't an admin yet — promote it.
      await db.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [existing.rows[0].id]);
      console.log(`Account ${adminEmail} existed as a non-admin user — promoted it to admin. Its existing password is unchanged.`);
    }
    return;
  }

  const defaultPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const hash = await bcrypt.hash(defaultPassword, 10);
  await db.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, is_admin) VALUES ($1,$2,'Mashumaan','Admin',TRUE)`,
    [adminEmail, hash]
  );
  console.log(`Created admin login -> email: ${adminEmail}  password: ${defaultPassword}`);
  console.log('IMPORTANT: log in and change this password immediately.');
}

module.exports = { ensureAdmin };

// Only run automatically when invoked directly (`node src/ensure-admin.js`) —
// not when required as a module by seed.js.
if (require.main === module) {
  ensureAdmin()
    .then(() => process.exit(0))
    .catch((err) => { console.error('ensure-admin failed:', err); process.exit(1); });
}

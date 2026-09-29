// ============================================================
// PostgreSQL connection + schema. All queries elsewhere in the app go
// through this pool with parameterized queries ($1, $2, ...) — never
// string-concatenated SQL, which is how SQL injection happens.
//
// Connect via DATABASE_URL (the standard env var name every Postgres
// host — Render, Railway, Supabase, Neon — gives you). For local
// development without a hosted DB yet, DATABASE_URL can point at a
// Postgres instance running on your own machine.
// ============================================================
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to your .env file (see .env.example) — this app requires a real PostgreSQL database, it will not fall back to a local file.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most hosted Postgres providers (Render, Supabase, etc.) require SSL and
  // use certificates not in Node's default trust store — this is the
  // standard, documented way to connect to them from a Node app.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

/* Run a series of statements as one atomic transaction. `fn` receives a
   client whose .query() must be used for every statement in the
   transaction (not the pool directly) so they all run on the same
   connection. Rolls back automatically if fn throws. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addresses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT,
  address     TEXT NOT NULL,
  city        TEXT NOT NULL,
  province    TEXT NOT NULL,
  postal      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  collection    TEXT,
  fabric        TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  is_new        BOOLEAN NOT NULL DEFAULT FALSE,
  is_bestseller BOOLEAN NOT NULL DEFAULT FALSE,
  featured      BOOLEAN NOT NULL DEFAULT FALSE,
  sizechart     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS variants (
  id                TEXT PRIMARY KEY,
  product_id        TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color             TEXT NOT NULL,
  color_hex         TEXT DEFAULT '#D98CA0',
  sku               TEXT UNIQUE NOT NULL,
  price             INTEGER NOT NULL,
  sale_price        INTEGER,
  image_front       TEXT,
  image_back        TEXT,
  image_neckline    TEXT,
  image_sleeve      TEXT,
  image_tunichem    TEXT,
  image_pantdetail  TEXT,
  image_embroidery  TEXT,
  image_fabric      TEXT
);

CREATE TABLE IF NOT EXISTS variant_stock (
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  size       TEXT NOT NULL,             -- '2'..'12' (years)
  quantity   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, size)
);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  customer_name   TEXT,
  customer_phone  TEXT,
  customer_email  TEXT,
  address         TEXT,
  city            TEXT,
  province        TEXT,
  postal          TEXT,
  payment_method  TEXT NOT NULL,          -- 'cod' | 'manual' | 'jazzcash' | 'easypaisa' | 'payfast'
  payment_status  TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed'
  payment_proof   TEXT,                   -- base64 screenshot, manual transfers only
  status          TEXT NOT NULL DEFAULT 'Order Placed',
  subtotal        INTEGER NOT NULL,
  delivery_fee    INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id            SERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL,
  variant_id    TEXT NOT NULL,
  product_name  TEXT NOT NULL,
  color         TEXT NOT NULL,
  sku           TEXT NOT NULL,
  size          TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  unit_price    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id         SERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  name       TEXT,
  rating     INTEGER,
  text       TEXT,
  verified   BOOLEAN DEFAULT FALSE,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Site FAQs — public GET /api/faqs serves only is_active=TRUE, ordered by
-- display_order; full CRUD lives behind admin auth in routes/admin.js.
CREATE TABLE IF NOT EXISTS faqs (
  id            SERIAL PRIMARY KEY,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Structured, admin-editable size charts. A row with product_id = NULL is
-- the site-wide DEFAULT chart (shown when a product has no chart of its
-- own); a row with product_id set overrides the default for that one
-- product only. "rows" holds the actual age-bracket/measurement lines as
-- JSON so the admin can add/remove age brackets freely without a schema
-- change — each element looks like:
--   {"ageLabel":"2–3 Years","shirtLength":"","chest":"","sleeveLength":"","trouserLength":"","waist":""}
CREATE TABLE IF NOT EXISTS size_charts (
  id         SERIAL PRIMARY KEY,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  unit       TEXT NOT NULL DEFAULT 'in',
  rows       JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Simple key-value store for site-wide content (hero text, About page,
-- delivery policy, contact info, manual payment details, etc.) — this is
-- what makes Admin > Site Content changes visible to every visitor,
-- instead of just the browser that made the edit.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
  `);

  // Size-chart uniqueness safety nets: one chart per product, and at most one
  // site-wide default (product_id NULL). Kept OUT of the big CREATE TABLE block
  // above on purpose — if an index were ever rejected it must not roll back the
  // tables. The routes already upsert (never blindly insert), so a failure here
  // only loses the extra database-level guard, and is logged rather than fatal.
  for (const stmt of [
    `CREATE UNIQUE INDEX IF NOT EXISTS size_charts_one_per_product ON size_charts (product_id) WHERE product_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS size_charts_one_global ON size_charts ((1)) WHERE product_id IS NULL`,
  ]) {
    try { await query(stmt); }
    catch (err) { console.warn('Could not create size_charts index (non-fatal):', err.message); }
  }

  // ---- Backward-compatible migrations for databases created before the
  // review-moderation and FAQ features existed. ADD COLUMN IF NOT EXISTS is
  // itself idempotent; constraints are wrapped so re-running never errors. ----
  await query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';`);
  await query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await query(`
DO $$ BEGIN
  ALTER TABLE reviews ADD CONSTRAINT reviews_status_check CHECK (status IN ('pending','approved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // Foreign key to products — only added if every existing review row already
  // points at a real product (true for a normal install); skipped harmlessly
  // otherwise rather than failing the whole schema init on old/inconsistent data.
  await query(`
DO $$ BEGIN
  ALTER TABLE reviews ADD CONSTRAINT reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN foreign_key_violation THEN NULL; WHEN others THEN NULL; END $$;
  `);

  // ---- Age category (Toddlers / Youngsters / Teens) ----
  // Nullable on purpose: existing products keep age_category = NULL (shown as
  // "unassigned" in admin) until someone deliberately assigns a category —
  // we never guess which bracket an existing product belongs to.
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS age_category TEXT;`);
  await query(`
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_age_category_check
    CHECK (age_category IS NULL OR age_category IN ('Toddlers','Youngsters','Teens'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}

module.exports = { pool, query, transaction, initSchema };

const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { hydrateProduct } = require('./products');

const router = express.Router();
router.use(requireAdmin); // every route below requires a logged-in admin

// ============================================================
// IMAGE UPLOADS — Cloudinary when configured, local disk otherwise.
//
// WHY: Render's web services (and most PaaS hosts) run on an EPHEMERAL
// filesystem — anything written to disk after the container starts
// (i.e. every image an admin uploads through this panel) is wiped the
// next time the service restarts, redeploys, or spins back up after
// scaling to zero on the free tier. That's the actual, confirmed cause
// of "product images disappear." The images that DO survive are the
// ones sitting in the repo's committed uploads/ folder from the seed
// data — those get redeployed with the code every time, so they look
// fine and mask the real problem until an admin uploads something new.
//
// FIX: when CLOUDINARY_* env vars are present, uploads go straight to
// Cloudinary's persistent storage and the full https:// URL it returns
// is what gets saved in the database — nothing is ever written to this
// server's local disk for admin uploads again. If those env vars are
// absent (e.g. local development on your own machine), it falls back to
// the old local-disk behavior so nothing breaks without Cloudinary set up.
// ============================================================
const cloudinaryConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

let cloudinary = null;
if (cloudinaryConfigured) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.warn(
    'CLOUDINARY_* environment variables are not set — falling back to local-disk image storage. ' +
    'This is fine for local development, but on Render (or any host without a persistent disk), ' +
    'any image an admin uploads will be LOST on the next restart/redeploy. ' +
    'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to fix this in production ' +
    '(see the backend README for exactly how to get these, free, from cloudinary.com).'
  );
}

const uploadMiddleware = cloudinaryConfigured
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)) })
  : multer({
      storage: multer.diskStorage({
        destination: path.join(__dirname, '..', '..', 'uploads'),
        filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
    });

router.post('/upload', uploadMiddleware.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  if (cloudinaryConfigured) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'mashumaan', resource_type: 'image' },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(req.file.buffer);
      });
      // The full https:// URL IS what gets stored in the product's image
      // columns from now on — see hydrateProduct() in routes/products.js,
      // which passes a value like this straight through unchanged instead
      // of prefixing it with this server's own /uploads/ path.
      return res.json({ url: result.secure_url });
    } catch (err) {
      console.error('Cloudinary upload failed:', err);
      return res.status(502).json({ error: 'Could not upload image to cloud storage — please try again.' });
    }
  }

  // Local-disk fallback (development only — see the warning above).
  res.json({ filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

// ---------- orders ----------
router.get('/orders', async (req, res) => {
  const ordersResult = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
  const withItems = await Promise.all(ordersResult.rows.map(async (o) => {
    const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
    return { ...o, items: itemsResult.rows };
  }));
  res.json({ orders: withItems });
});

// 'Cancelled' is intentionally listed separately from the shipping sequence
// below it — it's a terminal state an order can move to from any point, not
// another rung on the ladder. The frontend order-tracking UI renders it as a
// standalone "Cancelled" state instead of a normal completed timeline step.
const SHIPPING_STATUSES = ['Order Placed','Order Confirmed','Processing','Shipped','Out for Delivery','Delivered'];
const VALID_STATUSES = [...SHIPPING_STATUSES, 'Cancelled'];
router.patch('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
  const result = await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

// Manual-transfer orders (Bank/JazzCash/Easypaisa paid directly, not through a
// gateway) sit at payment_status='pending' with a screenshot attached until an
// admin actually checks the money arrived and confirms it here.
router.patch('/orders/:id/verify-payment', async (req, res) => {
  const result = await db.query(`UPDATE orders SET payment_status = 'paid', status = 'Order Placed' WHERE id = $1`, [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

// ---------- site content / settings ----------
// Public GET lives in routes/settings.js (no admin required — every visitor
// needs to read these). This PUT is the only way to change them, and it's
// behind requireAdmin same as everything else in this file.
router.put('/settings', async (req, res) => {
  const entries = Object.entries(req.body || {});
  await db.transaction(async (client) => {
    for (const [k, v] of entries) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [k, JSON.stringify(v)]
      );
    }
  });
  res.json({ ok: true });
});

// ---------- products ----------
router.get('/products', async (req, res) => {
  const result = await db.query('SELECT * FROM products ORDER BY created_at'); // includes deleted — admin needs to see/restore those
  const products = await Promise.all(result.rows.map(hydrateProduct));
  res.json({ products });
});

async function insertVariant(client, productId, v) {
  const variantId = v.id || `${productId}__${v.color.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
  await client.query(`
    INSERT INTO variants (id, product_id, color, color_hex, sku, price, sale_price, image_front, image_back, image_neckline, image_sleeve, image_tunichem, image_pantdetail, image_embroidery, image_fabric)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [
    variantId, productId, v.color, v.colorHex || '#D98CA0', v.sku,
    Number(v.price) || 0, v.salePrice ? Number(v.salePrice) : null,
    v.images.front, v.images.back || v.images.front,
    v.images.neckline || null, v.images.sleeve || null,
    v.images.tunicHem || null, v.images.pantDetail || null,
    v.images.embroidery || null, v.images.fabric || null,
  ]);
  const sizes = v.sizes || {};
  for (const s of ['2','3','4','5','6','7','8','9','10','11','12']) {
    await client.query('INSERT INTO variant_stock (variant_id, size, quantity) VALUES ($1,$2,$3)', [variantId, s, Number(sizes[s]) || 0]);
  }
  return variantId;
}

// Toddlers / Youngsters / Teens — see db.js migration + CHECK constraint.
// An empty string/undefined/null all mean "unassigned" and are stored as NULL.
const AGE_CATEGORIES = ['Toddlers', 'Youngsters', 'Teens'];
function parseAgeCategory(value) {
  if (value == null || value === '') return { ok: true, value: null };
  if (!AGE_CATEGORIES.includes(value)) {
    return { ok: false, error: `ageCategory must be one of: ${AGE_CATEGORIES.join(', ')} (or blank/unassigned).` };
  }
  return { ok: true, value };
}

// Create a product with one or more color variants.
// Body: { name, description, collection, fabric, isNew, isBestseller, featured, sizechart, ageCategory,
//          variants: [{ color, colorHex, sku, price, salePrice, images:{front,back,...}, sizes:{'2':5,...} }] }
router.post('/products', async (req, res) => {
  const p = req.body;
  if (!p.name || !Array.isArray(p.variants) || p.variants.length === 0) {
    return res.status(400).json({ error: 'name and at least one variant are required.' });
  }
  for (const v of p.variants) {
    if (!v.color || !v.sku || !v.images || !v.images.front) {
      return res.status(400).json({ error: 'Each variant needs a color, SKU, and front image.' });
    }
  }
  const ageCategory = parseAgeCategory(p.ageCategory);
  if (!ageCategory.ok) return res.status(400).json({ error: ageCategory.error });
  const id = p.id || `custom-${Date.now()}`;
  try {
    await db.transaction(async (client) => {
      await client.query(`
        INSERT INTO products (id, name, description, collection, fabric, tags, is_new, is_bestseller, featured, sizechart, age_category)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        id, p.name, p.description || '', p.collection || 'Casual Wear', p.fabric || 'Cotton Blend',
        p.tags || [], !!p.isNew, !!p.isBestseller, !!p.featured, p.sizechart || null, ageCategory.value,
      ]);
      for (const v of p.variants) { await insertVariant(client, id, v); }
    });
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not create product — check that SKUs are unique.' });
  }
});

// Replace a product's core fields + fully replace its variant list.
router.put('/products/:id', async (req, res) => {
  const p = req.body;
  const existing = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Product not found.' });
  const ageCategory = parseAgeCategory(p.ageCategory);
  if (!ageCategory.ok) return res.status(400).json({ error: ageCategory.error });
  try {
    await db.transaction(async (client) => {
      await client.query(`
        UPDATE products SET name=$1, description=$2, collection=$3, fabric=$4,
          tags=$5, is_new=$6, is_bestseller=$7, featured=$8, sizechart=$9, age_category=$10
        WHERE id=$11
      `, [
        p.name, p.description || '', p.collection, p.fabric, p.tags || [],
        !!p.isNew, !!p.isBestseller, !!p.featured, p.sizechart || null, ageCategory.value, req.params.id,
      ]);
      if (Array.isArray(p.variants)) {
        await client.query('DELETE FROM variants WHERE product_id = $1', [req.params.id]); // cascades to variant_stock
        for (const v of p.variants) { await insertVariant(client, req.params.id, v); }
      }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not update product — check that SKUs are unique.' });
  }
});

// Soft delete / restore
router.patch('/products/:id/toggle-delete', async (req, res) => {
  const result = await db.query('SELECT deleted FROM products WHERE id = $1', [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: 'Product not found.' });
  await db.query('UPDATE products SET deleted = $1 WHERE id = $2', [!row.deleted, req.params.id]);
  res.json({ deleted: !row.deleted });
});

// Quick stock-only update for one variant/size (used by "update stock" quick action)
router.patch('/variants/:variantId/stock/:size', async (req, res) => {
  const { quantity } = req.body;
  if (quantity == null || quantity < 0) return res.status(400).json({ error: 'quantity must be a non-negative number.' });
  await db.query(`
    INSERT INTO variant_stock (variant_id, size, quantity) VALUES ($1,$2,$3)
    ON CONFLICT (variant_id, size) DO UPDATE SET quantity = EXCLUDED.quantity
  `, [req.params.variantId, req.params.size, quantity]);
  res.json({ ok: true });
});

// ---------- reviews ----------
// GET /api/admin/reviews — every review (any status), newest first, with
// the product name joined in so the admin doesn't have to cross-reference
// product IDs by hand. Optional ?status=pending|approved|rejected filter.
router.get('/reviews', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await db.query(`
      SELECT r.id, r.product_id, p.name AS product_name, r.name AS customer_name,
             r.rating, r.text, r.verified, r.status, r.created_at, r.updated_at
      FROM reviews r LEFT JOIN products p ON p.id = r.product_id
      ${where}
      ORDER BY r.created_at DESC
    `, params);
    res.json({ reviews: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// PATCH /api/admin/reviews/:id/status — the only way a review's status can
// change. Only an admin (requireAdmin, applied to this whole router) can
// call this — customers can never set their own review to "approved".
const REVIEW_STATUSES = ['pending', 'approved', 'rejected'];
router.patch('/reviews/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!REVIEW_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${REVIEW_STATUSES.join(', ')}` });
  }
  try {
    const result = await db.query(
      `UPDATE reviews SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Review not found.' });
    res.json({ ok: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update review status.' });
  }
});

// DELETE /api/admin/reviews/:id — permanent; the frontend confirms with the
// admin before calling this (there's no undo, unlike product soft-delete).
router.delete('/reviews/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Review not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete review.' });
  }
});

// ---------- FAQs ----------
// GET /api/admin/faqs — every FAQ (active and inactive), in display order.
router.get('/faqs', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM faqs ORDER BY display_order ASC, id ASC');
    res.json({ faqs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load FAQs.' });
  }
});

router.post('/faqs', async (req, res) => {
  const question = (req.body.question || '').trim();
  const answer = (req.body.answer || '').trim();
  const displayOrder = Number.isFinite(Number(req.body.displayOrder)) ? Number(req.body.displayOrder) : 0;
  const isActive = req.body.isActive !== false; // defaults to true
  if (!question || !answer) return res.status(400).json({ error: 'Both a question and an answer are required.' });
  if (question.length > 300) return res.status(400).json({ error: 'Question must be 300 characters or fewer.' });
  if (answer.length > 2000) return res.status(400).json({ error: 'Answer must be 2000 characters or fewer.' });
  try {
    const result = await db.query(
      `INSERT INTO faqs (question, answer, display_order, is_active) VALUES ($1,$2,$3,$4) RETURNING id`,
      [question, answer, displayOrder, isActive]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create FAQ.' });
  }
});

router.put('/faqs/:id', async (req, res) => {
  const question = (req.body.question || '').trim();
  const answer = (req.body.answer || '').trim();
  const displayOrder = Number.isFinite(Number(req.body.displayOrder)) ? Number(req.body.displayOrder) : 0;
  const isActive = !!req.body.isActive;
  if (!question || !answer) return res.status(400).json({ error: 'Both a question and an answer are required.' });
  if (question.length > 300) return res.status(400).json({ error: 'Question must be 300 characters or fewer.' });
  if (answer.length > 2000) return res.status(400).json({ error: 'Answer must be 2000 characters or fewer.' });
  try {
    const result = await db.query(
      `UPDATE faqs SET question=$1, answer=$2, display_order=$3, is_active=$4, updated_at=NOW() WHERE id=$5`,
      [question, answer, displayOrder, isActive, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'FAQ not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update FAQ.' });
  }
});

// PATCH /api/admin/faqs/:id — quick partial update, used for the admin
// panel's Enable/Disable toggle so it doesn't need to resend the whole FAQ.
router.patch('/faqs/:id', async (req, res) => {
  const fields = [];
  const params = [];
  let i = 1;
  if (typeof req.body.isActive === 'boolean') { fields.push(`is_active = $${i++}`); params.push(req.body.isActive); }
  if (req.body.displayOrder != null && Number.isFinite(Number(req.body.displayOrder))) { fields.push(`display_order = $${i++}`); params.push(Number(req.body.displayOrder)); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  fields.push(`updated_at = NOW()`);
  params.push(req.params.id);
  try {
    const result = await db.query(`UPDATE faqs SET ${fields.join(', ')} WHERE id = $${i}`, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'FAQ not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update FAQ.' });
  }
});

router.delete('/faqs/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM faqs WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'FAQ not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete FAQ.' });
  }
});

// ---------- size charts ----------
const SIZE_CHART_FIELDS = ['size', 'ageLabel', 'shirtLength', 'chest', 'sleeveLength', 'trouserLength', 'waist'];

// Shared validation for both the global-default and per-product size chart
// payloads. Measurements are intentionally accepted as blank strings — the
// admin is expected to fill in real numbers later; this only guards
// against garbage shapes, not against incomplete data. Each row needs at
// least a Size or an Age so it can be told apart from the others.
function validateSizeChartPayload(body) {
  const unit = body.unit === 'cm' ? 'cm' : 'in';
  if (!Array.isArray(body.rows)) return { error: '"rows" must be an array.' };
  if (body.rows.length > 20) return { error: 'A size chart can have at most 20 rows.' };
  const rows = [];
  for (const r of body.rows) {
    if (!r || typeof r !== 'object') return { error: 'Each row must be an object.' };
    const row = {};
    for (const key of SIZE_CHART_FIELDS) {
      const val = String(r[key] == null ? '' : r[key]).trim();
      const max = (key === 'size' || key === 'ageLabel') ? 40 : 20;
      if (val.length > max) return { error: `${key} must be ${max} characters or fewer.` };
      row[key] = val;
    }
    if (!row.size && !row.ageLabel) return { error: 'Every row needs a Size or an Age (e.g. "6" or "6 Years").' };
    rows.push(row);
  }
  return { unit, rows };
}

// GET/PUT the single site-wide default chart (product_id IS NULL).
router.get('/size-charts/global', async (req, res) => {
  try {
    const result = await db.query('SELECT unit, rows, updated_at FROM size_charts WHERE product_id IS NULL');
    res.json({ chart: result.rows[0] || { unit: 'in', rows: [] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the default size chart.' });
  }
});

router.put('/size-charts/global', async (req, res) => {
  const parsed = validateSizeChartPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const existing = await db.query('SELECT id FROM size_charts WHERE product_id IS NULL');
    if (existing.rows[0]) {
      await db.query('UPDATE size_charts SET unit=$1, rows=$2, updated_at=NOW() WHERE id=$3', [parsed.unit, JSON.stringify(parsed.rows), existing.rows[0].id]);
    } else {
      await db.query('INSERT INTO size_charts (product_id, unit, rows) VALUES (NULL, $1, $2)', [parsed.unit, JSON.stringify(parsed.rows)]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the default size chart.' });
  }
});

// GET/PUT/DELETE a specific product's own chart (product_id set). DELETE
// simply removes the override so the product falls back to the default —
// it does not touch the product itself.
router.get('/products/:id/size-chart', async (req, res) => {
  try {
    const result = await db.query('SELECT unit, rows, updated_at FROM size_charts WHERE product_id = $1', [req.params.id]);
    res.json({ chart: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load this product’s size chart.' });
  }
});

router.put('/products/:id/size-chart', async (req, res) => {
  const parsed = validateSizeChartPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const productCheck = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!productCheck.rows[0]) return res.status(404).json({ error: 'Product not found.' });

    const existing = await db.query('SELECT id FROM size_charts WHERE product_id = $1', [req.params.id]);
    if (existing.rows[0]) {
      await db.query('UPDATE size_charts SET unit=$1, rows=$2, updated_at=NOW() WHERE id=$3', [parsed.unit, JSON.stringify(parsed.rows), existing.rows[0].id]);
    } else {
      await db.query('INSERT INTO size_charts (product_id, unit, rows) VALUES ($1, $2, $3)', [req.params.id, parsed.unit, JSON.stringify(parsed.rows)]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save this product’s size chart.' });
  }
});

router.delete('/products/:id/size-chart', async (req, res) => {
  try {
    await db.query('DELETE FROM size_charts WHERE product_id = $1', [req.params.id]);
    res.json({ ok: true }); // no-op if it didn't have its own chart — reverting to default either way
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove this product’s custom size chart.' });
  }
});

module.exports = router;

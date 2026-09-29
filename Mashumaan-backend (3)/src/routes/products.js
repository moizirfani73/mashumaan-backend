const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { optionalAuth } = require('../middleware/auth');
const router = express.Router();

async function hydrateProduct(row) {
  const variantsResult = await db.query('SELECT * FROM variants WHERE product_id = $1', [row.id]);
  const variants = await Promise.all(variantsResult.rows.map(async (v) => {
    const stockResult = await db.query('SELECT size, quantity FROM variant_stock WHERE variant_id = $1', [v.id]);
    const sizes = {};
    stockResult.rows.forEach(s => { sizes[s.size] = s.quantity; });
    return {
      color: v.color, colorHex: v.color_hex, sku: v.sku,
      price: v.price, salePrice: v.sale_price,
      images: {
        front: v.image_front, back: v.image_back, neckline: v.image_neckline,
        sleeve: v.image_sleeve, tunicHem: v.image_tunichem, pantDetail: v.image_pantdetail,
        embroidery: v.image_embroidery, fabric: v.image_fabric,
      },
      sizes,
    };
  }));
  // Rating/count shown on the storefront only ever reflect admin-approved
  // reviews — pending/rejected reviews never move a product's average.
  const statsResult = await db.query(`SELECT COUNT(*) c, AVG(rating) avg FROM reviews WHERE product_id = $1 AND status = 'approved'`, [row.id]);
  const reviewStats = statsResult.rows[0];
  return {
    id: row.id, name: row.name, description: row.description,
    collection: row.collection, fabric: row.fabric, tags: row.tags || [],
    isNew: !!row.is_new, isBestseller: !!row.is_bestseller, featured: !!row.featured,
    deleted: !!row.deleted,
    sizechart: row.sizechart,
    ageCategory: row.age_category || null,
    rating: Number(reviewStats.avg) || 0, reviewCount: Number(reviewStats.c) || 0,
    variants,
  };
}

// GET /api/products — list, with optional filters matching the storefront's UI
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products WHERE deleted = FALSE ORDER BY created_at');
    let products = await Promise.all(result.rows.map(hydrateProduct));

    const { collection, color, minPrice, maxPrice, isNew, isBestseller, ageCategory } = req.query;
    if (collection) products = products.filter(p => p.collection === collection);
    if (ageCategory) products = products.filter(p => p.ageCategory === ageCategory);
    if (color) products = products.filter(p => p.variants.some(v => v.color === color));
    if (isNew === 'true') products = products.filter(p => p.isNew);
    if (isBestseller === 'true') products = products.filter(p => p.isBestseller);
    if (minPrice) products = products.filter(p => p.variants.some(v => (v.salePrice || v.price) >= Number(minPrice)));
    if (maxPrice) products = products.filter(p => p.variants.some(v => (v.salePrice || v.price) <= Number(maxPrice)));

    res.json({ products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load products.' });
  }
});

// GET /api/products/:id — single product with full variant + review detail
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM products WHERE id = $1 AND deleted = FALSE', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: await hydrateProduct(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load this product.' });
  }
});

// GET /api/products/:id/reviews — public: only approved reviews, newest
// first, paginated so a popular product can't force loading its entire
// review history at once. ?limit=1..50 (default 10), ?offset=0..
router.get('/:id/reviews', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const [rowsResult, countResult] = await Promise.all([
      db.query(
        `SELECT id, name, rating, text, verified, created_at
         FROM reviews WHERE product_id = $1 AND status = 'approved'
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      ),
      db.query(`SELECT COUNT(*) c FROM reviews WHERE product_id = $1 AND status = 'approved'`, [req.params.id]),
    ]);
    res.json({ reviews: rowsResult.rows, total: Number(countResult.rows[0].c) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load reviews for this product.' });
  }
});

// A handful of review submissions per IP per 15 minutes — slows down
// review-spam without blocking a genuine customer.
const reviewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true });

// POST /api/products/:id/reviews — anyone can leave a review; it always
// starts as "pending" and only becomes publicly visible once an admin
// approves it (see PATCH /api/admin/reviews/:id/status).
//
// SECURITY: status is never accepted from the request body — the backend
// is the only thing that can set it, both here (always 'pending') and in
// the admin approve/reject endpoint. "Verified Purchase" is likewise never
// taken from the client: it's computed here from the *authenticated*
// customer's own email (via their JWT), never from an email string the
// client could type in to fraudulently claim someone else's purchase.
router.post('/:id/reviews', optionalAuth, reviewLimiter, async (req, res) => {
  const name = (req.body.name || '').trim();
  const text = (req.body.text || '').trim();
  const rating = Number(req.body.rating);

  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (name.length > 80) return res.status(400).json({ error: 'Name must be 80 characters or fewer.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please select a star rating from 1 to 5.' });
  }
  if (!text) return res.status(400).json({ error: 'Please write a review.' });
  if (text.length < 3) return res.status(400).json({ error: 'Review is too short.' });
  if (text.length > 1000) return res.status(400).json({ error: 'Review must be 1000 characters or fewer.' });

  try {
    const productResult = await db.query('SELECT id FROM products WHERE id = $1 AND deleted = FALSE', [req.params.id]);
    if (!productResult.rows[0]) return res.status(404).json({ error: 'Product not found.' });

    let verified = false;
    if (req.user) {
      const userResult = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const email = userResult.rows[0] && userResult.rows[0].email;
      if (email) {
        const purchased = await db.query(`
          SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_id = $1 AND o.customer_email = $2 LIMIT 1
        `, [req.params.id, email]);
        verified = purchased.rows.length > 0;
      }
    }

    const result = await db.query(
      `INSERT INTO reviews (product_id, user_id, name, rating, text, verified, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, status`,
      [req.params.id, req.user ? req.user.id : null, name, rating, text, verified]
    );
    res.status(201).json({ id: result.rows[0].id, status: result.rows[0].status, verified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save your review — please try again.' });
  }
});

// GET /api/products/:id/size-chart — public. Returns this product's own
// size chart if an admin set one, otherwise falls back to the site-wide
// default chart (product_id IS NULL) so a customer always sees something
// useful. `isDefault` tells the frontend which one it actually got, so it
// can label the modal correctly ("Size Guide for this product" vs the
// general Mashumaan guide).
router.get('/:id/size-chart', async (req, res) => {
  try {
    const own = await db.query('SELECT unit, rows, updated_at FROM size_charts WHERE product_id = $1', [req.params.id]);
    if (own.rows[0]) return res.json({ chart: own.rows[0], isDefault: false });

    const fallback = await db.query('SELECT unit, rows, updated_at FROM size_charts WHERE product_id IS NULL');
    if (fallback.rows[0]) return res.json({ chart: fallback.rows[0], isDefault: true });

    res.json({ chart: null, isDefault: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the size chart.' });
  }
});

module.exports = router;
module.exports.hydrateProduct = hydrateProduct;

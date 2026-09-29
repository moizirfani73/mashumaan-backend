// ============================================================
// Public read of the site-wide DEFAULT size chart (product_id IS NULL) —
// used by the "Size Guide" link in places with no specific product in
// context (e.g. the footer). A specific product's own chart, with
// fallback to this same default, is served from
// GET /api/products/:id/size-chart in routes/products.js instead.
// Admin create/edit lives behind admin auth in routes/admin.js.
// ============================================================
const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/global', async (req, res) => {
  try {
    const result = await db.query('SELECT unit, rows, updated_at FROM size_charts WHERE product_id IS NULL');
    res.json({ chart: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the size guide.' });
  }
});

module.exports = router;

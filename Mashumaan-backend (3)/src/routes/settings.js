// ============================================================
// Public site-content settings — anyone can read these (the storefront
// needs them to render the homepage, About page, delivery policy, etc.
// for every visitor). Writing them requires admin auth — see
// PUT /api/admin/settings in routes/admin.js.
// ============================================================
const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  const result = await db.query('SELECT key, value FROM settings');
  const settings = {};
  result.rows.forEach(r => { try { settings[r.key] = JSON.parse(r.value); } catch(e) { settings[r.key] = r.value; } });
  res.json({ settings });
});

module.exports = router;

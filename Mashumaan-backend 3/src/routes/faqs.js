// ============================================================
// Public FAQ reads — anyone can GET the active FAQ list (the Help page
// needs it for every visitor). Creating/editing/deleting/reordering FAQs
// requires admin auth — see the /faqs routes in routes/admin.js.
// ============================================================
const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /api/faqs — only active FAQs, in the order the admin arranged them.
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, question, answer, display_order FROM faqs WHERE is_active = TRUE ORDER BY display_order ASC, id ASC'
    );
    res.json({ faqs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load FAQs.' });
  }
});

module.exports = router;

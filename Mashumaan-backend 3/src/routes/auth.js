const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// A handful of failed logins per IP per 15 minutes — slows down password
// guessing without punishing a customer who just mistyped their password once.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true });

router.post('/register', async (req, res) => {
  const { email, password, firstName, lastName } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and a password of at least 6 characters are required.' });
  }
  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING id',
      [email.toLowerCase(), hash, firstName || '', lastName || '']
    );
    const user = { id: result.rows[0].id, email: email.toLowerCase(), is_admin: false };
    res.status(201).json({ token: signToken(user), user: { email: user.email, firstName, lastName, isAdmin: false } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create account — please try again.' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    res.json({
      token: signToken(user),
      user: { email: user.email, firstName: user.first_name, lastName: user.last_name, isAdmin: !!user.is_admin },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in — please try again.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT email, first_name, last_name, is_admin FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { email: user.email, firstName: user.first_name, lastName: user.last_name, isAdmin: !!user.is_admin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your profile.' });
  }
});

// PATCH /api/auth/me — lets a logged-in customer actually update their name
// for real (this used to be a frontend-only, non-persisted "fake save").
router.patch('/me', requireAuth, async (req, res) => {
  const { firstName, lastName } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name are required.' });
  try {
    await db.query('UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3', [firstName, lastName, req.user.id]);
    res.json({ user: { email: req.user.email, firstName, lastName, isAdmin: req.user.isAdmin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update your details.' });
  }
});

// PATCH /api/auth/me/password — change your own password (requires the
// current one). Does not exist for the admin account specifically — this
// works for any account, admin included, once logged in.
router.patch('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  try {
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(currentPassword || '', user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change your password.' });
  }
});

// ---------- saved addresses (real, per-account — used to be browser-only) ----------
router.get('/me/addresses', requireAuth, async (req, res) => {
  const result = await db.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
  res.json({ addresses: result.rows.map(a => ({ id: a.id, label: a.label, address: a.address, city: a.city, province: a.province, postal: a.postal })) });
});

router.post('/me/addresses', requireAuth, async (req, res) => {
  const { label, address, city, province, postal } = req.body;
  if (!address || !city || !province) return res.status(400).json({ error: 'Address, city, and province are required.' });
  const result = await db.query(
    'INSERT INTO addresses (user_id, label, address, city, province, postal) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [req.user.id, label || 'Address', address, city, province, postal || '']
  );
  res.status(201).json({ id: result.rows[0].id });
});

router.delete('/me/addresses/:id', requireAuth, async (req, res) => {
  const result = await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Address not found.' });
  res.json({ ok: true });
});

module.exports = router;

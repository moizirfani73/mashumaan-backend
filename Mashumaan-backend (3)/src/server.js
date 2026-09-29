require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const productsRoutes = require('./routes/products');
const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const paymentsRoutes = require('./routes/payments');
const settingsRoutes = require('./routes/settings');
const faqsRoutes = require('./routes/faqs');
const sizechartsRoutes = require('./routes/sizecharts');

const app = express();
const PORT = process.env.PORT || 4000;

// CORS: only allow real storefront origin(s) to call this API.
// ALLOWED_ORIGIN may be one origin or a comma-separated list, e.g.
//   ALLOWED_ORIGIN=https://mashumaan-frontend.vercel.app,https://mashumaan.pk
// If it isn't set, we fall back to a known, explicit allow-list (the live
// Vercel frontend + common local-dev origins) rather than reflecting every
// origin — this is never "*" in production. Set ALLOWED_ORIGIN on Render to
// override/extend this list once you have a final production domain.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://mashumaan-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
];
const configuredOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
app.use(cors({
  origin(origin, cb) {
    // No Origin header = same-origin/non-browser request (curl, server-to-server) — allow.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin "${origin}" is not allowed. Set ALLOWED_ORIGIN on the server to permit it.`));
  },
}));

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '8mb' })); // 8mb: comfortably covers a base64 payment-screenshot upload
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Generic rate limit across the whole API — a basic defense against abuse/scraping.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/products', productsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/faqs', faqsRoutes);
app.use('/api/size-charts', sizechartsRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

app.listen(PORT, async () => {
  try {
    await db.initSchema(); // creates tables on first run; a no-op if they already exist
  } catch (err) {
    console.error('Could not initialize the database schema:', err.message);
  }
  console.log(`Mashumaan backend listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

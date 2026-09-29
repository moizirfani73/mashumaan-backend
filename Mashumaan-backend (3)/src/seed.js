// ============================================================
// Seed script — populates the database with the same 9 products
// (grouped into 4 color-variant products) that the storefront ships
// with, so the backend and frontend start out identical.
// Run once with: npm run seed
// Safe to re-run — it wipes and recreates catalog data (products/
// variants/stock) each time, but never touches users, orders, or
// reviews, so re-seeding won't erase real customer activity.
// ============================================================
require('dotenv').config();
const db = require('./db');
const { ensureAdmin } = require('./ensure-admin');

async function wipeCatalog() {
  await db.query('DELETE FROM variant_stock');
  await db.query('DELETE FROM variants');
  await db.query('DELETE FROM products');
}

async function insertProduct(p) {
  await db.query(`
    INSERT INTO products (id, name, description, collection, fabric, tags, is_new, is_bestseller, featured, sizechart)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    p.id, p.name, p.description, p.collection, p.fabric, p.tags || [],
    !!p.isNew, !!p.isBestseller, !!p.featured, p.sizechart || null,
  ]);
  for (const v of p.variants) {
    const variantId = `${p.id}__${v.color.toLowerCase().replace(/\s+/g,'-')}`;
    await db.query(`
      INSERT INTO variants (id, product_id, color, color_hex, sku, price, sale_price, image_front, image_back)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [variantId, p.id, v.color, v.colorHex, v.sku, v.price, v.salePrice || null, v.image, v.image]);
    for (const [size, qty] of Object.entries(v.stock)) {
      await db.query('INSERT INTO variant_stock (variant_id, size, quantity) VALUES ($1,$2,$3)', [variantId, size, qty]);
    }
  }
}

function fullStock(overrides) {
  const sizes = ['2','3','4','5','6','7','8','9','10','11','12'];
  const out = {};
  sizes.forEach(s => { out[s] = Object.prototype.hasOwnProperty.call(overrides, s) ? overrides[s] : 6; });
  return out;
}

const CATALOG = [
  {
    id: 'p-classic-suit', name: 'Mashumaan Printed 2-Piece Suit',
    description: "A relaxed A-line kurta finished with an intricately printed border panel and matching palazzo pants. Soft cotton blend, breathable for everyday wear.",
    collection: 'Casual Wear', fabric: 'Cotton Blend', tags: ['casual','printed','2-piece'],
    isNew: true, isBestseller: false, featured: true,
    variants: [
      { color: 'Ruby Red', colorHex: '#A72430', sku: 'MSH-2PC-RED', price: 3499, salePrice: null, image: 'red.jpg', stock: fullStock({2:0,12:0,9:2}) },
      { color: 'Mustard', colorHex: '#C1862C', sku: 'MSH-2PC-MUS', price: 3499, salePrice: null, image: 'mustard.jpg', stock: fullStock({2:0,3:0,10:1}) },
      { color: 'Deep Blue', colorHex: '#1B3A56', sku: 'MSH-2PC-NVY', price: 3499, salePrice: 2499, image: 'navy.jpg', stock: fullStock({11:0,12:0}) },
    ],
  },
  {
    id: 'p-feather-suit', name: 'Mashumaan Feather Print 2-Piece Set',
    description: "A signature feather plume print scattered across the front and blooming into a full statement design at the back, finished with matching wide-leg pants.",
    collection: 'Festive Wear', fabric: 'Lawn', tags: ['peach','blue','white','cream','feather','festive','2-piece'],
    isNew: true, isBestseller: false, featured: true,
    variants: [
      { color: 'Peach', colorHex: '#EFC1AE', sku: 'MSH-2PC-PCH', price: 3699, salePrice: null, image: 'peach.jpg', stock: fullStock({6:2}) },
      { color: 'Sky Blue', colorHex: '#A9D3E8', sku: 'MSH-2PC-SKY', price: 3699, salePrice: null, image: 'skyblue.jpg', stock: fullStock({12:0}) },
      { color: 'White', colorHex: '#F1EAD9', sku: 'MSH-2PC-WHT', price: 3699, salePrice: null, image: 'cream.jpg', stock: fullStock({}) },
    ],
  },
  {
    id: 'p-mandala-suit', name: 'Mashumaan Mandala Print 2-Piece Set',
    description: "A hand-drawn mandala motif blooming into a floral archway print at the back, finished with matching palazzo pants. A festive favourite.",
    collection: 'Festive Wear', fabric: 'Khaddar', tags: ['pink','magenta','blue','teal','mandala','festive','2-piece'],
    isNew: false, isBestseller: true, featured: true,
    variants: [
      { color: 'Magenta', colorHex: '#D6266E', sku: 'MSH-2PC-MAG', price: 3999, salePrice: null, image: 'magenta.jpg', stock: fullStock({3:0,4:0}) },
      { color: 'Cerulean', colorHex: '#1E7FA8', sku: 'MSH-2PC-TEL', price: 3999, salePrice: 3199, image: 'teal.jpg', stock: fullStock({2:0,4:0,8:2}) },
    ],
  },
  {
    id: 'p-mountain-suit', name: 'Mashumaan Mountain Print 2-Piece Set',
    description: "A striking mountain-diamond medallion print in warm sunset tones, tied at the neckline with delicate tassels and finished with matching wide-leg pants.",
    collection: 'Festive Wear', fabric: 'Cotton Blend', tags: ['blue','teal','olive','green','dustyrose','pink','mountain','festive','2-piece'],
    isNew: false, isBestseller: false, featured: false,
    variants: [
      { color: 'Blue/Teal', colorHex: '#2E7A96', sku: 'MSH-2PC-TBL', price: 3799, salePrice: null, image: 'tealblue.jpg', stock: fullStock({}) },
      { color: 'Olive', colorHex: '#585B31', sku: 'MSH-2PC-OLV', price: 3299, salePrice: 2599, image: 'olive.jpg', stock: fullStock({2:0,3:0,11:0}) },
      { color: 'Dusty Rose', colorHex: '#D9A0AE', sku: 'MSH-2PC-DPK', price: 3799, salePrice: null, image: 'dustypink.jpg', stock: fullStock({2:0,5:3}) },
    ],
  },
];

async function run() {
  await db.initSchema();
  await wipeCatalog();
  for (const p of CATALOG) { await insertProduct(p); }
  const countResult = await db.query('SELECT COUNT(*) c FROM variants');
  console.log(`Seeded ${CATALOG.length} products (${countResult.rows[0].c} color variants).`);

  // Admin bootstrap shared with ensure-admin.js (the script to use on
  // production, since it doesn't wipe the catalog like this seed script does).
  await ensureAdmin();
  // Seed a starter FAQ list if none exist yet — safe to re-run (admin edits
  // via the Admin > FAQs panel are left untouched on subsequent seed runs).
  const faqCount = await db.query('SELECT COUNT(*) c FROM faqs');
  if (Number(faqCount.rows[0].c) === 0) {
    const DEFAULT_FAQS = [
      { q: 'How can I place an order?', a: 'Browse a product, pick a color and size, then use Add to Cart or Buy Now. At checkout, enter your delivery details and choose a payment method to place your order.' },
      { q: 'What payment methods do you accept?', a: 'We accept Cash on Delivery and manual Bank Transfer / JazzCash / Easypaisa. Online card payment will appear here once a licensed payment gateway is connected.' },
      { q: 'How long does delivery take?', a: 'Orders are processed within 1–2 business days and delivered across Pakistan within 3–5 business days.' },
      { q: 'Can I exchange or return an item?', a: 'Yes — exchanges are accepted within 7 days of delivery for unworn items with tags attached. Contact us to start an exchange.' },
      { q: 'Do you offer Cash on Delivery?', a: 'Yes, Cash on Delivery is available nationwide alongside Bank Transfer, JazzCash, and Easypaisa.' },
      { q: 'How can I track my order?', a: 'Use the Track Your Order page with your order number and the phone number you provided at checkout to see live status.' },
    ];
    for (let i = 0; i < DEFAULT_FAQS.length; i++) {
      await db.query(
        'INSERT INTO faqs (question, answer, display_order, is_active) VALUES ($1,$2,$3,TRUE)',
        [DEFAULT_FAQS[i].q, DEFAULT_FAQS[i].a, i]
      );
    }
    console.log(`Seeded ${DEFAULT_FAQS.length} starter FAQs.`);
  } else {
    console.log('FAQs already exist — left untouched.');
  }

  await db.pool.end();
}

run().catch(err => { console.error('Seed failed:', err); process.exit(1); });

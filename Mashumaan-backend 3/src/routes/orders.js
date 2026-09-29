const express = require('express');
const db = require('../db');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { availablePaymentMethods } = require('../gateways');

const router = express.Router();

async function getSetting(key, fallback) {
  const result = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (!result.rows[0]) return fallback;
  try { return JSON.parse(result.rows[0].value); } catch(e) { return result.rows[0].value; }
}

function genOrderId() {
  return 'MSH' + Math.floor(100000 + Math.random() * 899999);
}

// GET /api/orders/payment-methods — lets the frontend know, at runtime,
// which payment methods are actually live right now. COD and manual
// transfer always work; a gateway only appears once its real credentials
// are set in .env.
router.get('/payment-methods', (req, res) => {
  res.json({ methods: availablePaymentMethods() });
});

// POST /api/orders — create an order.
// CRITICAL: prices and stock are read from the DATABASE here, never trusted
// from the client. The stock check-and-decrement uses SELECT ... FOR UPDATE
// inside one transaction, which locks each variant/size row for the duration —
// under real concurrent traffic (which Postgres allows, unlike the old
// single-writer SQLite setup), this is what actually stops two customers
// racing for the last unit of a size from both succeeding.
router.post('/', optionalAuth, async (req, res) => {
  const { items, customer, paymentMethod, paymentProof } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty.' });
  if (!customer || !customer.name || !customer.phone || !customer.email || !customer.address || !customer.city || !customer.province) {
    return res.status(400).json({ error: 'Missing required customer/shipping details.' });
  }
  const allowed = availablePaymentMethods(); // e.g. ['cod','manual'] until a gateway is configured
  if (!allowed.includes(paymentMethod)) {
    return res.status(501).json({
      error: `"${paymentMethod}" is not available yet. Currently accepted: ${allowed.join(', ')}.`,
      availableMethods: allowed,
    });
  }
  // Orders paid via a gateway or manual transfer start as "pending" — a gateway
  // order flips to "paid" once its webhook confirms the transaction; a manual
  // transfer flips once an admin verifies it in Admin > Orders. Stock is still
  // reserved/decremented immediately on order creation either way, matching
  // the storefront's COD behaviour.
  try {
    const DELIVERY_FEE = await getSetting('deliveryFee', 250);
    const FREE_DELIVERY_THRESHOLD = await getSetting('freeDeliveryThreshold', 3000);

    const order = await db.transaction(async (client) => {
      let subtotal = 0;
      const resolvedItems = [];

      for (const item of items) {
        const variantResult = await client.query('SELECT * FROM variants WHERE product_id = $1 AND color = $2', [item.productId, item.color]);
        const variant = variantResult.rows[0];
        if (!variant) throw { status: 400, message: `Unknown product/color: ${item.productId} / ${item.color}` };

        // FOR UPDATE locks this exact (variant, size) row until the transaction
        // commits or rolls back — a second concurrent order for the same size
        // has to wait right here until this one finishes, so it always sees
        // the up-to-date remaining stock rather than a stale read.
        const stockResult = await client.query(
          'SELECT quantity FROM variant_stock WHERE variant_id = $1 AND size = $2 FOR UPDATE',
          [variant.id, item.size]
        );
        const available = stockResult.rows[0] ? stockResult.rows[0].quantity : 0;
        if (available < item.qty) {
          throw { status: 409, message: `Only ${available} left in stock for ${variant.color}, size ${item.size} — please adjust your quantity.` };
        }

        await client.query('UPDATE variant_stock SET quantity = quantity - $1 WHERE variant_id = $2 AND size = $3', [item.qty, variant.id, item.size]);

        const productResult = await client.query('SELECT name FROM products WHERE id = $1', [item.productId]);
        const unitPrice = variant.sale_price || variant.price;
        subtotal += unitPrice * item.qty;
        resolvedItems.push({
          product_id: item.productId, variant_id: variant.id, product_name: productResult.rows[0].name,
          color: variant.color, sku: variant.sku, size: item.size, qty: item.qty, unit_price: unitPrice,
        });
      }

      const deliveryFee = subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
      const total = subtotal + deliveryFee;
      const initialStatus = paymentMethod === 'manual' ? 'Awaiting Payment Verification' : 'Order Placed';

      // Order IDs are short random strings, not sequential — retry on the
      // (very rare) chance of a collision with an existing order.
      let orderId;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = genOrderId();
        const clash = await client.query('SELECT 1 FROM orders WHERE id = $1', [candidate]);
        if (clash.rows.length === 0) { orderId = candidate; break; }
      }
      if (!orderId) throw { status: 500, message: 'Could not generate a unique order number — please try again.' };

      await client.query(`
        INSERT INTO orders (id, user_id, customer_name, customer_phone, customer_email, address, city, province, postal, payment_method, payment_proof, status, subtotal, delivery_fee, total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        orderId, req.user ? req.user.id : null,
        customer.name, customer.phone, customer.email,
        customer.address, customer.city, customer.province, customer.postal || '',
        paymentMethod, paymentMethod === 'manual' ? (paymentProof || null) : null,
        initialStatus, subtotal, deliveryFee, total,
      ]);

      for (const it of resolvedItems) {
        await client.query(`
          INSERT INTO order_items (order_id, product_id, variant_id, product_name, color, sku, size, qty, unit_price)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [orderId, it.product_id, it.variant_id, it.product_name, it.color, it.sku, it.size, it.qty, it.unit_price]);
      }

      return { id: orderId, status: initialStatus, subtotal, deliveryFee, total, items: resolvedItems };
    });

    res.status(201).json({ order });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not place order — please try again.' });
  }
});

// GET /api/orders/track?orderId=MSH123456&phone=03001234567 — public tracking lookup
router.get('/track', async (req, res) => {
  const { orderId, phone } = req.query;
  const result = await db.query('SELECT * FROM orders WHERE id = $1 AND customer_phone = $2', [orderId, phone]);
  const order = result.rows[0];
  if (!order) return res.status(404).json({ error: 'No order found with that order number and phone.' });
  const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
  res.json({ order: { ...order, items: itemsResult.rows } });
});

// GET /api/orders/mine — the logged-in customer's own order history
router.get('/mine', requireAuth, async (req, res) => {
  const userResult = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
  const email = userResult.rows[0].email;
  const ordersResult = await db.query('SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC', [email]);
  const withItems = await Promise.all(ordersResult.rows.map(async (o) => {
    const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
    return { ...o, items: itemsResult.rows };
  }));
  res.json({ orders: withItems });
});

module.exports = router;

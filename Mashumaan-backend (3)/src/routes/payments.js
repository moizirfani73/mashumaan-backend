// ============================================================
// Payment gateway scaffolding: JazzCash, Easypaisa, and PayFast.
//
// NONE OF THESE ARE LIVE YET. Each one follows the same honest pattern:
//   - isConfigured() checks for real credentials in .env
//   - if they're missing, the endpoint returns a clear 501 error —
//     it never fakes a successful payment
//   - once you register as a merchant with that gateway and add your
//     real credentials to .env, it becomes a genuine integration
//   - /api/orders/payment-methods tells the frontend which of these
//     are actually live right now, so the checkout page only shows
//     options that will really work
//
// IMPORTANT: field names, endpoint URLs, and hash algorithms below
// follow each gateway's publicly documented integration pattern as
// closely as I could verify. Payment gateway specs are only fully
// published to registered merchants and do change — before going
// live, confirm every field name and URL against the official
// merchant integration guide you receive after signing up, and test
// against their sandbox/UAT environment first. Never store card
// numbers, CVV, PINs, or OTPs in this database — the gateway's own
// hosted page collects those directly, never your server.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { optionalAuth } = require('../middleware/auth');
const {
  JAZZCASH, isJazzCashConfigured,
  EASYPAISA, isEasypaisaConfigured,
  PAYFAST, isPayfastConfigured,
} = require('../gateways');

const router = express.Router();

async function getPayableOrder(orderId, res) {
  const result = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = result.rows[0];
  if (!order) { res.status(404).json({ error: 'Order not found.' }); return null; }
  if (order.payment_status === 'paid') { res.status(400).json({ error: 'Order is already paid.' }); return null; }
  return order;
}

async function markOrderPaid(orderId, succeeded) {
  await db.query('UPDATE orders SET payment_status = $1 WHERE id = $2', [succeeded ? 'paid' : 'failed', orderId]);
}

// ============================================================
// JAZZCASH — Hosted Checkout Page (HCP)
// Merchant portal: jazzcash.com.pk/business
// You build pp_ fields + a secure hash; customer is redirected to
// JazzCash's own page to enter card/wallet details (so their card
// number/CVV/PIN never touches your server); JazzCash POSTs the
// result back to your webhook, which you must verify before trusting.
// ============================================================
function jazzcashHash(fields) {
  const sortedValues = Object.keys(fields)
    .filter(k => k !== 'pp_SecureHash' && fields[k] !== '' && fields[k] != null)
    .sort()
    .map(k => fields[k]);
  const hashString = JAZZCASH.integritySalt + '&' + sortedValues.join('&');
  return crypto.createHmac('sha256', JAZZCASH.integritySalt).update(hashString).digest('hex');
}

router.post('/jazzcash/initiate', optionalAuth, async (req, res) => {
  if (!isJazzCashConfigured()) {
    return res.status(501).json({ error: 'JazzCash is not configured yet. Add JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD, JAZZCASH_INTEGRITY_SALT, and JAZZCASH_RETURN_URL to your .env file.' });
  }
  const order = await getPayableOrder(req.body.orderId, res);
  if (!order) return;

  const now = new Date();
  const txnDateTime = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const expiry = new Date(now.getTime() + 60 * 60 * 1000);
  const txnExpiryDateTime = expiry.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

  const fields = {
    pp_Version: '1.1',
    pp_TxnType: 'MWALLET',
    pp_Language: 'EN',
    pp_MerchantID: JAZZCASH.merchantId,
    pp_Password: JAZZCASH.password,
    pp_TxnRefNo: order.id,
    pp_Amount: String(Math.round(order.total * 100)), // JazzCash expects amount in paisas
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: txnDateTime,
    pp_TxnExpiryDateTime: txnExpiryDateTime,
    pp_BillReference: order.id,
    pp_Description: `Mashumaan order ${order.id}`,
    pp_ReturnURL: JAZZCASH.returnUrl,
    ppmpf_1: order.customer_email || '',
  };
  fields.pp_SecureHash = jazzcashHash(fields);

  // The frontend auto-submits these fields as a POST form to `endpoint`
  // (JazzCash's hosted page) — that's how the customer ends up there.
  res.json({ gateway: 'jazzcash', endpoint: JAZZCASH.endpoint, method: 'POST', fields });
});

router.post('/jazzcash/webhook', express.urlencoded({ extended: true }), async (req, res) => {
  if (!isJazzCashConfigured()) return res.status(501).send('JazzCash not configured.');
  const body = req.body;
  if (body.pp_SecureHash !== jazzcashHash(body)) {
    console.error('JazzCash webhook: secure hash mismatch — possible spoofed request. Ignoring.');
    return res.status(400).send('Invalid signature.');
  }
  await markOrderPaid(body.pp_TxnRefNo, body.pp_ResponseCode === '000'); // '000' = success
  res.status(200).send('OK'); // JazzCash expects a plain 200 acknowledgement
});

// ============================================================
// EASYPAISA — Hosted checkout (Hash-Key signed redirect)
// Merchant portal: easypaisa.com.pk (Merchant Onboarding)
// Same shape as JazzCash: you sign a request package with the
// Hash-Key from your merchant portal, redirect the customer to
// Easypaisa's page, and they notify your configured IPN/return URL.
// Easypaisa also offers a direct server-to-server "MA Transaction"
// API using RSA-2048 request signing instead of this redirect flow —
// worth asking your account manager which one they provision you,
// since the exact field names differ between the two methods.
// ============================================================
function easypaisaHash(fields) {
  // Easypaisa's merchant guide describes signing the request with the
  // portal-issued Hash-Key so the package can't be tampered with in transit.
  // Confirm the exact field concatenation order in your merchant guide —
  // this uses the same "sorted, salted HMAC" shape as JazzCash's, which is
  // the safe default until you have their PDF in hand.
  const sortedValues = Object.keys(fields)
    .filter(k => k !== 'merchantHashedReq' && fields[k] !== '' && fields[k] != null)
    .sort()
    .map(k => fields[k]);
  return crypto.createHmac('sha256', EASYPAISA.hashKey).update(sortedValues.join('&')).digest('hex');
}

router.post('/easypaisa/initiate', optionalAuth, async (req, res) => {
  if (!isEasypaisaConfigured()) {
    return res.status(501).json({ error: 'Easypaisa is not configured yet. Add EASYPAISA_STORE_ID, EASYPAISA_HASH_KEY, and EASYPAISA_RETURN_URL to your .env file.' });
  }
  const order = await getPayableOrder(req.body.orderId, res);
  if (!order) return;

  const orderRefNum = order.id + '-' + Date.now(); // Easypaisa requires a unique reference per attempt
  const fields = {
    storeId: EASYPAISA.storeId,
    amount: order.total.toFixed(2),
    postBackURL: EASYPAISA.returnUrl,
    orderRefNum,
    expiryDate: new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 8) + '2359',
    merchantHashedReq: '', // filled below
    autoRedirect: '1',
    paymentMethod: 'MA_PAYMENT_METHOD', // mobile account; Easypaisa also supports card via their page
  };
  fields.merchantHashedReq = easypaisaHash(fields);

  res.json({ gateway: 'easypaisa', endpoint: EASYPAISA.endpoint, method: 'POST', fields, orderRefNum });
});

router.post('/easypaisa/webhook', express.urlencoded({ extended: true }), async (req, res) => {
  if (!isEasypaisaConfigured()) return res.status(501).send('Easypaisa not configured.');
  const body = req.body;
  const orderId = String(body.orderRefNum || '').split('-')[0];
  const expectedHash = easypaisaHash(body);
  if (body.merchantHashedReq && body.merchantHashedReq !== expectedHash) {
    console.error('Easypaisa webhook: hash mismatch — possible spoofed request. Ignoring.');
    return res.status(400).send('Invalid signature.');
  }
  const succeeded = body.responseCode === '0000' || body.transactionStatus === 'PAID';
  await markOrderPaid(orderId, succeeded);
  res.status(200).send('OK');
});

// ============================================================
// PAYFAST (Pakistan, State Bank–licensed) — OAuth2 token + REST API
// Merchant portal: gopayfast.com
// Unlike JazzCash/Easypaisa's redirect-a-form pattern, PayFast issues
// a short-lived access token from your Merchant ID + Secured Key, then
// you call their REST transaction API directly with that Bearer token.
// This is what lets it cover Visa/Mastercard/Amex + direct bank
// payment through one integration.
// ============================================================
let payfastTokenCache = { token: null, expiresAt: 0 };

async function getPayfastToken() {
  if (payfastTokenCache.token && Date.now() < payfastTokenCache.expiresAt) {
    return payfastTokenCache.token;
  }
  const resp = await fetch(PAYFAST.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: PAYFAST.merchantId,
      client_secret: PAYFAST.securedKey,
    }),
  });
  if (!resp.ok) throw new Error(`PayFast token request failed (${resp.status})`);
  const data = await resp.json();
  // PayFast's token responses are OAuth2-shaped: access_token + expires_in (seconds).
  payfastTokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3000) - 60) * 1000 };
  return payfastTokenCache.token;
}

router.post('/payfast/initiate', optionalAuth, async (req, res) => {
  if (!isPayfastConfigured()) {
    return res.status(501).json({ error: 'PayFast is not configured yet. Add PAYFAST_MERCHANT_ID, PAYFAST_SECURED_KEY, and PAYFAST_RETURN_URL to your .env file.' });
  }
  const order = await getPayableOrder(req.body.orderId, res);
  if (!order) return;

  try {
    const token = await getPayfastToken();
    const txnResp = await fetch(PAYFAST.transactionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        merchantId: PAYFAST.merchantId,
        orderId: order.id,
        transactionAmount: order.total.toFixed(2),
        transactionType: 'CC', // card scheme (Visa/Mastercard/Amex) — PayFast also supports bank/wallet channels
        currencyCode: 'PKR',
        customerEmailAddress: order.customer_email || '',
        customerMobileNumber: order.customer_phone || '',
        returnUrl: PAYFAST.returnUrl,
      }),
    });
    const data = await txnResp.json();
    if (!txnResp.ok) {
      console.error('PayFast transaction init failed:', data);
      return res.status(502).json({ error: 'PayFast rejected the transaction request.', details: data });
    }
    // PayFast's REST response for a hosted transaction includes a redirect
    // URL for the customer to complete payment on their secure page.
    res.json({ gateway: 'payfast', redirectUrl: data.redirectUrl || data.paymentUrl, raw: data });
  } catch (err) {
    console.error('PayFast initiate error:', err.message);
    res.status(502).json({ error: 'Could not reach PayFast. Try again shortly.' });
  }
});

// PayFast confirms transactions via a server-to-server callback to your
// returnUrl/notify endpoint. Because the exact callback payload/signature
// scheme is only published in the merchant guide you get after signing up,
// this handler re-queries PayFast's own transaction-status API rather than
// trusting the callback body directly — the safer default when a webhook's
// signature format isn't 100% pinned down yet. Swap in real signature
// verification once you have PayFast's guide, mirroring the JazzCash/
// Easypaisa pattern above.
router.post('/payfast/webhook', express.json(), async (req, res) => {
  if (!isPayfastConfigured()) return res.status(501).send('PayFast not configured.');
  const orderId = req.body.orderId || req.body.order_id;
  if (!orderId) return res.status(400).send('Missing orderId.');
  try {
    const token = await getPayfastToken();
    const statusResp = await fetch(`${PAYFAST.transactionUrl}/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await statusResp.json();
    const succeeded = String(data.status || data.transactionStatus || '').toUpperCase() === 'PAID';
    await markOrderPaid(orderId, succeeded);
    res.status(200).send('OK');
  } catch (err) {
    console.error('PayFast webhook verification error:', err.message);
    res.status(502).send('Could not verify with PayFast.');
  }
});

module.exports = router;

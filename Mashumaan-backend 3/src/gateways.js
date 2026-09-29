// ============================================================
// Shared "is this gateway actually configured" checks.
// Both routes/orders.js (to decide whether to accept an order with
// this payment method) and routes/payments.js (to build the actual
// redirect/hash) need this, so it lives in one place to avoid the
// two files drifting out of sync about what "configured" means.
// ============================================================

const JAZZCASH = {
  merchantId: process.env.JAZZCASH_MERCHANT_ID,
  password: process.env.JAZZCASH_PASSWORD,
  integritySalt: process.env.JAZZCASH_INTEGRITY_SALT,
  returnUrl: process.env.JAZZCASH_RETURN_URL,
  endpoint: process.env.JAZZCASH_ENDPOINT || 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
};
function isJazzCashConfigured() {
  return !!(JAZZCASH.merchantId && JAZZCASH.password && JAZZCASH.integritySalt && JAZZCASH.returnUrl);
}

const EASYPAISA = {
  storeId: process.env.EASYPAISA_STORE_ID,
  hashKey: process.env.EASYPAISA_HASH_KEY,
  returnUrl: process.env.EASYPAISA_RETURN_URL,
  endpoint: process.env.EASYPAISA_ENDPOINT || 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf',
};
function isEasypaisaConfigured() {
  return !!(EASYPAISA.storeId && EASYPAISA.hashKey && EASYPAISA.returnUrl);
}

const PAYFAST = {
  merchantId: process.env.PAYFAST_MERCHANT_ID,
  securedKey: process.env.PAYFAST_SECURED_KEY,
  returnUrl: process.env.PAYFAST_RETURN_URL,
  tokenUrl: process.env.PAYFAST_TOKEN_URL || 'https://ipguat.apps.net.pk/Ecommerce/api/Token',
  transactionUrl: process.env.PAYFAST_TRANSACTION_URL || 'https://ipguat.apps.net.pk/Ecommerce/api/Transaction',
};
function isPayfastConfigured() {
  return !!(PAYFAST.merchantId && PAYFAST.securedKey && PAYFAST.returnUrl);
}

// The single source of truth for "which payment methods can this order
// actually use right now" — cod and manual transfer always work (neither
// needs a gateway); each real gateway only becomes selectable once its
// credentials are in .env.
function availablePaymentMethods() {
  const methods = ['cod', 'manual'];
  if (isJazzCashConfigured()) methods.push('jazzcash');
  if (isEasypaisaConfigured()) methods.push('easypaisa');
  if (isPayfastConfigured()) methods.push('payfast');
  return methods;
}

module.exports = {
  JAZZCASH, isJazzCashConfigured,
  EASYPAISA, isEasypaisaConfigured,
  PAYFAST, isPayfastConfigured,
  availablePaymentMethods,
};

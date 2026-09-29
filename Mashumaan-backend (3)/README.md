# Mashumaan Backend

A real backend API for the Mashumaan storefront: a PostgreSQL database, product/variant/stock
management, customer accounts (with real saved addresses and profile editing), order
placement with transaction-safe stock validation, an admin API, and payment gateway
scaffolding for JazzCash, Easypaisa, and PayFast (Pakistan) — none of the gateways are
live until you connect real merchant credentials.

The frontend (`mashumaan.html`) is already wired up to call this API for everything —
products, checkout, accounts, admin — instead of storing data in the browser. Every
visitor and the admin panel now talk to the same real database.

## What this does NOT do

- It does not include hosting for either the backend or the database — you still need
  to deploy both somewhere (see Deployment below).
- It does not include a real payment gateway connection — JazzCash, Easypaisa, and
  PayFast are all scaffolded but disabled until you register as a merchant with each
  and add real credentials. COD and manual bank/wallet transfer need no setup and work today.

## Requirements

- [Node.js](https://nodejs.org) version 18 or later installed on your computer (or your host)
- A PostgreSQL database — either installed locally for development, or a free tier from
  a host like [Render](https://render.com), [Railway](https://railway.app),
  [Supabase](https://supabase.com), or [Neon](https://neon.tech). You'll want a real
  hosted one for production either way (see Deployment below), so it's often easiest to
  just create that first and use it for local development too.

## Running it locally

```bash
cd mashumaan-backend
npm install               # installs all dependencies
cp .env.example .env      # create your local config file
```

Open `.env` and set:

```
DATABASE_URL=<your PostgreSQL connection string>
JWT_SECRET=<run the command below to generate one>
```

Your `DATABASE_URL` looks like `postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME` —
whichever Postgres host you're using will show you this exact string when you create
the database. If you installed Postgres locally instead, set `DATABASE_SSL=false`
(hosted providers need SSL; a local install usually doesn't have it configured).

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste the output as the value of `JWT_SECRET` in `.env`.

Then seed the database with the current catalog and a default admin login (this also
creates all the tables — you don't need to run any SQL yourself):
```bash
npm run seed
```
This prints an admin email/password — **log in and change that password immediately**
using the new Change Password form in My Account.

Start the server:
```bash
npm start
```
Visit `http://localhost:4000/api/health` — you should see `{"ok":true, ...}`.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/products` | List all products (supports `?collection=`, `?color=`, `?isNew=true`, etc.) |
| GET | `/api/products/:id` | One product with all its color variants and stock |
| GET | `/api/products/:id/reviews` | Approved reviews for a product (paginated: `?limit=&offset=`) |
| POST | `/api/products/:id/reviews` | Submit a review — always starts as `pending`, never shown publicly until an admin approves it |
| GET | `/api/faqs` | Active FAQs, in display order (public) |
| GET | `/api/products/:id/size-chart` | That product's size chart, or the site-wide default if it has none (`isDefault` says which) |
| GET | `/api/size-charts/global` | The site-wide default size chart (public) |
| POST | `/api/auth/register` | Create a customer account |
| POST | `/api/auth/login` | Log in, returns a token |
| GET | `/api/auth/me` | Current logged-in user (requires `Authorization: Bearer <token>`) |
| PATCH | `/api/auth/me` | Update your own name (real, persisted — not a browser-only change) |
| PATCH | `/api/auth/me/password` | Change your own password (requires current password) |
| GET | `/api/auth/me/addresses` | Your saved addresses |
| POST | `/api/auth/me/addresses` | Save a new address |
| DELETE | `/api/auth/me/addresses/:id` | Remove a saved address |
| GET | `/api/orders/payment-methods` | Which payment methods are actually live right now (`cod` always; gateways only once configured) |
| POST | `/api/orders` | Place an order (validates & decrements real stock) |
| GET | `/api/orders/track?orderId=&phone=` | Public order tracking |
| GET | `/api/orders/mine` | Logged-in customer's own orders |
| GET | `/api/admin/orders` | All orders (admin only) |
| PATCH | `/api/admin/orders/:id/status` | Update fulfillment status (admin only) |
| GET | `/api/admin/reviews` | All reviews, any status, product name included (admin only; `?status=` filter optional) |
| PATCH | `/api/admin/reviews/:id/status` | Approve/reject a review — the only way a review becomes publicly visible (admin only) |
| DELETE | `/api/admin/reviews/:id` | Permanently delete a review (admin only) |
| GET | `/api/admin/faqs` | All FAQs, active and inactive (admin only) |
| POST | `/api/admin/faqs` | Create an FAQ (admin only) |
| PUT | `/api/admin/faqs/:id` | Replace an FAQ's question/answer/order/active flag (admin only) |
| PATCH | `/api/admin/faqs/:id` | Partially update an FAQ, e.g. just toggling active or reordering (admin only) |
| DELETE | `/api/admin/faqs/:id` | Delete an FAQ (admin only) |
| GET / PUT | `/api/admin/size-charts/global` | Read / save the site-wide default size chart (admin only) |
| GET / PUT / DELETE | `/api/admin/products/:id/size-chart` | Read / save / remove one product's own size chart; DELETE reverts it to the default (admin only) |
| GET/POST/PUT | `/api/admin/products` | Manage products & variants (admin only) |
| PATCH | `/api/admin/products/:id/toggle-delete` | Hide/restore a product (admin only) |
| PATCH | `/api/admin/variants/:variantId/stock/:size` | Quick stock update (admin only) |
| POST | `/api/admin/upload` | Upload a product image (admin only) |
| POST | `/api/payments/jazzcash/initiate` | Build a JazzCash redirect (disabled until configured) |
| POST | `/api/payments/jazzcash/webhook` | JazzCash payment confirmation (disabled until configured) |
| POST | `/api/payments/easypaisa/initiate` | Build an Easypaisa redirect (disabled until configured) |
| POST | `/api/payments/easypaisa/webhook` | Easypaisa payment confirmation (disabled until configured) |
| POST | `/api/payments/payfast/initiate` | Start a PayFast transaction — Visa/Mastercard/Amex/bank (disabled until configured) |
| POST | `/api/payments/payfast/webhook` | PayFast payment confirmation, re-verified against PayFast's own status API (disabled until configured) |

Admin routes require a header: `Authorization: Bearer <admin's login token>`.

## Why stock can't be oversold

Placing an order runs inside a single PostgreSQL transaction (see `src/routes/orders.js`):
each item's stock row is locked with `SELECT ... FOR UPDATE` while it's checked, and only
if every item has enough stock does it decrement the stock and create the order — all
atomically. If two customers try to buy the last unit of a size at the same instant, the
second request's lock simply waits until the first transaction finishes, then sees the
now-updated (zero) stock and fails cleanly. This was verified directly, not just assumed:
firing two genuinely simultaneous requests at the last unit of a size resulted in exactly
one order succeeding and one correctly failing with "out of stock," with final stock
landing at exactly zero — never negative.

## Review moderation & FAQs

Every review a customer submits starts as `status = 'pending'` — the backend sets this,
never the client, and it's the only thing that ever changes it (`PATCH
/api/admin/reviews/:id/status`, admin-only). Public reads (`GET
/api/products/:id/reviews`, and the average rating baked into `GET /api/products`) only
ever include `status = 'approved'` reviews. "Verified Purchase" is computed from the
*authenticated* customer's own email via their JWT — never from an email string a guest
could type into the review form — so it can't be spoofed by claiming someone else's order.

FAQs work the same shape: `GET /api/faqs` (public) only returns `is_active = TRUE` rows,
ordered by `display_order`; everything else (`POST`/`PUT`/`PATCH`/`DELETE
/api/admin/faqs`) requires an admin token.

## The frontend is already connected

`mashumaan.html` (a single self-contained file — there is no separate `app.js`) calls
this API directly — for the product catalog, checkout, login/register, account details,
addresses, reviews, and everything in the admin panel. The only thing separating a local
test run from a real, live site is:

1. Deploy this backend somewhere with a real URL (see Deployment below).
2. In `mashumaan.html`, find the line:
   ```js
   const API_BASE_URL = 'http://localhost:4000/api';
   ```
   (near the top of the `<script id="app-script">` block) and change it to your deployed
   backend's URL, e.g. `const API_BASE_URL = 'https://mashumaan-backend.onrender.com/api';`
3. In this backend's `.env` (or your host's environment variable settings), set
   `ALLOWED_ORIGIN` to wherever you host the frontend, so only your real site can call
   your API.

That's it — no further rewiring needed. See the top-level `README.md` (one directory up
from this backend folder) for the complete, step-by-step deployment walkthrough covering
GitHub, Render, and the frontend host together.

## Deployment (suggested path: Render)

1. Create a PostgreSQL database first — on Render: New → PostgreSQL. It gives you an
   "Internal Database URL" — copy that.
2. Push this backend folder to a GitHub repository (excluding `node_modules` and `.env`
   — already handled by `.gitignore`).
3. On Render: New → Web Service → connect your GitHub repo.
4. Build command: `npm install`. Start command: `npm start`.
5. Add environment variables in Render's dashboard: `DATABASE_URL` (the value from step 1),
   `JWT_SECRET`, `CLOUDINARY_CLOUD_NAME`/`CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET` (see
   below — required for product images to survive a redeploy), and once you have a real
   frontend domain, `ALLOWED_ORIGIN` — never commit your real `.env` file.
6. Render gives your web service a URL like `https://mashumaan-backend.onrender.com` —
   that's your API's live address. Run `npm run seed` once (Render's Shell tab, or locally
   with `DATABASE_URL` pointed at the same database) to create the tables and starting catalog.
7. **Product images and Cloudinary — do this before uploading any product image on the
   live site.** Render's filesystem is ephemeral: anything an admin uploads through the
   panel gets written to local disk and is then silently deleted the next time the service
   restarts, redeploys, or (on the free tier) spins back up after being idle. The fix
   already built into this backend is to upload straight to
   [Cloudinary](https://cloudinary.com) instead, whose free tier (25GB storage/bandwidth)
   is more than enough for a store like this:
   1. Create a free account at cloudinary.com.
   2. Your dashboard homepage shows **Cloud Name**, **API Key**, and **API Secret**
      immediately after signup — no card required.
   3. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` in Render's
      Environment tab with those three values → Save Changes (redeploys automatically).
   4. From then on, every image an admin uploads goes to Cloudinary and its permanent URL is
      what's stored in the database — nothing is written to this server's disk anymore, so
      nothing is lost on restart.

   The images already sitting in the repo's `uploads/` folder (the seed catalog photos) are
   unaffected either way — they're part of your git history and get redeployed with the code
   every time, whether or not Cloudinary is configured. Only *new* admin uploads need this.

   If you genuinely don't set Cloudinary's variables, the backend still works — it falls
   back to local-disk storage with a clear warning in the logs — but any product image an
   admin uploads in production will disappear on the next restart. This fallback exists
   for local development only; it is not a safe production configuration.

## Connecting a payment gateway (when you're ready)

Each gateway is independent — connect one, two, or all three whenever you have real
credentials for it. Nothing else in the codebase needs to change: `/api/orders/payment-methods`
automatically reports a gateway as available the moment its `.env` variables are filled in,
and the storefront's checkout page should read that list rather than hardcoding options.

**JazzCash**
1. Register as a business merchant at jazzcash.com.pk/business.
2. They'll give you a Merchant ID, Password, and Integrity Salt — put these in your
   `.env` as `JAZZCASH_MERCHANT_ID`, `JAZZCASH_PASSWORD`, `JAZZCASH_INTEGRITY_SALT`.
3. Set `JAZZCASH_RETURN_URL` to `https://your-api-domain.com/api/payments/jazzcash/webhook`.
4. Test against their sandbox URL (the `.env.example` default) before switching
   `JAZZCASH_ENDPOINT` to production.

**Easypaisa**
1. Register through Easypaisa Merchant Onboarding at easypaisa.com.pk.
2. They'll give you a Store ID and a Hash-Key from the merchant portal — put these in
   `EASYPAISA_STORE_ID` and `EASYPAISA_HASH_KEY`.
3. Set `EASYPAISA_RETURN_URL` to `https://your-api-domain.com/api/payments/easypaisa/webhook`.
4. Ask your Easypaisa account manager whether you've been provisioned the hosted
   redirect flow (what's implemented here) or the direct server-to-server "MA Transaction"
   API (RSA-2048 signed) — they're two different integration shapes, and the field names
   in `payments.js` match the hosted redirect flow specifically.

**PayFast (Pakistan)** — covers Visa, Mastercard, American Express, and direct bank/RAAST
payment through a single integration.
1. Register as a merchant at gopayfast.com.
2. They'll give you a Merchant ID and Secured Key — put these in `PAYFAST_MERCHANT_ID`
   and `PAYFAST_SECURED_KEY`.
3. Set `PAYFAST_RETURN_URL` to `https://your-api-domain.com/api/payments/payfast/webhook`.
4. Test against their UAT URLs (the `.env.example` defaults) before switching
   `PAYFAST_TOKEN_URL`/`PAYFAST_TRANSACTION_URL` to production.

**Before going live with any of them:** re-verify field names, endpoint URLs, and webhook
payloads against that gateway's current official merchant integration guide (they only
hand this over after you register) — payment gateway specs do change, so treat
`payments.js` as a correct-at-time-of-writing starting point built from their publicly
documented patterns, not a guarantee. Test every gateway against its sandbox/UAT
environment with a real test transaction before accepting real customer payments.

## Security notes

- Passwords are hashed with bcrypt — never stored in plain text.
- Card numbers, CVVs, PINs, and OTPs are never handled or stored by this backend at
  all — that's each gateway's own hosted page's job by design.
- The JazzCash and Easypaisa webhooks verify a cryptographic signature before trusting
  any payment confirmation — a request can't just claim "payment succeeded" without it.
  The PayFast webhook goes a step further and re-queries PayFast's own transaction-status
  API rather than trusting the callback body at all, since PayFast's callback signature
  format isn't fully pinned down until you have their merchant guide in hand.
  confirmation — a request can't just claim "payment succeeded" without it.
- Change the default admin password (from `npm run seed`) immediately.

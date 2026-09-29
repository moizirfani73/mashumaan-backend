# Deploying Mashumaan to production

This covers the whole path: **Frontend (static host) → Backend (Render) → PostgreSQL**.
The backend itself has its own more detailed `README.md` inside `mashumaan-backend/` —
this file is the end-to-end walkthrough tying it all together.

Nothing below invents credentials or URLs for you — every `<placeholder>` is something
you'll get from GitHub, Render, or your Postgres provider during the steps themselves.

---

## 1. Upload the project to GitHub

1. Create a new, empty repository on GitHub (e.g. `mashumaan-backend`).
2. On your computer, inside the `mashumaan-backend` folder:
   ```bash
   cd mashumaan-backend
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. `.gitignore` already excludes `node_modules/` and `.env` — your real secrets and
   dependencies are never pushed. Double-check after pushing that no `.env` file shows
   up in the GitHub repo; if it does, remove it and rotate any secrets it contained.
4. Keep the frontend (`mashumaan.html`) in a **separate** repo (or a separate folder in
   the same repo, your choice) — it deploys to a different kind of host than the backend.

## 2. Create the PostgreSQL database

Pick one hosting provider for the database — Render, Neon, Supabase, and Railway all
have a free tier that's enough to start:

- **Render**: Dashboard → New → PostgreSQL → give it a name → Create Database. Once it's
  ready, copy the **Internal Database URL** if your backend will also be a Render Web
  Service (faster, free network path), or the **External Database URL** otherwise.
- **Neon / Supabase / Railway**: create a new project/database from their dashboard; each
  shows you a ready-made connection string in the form
  `postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME`.

Copy that connection string — you'll paste it into `DATABASE_URL` in step 5.

## 3. Required environment variables

Set these on your backend host (Render — see step 4). Never commit real values for these
to git; `.env.example` in the backend folder lists the same names with no secrets filled in.

| Variable | Required? | Value |
|---|---|---|
| `DATABASE_URL` | **Required** | The connection string from step 2 |
| `JWT_SECRET` | **Required** | A random secret — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | Optional | Render sets this automatically; the app already falls back to `4000` locally |
| `DATABASE_SSL` | Optional | Leave unset (SSL on) for a hosted Postgres provider; set to `false` only for a local Postgres install without SSL |
| `ALLOWED_ORIGIN` | Recommended once you have a frontend URL | Your deployed frontend's exact origin, e.g. `https://mashumaan.pk` or `https://your-site.netlify.app` (no trailing slash) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Optional | Used once by `npm run seed` to create the first admin login; defaults to `admin@mashumaan.pk` / `ChangeMe123!` if left unset — **change this password after your first login either way** |
| `JAZZCASH_*` / `EASYPAISA_*` / `PAYFAST_*` | Optional | Only needed once you register as a merchant with a gateway and want it live — see `mashumaan-backend/README.md` |

## 4. Deploy the backend on Render

1. Render Dashboard → New → Web Service → connect the GitHub repo from step 1.
2. **Root directory**: the folder containing `package.json` (if the repo root *is* the
   backend folder, leave this blank).
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Environment**: `Node`
6. Click **Create Web Service** — Render will build and attempt to start it.

## 5. Set the backend's environment variables on Render

In the Web Service → **Environment** tab, add each variable from the table in step 3
(`DATABASE_URL` and `JWT_SECRET` at minimum). Save changes — Render redeploys
automatically. Watch the **Logs** tab; a healthy start looks like:
```
Mashumaan backend listening on http://localhost:10000
Health check: http://localhost:10000/api/health
```

## 6. Run the database migration/seed

The database tables are created automatically the first time the server starts
(`db.initSchema()` runs on every boot and is a no-op if the tables already exist), so
no separate "migrate" step is required. To load the starting product catalog and create
the first admin login, run the seed script **once** against the same database:

- **On Render**: open the Web Service → **Shell** tab and run:
  ```bash
  npm run seed
  ```
- **Or locally**: with `DATABASE_URL` in your local `.env` pointed at the same hosted
  database, run `npm run seed` from your machine.

This prints something like:
```
Seeded 4 products (8 color variants).
Created default admin login -> email: admin@mashumaan.pk  password: ChangeMe123!
IMPORTANT: change this password immediately after your first login.
```
**Log in with that email/password and change the password immediately** (My Account →
Change Password once logged in) before you consider the store live. Seeding is safe to
re-run later — it refreshes catalog data but never touches existing users, orders, or
reviews.

## 7. Get the live backend URL

Render shows your Web Service's public URL at the top of its dashboard page, in the form:
```
https://<your-service-name>.onrender.com
```
Your API's base URL is that address plus `/api`, e.g.
`https://mashumaan-backend.onrender.com/api`. Confirm it's live by visiting
`https://<your-service-name>.onrender.com/api/health` in a browser — you should see
`{"ok":true, "time":"..."}`.

## 8. Put the live backend URL in the frontend

Open `mashumaan.html` and find this line near the top of the `<script id="app-script">`
block (currently around line 760):
```js
const API_BASE_URL = 'http://localhost:4000/api';
```
Change it to your real backend URL from step 7:
```js
const API_BASE_URL = 'https://<your-service-name>.onrender.com/api';
```
Save the file. This single line is the only place the API address is defined — every
request and every product/upload image URL in the app derives from it.

## 9. Deploy the frontend

`mashumaan.html` is a single static file with no build step, so any static host works —
pick one:

- **Netlify**: drag-and-drop the folder containing `mashumaan.html` onto
  [app.netlify.com/drop](https://app.netlify.com/drop), or connect a GitHub repo and set
  the publish directory to wherever the file lives.
- **Vercel**: `vercel deploy` from the folder, or import the GitHub repo in the Vercel
  dashboard (framework preset: "Other" / static).
- **GitHub Pages**: push `mashumaan.html` (renamed to `index.html`) to a repo, then
  enable Pages on that repo/branch in Settings → Pages.
- **Render Static Site**: New → Static Site → connect the repo → leave the build command
  empty and set the publish directory to the folder containing the file.

Once deployed, copy the frontend's live URL (e.g. `https://mashumaan.netlify.app`) and go
back to the backend's `ALLOWED_ORIGIN` environment variable on Render (step 5) — set it to
that exact URL and save, so only your real storefront can call your API.

## 10. Test the complete live website

Work through this checklist against your live URLs (not localhost):

- [ ] Homepage loads products, images, and prices (confirms frontend → backend → DB read path)
- [ ] Open a product, pick a color and size, add to cart
- [ ] "Buy Now" and the cart page both total correctly
- [ ] Checkout as a guest with Cash on Delivery → order appears on the confirmation page
- [ ] Register a new customer account, log in, log out, log back in (confirms auth + JWT)
- [ ] Refresh the page after adding to cart / logging in — cart and login should **persist**
      (this confirms the frontend's browser storage is actually working in production)
- [ ] Log in with the admin account (from step 6) → visit `#/admin` on the frontend URL
- [ ] Admin: view orders, update an order's status, verify a manual-payment order
- [ ] Admin: edit a product's stock/price, confirm it reflects on the storefront
- [ ] Try to open `#/admin` in a private/incognito window (logged out) — you should be
      redirected to login, and any direct API calls to `/api/admin/*` without a token
      should fail with 401/403
- [ ] Place a second COD order for the very last unit of a size, from two browser tabs at
      once, to confirm stock can't be oversold (optional, but worth doing once)
- [ ] Order tracking (`#/order-tracking`) with the order number + phone from a placed order

If every box is checked against your real, deployed URLs — not `localhost` — the site is
genuinely live.

---

## Notes on payment gateways

COD and manual bank/wallet transfer work with zero extra setup. JazzCash, Easypaisa, and
PayFast are scaffolded but stay disabled (checkout won't show them, and the backend
rejects them with a clear error) until you register as a merchant with each and add real
credentials — see `mashumaan-backend/README.md` for exactly which variables each one needs.

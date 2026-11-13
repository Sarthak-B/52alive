# 52 Alive

One-page storefront for 52 Alive streetwear: 3D hanging rack, collection filters, size guide and a WhatsApp order form that sends the full order to +91 93689 86368.

- Site files live in `public/` (`index.html` + `images/`).
- Deployed on Cloudflare Workers via `wrangler.jsonc` (deploy command: `npx wrangler deploy`).
- `src/worker.js` serves the site and adds `POST /api/order`, which creates every website order in Shiprocket.

## Shiprocket

Each order form submit still opens WhatsApp as before, and in the background the same order is created in Shiprocket (Orders → Processing / New) with the customer's address, COD/Prepaid, items, SKUs, price and parcel weight. Prices always come from `CATALOG` in `src/worker.js`, not from the browser.

### One-time setup

1. In Shiprocket go to **Settings → API → Configure → Create an API User**. Use a different email from your main login and note the password.
2. Check the pickup address name in **Settings → Pickup Addresses** and put it in `wrangler.jsonc` → `vars.SHIPROCKET_PICKUP` (must match exactly).
3. Put the shop's email in `vars.SHIPROCKET_FALLBACK_EMAIL` (the form doesn't ask customers for email; Shiprocket uses this for the order).
4. Add the API user login as Worker secrets:
   ```
   npx wrangler secret put SHIPROCKET_EMAIL
   npx wrangler secret put SHIPROCKET_PASSWORD
   ```
5. `npx wrangler deploy`

**The live site runs on Cloudflare Pages** at `https://52alive.make4yu.com` (also `52-alive.pages.dev`). Pages uses `functions/api/order.js` (same code) instead of the Worker, so add the same four values in Cloudflare → Workers & Pages → **52-alive** → Settings → Variables and Secrets (`SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD` as *Secret*, the other two as plain text), then redeploy.

Until the secrets are set, `/api/order` returns 503 and the site keeps working on WhatsApp only.

### When you change products

Update both `const P` in `public/index.html` and `CATALOG` in `src/worker.js` (names, prices, sizes, colours). `node --test tests/*.test.mjs` fails if they drift apart. Weights (kg) and the box size in `src/worker.js` are estimates — set them to your real packaging so shipping rates are right.

Failed Shiprocket calls show up in Cloudflare → Workers → 52alive → Logs.

## Stock (sold-out variants disappear)

Each colour in the product catalogue can carry `stock: {size: count}`, set from the make4yu client dashboard (Shop → Products → Track stock). A size at 0 disappears from the shop, a colour with nothing left disappears, and so does a product. `/api/order` refuses sold-out variants.

When Shiprocket picks up / ships a website order, `POST /api/courier-updates` takes its items off the stock and commits the catalogue, so the site redeploys. Each order is counted once.

Setup — on the **Pages project** that serves 52-alive.pages.dev, not the 52alive Worker (Cloudflare → Workers & Pages → **52-alive** → Settings → Variables and Secrets → **Production**, then redeploy):
- `GITHUB_TOKEN` — fine-grained token, Contents read & write on this repo
- `SHIPROCKET_WEBHOOK_TOKEN` — any long random string

Shiprocket → Settings → API → Webhooks: URL `https://52-alive.pages.dev/api/courier-updates`, security token = `SHIPROCKET_WEBHOOK_TOKEN`, switched on.

Check: `https://52-alive.pages.dev/api/shiprocket-health` → `stockSync.webhookToken`, `githubToken` and `githubCanWrite` all `true`.

If the Shiprocket API user's password changes, update `SHIPROCKET_PASSWORD` on the Pages project and redeploy. After a failed login the site waits 15 minutes before trying again, so Shiprocket doesn't block the user.

Use a dedicated Shiprocket API user (Settings → API → Configure), not the main login.

## Shipping from the make4yu dashboard

`POST /api/store` lets the client dashboard (Shop → Orders) list Shiprocket orders and press **Ship now**:
it books the courier (AWB), schedules the pickup, returns the label and invoice links and takes the
items off the website's stock. The make4yu dashboard (Origin make4yu.com, or DASHBOARD_ORIGINS) needs no key;
anything else must send `x-store-key` = `STORE_KEY` or `SHIPROCKET_WEBHOOK_TOKEN`.
Courier charges come out of the Shiprocket wallet.

## Ordering and tracking

- **Order now** places the order straight from the site (`POST /api/order`): it checks prices and stock against the
  catalogue, creates it in Shiprocket and saves it to the make4yu dashboard. No WhatsApp redirect.
- **Tracking page:** `/track/?id=52A-…` (old `/?track=…` links redirect there).
- **WhatsApp order alert to the shop** comes from make4yu (repo Sarthak-B/make4yu, workflow `whatsapp.yml`), for every client site.

## Winter page

`public/winter/index.html` (the `/winter/` page, opened from the banner on the home page) shows every product whose `"collection"` is `"winter"` in the catalogue block (they stay in the main shop too). Set it from the make4yu dashboard: Shop → Products → open a product → **Show in → Winter section** → Publish. It reads the catalogue from the home page, so there is one place to edit. Pieces added there go into the same bag (kept in the browser as `52a_bag`), and the page has its own winter-styled checkout drawer that places orders through the same `/api/order` (Shiprocket), sends them to the make4yu dashboard (Orders and UPI payments) and shows the same UPI / cash-on-delivery payment step — no trip back to the home page. Fees and UPI details are read from `window.SITE` on the home page. With no winter products the banner and its menu link hide themselves.


---

**© 2026 make4yu. All rights reserved.** This code is shown for portfolio viewing only. Copying, reusing or redistributing any part of it is not permitted. See [LICENSE](LICENSE).

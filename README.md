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

Until the secrets are set, `/api/order` returns 503 and the site keeps working on WhatsApp only.

### When you change products

Update both `const P` in `public/index.html` and `CATALOG` in `src/worker.js` (names, prices, sizes, colours). `node --test tests/*.test.mjs` fails if they drift apart. Weights (kg) and the box size in `src/worker.js` are estimates — set them to your real packaging so shipping rates are right.

Failed Shiprocket calls show up in Cloudflare → Workers → 52alive → Logs.

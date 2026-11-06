/*
 * 52 Alive — Cloudflare Worker
 *
 * Serves the static site from ./public and adds one endpoint:
 *   POST /api/order  → creates the order in Shiprocket (Orders → Custom order).
 *
 * The browser only sends what the customer picked (product key, colour, size, qty)
 * and their address. Names and prices come from the page's product catalogue, never from the
 * browser, so nobody can push a ₹1 order into the Shiprocket panel.
 *
 * Secrets (set once with `npx wrangler secret put <NAME>`):
 *   SHIPROCKET_EMAIL     – email of the Shiprocket *API user* (Settings → API → Configure)
 *   SHIPROCKET_PASSWORD  – password of that API user
 * Vars (wrangler.jsonc → "vars"):
 *   SHIPROCKET_PICKUP          – pickup location name exactly as in Shiprocket (Settings → Pickup Addresses)
 *   SHIPROCKET_FALLBACK_EMAIL  – email sent as billing_email (the form doesn't ask customers for one)
 */

/* The product list lives in the page itself: <script type="application/json" id="nowora-products"> in
 * public/index.html, edited from the NOWORA client dashboard. The endpoint reads that block from the
 * deployed site (cached for a minute), so names and prices always match what customers see and never
 * come from the browser. */
const DEFAULT_WEIGHT = 0.5;
export function catalogFromHtml(html) {
  const m = /<script[^>]*id=["']nowora-products["'][^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ""));
  if (!m) throw new Error("Product catalogue not found on the page");
  const data = JSON.parse(m[1]);
  const out = {};
  for (const p of Array.isArray(data.products) ? data.products : []) {
    if (!p || !/^[\w-]{1,40}$/.test(p.id || "") || p.hidden) continue;
    const price = Number(p.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const colours = (Array.isArray(p.colours) ? p.colours : []).map(c => c && c.name).filter(Boolean);
    if (!colours.length) continue;
    const w = Number(p.weight);
    out[p.id] = { name: String(p.name || p.id), price, weight: w > 0 && w < 30 ? w : DEFAULT_WEIGHT,
      sizes: Array.isArray(p.sizes) && p.sizes.length ? p.sizes.map(String) : ["Free size"], colours };
  }
  if (!Object.keys(out).length) throw new Error("Product catalogue is empty");
  return out;
}

let catalogCache = { at: 0, data: null };
export function _resetCatalogCache() { catalogCache = { at: 0, data: null }; }
export async function loadCatalog(request, env) {
  if (catalogCache.data && Date.now() - catalogCache.at < 60000) return catalogCache.data;
  const res = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
  if (!res.ok) throw new Error("Could not read the product catalogue (" + res.status + ")");
  catalogCache = { at: Date.now(), data: catalogFromHtml(await res.text()) };
  return catalogCache.data;
}

/* Box used for every parcel (cm). Height grows with item count. Adjust to your real packaging. */
const BOX = { length: 32, breadth: 26, heightPerItem: 4, minHeight: 5 };

const SR = "https://apiv2.shiprocket.in/v1/external";
const MAX_LINES = 20, MAX_QTY = 10;

/* Shiprocket tokens last ~10 days; cache per isolate and refresh a bit early. */
let tokenCache = { token: "", exp: 0 };
export function _resetTokenCache() { tokenCache = { token: "", exp: 0 }; }

async function login(env, force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(SR + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error("Shiprocket login failed (" + r.status + "): " + (d.message || "no token"));
  tokenCache = { token: d.token, exp: Date.now() + 8 * 24 * 3600 * 1000 };
  return d.token;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const str = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/* "YYYY-MM-DD HH:mm" in India time */
export function istStamp(d = new Date()) {
  const t = new Date(d.getTime() + 330 * 60000);
  const p = n => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

const slug = s => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");

/* Validate the browser's order and turn it into a Shiprocket payload. Throws on bad input. */
export function buildPayload(input, env, now = new Date(), CATALOG = {}) {
  const bad = m => { const e = new Error(m); e.status = 400; throw e; };
  if (!input || typeof input !== "object") bad("Invalid body");

  const orderId = str(input.orderId, 50);
  if (!/^52A-[0-9a-f-]{36}$/i.test(orderId)) bad("Invalid order ID");

  const name = str(input.name, 80);
  const phone = String(input.phone || "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  const address = str(input.address, 300), city = str(input.city, 60), state = str(input.state, 60);
  const pin = String(input.pin || "").trim();
  if (name.length < 2) bad("Invalid name");
  if (!/^[6-9]\d{9}$/.test(phone)) bad("Invalid phone");
  if (address.length < 8) bad("Invalid address");
  if (city.length < 2 || state.length < 2) bad("Invalid city/state");
  if (!/^[1-9]\d{5}$/.test(pin)) bad("Invalid PIN");

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length || items.length > MAX_LINES) bad("Invalid items");

  /* merge duplicate lines, price everything from CATALOG */
  const lines = new Map();
  for (const it of items) {
    const p = it && Object.prototype.hasOwnProperty.call(CATALOG, it.key) ? CATALOG[it.key] : null;
    if (!p) bad("Unknown product");
    if (!p.colours.includes(it.colour) || !p.sizes.includes(it.size)) bad("Invalid colour/size");
    const q = Number(it.qty);
    if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) bad("Invalid quantity");
    const sku = `52A-${slug(it.key)}-${slug(it.colour)}-${it.size}`;
    const prev = lines.get(sku);
    if (prev) prev.units += q;
    else lines.set(sku, { name: `${p.name} - ${it.colour} / ${it.size}`, sku, units: q, selling_price: p.price, discount: 0, tax: 0, _w: p.weight });
  }
  const order_items = [...lines.values()];
  const units = order_items.reduce((a, b) => a + b.units, 0);
  if (units > MAX_LINES * MAX_QTY) bad("Too many items");
  const sub_total = order_items.reduce((a, b) => a + b.selling_price * b.units, 0);
  const weight = Math.round(order_items.reduce((a, b) => a + b._w * b.units, 0) * 100) / 100;
  order_items.forEach(i => delete i._w);

  const [first, ...rest] = name.split(" ");
  const cod = input.payment === "Cash on Delivery";
  const note = str(input.note, 250);

  const payload = {
    order_id: orderId,
    order_date: istStamp(now),
    pickup_location: env.SHIPROCKET_PICKUP || "Primary",
    comment: note ? "Customer note: " + note : "52 Alive website order",
    billing_customer_name: first,
    billing_last_name: rest.join(" "),
    billing_address: address,
    billing_city: city,
    billing_pincode: pin,
    billing_state: state,
    billing_country: "India",
    billing_phone: phone,
    shipping_is_billing: true,
    order_items,
    payment_method: cod ? "COD" : "Prepaid",
    sub_total,
    length: BOX.length,
    breadth: BOX.breadth,
    height: Math.max(BOX.minHeight, BOX.heightPerItem * units),
    weight,
  };
  if (env.SHIPROCKET_FALLBACK_EMAIL) payload.billing_email = env.SHIPROCKET_FALLBACK_EMAIL;
  return payload;
}

async function createOrder(payload, env) {
  const send = token => fetch(SR + "/orders/create/adhoc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(payload),
  });
  let r = await send(await login(env));
  if (r.status === 401) r = await send(await login(env, true)); /* token expired early */
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.status_code >= 400) {
    const e = new Error("Shiprocket rejected the order (" + r.status + "): " + JSON.stringify(d.errors || d.message || d));
    e.status = 502; throw e;
  }
  return d;
}

export async function handleOrder(request, env) {
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) return json({ ok: false, error: "Shiprocket not configured" }, 503);

  /* only accept submits from this site's own pages */
  const origin = request.headers.get("Origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch {}
    if (host !== new URL(request.url).host) return json({ ok: false, error: "Forbidden" }, 403);
  }

  const raw = await request.text();
  if (raw.length > 20000) return json({ ok: false, error: "Too large" }, 413);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  try {
    let catalog;
    try { catalog = await loadCatalog(request, env); }
    catch (e) { console.error("[shiprocket] catalogue:", e.message); return json({ ok: false, error: "Product list unavailable" }, 503); }
    const d = await createOrder(buildPayload(input, env, new Date(), catalog), env);
    return json({ ok: true, shiprocket_order_id: d.order_id, shipment_id: d.shipment_id });
  } catch (e) {
    console.error("[shiprocket]", e.message);
    return json({ ok: false, error: e.status === 400 ? e.message : "Could not create Shiprocket order" }, e.status || 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/order") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleOrder(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

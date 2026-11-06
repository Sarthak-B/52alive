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
    const payload = buildPayload(input, env, new Date(), catalog);
    payload.pickup_location = await resolvePickup(env);
    const d = await createOrder(payload, env);
    return json({ ok: true, shiprocket_order_id: d.order_id, shipment_id: d.shipment_id });
  } catch (e) {
    console.error("[shiprocket]", e.message);
    return json({ ok: false, error: e.status === 400 ? e.message : "Could not create Shiprocket order" }, e.status || 500);
  }
}


/* ============================== pickup location ==============================
 * Shiprocket wants the pickup location's NAME (Settings → Pickup Addresses), e.g. "Home".
 * SHIPROCKET_PICKUP may hold that name, or an address, or nothing: we read the account's locations
 * (cached 10 min) and use the one that matches by name, then by address text, then the only/primary one.
 */
let pickupCache = { at: 0, list: null };
export function _resetPickupCache() { pickupCache = { at: 0, list: null }; }
const norm = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function choosePickup(list, wanted) {
  const names = list.map(x => x.pickup_location).filter(Boolean);
  if (!names.length) return wanted || "Primary";
  const w = norm(wanted);
  if (w) {
    const byName = list.find(x => norm(x.pickup_location) === w); if (byName) return byName.pickup_location;
    const byAddr = list.find(x => { const a = norm([x.address, x.address_2, x.city, x.pin_code].join(" ")); return a && (w.includes(norm(x.address)) || a.includes(w)) && norm(x.address).length > 3; });
    if (byAddr) return byAddr.pickup_location;
  }
  const primary = list.find(x => x.is_primary_location == 1 || x.is_primary_location === true);
  return (primary || list[0]).pickup_location;
}
export async function resolvePickup(env) {
  if (!pickupCache.list || Date.now() - pickupCache.at > 10 * 60000) {
    try {
      const p = await srGet("/settings/company/pickup", env);
      const raw = (p && p.data && (p.data.shipping_address || p.data)) || [];
      pickupCache = { at: Date.now(), list: Array.isArray(raw) ? raw.filter(x => x && x.pickup_location) : [] };
    } catch (e) { console.error("[shiprocket] pickup list:", e.message); return env.SHIPROCKET_PICKUP || "Primary"; }
  }
  return choosePickup(pickupCache.list, env.SHIPROCKET_PICKUP);
}

/* ============================== order tracking ==============================
 * POST /api/track {orderId, phone} → where the order is, straight from Shiprocket.
 * No customer accounts: the long random order ID plus the phone number the order was placed with
 * act as the key. A wrong ID and a wrong phone get the same "not found" answer, so nobody can probe
 * other people's orders, and each visitor gets a limited number of lookups.
 */
async function srGet(path, env) {
  const send = token => fetch(SR + path, { headers: { Authorization: "Bearer " + token } });
  let r = await send(await login(env));
  if (r.status === 401) r = await send(await login(env, true));
  const d = await r.json().catch(() => ({}));
  if (r.status === 404) return null;
  if (!r.ok) { const e = new Error("Shiprocket " + r.status + ": " + JSON.stringify(d.message || d).slice(0, 200)); e.status = 502; throw e; }
  return d;
}

/* Customer-facing step for a Shiprocket status: 0 placed · 1 confirmed · 2 shipped · 3 out for delivery · 4 delivered */
export function trackStep(status) {
  const s = String(status || "").toUpperCase().replace(/_/g, " ");
  if (/CANCEL/.test(s)) return { step: -1, label: "Cancelled", problem: "cancelled" };
  if (/RTO|RETURN/.test(s)) return { step: -1, label: "Being returned to us", problem: "returned" };
  if (/UNDELIVERED|NDR|FAILED|LOST|DAMAGED|DESTROYED/.test(s)) return { step: 3, label: "Delivery attempt failed — we'll contact you", problem: "attempt" };
  if (/DELIVERED/.test(s)) return { step: 4, label: "Delivered" };
  if (/OUT FOR DELIVERY/.test(s)) return { step: 3, label: "Out for delivery" };
  if (/SHIPPED|TRANSIT|PICKED|REACHED|DESTINATION|DISPATCH|MISROUTED|DELAYED/.test(s)) return { step: 2, label: "On the way" };
  if (/PICKUP|READY|INVOICED|MANIFEST|PACKED|AWB|CONFIRMED|PROCESSING/.test(s)) return { step: 1, label: "Confirmed — being packed" };
  return { step: 0, label: "Order received" };
}

const cleanPhone = v => String(v || "").replace(/\D/g, "").slice(-10);
const lookups = new Map();                          /* per-visitor lookup counter (per isolate) */
function tooMany(ip) {
  const now = Date.now(), k = ip || "?", e = lookups.get(k);
  if (!e || now - e.t > 10 * 60000) { lookups.set(k, { t: now, n: 1 }); if (lookups.size > 5000) lookups.clear(); return false; }
  e.n++; return e.n > 20;
}
export function _resetLookups() { lookups.clear(); }

export async function trackOrder(input, env) {
  const orderId = String(input && input.orderId || "").trim();
  const phone = cleanPhone(input && input.phone);
  if (!/^52A-[0-9a-f-]{36}$/i.test(orderId)) { const e = new Error("Check your order ID — it starts with 52A-"); e.status = 400; throw e; }
  if (!/^[6-9]\d{9}$/.test(phone)) { const e = new Error("Enter the 10-digit mobile number you ordered with"); e.status = 400; throw e; }

  const list = await srGet("/orders?filter_by=channel_order_id&filter=" + encodeURIComponent(orderId) + "&per_page=5", env);
  const orders = Array.isArray(list && list.data) ? list.data : [];
  const o = orders.find(x => String(x.channel_order_id || "").toLowerCase() === orderId.toLowerCase());
  if (!o || cleanPhone(o.customer_phone) !== phone) return null;

  const shipments = Array.isArray(o.shipments) ? o.shipments : o.shipments ? [o.shipments] : [];
  const sh = shipments.find(x => x && (x.awb || x.awb_code)) || shipments[0] || {};
  const awb = String(sh.awb || sh.awb_code || "").trim();

  let tracking = null;
  if (awb) {
    try {
      const t = await srGet("/courier/track/awb/" + encodeURIComponent(awb), env);
      const td = t && (t.tracking_data || (t[awb] && t[awb].tracking_data)) || null;
      if (td) {
        const st = (Array.isArray(td.shipment_track) ? td.shipment_track[0] : null) || {};
        const acts = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [];
        tracking = {
          status: st.current_status || "",
          courier: st.courier_name || sh.courier || "",
          etd: td.etd || st.edd || "",
          delivered: st.delivered_date || "",
          url: /^https:\/\//.test(td.track_url || "") ? td.track_url : "",
          activities: acts.slice(0, 25).map(a => ({ date: String(a.date || ""), status: String(a["sr-status-label"] || a.activity || a.status || ""), detail: String(a.activity || ""), location: String(a.location || "") }))
        };
      }
    } catch (e) { console.error("[track] awb", e.message); }       /* the order status below still answers */
  }

  const status = (tracking && tracking.status) || o.status || "";
  const products = Array.isArray(o.products) ? o.products : [];
  return {
    orderId: orderId,
    placed: o.created_at || o.channel_created_at || "",
    payment: /cod/i.test(o.payment_method || "") ? "Cash on delivery" : o.payment_method ? "Prepaid" : "",
    total: Number(o.total) || 0,
    items: products.slice(0, 20).map(p => ({ name: String(p.name || ""), qty: Number(p.quantity || p.units || 1) || 1 })),
    city: o.customer_city || "",
    ...trackStep(status),
    status: status,
    awb: awb,
    courier: (tracking && tracking.courier) || sh.courier || "",
    tracking: tracking
  };
}

export async function handleTrack(request, env) {
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) return json({ ok: false, error: "Order tracking isn't switched on yet — message us on WhatsApp." }, 503);
  const origin = request.headers.get("Origin");
  if (origin) { let host = ""; try { host = new URL(origin).host; } catch {} if (host !== new URL(request.url).host) return json({ ok: false, error: "Forbidden" }, 403); }
  if (tooMany(request.headers.get("CF-Connecting-IP"))) return json({ ok: false, error: "Too many lookups — try again in a few minutes." }, 429);
  const raw = await request.text();
  if (raw.length > 2000) return json({ ok: false, error: "Too large" }, 413);
  let input; try { input = JSON.parse(raw); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  try {
    const order = await trackOrder(input, env);
    if (!order) return json({ ok: false, error: "We couldn't find that order. Check the order ID and use the phone number you ordered with." }, 404);
    return json({ ok: true, order: order });
  } catch (e) {
    console.error("[track]", e.message);
    return json({ ok: false, error: e.status === 400 ? e.message : "Tracking is busy right now — please try again in a minute." }, e.status === 400 ? 400 : 502);
  }
}


/* ============================== health check ==============================
 * GET /api/shiprocket-health[?order=52A-…] → yes/no answers only (no customer details):
 * can we log in, does the pickup location name match Shiprocket, and can a given order be found.
 */
export async function handleHealth(request, env) {
  const out = { secrets: !!(env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD), fallbackEmailSet: !!env.SHIPROCKET_FALLBACK_EMAIL };
  if (!out.secrets) return json(out);
  try { await login(env, true); out.login = true; } catch (e) { out.login = false; out.loginError = String(e.message).slice(0, 160); return json(out); }
  try {
    const p = await srGet("/settings/company/pickup", env);
    const list = (p && p.data && (p.data.shipping_address || p.data)) || [];
    const names = (Array.isArray(list) ? list : []).map(x => x && x.pickup_location).filter(Boolean);
    out.pickupLocations = names.length;
    out.settingIsAName = names.includes(env.SHIPROCKET_PICKUP || "");
    _resetPickupCache(); out.pickupUsed = await resolvePickup(env);
  } catch (e) { out.pickupError = String(e.message).slice(0, 160); }
  const id = new URL(request.url).searchParams.get("order") || "";
  if (/^52A-[0-9a-f-]{36}$/i.test(id)) {
    const look = async q => { try { const d = await srGet("/orders?" + q, env); const rows = Array.isArray(d && d.data) ? d.data : [];
      const hit = rows.find(x => String(x.channel_order_id || "").toLowerCase() === id.toLowerCase());
      return { rows: rows.length, found: !!hit, status: hit ? hit.status : undefined, hasAwb: hit ? !!((hit.shipments && (hit.shipments[0] || hit.shipments).awb) || "") : undefined }; }
      catch (e) { return { error: String(e.message).slice(0, 160) }; } };
    out.orderByFilter = await look("filter_by=channel_order_id&filter=" + encodeURIComponent(id) + "&per_page=5");
    out.orderBySearch = await look("search=" + encodeURIComponent(id) + "&per_page=5");
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/order") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleOrder(request, env);
    }
    if (url.pathname === "/api/shiprocket-health") return handleHealth(request, env);
    if (url.pathname === "/api/track") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleTrack(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

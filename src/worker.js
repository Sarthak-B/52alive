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
    const base = Array.isArray(p.sizes) && p.sizes.length ? p.sizes.map(String) : ["Free size"];
    const avail = {};                    /* colour → sizes in stock (no stock object = not tracked = all sizes) */
    for (const c of Array.isArray(p.colours) ? p.colours : []) {
      if (!c || !c.name) continue;
      const st = c.stock && typeof c.stock === "object" ? c.stock : null;
      const a = st ? base.filter(z => Number(st[z]) > 0) : base.slice();
      if (a.length) avail[c.name] = a;
    }
    const colours = Object.keys(avail);
    if (!colours.length) continue;
    const w = Number(p.weight);
    out[p.id] = { name: String(p.name || p.id), price, weight: w > 0 && w < 30 ? w : DEFAULT_WEIGHT,
      sizes: base.filter(z => colours.some(c => avail[c].includes(z))), colours, avail };
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

/* Shiprocket blocks the API user after repeated logins that fail — and every Cloudflare instance used to log in
   on its own. So the token and any failure are shared through Cloudflare's cache (one login per ~8 days per data
   centre), a failure stops ALL instances from trying for 30 minutes, and two requests never log in at once. */
let loginFail = { until: 0, msg: "" };
export function _resetLoginFail() { loginFail = { until: 0, msg: "" }; }
const shared = () => { try { return typeof caches !== "undefined" && caches.default ? caches.default : null; } catch (e) { return null; } };
const sharedKey = (env, what) => "https://52alive-cache.invalid/sr/" + what + "/" + encodeURIComponent(String(env.SHIPROCKET_EMAIL || "").toLowerCase());
async function sharedGet(env, what) { const c = shared(); if (!c) return null; try { const r = await c.match(sharedKey(env, what)); return r ? await r.json() : null; } catch (e) { return null; } }
async function sharedPut(env, what, value, seconds) { const c = shared(); if (!c) return; try { await c.put(sharedKey(env, what), new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + Math.max(1, Math.floor(seconds)) } })); } catch (e) { /* best effort */ } }
async function sharedDel(env, what) { const c = shared(); if (!c) return; try { await c.delete(sharedKey(env, what)); } catch (e) {} }
export const _shared = { get: sharedGet, put: sharedPut };
let loginInFlight = null;
async function login(env, force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  if (!force) { const t = await sharedGet(env, "token"); if (t && t.token && t.exp > Date.now()) { tokenCache = t; return t.token; } }
  if (Date.now() < loginFail.until) throw new Error(loginFail.msg + " (waiting before trying again)");
  const f = await sharedGet(env, "fail");
  if (f && f.until > Date.now()) { loginFail = f; throw new Error(f.msg + " (waiting before trying again)"); }
  if (force) await sharedDel(env, "token");
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    const r = await fetch(SR + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token) {
      const msg = "Shiprocket login failed (" + r.status + "): " + (d.message || "no token");
      if (r.status >= 400 && r.status < 500) { loginFail = { until: Date.now() + 30 * 60000, msg }; await sharedPut(env, "fail", loginFail, 30 * 60); }
      throw new Error(msg);
    }
    loginFail = { until: 0, msg: "" };
    tokenCache = { token: d.token, exp: Date.now() + 8 * 24 * 3600 * 1000 };
    await sharedPut(env, "token", tokenCache, 8 * 24 * 3600);
    return d.token;
  })();
  try { return await loginInFlight; } finally { loginInFlight = null; }
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
    if (!(p.avail ? (p.avail[it.colour] || []) : p.colours.includes(it.colour) ? p.sizes : []).includes(it.size)) bad("Sold out or not available: " + p.name + " " + String(it.colour || "").slice(0, 40) + " " + String(it.size || "").slice(0, 12));
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

export async function handleOrder(request, env, ctx) {
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

  let catalog, payload;
  try { catalog = await loadCatalog(request, env); }
  catch (e) { console.error("[order] catalogue:", e.message); return json({ ok: false, error: "Our product list didn't load — please try again in a minute." }, 503); }
  try { payload = buildPayload(input, env, new Date(), catalog); }
  catch (e) { return json({ ok: false, error: e.status === 400 ? e.message : "Something went wrong — please try again." }, e.status || 500); }

  /* the order is valid: tell the shop on WhatsApp (from the site's own number) and put it in Shiprocket.
     The WhatsApp alert never waits on Shiprocket, and a Shiprocket hiccup never fails the customer's order:
     it is also saved to the shop's NOWORA dashboard by the page. */
  const alert = sendOrderAlert(input, payload, request, env).catch(e => { console.error("[alert]", e.message); return false; });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(alert);
  let shiprocket = false, sr = {};
  if (env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD) {
    try { payload.pickup_location = await resolvePickup(env); sr = await createOrder(payload, env); shiprocket = true; }
    catch (e) { console.error("[shiprocket]", e.message); }
  }
  return json({ ok: true, orderId: payload.order_id, shiprocket, shiprocket_order_id: sr.order_id, shipment_id: sr.shipment_id });
}

/* ============================== WhatsApp order alert ==============================
 * Every new order goes to the shop owner's WhatsApp (ORDER_ALERT_TO, comma-separated, e.g. 919368986368)
 * from the business number on the WhatsApp Business API — not from the customer's phone.
 * WhatsApp only lets a business start a chat with an approved template, so the message is the template
 * "new_order_alert" (or WHATSAPP_TEMPLATE) with 6 values: order ID · customer name · customer phone ·
 * items · total & payment · full address (+ note and tracking link).
 *   Meta WhatsApp Cloud API: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID (+ WHATSAPP_TEMPLATE, WHATSAPP_LANG)
 *   or AiSensy:              AISENSY_API_KEY, AISENSY_CAMPAIGN (a live API campaign on that template)
 */
const tplText = (v, max = 900) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").trim().slice(0, max) || "-";
export function orderAlertValues(input, payload, origin) {
  const items = payload.order_items.map(i => i.units + " × " + i.name + " (₹" + (i.selling_price * i.units).toLocaleString("en-IN") + ")").join(" · ");
  const pay = payload.payment_method === "COD" ? "Cash on delivery" : "Prepaid (UPI)";
  const addr = [payload.billing_address, payload.billing_city, payload.billing_state, payload.billing_pincode].filter(Boolean).join(", ");
  const note = str(input && input.note, 200);
  return [
    payload.order_id,
    (payload.billing_customer_name + " " + payload.billing_last_name).trim(),
    "+91 " + payload.billing_phone,
    items,
    "₹" + Number(payload.sub_total).toLocaleString("en-IN") + " · " + pay,
    addr + (note ? " · Note: " + note : "") + (origin ? " · Track: " + origin + "/track/?id=" + payload.order_id : ""),
  ].map(v => tplText(v));
}
export async function sendOrderAlert(input, payload, request, env) {
  const to = String(env.ORDER_ALERT_TO || "").split(",").map(x => x.replace(/\D/g, "")).filter(x => x.length >= 10);
  if (!to.length) return false;
  const values = orderAlertValues(input, payload, new URL(request.url).origin);
  const sends = [];
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
    for (const n of to) sends.push(fetch("https://graph.facebook.com/v21.0/" + encodeURIComponent(env.WHATSAPP_PHONE_ID) + "/messages", {
      method: "POST", headers: { Authorization: "Bearer " + env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: n, type: "template", template: { name: env.WHATSAPP_TEMPLATE || "new_order_alert", language: { code: env.WHATSAPP_LANG || "en" },
        components: [{ type: "body", parameters: values.map(t => ({ type: "text", text: t })) }] } })
    }));
  } else if (env.AISENSY_API_KEY && env.AISENSY_CAMPAIGN) {
    for (const n of to) sends.push(fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: env.AISENSY_API_KEY, campaignName: env.AISENSY_CAMPAIGN, destination: n, userName: "52 Alive orders", templateParams: values, source: "52alive-website" })
    }));
  } else return false;
  const res = await Promise.all(sends.map(p => p.then(async r => { if (!r.ok) console.error("[alert]", r.status, (await r.text()).slice(0, 300)); return r.ok; }, e => { console.error("[alert]", e.message); return false; })));
  return res.some(Boolean);
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
/* Shiprocket may return the number in full or partly masked (e.g. "******8191"): compare the digits it shows. */
export function phoneMatch(stored, typed) {
  const t = cleanPhone(typed), raw = String(stored || "").trim();
  if (!/^[6-9]\d{9}$/.test(t)) return false;
  if (/^[\d\s+()-]+$/.test(raw)) return cleanPhone(raw) === t;
  const tail = (raw.match(/\d+$/) || [""])[0];
  return tail.length >= 4 && t.endsWith(tail.slice(-10));
}
const lookups = new Map();                          /* per-visitor lookup counter (per isolate) */
function tooMany(ip) {
  const now = Date.now(), k = ip || "?", e = lookups.get(k);
  if (!e || now - e.t > 10 * 60000) { lookups.set(k, { t: now, n: 1 }); if (lookups.size > 5000) lookups.clear(); return false; }
  e.n++; return e.n > 20;
}
export function _resetLookups() { lookups.clear(); }

export async function trackOrder(input, env) {
  const orderId = String(input && input.orderId || "").trim();

  if (!/^52A-[0-9a-f-]{36}$/i.test(orderId)) { const e = new Error("Check your order ID — it starts with 52A-"); e.status = 400; throw e; }


  const list = await srGet("/orders?filter_by=channel_order_id&filter=" + encodeURIComponent(orderId) + "&per_page=5", env);
  const orders = Array.isArray(list && list.data) ? list.data : [];
  const o = orders.find(x => String(x.channel_order_id || "").toLowerCase() === orderId.toLowerCase());
  if (!o) return null;                 /* the order ID itself is the key: long and random, so nobody can guess one */

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
    if (!order) return json({ ok: false, error: "We couldn't find that order yet. Check the order ID — new orders can take a minute to appear." }, 404);
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
  const out = { secrets: !!(env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD), fallbackEmailSet: !!env.SHIPROCKET_FALLBACK_EMAIL,
    orderAlert: { to: !!env.ORDER_ALERT_TO, whatsappCloud: !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID), aisensy: !!(env.AISENSY_API_KEY && env.AISENSY_CAMPAIGN) },
    stockSync: { webhookToken: !!env.SHIPROCKET_WEBHOOK_TOKEN, githubToken: !!env.GITHUB_TOKEN } };
  if (env.GITHUB_TOKEN) { try { const r = await gh(env, "GET", "/repos/" + (env.GITHUB_REPO || "Sarthak-B/52alive")); const d = await r.json().catch(() => ({})); out.stockSync.githubCanWrite = r.ok && !!(d.permissions && d.permissions.push); } catch (e) { out.stockSync.githubCanWrite = false; } }
  if (!out.secrets) return json(out);
  try { await sharedPut(env, "probe", { ok: 1 }, 60); out.sharedCache = !!(await sharedGet(env, "probe")); } catch (e) { out.sharedCache = false; }
  try { await login(env); out.login = true; } catch (e) { out.login = false; out.loginError = String(e.message).slice(0, 160); return json(out); }
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
      const ph = new URL(request.url).searchParams.get("phone");
      return { rows: rows.length, found: !!hit, status: hit ? hit.status : undefined, hasAwb: hit ? !!((hit.shipments && (hit.shipments[0] || hit.shipments).awb) || "") : undefined,
        phoneShape: hit ? String(hit.customer_phone || "").replace(/\d/g, "d") : undefined, phoneMatches: hit && ph ? phoneMatch(hit.customer_phone, ph) : undefined,
        shapes: hit ? Object.fromEntries(["customer_pincode", "customer_city", "customer_name", "customer_email", "customer_state", "id"].map(k => [k, String(hit[k] == null ? "" : hit[k]).replace(/[a-z]/gi, "a").replace(/\d/g, "#").slice(0, 30)])) : undefined,
        detail: hit && hit.id ? await (async () => { try { const d = await srGet("/orders/show/" + encodeURIComponent(hit.id), env); const x = d && (d.data || d) || {};
          return Object.fromEntries(["customer_phone", "customer_pincode", "customer_email", "billing_phone", "customer_alternate_phone"].map(k => [k, String(x[k] == null ? "(none)" : x[k]).replace(/[a-z]/gi, "a").replace(/\d/g, "#").slice(0, 30)])); } catch (e) { return String(e.message).slice(0, 80); } })() : undefined }; }
      catch (e) { return { error: String(e.message).slice(0, 160) }; } };
    out.orderByFilter = await look("filter_by=channel_order_id&filter=" + encodeURIComponent(id) + "&per_page=5");
    out.orderBySearch = await look("search=" + encodeURIComponent(id) + "&per_page=5");
  }
  return json(out);
}


/* ============================== stock: dispatch → website ==============================
 * Shiprocket calls POST /api/courier-updates on every tracking event (Settings → API → Webhooks,
 * security token = SHIPROCKET_WEBHOOK_TOKEN, sent as x-api-key; the URL must not contain "shiprocket",
 * "sr" or "kr"). When an order is first picked up / shipped, its items come off the stock in the
 * product catalogue (public/index.html), the change is committed to GitHub and the site redeploys:
 * a size at 0 disappears from the shop. Each order counts once — the catalogue keeps a list of
 * dispatched order IDs, and the commit is retried if the file changed in between.
 * Needs GITHUB_TOKEN (fine-grained, Contents: read & write on this repo). Optional GITHUB_REPO,
 * GITHUB_BRANCH, CATALOGUE_PATH.
 */
const GH = "https://api.github.com";
const b64encode = text => { const bytes = new TextEncoder().encode(text); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64decode = b64 => { const bin = atob(String(b64).replace(/\s/g, "")); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes); };
const CAT_BLOCK = /(<script[^>]*id=["']nowora-products["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const SLUG = t => String(t).toUpperCase().replace(/[^A-Z0-9]+/g, "");
const DISPATCH_STEP = s => /PICKED|SHIPPED|TRANSIT|OUT FOR DELIVERY|DELIVERED|REACHED|DESTINATION/i.test(s) && !/RTO|RETURN|CANCEL|UNDELIVERED|NOT PICKED|PICKUP EXCEPTION/i.test(s);

function gh(env, method, path, body) {
  return fetch(GH + path, { method, headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "52alive-stock", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
}

/** Takes an order's items off the catalogue stock. Pure: returns {data, changes} or null if already counted. */
export function applyDispatch(data, orderId, items) {
  data.dispatched = Array.isArray(data.dispatched) ? data.dispatched : [];
  if (data.dispatched.includes(orderId)) return null;
  const bySku = {};
  for (const p of data.products || []) for (const c of p.colours || []) for (const z of (p.sizes && p.sizes.length ? p.sizes : ["Free size"]))
    bySku["52A-" + SLUG(p.id) + "-" + SLUG(c.name) + "-" + z] = { p, c, z: String(z) };
  const changes = [];
  for (const it of items) {
    const hit = bySku[String(it.sku || "").trim()];
    if (!hit) { changes.push({ sku: it.sku, skipped: "unknown product" }); continue; }
    const st = hit.c.stock;
    if (!st || typeof st !== "object") { changes.push({ sku: it.sku, skipped: "stock not tracked" }); continue; }
    const before = Math.max(0, Number(st[hit.z]) || 0), qty = Math.max(1, Number(it.qty) || 1);
    st[hit.z] = Math.max(0, before - qty);
    changes.push({ sku: it.sku, name: hit.p.name + " " + hit.c.name + " " + hit.z, from: before, to: st[hit.z] });
  }
  data.dispatched.push(orderId);
  if (data.dispatched.length > 400) data.dispatched = data.dispatched.slice(-400);
  return { data, changes };
}

export async function recordDispatch(orderId, env) {
  /* the order's line items (SKUs) from Shiprocket */
  const list = await srGet("/orders?filter_by=channel_order_id&filter=" + encodeURIComponent(orderId) + "&per_page=5", env);
  const o = (Array.isArray(list && list.data) ? list.data : []).find(x => String(x.channel_order_id || "").toLowerCase() === orderId.toLowerCase());
  if (!o) return { ok: false, reason: "order not in Shiprocket" };
  const items = (Array.isArray(o.products) ? o.products : []).map(p => ({ sku: p.channel_sku || p.sku, qty: p.quantity || p.units }));
  if (!items.length) return { ok: false, reason: "no items" };
  const repo = env.GITHUB_REPO || "Sarthak-B/52alive", branch = env.GITHUB_BRANCH || "main", path = env.CATALOGUE_PATH || "public/index.html";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await gh(env, "GET", "/repos/" + repo + "/contents/" + path + "?ref=" + encodeURIComponent(branch));
    if (!r.ok) throw new Error("GitHub read " + r.status);
    const f = await r.json();
    const html = f.content && f.encoding === "base64" ? b64decode(f.content) : await (await gh(env, "GET", "/repos/" + repo + "/git/blobs/" + f.sha)).json().then(b => b64decode(b.content));
    const m = CAT_BLOCK.exec(html); if (!m) throw new Error("catalogue block not found");
    const res = applyDispatch(JSON.parse(m[2]), orderId, items);
    if (!res) return { ok: true, already: true };
    const json = JSON.stringify(res.data, null, 1).replace(/<\//g, "<\\/");
    const next = html.replace(CAT_BLOCK, (_, a, __, c) => a + "\n" + json + "\n" + c);
    const moved = res.changes.filter(c => c.to !== undefined);
    const msg = "Stock: order " + orderId.slice(0, 12) + " dispatched" + (moved.length ? " — " + moved.map(c => c.name + " " + c.from + "→" + c.to).join(", ").slice(0, 160) : " (no tracked stock)");
    const put = await gh(env, "PUT", "/repos/" + repo + "/contents/" + path, { message: msg, content: b64encode(next), sha: f.sha, branch });
    if (put.ok) return { ok: true, changes: res.changes };
    if (put.status !== 409 && put.status !== 422) throw new Error("GitHub write " + put.status);
    await new Promise(z => setTimeout(z, 400 * (attempt + 1)));          /* someone else changed the file: read again */
  }
  throw new Error("GitHub write kept conflicting");
}

function sameToken(a, b) { a = String(a || ""); b = String(b || ""); if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export async function handleCourierUpdate(request, env, ctx) {
  const done = extra => json({ ok: true, ...extra });                    /* Shiprocket only accepts 200 */
  if (!sameToken(request.headers.get("x-api-key"), env.SHIPROCKET_WEBHOOK_TOKEN)) return done({ ignored: "token" });
  let b; try { b = JSON.parse(await request.text()); } catch { return done({ ignored: "body" }); }
  const status = String(b.shipment_status || b.current_status || "");
  if (b.is_return == 1 || b.is_return === true || !DISPATCH_STEP(status)) return done({ ignored: "status" });
  const m = /52A-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(String(b.order_id || ""));
  if (!m) return done({ ignored: "not a website order" });
  if (!env.GITHUB_TOKEN || !env.SHIPROCKET_EMAIL) { console.warn("[stock] GITHUB_TOKEN or Shiprocket login missing — stock not updated for", m[0]); return done({ ignored: "not configured" }); }
  const work = recordDispatch(m[0], env).then(r => console.log("[stock]", m[0], JSON.stringify(r).slice(0, 300))).catch(e => console.error("[stock]", m[0], e.message));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work); else await work;
  return done({ queued: true });
}

/* ============================== store dashboard: orders → ship ==============================
 * POST /api/store  — from the NOWORA dashboard (Origin nowora.vercel.app, or DASHBOARD_ORIGINS), or with x-store-key
 * Used by the NOWORA client dashboard (Shop → Orders), which runs on another domain, so CORS is open
 * and the key is the gate: shipping spends Shiprocket wallet money.
 *   {action:"list"}                         → latest Shiprocket orders, each with a stage
 *   {action:"rates", id}                    → couriers that can deliver it, cheapest first, recommended flagged
 *   {action:"ship", id, courierId?}         → assign courier (AWB) → schedule pickup → label + invoice → stock off
 *   {action:"label", id}                    → label + invoice links again
 *   {action:"cancel", id}                   → cancel an order that hasn't shipped
 */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-store-key", "Access-Control-Max-Age": "86400" };
const cjson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
const arr = v => Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];

/* Any Shiprocket call that should hand back the error message instead of throwing (4xx carry the reason). */
async function srReq(method, path, body, env) {
  const send = token => fetch(SR + path, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let r = await send(await login(env));
  if (r.status === 401) r = await send(await login(env, true));
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
const srMsg = (d, fallback) => {
  const m = d && (d.message || (d.response && d.response.data && (d.response.data.awb_assign_error || d.response.data.message)) || (d.errors && JSON.stringify(d.errors)));
  return String(m || fallback || "Shiprocket said no").replace(/\s+/g, " ").slice(0, 240);
};

/** One Shiprocket order (list or show shape) → what the dashboard needs. */
export function storeOrder(o) {
  const sh = arr(o.shipments)[0] || {};
  const awb = String(sh.awb || sh.awb_code || o.awb_code || "").trim();
  const status = String(o.status || "");
  const t = trackStep(status);
  const stage = t.problem === "cancelled" ? "cancelled" : t.problem === "returned" ? "returned"
    : t.step >= 4 ? "delivered" : t.step >= 2 ? "transit" : awb ? "ready" : "new";
  return {
    id: o.id, orderId: String(o.channel_order_id || ""), placed: o.created_at || o.channel_created_at || "",
    name: String(o.customer_name || ""), city: String(o.customer_city || ""), state: String(o.customer_state || ""), pin: String(o.customer_pincode || ""),
    payment: /cod/i.test(o.payment_method || "") ? "COD" : "Prepaid", total: Number(o.total) || 0,
    items: arr(o.products || o.order_items).slice(0, 20).map(p => ({ name: String(p.name || ""), qty: Number(p.quantity || p.units || 1) || 1, sku: String(p.channel_sku || p.sku || "") })),
    status, label: t.label, stage, shipmentId: sh.id || o.shipment_id || null, awb, courier: String(sh.courier || sh.courier_name || o.courier_name || ""),
    pickup: String(sh.pickup_scheduled_date || o.pickup_scheduled_date || "")
  };
}

async function srOrder(id, env) {
  const r = await srReq("GET", "/orders/show/" + encodeURIComponent(id), null, env);
  if (!r.ok) { const e = new Error(r.status === 404 ? "Order not found in Shiprocket" : srMsg(r.d, "Couldn't read the order")); e.status = r.status === 404 ? 404 : 502; throw e; }
  const o = r.d && (r.d.data || r.d);
  if (!o || !o.id) { const e = new Error("Order not found in Shiprocket"); e.status = 404; throw e; }
  return o;
}

export async function storeList(env, page = 1) {
  const r = await srReq("GET", "/orders?per_page=60&page=" + Math.max(1, Math.min(20, page | 0 || 1)), null, env);
  if (!r.ok) { const e = new Error(srMsg(r.d, "Couldn't load orders")); e.status = 502; throw e; }
  return arr(r.d && r.d.data).map(storeOrder);
}

export async function storeRates(id, env) {
  let r = await srReq("GET", "/courier/serviceability/?order_id=" + encodeURIComponent(id), null, env);
  let data = r.ok && r.d && r.d.data;
  if (!data || !arr(data.available_courier_companies).length) {         /* fall back to pincodes + weight */
    const o = await srOrder(id, env);
    await resolvePickup(env);
    const from = ((pickupCache.list || []).find(x => x.pickup_location === o.pickup_location) || (pickupCache.list || [])[0] || {}).pin_code;
    const to = o.customer_pincode || (o.shipping_address && o.shipping_address.pincode);
    const w = Number(o.weight || (o.others && o.others.weight)) || 0.5;
    if (from && to) {
      r = await srReq("GET", "/courier/serviceability/?pickup_postcode=" + from + "&delivery_postcode=" + to + "&weight=" + w + "&cod=" + (/cod/i.test(o.payment_method || "") ? 1 : 0), null, env);
      data = r.ok && r.d && r.d.data;
    }
  }
  const list = arr(data && data.available_courier_companies);
  if (!list.length) { const e = new Error(srMsg(r.d, "No courier delivers to this PIN code right now")); e.status = 422; throw e; }
  const rec = Number(data.recommended_courier_company_id || data.shiprocket_recommended_courier_id) || 0;
  const out = list.map(c => ({ id: Number(c.courier_company_id), name: String(c.courier_name || ""), rate: Math.round((Number(c.rate || c.freight_charge) || 0) * 100) / 100,
    days: String(c.estimated_delivery_days || ""), etd: String(c.etd || ""), rating: Number(c.rating) || 0, recommended: Number(c.courier_company_id) === rec }))
    .filter(c => c.id).sort((a, b) => a.rate - b.rate);
  const top = out.slice(0, 8); const recC = out.find(c => c.recommended); if (recC && !top.includes(recC)) top.push(recC);
  return top;
}

async function labelLinks(id, sid, env) {
  const out = {};
  if (sid) { const l = await srReq("POST", "/courier/generate/label", { shipment_id: [sid] }, env).catch(() => null);
    if (l && l.d && /^https?:/.test(l.d.label_url || "")) out.labelUrl = l.d.label_url; else if (l) out.labelError = srMsg(l.d, "Label not ready yet"); }
  const v = await srReq("POST", "/orders/print/invoice", { ids: [String(id)] }, env).catch(() => null);
  if (v && v.d && /^https?:/.test(v.d.invoice_url || "")) out.invoiceUrl = v.d.invoice_url;
  return out;
}

export async function storeShip(input, env, ctx) {
  const id = Number(input.id); if (!id) { const e = new Error("Missing order"); e.status = 400; throw e; }
  const o = await srOrder(id, env), s = storeOrder(o);
  if (s.stage === "cancelled" || s.stage === "returned") { const e = new Error("This order is " + s.stage); e.status = 409; throw e; }
  const sid = s.shipmentId || Number(input.shipmentId) || null;
  if (!sid) { const e = new Error("Shiprocket hasn't made a shipment for this order"); e.status = 409; throw e; }
  let awb = s.awb, courier = s.courier;
  if (!awb) {
    const courierId = Number(input.courierId) || 0;
    const a = await srReq("POST", "/courier/assign/awb", { shipment_id: sid, ...(courierId ? { courier_id: courierId } : {}) }, env);
    const ad = a.d && a.d.response && a.d.response.data;
    if (!a.ok || a.d.awb_assign_status != 1 || !ad || !ad.awb_code) { const e = new Error(srMsg(a.d, "Couldn't book a courier")); e.status = 422; throw e; }
    awb = String(ad.awb_code); courier = String(ad.courier_name || courier);
  }
  const out = { ok: true, awb, courier };
  const p = await srReq("POST", "/courier/generate/pickup", { shipment_id: [sid] }, env);
  if (p.ok && p.d && p.d.pickup_status == 1) out.pickup = String((p.d.response && (p.d.response.pickup_scheduled_date || p.d.response.pickup_generated_date)) || "");
  else if (/already|queue|scheduled/i.test(srMsg(p.d))) out.pickup = s.pickup || "already booked";
  else out.pickupError = srMsg(p.d, "Pickup not booked — book it in Shiprocket");
  Object.assign(out, await labelLinks(id, sid, env));
  /* the parcel is committed: take it off the website's stock (counted once per order, so the webhook won't double it) */
  if (env.GITHUB_TOKEN && /^52A-[0-9a-f-]{36}$/i.test(s.orderId)) {
    const work = recordDispatch(s.orderId, env).then(r => console.log("[stock]", s.orderId, JSON.stringify(r).slice(0, 300))).catch(e => console.error("[stock]", s.orderId, e.message));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work); else await work;
    out.stock = true;
  }
  return out;
}

export function dashboardOrigin(request, env) {
  let host = ""; try { host = new URL(request.headers.get("Origin") || "").host; } catch (e) { return false; }
  const allowed = String(env.DASHBOARD_ORIGINS || "nowora.vercel.app").split(",").map(x => x.trim()).filter(Boolean);
  return host === new URL(request.url).host || allowed.includes(host);
}
export async function handleStore(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return cjson({ ok: false, error: "Method not allowed" }, 405);
  /* No key to paste: the NOWORA dashboard (behind the client's PIN) and this site itself are let in by origin.
     A key still works for anything else (STORE_KEY, or SHIPROCKET_WEBHOOK_TOKEN). */
  const key = env.STORE_KEY || env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!dashboardOrigin(request, env) && !(key && sameToken(request.headers.get("x-store-key"), key))) return cjson({ ok: false, error: "Not allowed", badKey: true }, 401);
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) return cjson({ ok: false, error: "Shiprocket isn't connected" }, 503);
  let b; try { b = JSON.parse(await request.text() || "{}"); } catch { return cjson({ ok: false, error: "Invalid JSON" }, 400); }
  try {
    switch (b.action) {
      case "list": return cjson({ ok: true, orders: await storeList(env, b.page) });
      case "rates": return cjson({ ok: true, couriers: await storeRates(Number(b.id), env) });
      case "ship": return cjson(await storeShip(b, env, ctx));
      case "label": { const o = storeOrder(await srOrder(Number(b.id), env)); return cjson({ ok: true, ...(await labelLinks(o.id, o.shipmentId, env)) }); }
      case "cancel": {
        const o = storeOrder(await srOrder(Number(b.id), env));
        if (o.stage !== "new" && o.stage !== "ready") return cjson({ ok: false, error: "It's already with the courier — cancel it in Shiprocket" }, 409);
        const r = await srReq("POST", "/orders/cancel", { ids: [o.id] }, env);
        return r.ok ? cjson({ ok: true }) : cjson({ ok: false, error: srMsg(r.d, "Couldn't cancel") }, 422);
      }
      default: return cjson({ ok: false, error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("[store]", b.action, e.message);
    return cjson({ ok: false, error: String(e.message || "Shiprocket error").slice(0, 240) }, e.status && e.status < 600 ? e.status : 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/order") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleOrder(request, env, ctx);
    }
    if (url.pathname === "/api/shiprocket-health") return handleHealth(request, env);
    if (url.pathname === "/api/courier-updates") {
      if (request.method !== "POST") return json({ ok: true });
      return handleCourierUpdate(request, env, ctx);
    }
    if (url.pathname === "/api/store") return handleStore(request, env, ctx);
    if (url.pathname === "/api/track") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleTrack(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test, beforeEach} from 'node:test';
import worker, {catalogFromHtml, buildPayload, istStamp, _resetTokenCache, _resetCatalogCache} from '../src/worker.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const CATALOG = catalogFromHtml(html);
const env = {SHIPROCKET_EMAIL: 'api@shop.in', SHIPROCKET_PASSWORD: 'x', SHIPROCKET_PICKUP: 'Home', SHIPROCKET_FALLBACK_EMAIL: 'orders@shop.in', ASSETS: {fetch: req => new Response(new URL(req.url).pathname === '/' ? html : 'asset')}};
const order = (over = {}) => ({
  orderId: '52A-' + crypto.randomUUID(), name: 'Riya Kumar Singh', phone: '9876543210',
  address: '12 MG Road, near park', city: 'Dehradun', state: 'Uttarakhand', pin: '248001',
  payment: 'Cash on Delivery', note: 'gift wrap',
  items: [{key: 'hoodie', colour: 'Stone Beige', size: 'L', qty: 2}, {key: 'puffer', colour: 'Blue Grey', size: 'M', qty: 1}],
  ...over,
});

beforeEach(() => { _resetTokenCache(); _resetCatalogCache(); });

test('page shows exactly the products Shiprocket prices from', () => {
  const src = html.match(/const DATA=[\s\S]*?\nconst FIRST_KEY=[^\n]*/)[0];
  const block = html.match(/<script type="application\/json" id="nowora-products">([\s\S]*?)<\/script>/)[1];
  const ctx = {document: {getElementById: () => ({textContent: block})}}; vm.createContext(ctx);
  vm.runInContext(src + '\nthis.P=P;', ctx);
  assert.deepEqual(Object.keys(ctx.P), Object.keys(CATALOG));
  for (const [k, p] of Object.entries(ctx.P)) {
    assert.equal(CATALOG[k].name, p.name);
    assert.equal(CATALOG[k].price, p.price);
    assert.deepEqual(CATALOG[k].sizes, [...p.sizes]);
    assert.deepEqual(CATALOG[k].colours, Object.keys(p.colours));
    for (const c of Object.keys(p.colours)) assert.ok(p.gallery[c].length, `${k} ${c} has photos`);
  }
});

test('catalogue skips hidden and unpriced products and rejects a missing block', () => {
  const data = {products: [
    {id: 'a', name: 'A', price: 500, colours: [{name: 'Red'}], sizes: ['M']},
    {id: 'b', name: 'B', price: 500, hidden: true, colours: [{name: 'Red'}]},
    {id: 'c', name: 'C', price: 0, colours: [{name: 'Red'}]},
    {id: 'bad id!', name: 'D', price: 5, colours: [{name: 'Red'}]},
  ]};
  const cat = catalogFromHtml(`<script type="application/json" id="nowora-products">${JSON.stringify(data)}</script>`);
  assert.deepEqual(Object.keys(cat), ['a']);
  assert.equal(cat.a.weight, 0.5);
  assert.throws(() => catalogFromHtml('<html></html>'));
});

test('builds a Shiprocket payload priced from the catalog', () => {
  const p = buildPayload(order({items: [{key: 'hoodie', colour: 'Stone Beige', size: 'L', qty: 2, price: 1}]}), env, new Date('2026-11-05T20:00:00Z'), CATALOG);
  assert.equal(p.order_date, '2026-11-06 01:30');
  assert.equal(p.pickup_location, 'Home');
  assert.equal(p.billing_customer_name, 'Riya');
  assert.equal(p.billing_last_name, 'Kumar Singh');
  assert.equal(p.billing_email, 'orders@shop.in');
  assert.equal(p.payment_method, 'COD');
  assert.equal(p.order_items[0].selling_price, 1299);
  assert.equal(p.order_items[0].sku, '52A-HOODIE-STONEBEIGE-L');
  assert.equal(p.sub_total, 2598);
  assert.equal(p.weight, 1.2);
});

test('merges duplicate lines and maps prepaid', () => {
  const it = {key: 'sweatpants', colour: 'Grey Marl', size: 'S', qty: 1};
  const p = buildPayload(order({payment: 'UPI (prepaid)', items: [it, it]}), env, new Date(), CATALOG);
  assert.equal(p.order_items.length, 1);
  assert.equal(p.order_items[0].units, 2);
  assert.equal(p.payment_method, 'Prepaid');
});

test('removed products are rejected', () => {
  for (const key of ['jacket', 'joggers', 'vest']) assert.throws(() => buildPayload(order({items: [{key, colour: 'Ash Grey', size: 'M', qty: 1}]}), env, new Date(), CATALOG), e => e.status === 400);
});

test('rejects bad input', () => {
  for (const o of [
    order({orderId: 'abc'}), order({phone: '12345'}), order({pin: '012345'}),
    order({items: [{key: 'hat', colour: 'Red', size: 'M', qty: 1}]}),
    order({items: [{key: 'puffer', colour: 'Neon', size: 'M', qty: 1}]}),
    order({items: [{key: 'puffer', colour: 'Lavender', size: 'M', qty: 99}]}),
    order({items: []}),
  ]) assert.throws(() => buildPayload(o, env, new Date(), CATALOG), e => e.status === 400);
});

test('POST /api/order logs in, creates the order and refreshes an expired token', async () => {
  const calls = [];
  let logins = 0, creates = 0;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/auth/login')) return Response.json({token: 'T' + (++logins)});
    creates++;
    if (creates === 1 && init.headers.Authorization === 'Bearer T1') return new Response('{}', {status: 401});
    return Response.json({order_id: 111, shipment_id: 222, status: 'NEW'});
  };
  const res = await worker.fetch(new Request('https://52alive.example/api/order', {method: 'POST', headers: {Origin: 'https://52alive.example'}, body: JSON.stringify(order())}), env);
  assert.deepEqual(await res.json(), {ok: true, shiprocket_order_id: 111, shipment_id: 222});
  assert.equal(logins, 2);
  assert.equal(calls.filter(u => u.endsWith('/orders/create/adhoc')).length, 2);
});

test('blocks other origins and works without secrets', async () => {
  const req = o => new Request('https://52alive.example/api/order', {method: 'POST', headers: {Origin: o}, body: JSON.stringify(order())});
  assert.equal((await worker.fetch(req('https://evil.example'), env)).status, 403);
  assert.equal((await worker.fetch(req('https://52alive.example'), {...env, SHIPROCKET_EMAIL: ''})).status, 503);
  assert.ok((await (await worker.fetch(new Request('https://52alive.example/'), env)).text()).includes('nowora-products'));
  assert.equal(await (await worker.fetch(new Request('https://52alive.example/style.css'), env)).text(), 'asset');
});

test('page sends the order to /api/order without blocking WhatsApp', () => {
  assert.ok(html.includes('fetch("/api/order"'));
  assert.ok(html.indexOf('fetch("/api/order"') < html.indexOf('window.open(lastLink'));
  assert.equal(istStamp(new Date('2026-01-01T00:00:00Z')), '2026-01-01 05:30');
});

test('Pages Function routes POST /api/order to the same handler', async () => {
  const {onRequestPost} = await import('../functions/api/order.js');
  const res = await onRequestPost({request: new Request('https://52-alive.pages.dev/api/order', {method: 'POST', body: '{}'}), env: {}});
  assert.equal(res.status, 503);
});

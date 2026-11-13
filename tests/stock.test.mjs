import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test, beforeEach} from 'node:test';
import worker, {catalogFromHtml, buildPayload, applyDispatch, _resetTokenCache, _resetLoginFail} from '../src/worker.js';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const block = d => `<script type="application/json" id="make4yu-products">\n${JSON.stringify(d, null, 1)}\n</script>`;
const cat = () => ({categories: [{id: 'jackets', name: 'Jackets'}], products: [
  {id: 'puffer', name: 'Puffer', category: 'jackets', price: 1999, sizes: ['S', 'M', 'L'], colours: [
    {name: 'Blush Pink', hex: '#D9AFA4', photos: ['a.jpg'], stock: {S: 2, M: 0, L: 1}},
    {name: 'Lavender', hex: '#C9BFD6', photos: ['b.jpg'], stock: {S: 0, M: 0, L: 0}}]},
  {id: 'tee', name: 'Tee', category: 'jackets', price: 799, sizes: ['M'], colours: [{name: 'Black', hex: '#111', photos: ['c.jpg']}]},
  {id: 'gone', name: 'Gone', category: 'jackets', price: 500, sizes: ['M'], colours: [{name: 'Red', hex: '#f00', photos: ['d.jpg'], stock: {M: 0}}]}]});
const order = items => ({orderId: '52A-' + crypto.randomUUID(), name: 'Riya K', phone: '9876543210', address: '12 MG Road, near park', city: 'Dehradun', state: 'Uttarakhand', pin: '248001', payment: 'Cash on Delivery', items});

test('website hides sold-out sizes, colours and products (same rules on page and server)', () => {
  const c = catalogFromHtml(block(cat()));
  assert.deepEqual(Object.keys(c), ['puffer', 'tee']);
  assert.deepEqual(c.puffer.colours, ['Blush Pink']);
  assert.deepEqual(c.puffer.avail['Blush Pink'], ['S', 'L']);
  assert.deepEqual(c.tee.avail.Black, ['M']);                       // no stock object = not tracked
  const src = page.match(/const DATA=[\s\S]*?\nconst leftFor=[^\n]*/)[0];
  const ctx = {document: {getElementById: () => ({textContent: JSON.stringify(cat())})}}; vm.createContext(ctx);
  vm.runInContext(src + '\nthis.P=P; this.sf=sizesFor; this.lf=leftFor;', ctx);
  assert.deepEqual(Object.keys(ctx.P), ['puffer', 'tee']);
  assert.deepEqual(Object.keys(ctx.P.puffer.colours), ['Blush Pink']);
  assert.deepEqual([...ctx.sf('puffer', 'Blush Pink')], ['S', 'L']);
  assert.equal(ctx.lf('puffer', 'Blush Pink', 'L'), 1);
  assert.equal(ctx.lf('tee', 'Black', 'M'), null);
});

test('orders for sold-out variants are refused', () => {
  const c = catalogFromHtml(block(cat()));
  assert.equal(buildPayload(order([{key: 'puffer', colour: 'Blush Pink', size: 'S', qty: 1}]), {COD_FEE: '0'}, new Date(), c).sub_total, 1999);
  assert.throws(() => buildPayload(order([{key: 'puffer', colour: 'Blush Pink', size: 'M', qty: 1}]), {}, new Date(), c), /Sold out/);
  assert.throws(() => buildPayload(order([{key: 'puffer', colour: 'Lavender', size: 'S', qty: 1}]), {}, new Date(), c), e => e.status === 400);
  assert.throws(() => buildPayload(order([{key: 'gone', colour: 'Red', size: 'M', qty: 1}]), {}, new Date(), c), e => e.status === 400);
});

test('a dispatch takes stock off once, by SKU; untracked and unknown items are left alone', () => {
  const d = cat(), id = '52A-' + crypto.randomUUID();
  const r = applyDispatch(d, id, [{sku: '52A-PUFFER-BLUSHPINK-S', qty: 1}, {sku: '52A-PUFFER-BLUSHPINK-L', qty: 3}, {sku: '52A-TEE-BLACK-M', qty: 1}, {sku: 'X', qty: 1}]);
  assert.equal(d.products[0].colours[0].stock.S, 1);
  assert.equal(d.products[0].colours[0].stock.L, 0);                // never below zero
  assert.deepEqual(r.changes.map(c => c.skipped || c.to), [1, 0, 'stock not tracked', 'unknown product']);
  assert.equal(applyDispatch(d, id, [{sku: '52A-PUFFER-BLUSHPINK-S', qty: 1}]), null);
  assert.equal(d.products[0].colours[0].stock.S, 1);
});

/* ---- webhook end to end with a stand-in Shiprocket and GitHub ---- */
const env = {SHIPROCKET_EMAIL: 'a', SHIPROCKET_PASSWORD: 'b', SHIPROCKET_WEBHOOK_TOKEN: 'tok-123', GITHUB_TOKEN: 'gh', ASSETS: {fetch: () => new Response('')}};
let repo, puts, conflicts;
const OID = '52A-3ac6011a-d786-4d90-bfc6-4e5938741314';
function stand() {
  repo = {html: '<html><body>' + block(cat()) + '<p>rest</p></body></html>', sha: 's1'}; puts = []; conflicts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith('/auth/login')) return Response.json({token: 'T'});
    if (url.includes('/orders?')) return Response.json({data: [{channel_order_id: OID, products: [{channel_sku: '52A-PUFFER-BLUSHPINK-S', quantity: 2}]}]});
    if (url.includes('/contents/public/index.html') && (init.method || 'GET') === 'GET') return Response.json({sha: repo.sha, encoding: 'base64', content: Buffer.from(repo.html).toString('base64')});
    if (url.includes('/contents/public/index.html') && init.method === 'PUT') {
      const b = JSON.parse(init.body); puts.push(b);
      if (conflicts > 0) { conflicts--; repo.sha = 's' + Math.random(); return new Response('{}', {status: 409}); }
      if (b.sha !== repo.sha) return new Response('{}', {status: 409});
      repo.html = Buffer.from(b.content, 'base64').toString('utf8'); repo.sha = 's' + puts.length; return Response.json({content: {sha: repo.sha}});
    }
    return new Response('{}', {status: 404});
  };
}
const hook = (body, key = 'tok-123') => worker.fetch(new Request('https://52.example/api/courier-updates', {method: 'POST', headers: {'x-api-key': key, 'Content-Type': 'application/json'}, body: JSON.stringify(body)}), env, {waitUntil: p => p});
const stockNow = () => JSON.parse(repo.html.match(/id="make4yu-products">([\s\S]*?)<\/script>/)[1]);
beforeEach(() => _resetTokenCache());

test('shipped webhook takes the order off stock, commits, and counts each order once', async () => {
  stand();
  for (const st of ['PICKUP SCHEDULED', 'NEW']) assert.deepEqual(await (await hook({order_id: OID, current_status: st})).json(), {ok: true, ignored: 'status'});
  assert.equal(puts.length, 0);
  const r = await hook({order_id: '1373900_' + OID, current_status: 'PICKED UP', shipment_status: 'PICKED UP', awb: 'A1'});
  assert.equal(r.status, 200);
  await new Promise(z => setTimeout(z, 20));
  assert.equal(puts.length, 1);
  assert.match(puts[0].message, /Stock: order 52A-3ac6011a dispatched — Puffer Blush Pink S 2→0/);
  assert.equal(stockNow().products[0].colours[0].stock.S, 0);
  assert.ok(stockNow().dispatched.includes(OID));
  assert.ok(repo.html.endsWith('<p>rest</p></body></html>'));
  await hook({order_id: OID, current_status: 'IN TRANSIT'}); await hook({order_id: OID, current_status: 'DELIVERED'});
  await new Promise(z => setTimeout(z, 20));
  assert.equal(puts.length, 1);                                       // repeats change nothing
  assert.equal(catalogFromHtml(repo.html).puffer.avail['Blush Pink'].includes('S'), false);
});

test('retries when the file changed meanwhile; ignores wrong token, returns and other sites', async () => {
  stand(); conflicts = 2;
  await hook({order_id: OID, current_status: 'SHIPPED'}); await new Promise(z => setTimeout(z, 1500));
  assert.equal(puts.length, 3); assert.equal(stockNow().products[0].colours[0].stock.S, 0);
  stand();
  assert.deepEqual(await (await hook({order_id: OID, current_status: 'SHIPPED'}, 'wrong')).json(), {ok: true, ignored: 'token'});
  assert.deepEqual(await (await hook({order_id: OID, current_status: 'SHIPPED', is_return: 1})).json(), {ok: true, ignored: 'status'});
  assert.deepEqual(await (await hook({order_id: '12345', current_status: 'SHIPPED'})).json(), {ok: true, ignored: 'not a website order'});
  assert.deepEqual(await (await hook({order_id: OID, current_status: 'RTO IN TRANSIT'})).json(), {ok: true, ignored: 'status'});
  assert.equal(puts.length, 0);
  const noGh = await worker.fetch(new Request('https://52.example/api/courier-updates', {method: 'POST', headers: {'x-api-key': 'tok-123'}, body: JSON.stringify({order_id: OID, current_status: 'SHIPPED'})}), {...env, GITHUB_TOKEN: ''});
  assert.deepEqual(await noGh.json(), {ok: true, ignored: 'not configured'});
});

test('Pages Function routes the webhook to the same handler', async () => {
  const {onRequestPost} = await import('../functions/api/courier-updates.js');
  const r = await onRequestPost({request: new Request('https://52-alive.pages.dev/api/courier-updates', {method: 'POST', body: '{}'}), env: {}, waitUntil: () => {}});
  assert.equal(r.status, 200);
});

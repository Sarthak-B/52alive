import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import worker, {_resetCatalogCache} from '../src/worker.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const base = {ASSETS: {fetch: () => new Response(html)}, ORDER_ALERT_TO: '91 93689 86368'};
const order = {orderId: '52A-3ac6011a-d786-4d90-bfc6-4e5938741314', name: 'Riya Sharma', phone: '9876543210', address: 'Flat 4, Rajpur Road\nNear clock tower', city: 'Dehradun', state: 'Uttarakhand', pin: '248001', payment: 'Cash on Delivery', note: 'Gift wrap',
  items: [{key: 'hoodie', colour: JSON.parse(/id="nowora-products"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]).products.find(p => p.id === 'hoodie').colours[0].name, size: 'L', qty: 1}]};
function capture() {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => { sent.push({url, body: init.body ? JSON.parse(init.body) : null}); return Response.json({}); };
  return sent;
}
const place = env => { _resetCatalogCache(); const waits = []; return worker.fetch(new Request('https://52.example/api/order', {method: 'POST', headers: {Origin: 'https://52.example'}, body: JSON.stringify(order)}), env, {waitUntil: p => waits.push(p)}).then(async r => { await Promise.all(waits); return r; }); };

test('WhatsApp Cloud API: order alert goes to the shop with all customer details', async () => {
  const sent = capture();
  const r = await place({...base, WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '123'});
  assert.equal((await r.json()).ok, true);
  const m = sent.find(x => x.url.includes('graph.facebook.com'));
  assert.ok(m, 'alert sent'); assert.equal(m.body.to, '919368986368'); assert.equal(m.body.template.name, 'new_order_alert');
  const v = m.body.template.components[0].parameters.map(p => p.text);
  assert.equal(v.length, 6); assert.equal(v[0], order.orderId); assert.equal(v[1], 'Riya Sharma'); assert.equal(v[2], '+91 9876543210');
  assert.match(v[3], /1 × .+ \/ L/); assert.match(v[4], /Cash on delivery/);
  assert.match(v[5], /Dehradun, Uttarakhand, 248001/); assert.match(v[5], /Note: Gift wrap/); assert.match(v[5], /track\/\?id=52A-/);
  assert.ok(v.every(t => !/[\n\t]/.test(t)), 'no newlines in template values');
});

test('AiSensy works too; nothing is sent when no provider is set', async () => {
  let sent = capture();
  await place({...base, AISENSY_API_KEY: 'k', AISENSY_CAMPAIGN: 'new_order_alert'});
  const a = sent.find(x => x.url.includes('aisensy'));
  assert.equal(a.body.destination, '919368986368'); assert.equal(a.body.templateParams.length, 6);
  sent = capture();
  const r = await place(base);
  assert.equal((await r.json()).ok, true); assert.equal(sent.length, 0);
});

test('a sold-out or invalid order is refused and sends no alert', async () => {
  const sent = capture();
  const r = await worker.fetch(new Request('https://52.example/api/order', {method: 'POST', body: JSON.stringify({...order, phone: '123'})}), {...base, WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1'});
  assert.equal(r.status, 400); assert.equal(sent.length, 0);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import crypto from 'node:crypto';
import worker, {_resetCatalogCache} from '../src/worker.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const KEY = '52a_test_key_123456';
const base = {ASSETS: {fetch: () => new Response(html)}, GITHUB_TOKEN: 'gh', SHIPROCKET_WEBHOOK_TOKEN: KEY};
const colour = JSON.parse(/id="nowora-products"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]).products.find(p => p.id === 'hoodie').colours[0].name;
const order = {orderId: '52A-3ac6011a-d786-4d90-bfc6-4e5938741314', name: 'Riya Sharma', phone: '9876543210', address: 'Flat 4, Rajpur Road', city: 'Dehradun', state: 'Uttarakhand', pin: '248001', payment: 'Cash on Delivery', note: 'Gift wrap',
  items: [{key: 'hoodie', colour, size: 'L', qty: 2}]};
/* same as scripts/whatsapp.mjs openAlert */
const open = (b64, key) => { const buf = Buffer.from(b64, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16)); return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString()); };
function capture() { const sent = []; globalThis.fetch = async (url, init = {}) => { sent.push({url, body: init.body ? JSON.parse(init.body) : null}); return new Response(null, {status: 204}); }; return sent; }
const place = (env, body = order) => { _resetCatalogCache(); const waits = []; return worker.fetch(new Request('https://52.example/api/order', {method: 'POST', headers: {Origin: 'https://52.example'}, body: JSON.stringify(body)}), env, {waitUntil: p => waits.push(p)}).then(async r => { await Promise.all(waits); return r; }); };

test('each order fires the WhatsApp workflow with the full details, encrypted', async () => {
  const sent = capture();
  assert.equal((await (await place(base)).json()).ok, true);
  const d = sent.find(x => x.url.endsWith('/repos/Sarthak-B/52alive/dispatches'));
  assert.ok(d, 'dispatched'); assert.equal(d.body.event_type, 'order-alert');
  assert.ok(!JSON.stringify(d.body).includes('9876543210'), 'nothing readable in the public payload');
  const a = open(d.body.client_payload.data, KEY);
  assert.deepEqual(a.to, ['919368986368']); assert.equal(a.id, order.orderId);
  for (const s of ['Riya Sharma', '+91 9876543210', '× 2', 'Cash on delivery', 'Dehradun, Uttarakhand, 248001', 'Gift wrap', '/track/?id=' + order.orderId]) assert.ok(a.text.includes(s), s);
  assert.throws(() => open(d.body.client_payload.data, 'wrong key'));
});

test('ORDER_ALERT_TO picks the numbers; "off" or no GitHub token sends nothing; bad orders send nothing', async () => {
  let sent = capture();
  await place({...base, ORDER_ALERT_TO: '+91 98765 00000, 91 91234 11111'});
  assert.deepEqual(open(sent[0].body.client_payload.data, KEY).to, ['919876500000', '919123411111']);
  sent = capture(); await place({...base, ORDER_ALERT_TO: 'off'}); assert.equal(sent.length, 0);
  sent = capture(); await place({...base, GITHUB_TOKEN: ''}); assert.equal(sent.length, 0);
  sent = capture(); assert.equal((await place(base, {...order, phone: '12'})).status, 400); assert.equal(sent.length, 0);
});

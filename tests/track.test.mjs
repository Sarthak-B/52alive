import assert from 'node:assert/strict';
import {test, beforeEach} from 'node:test';
import worker, {trackStep, _resetTokenCache, _resetLoginFail, _resetLookups} from '../src/worker.js';

const env = {SHIPROCKET_EMAIL: 'api@shop.in', SHIPROCKET_PASSWORD: 'x', ASSETS: {fetch: () => new Response('asset')}};
const ID = '52A-3ac6011a-d786-4d90-bfc6-4e5938741314';
const order = {id: 99, channel_order_id: ID, customer_phone: 'xxxxxxxxxx', customer_pincode: '248001', customer_city: 'Dehradun', status: 'SHIPPED', payment_method: 'cod', total: '2998', created_at: '07 Nov 2026, 01:10 AM',
  products: [{name: 'Packable Quilted Puffer - Lavender / L', quantity: 1}], shipments: [{id: 5, awb: 'AWB123', courier: 'Delhivery'}]};
const tracking = {tracking_data: {track_status: 1, etd: '2026-11-10', track_url: 'https://shiprocket.co/tracking/AWB123',
  shipment_track: [{awb_code: 'AWB123', courier_name: 'Delhivery', current_status: 'In Transit'}],
  shipment_track_activities: [{date: '2026-11-08 10:00:00', 'sr-status-label': 'IN TRANSIT', activity: 'Reached hub', location: 'Delhi'}]}};
let calls;
function mock({orders = [order], track = tracking, trackStatus = 200} = {}) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/auth/login')) return Response.json({token: 'T'});
    if (url.includes('/orders?')) return Response.json({data: orders});
    if (url.includes('/courier/track/awb/')) return Response.json(track, {status: trackStatus});
    return new Response('{}', {status: 404});
  };
}
const ask = (body, origin = 'https://52.example') => worker.fetch(new Request('https://52.example/api/track', {method: 'POST', headers: {Origin: origin, 'CF-Connecting-IP': '1.2.3.4'}, body: JSON.stringify(body)}), env);
beforeEach(() => { _resetTokenCache(); _resetLoginFail(); _resetLookups(); });

test('finds the order by its ID, checks the delivery PIN code, and returns the courier timeline', async () => {
  mock();
  const r = await ask({orderId: ID, pin: '248001'});
  assert.equal(r.status, 200);
  const {order: o} = await r.json();
  assert.equal(o.step, 2); assert.equal(o.label, 'On the way');
  assert.equal(o.awb, 'AWB123'); assert.equal(o.courier, 'Delhivery'); assert.equal(o.tracking.etd, '2026-11-10');
  assert.equal(o.tracking.activities[0].location, 'Delhi');
  assert.equal(o.payment, 'Cash on delivery'); assert.equal(o.total, 2998);
  assert.ok(calls.some(u => u.includes('filter_by=channel_order_id') && u.includes(encodeURIComponent(ID))));
});

test('wrong PIN code and unknown order look the same', async () => {
  mock();
  const a = await ask({orderId: ID, pin: '110001'});
  mock({orders: []});
  const b = await ask({orderId: ID, pin: '248001'});
  assert.equal(a.status, 404); assert.equal(b.status, 404);
  assert.deepEqual(await a.json(), await b.json());
});

test('an order not yet shipped still answers, without courier details', async () => {
  mock({orders: [{...order, status: 'NEW', shipments: [{id: 5, awb: ''}]}]});
  const {order: o} = await (await ask({orderId: ID, pin: '248001'})).json();
  assert.equal(o.step, 0); assert.equal(o.tracking, null);
  assert.ok(!calls.some(u => u.includes('/courier/track/')));
});

test('a courier tracking error falls back to the order status', async () => {
  mock({track: {message: 'boom'}, trackStatus: 500});
  const {order: o} = await (await ask({orderId: ID, pin: '248001'})).json();
  assert.equal(o.label, 'On the way'); assert.equal(o.tracking, null);
});

test('rejects bad input, other sites, too many lookups, and works only with secrets', async () => {
  mock();
  assert.equal((await ask({orderId: 'abc', pin: '248001'})).status, 400);
  assert.equal((await ask({orderId: ID, pin: '12'})).status, 400);
  assert.equal((await ask({orderId: ID, pin: '248001'}, 'https://evil.example')).status, 403);
  _resetLookups(); let last;
  for (let i = 0; i < 21; i++) last = await ask({orderId: ID, pin: '248001'});
  assert.equal(last.status, 429);
  const r = await worker.fetch(new Request('https://52.example/api/track', {method: 'POST', body: '{}'}), {ASSETS: env.ASSETS});
  assert.equal(r.status, 503);
  assert.equal((await worker.fetch(new Request('https://52.example/api/track'), env)).status, 405);
});

test('status words map to the customer steps', () => {
  const s = x => trackStep(x).step;
  assert.equal(s('NEW'), 0); assert.equal(s('PICKUP SCHEDULED'), 1); assert.equal(s('READY TO SHIP'), 1);
  assert.equal(s('In Transit'), 2); assert.equal(s('SHIPPED'), 2); assert.equal(s('OUT FOR DELIVERY'), 3);
  assert.equal(s('DELIVERED'), 4); assert.equal(s('CANCELED'), -1); assert.equal(s('RTO DELIVERED'), -1);
  assert.equal(trackStep('UNDELIVERED').problem, 'attempt');
});

test('Pages Function routes POST /api/track to the same handler', async () => {
  const {onRequestPost} = await import('../functions/api/track.js');
  assert.equal((await onRequestPost({request: new Request('https://52-alive.pages.dev/api/track', {method: 'POST', body: '{}'}), env: {}})).status, 503);
});

import {phoneMatch} from '../src/worker.js';
test('phone check works with full and masked numbers', () => {
  assert.equal(phoneMatch('9876543210', '+91 98765 43210'), true);
  assert.equal(phoneMatch('919876543210', '9876543210'), true);
  assert.equal(phoneMatch('******3210', '9876543210'), true);
  assert.equal(phoneMatch('98xxxxx210', '9876543210'), false);       // too little shown to be sure
  assert.equal(phoneMatch('9876543210', '9876543211'), false);
  assert.equal(phoneMatch('******3210', '9876543299'), false);
});

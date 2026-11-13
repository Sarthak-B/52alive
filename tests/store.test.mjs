import assert from 'node:assert/strict';
import {test, beforeEach} from 'node:test';
import worker, {storeOrder, _resetTokenCache, _resetLoginFail, _resetPickupCache} from '../src/worker.js';

const ID = '52A-8fe6eaa1-c77d-4c24-8c6a-fef3a71899ac';
const env = {SHIPROCKET_EMAIL: 'a', SHIPROCKET_PASSWORD: 'b', SHIPROCKET_WEBHOOK_TOKEN: 'k'.repeat(20), ASSETS: {fetch: () => new Response('')}};
const fresh = {id: 7, channel_order_id: ID, customer_name: 'Riya', customer_city: 'Pune', customer_pincode: '411001', status: 'NEW', payment_method: 'cod', total: '1699',
  products: [{name: 'Retro Track Jacket - Tan / XL', quantity: 1, channel_sku: '52A-RETROJACKET-TAN-XL'}], shipments: [{id: 70}]};
let calls, state;
function mock(o = {}) {
  calls = []; state = {order: {...fresh, ...o.order}};
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({url, method: init.method || 'GET', body});
    if (url.endsWith('/auth/login')) return Response.json({token: 'T'});
    if (url.includes('/orders/show/')) return Response.json({data: state.order});
    if (url.includes('/orders?per_page')) return Response.json({data: [state.order]});
    if (url.includes('/courier/serviceability/')) return Response.json({data: {recommended_courier_company_id: 2, available_courier_companies: [
      {courier_company_id: 1, courier_name: 'Xpress', rate: 90, estimated_delivery_days: '4'}, {courier_company_id: 2, courier_name: 'Delhivery', rate: 75.5, estimated_delivery_days: '3'}]}});
    if (url.endsWith('/courier/assign/awb')) return o.assignFail ? Response.json({message: 'Insufficient wallet balance'}, {status: 400})
      : Response.json({awb_assign_status: 1, response: {data: {awb_code: 'AWB9', courier_name: 'Delhivery'}}});
    if (url.endsWith('/courier/generate/pickup')) return Response.json({pickup_status: 1, response: {pickup_scheduled_date: '2026-11-08 10:00:00'}});
    if (url.endsWith('/courier/generate/label')) return Response.json({label_created: 1, label_url: 'https://sr/label.pdf'});
    if (url.endsWith('/orders/print/invoice')) return Response.json({is_invoice_created: true, invoice_url: 'https://sr/inv.pdf'});
    if (url.endsWith('/orders/cancel')) return Response.json({});
    return new Response('{}', {status: 404});
  };
}
const ask = (body, key = env.SHIPROCKET_WEBHOOK_TOKEN, method = 'POST') => worker.fetch(new Request('https://52.example/api/store', {method, headers: {'x-store-key': key, Origin: 'https://nowora.vercel.app'}, body: method === 'POST' ? JSON.stringify(body) : undefined}), env);
beforeEach(() => { _resetTokenCache(); _resetLoginFail(); _resetPickupCache(); });

test('the make4yu dashboard needs no key; others do; preflight is open', async () => {
  mock();
  const plain = (origin, key) => worker.fetch(new Request('https://52.example/api/store', {method: 'POST', headers: {...(origin ? {Origin: origin} : {}), ...(key ? {'x-store-key': key} : {})}, body: '{"action":"list"}'}), env);
  assert.equal((await plain('https://nowora.vercel.app')).status, 200);
  assert.equal((await plain('https://make4yu.vercel.app')).status, 200);
  assert.equal((await plain('https://make4yu.com')).status, 200);
  assert.equal((await plain('https://52.example')).status, 200);
  calls = [];
  assert.equal((await plain('https://evil.example')).status, 401);
  assert.equal((await plain(null)).status, 401);
  assert.equal((await plain(null, env.SHIPROCKET_WEBHOOK_TOKEN)).status, 200);
  calls = [];
  const p = await ask(null, '', 'OPTIONS'); assert.equal(p.status, 204); assert.equal(p.headers.get('access-control-allow-origin'), '*');
});

test('lists orders with a stage', async () => {
  mock();
  const r = await ask({action: 'list'}); const d = await r.json();
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(d.orders[0].stage, 'new'); assert.equal(d.orders[0].orderId, ID); assert.equal(d.orders[0].shipmentId, 70);
  assert.equal(d.orders[0].items[0].sku, '52A-RETROJACKET-TAN-XL');
});

test('stages', () => {
  assert.equal(storeOrder({status: 'READY TO SHIP', shipments: [{id: 1, awb: 'A'}]}).stage, 'ready');
  assert.equal(storeOrder({status: 'PICKUP SCHEDULED', shipments: [{id: 1, awb: 'A'}]}).stage, 'ready');
  assert.equal(storeOrder({status: 'IN TRANSIT', shipments: [{id: 1, awb: 'A'}]}).stage, 'transit');
  assert.equal(storeOrder({status: 'DELIVERED'}).stage, 'delivered');
  assert.equal(storeOrder({status: 'CANCELED'}).stage, 'cancelled');
});

test('rates: cheapest first, recommended flagged', async () => {
  mock();
  const d = await (await ask({action: 'rates', id: 7})).json();
  assert.deepEqual(d.couriers.map(c => c.name), ['Delhivery', 'Xpress']);
  assert.equal(d.couriers[0].recommended, true);
});

test('ship: courier → pickup → label + invoice, with the chosen courier', async () => {
  mock();
  const d = await (await ask({action: 'ship', id: 7, courierId: 2})).json();
  assert.equal(d.ok, true); assert.equal(d.awb, 'AWB9'); assert.equal(d.courier, 'Delhivery');
  assert.equal(d.pickup, '2026-11-08 10:00:00'); assert.equal(d.labelUrl, 'https://sr/label.pdf'); assert.equal(d.invoiceUrl, 'https://sr/inv.pdf');
  const as = calls.find(c => c.url.endsWith('/courier/assign/awb')); assert.deepEqual(as.body, {shipment_id: 70, courier_id: 2});
  assert.deepEqual(calls.find(c => c.url.endsWith('/generate/pickup')).body, {shipment_id: [70]});
});

test('ship: an order that already has a courier only books the pickup', async () => {
  mock({order: {status: 'READY TO SHIP', shipments: [{id: 70, awb: 'OLD1', courier: 'Ekart'}]}});
  const d = await (await ask({action: 'ship', id: 7})).json();
  assert.equal(d.awb, 'OLD1'); assert.ok(!calls.some(c => c.url.endsWith('/assign/awb')));
});

test('ship: Shiprocket\'s reason comes back (e.g. wallet)', async () => {
  mock({assignFail: true});
  const r = await ask({action: 'ship', id: 7}); const d = await r.json();
  assert.equal(r.status, 422); assert.match(d.error, /wallet/);
  assert.ok(!calls.some(c => c.url.endsWith('/generate/pickup')));
});

test('cancel only before the courier has it', async () => {
  mock(); assert.equal((await (await ask({action: 'cancel', id: 7})).json()).ok, true);
  mock({order: {status: 'IN TRANSIT', shipments: [{id: 70, awb: 'A'}]}});
  assert.equal((await ask({action: 'cancel', id: 7})).status, 409);
});

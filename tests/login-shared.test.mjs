import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker, {_resetTokenCache, _resetLoginFail} from '../src/worker.js';

const store = new Map();
globalThis.caches = {default: {match: async k => store.has(k) ? new Response(store.get(k)) : undefined, put: async (k, r) => store.set(k, await r.text()), delete: async k => store.delete(k)}};
const env = {SHIPROCKET_EMAIL: 'api@x.in', SHIPROCKET_PASSWORD: 'p', SHIPROCKET_WEBHOOK_TOKEN: 'k', ASSETS: {fetch: () => new Response('')}};
let logins = 0, fail = false;
globalThis.fetch = async url => {
  if (url.endsWith('/auth/login')) { logins++; return fail ? Response.json({message: 'Invalid'}, {status: 401}) : Response.json({token: 'T'}); }
  return Response.json({data: []});
};
const list = () => worker.fetch(new Request('https://52.example/api/store', {method: 'POST', headers: {Origin: 'https://nowora.vercel.app'}, body: '{"action":"list"}'}), env);

test('a fresh instance reuses the shared token instead of logging in again', async () => {
  store.clear(); logins = 0;
  for (let i = 0; i < 5; i++) { _resetTokenCache(); _resetLoginFail(); assert.equal((await list()).status, 200); }
  assert.equal(logins, 1);
});

test('one failed login stops every instance from retrying', async () => {
  store.clear(); logins = 0; fail = true;
  for (let i = 0; i < 5; i++) { _resetTokenCache(); _resetLoginFail(); await list(); }
  assert.equal(logins, 1);
  fail = false;
});

test('requests at the same moment share one login', async () => {
  store.clear(); logins = 0; _resetTokenCache(); _resetLoginFail();
  await Promise.all([list(), list(), list(), list()]);
  assert.equal(logins, 1);
});

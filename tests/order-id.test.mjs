import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('each new order has a fresh identifier',()=>{
 const source=html.match(/function newOrderId\(\)\{[^}]+\}/)[0];
 const context={crypto:webcrypto};vm.createContext(context);vm.runInContext(source,context);
 const ids=new Set(Array.from({length:1000},()=>context.newOrderId()));
 assert.equal(ids.size,1000);
 assert.ok(html.includes('orderId=newOrderId(); $("#oid").textContent="#"+orderId; form.reset();'));
});
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
 if(match[1].trim() && !/application\/(ld\+)?json/.test(match[0])) new vm.Script(match[1]);
}

'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {rubleAmount, analyze, composeReport} = require('../lib/ozon-paid-audit');
const types = [
  {id: 10, name:'Subscription Fee', description:'Подписка управление отзывами'},
  {id: 20, name:'Logistic', description:'Обычная логистика'},
  {id: 30, name:'Promotion', description:'Продвижение товаров'},
];
const a = (type_id, amount, scope = 'seller') => scope === 'seller'
  ? {non_item_fee: {type_id, accrued: {amount: String(amount), currency: 'RUB'}}}
  : {item_fees: {fees: [{sku: 1, fees: [{type_id, accrued: {amount: String(amount), currency:'RUB'}}]}]}};

test('money parsing handles invalid currency and missing values', () => {
  assert.equal(rubleAmount({amount:'-10.25',currency:'RUB'}),-10.25);
  assert.equal(rubleAmount({amount:'100',currency:'USD'}),null);
  assert.equal(rubleAmount(undefined),null);
});
test('flags new seller-level paid fee and premium', () => {
  const r = analyze({recent:[a(10,-199),a(20,-50,'item')],history:[],types,subscription:{is_premium:true,type:'Premium Pro'}});
  assert.equal(r.suspicious.length,1);
  assert.equal(r.suspicious[0].amount,199);
  assert.equal(r.unexpectedPremium,true);
  assert.match(composeReport('2026-10-21',r),/199,00 ₽/);
});
test('does not flag recurring types or allowlisted fees', () => {
  const r = analyze({recent:[a(10,-199),a(30,-15,'item')],history:[a(10,-199)],types,subscription:{is_premium:false},allowedTypes:'30'});
  assert.equal(r.suspicious.length,0);
  assert.equal(r.charges.length,2);
});
test('ignores standard item charges but includes seller-level fee', () => {
  const r = analyze({recent:[a(20,-100,'item'),a(20,-25)],history:[],types,subscription:{is_premium:false}});
  assert.equal(r.suspicious.length,1);
  assert.equal(r.charges.length,1);
});
test('requires cron secret, posts to Ozon finance and sends report to Telegram', async () => {
  const handler = require('../api/ozon-paid-audit');
  const oldFetch = global.fetch;
  const keys = ['OZON_CLIENT_ID','OZON_FINANCE_API_KEY','OZON_API_KEY','CRON_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, {OZON_CLIENT_ID:'test-client',OZON_FINANCE_API_KEY:'test-finance',OZON_API_KEY:'test-product',CRON_SECRET:'abc-123',TELEGRAM_BOT_TOKEN:'bot-test',TELEGRAM_CHAT_ID:'chat-test'});
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({url, opts});
    if (url.endsWith('/v1/seller/info')) return {ok:true,json:async()=>({subscription:{is_premium:false,type:'Базовая'}})};
    if (url.endsWith('/v1/finance/accrual/types')) return {ok:true,json:async()=>({accrual_types:types})};
    if (url.endsWith('/v1/finance/accrual/by-day')) return {ok:true,json:async()=>({accruals:[], last_id:''})};
    if (url.includes('/sendMessage')) return {ok:true,json:async()=>({ok:true})};
    assert.fail('unexpected URL '+url);
  };
  function response() {
    return {headers:{},setHeader(k,v){this.headers[k]=v;},end(t){this.value=JSON.parse(t);}};
  }
  try {
    const rejected = response();
    await handler({method:'GET',headers:{authorization:'Bearer wrong'}}, rejected);
    assert.equal(rejected.statusCode,401);
    assert.equal(calls.length,0);
    const res = response();
    await handler({method:'GET',headers:{authorization:'Bearer abc-123'}}, res);
    assert.equal(res.statusCode,200);
    assert.equal(res.value.ok,true);
    assert.equal(calls.filter(c=>c.url.includes('/v1/finance/accrual/by-day')).length,8);
    assert.equal(calls.filter(c=>c.url.includes('sendMessage')).length,1);
  } finally {
    global.fetch=oldFetch;
    for (const k of keys) if (prev[k]===undefined) delete process.env[k]; else process.env[k]=prev[k];
  }
});

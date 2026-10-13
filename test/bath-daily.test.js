'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/bath-daily');
const config = require('../config/bath-pricing.json');
const observations = require('../config/bath-market-observations.json');

function response() {
  return {statusCode:0, setHeader(){}, end(value){this.body=JSON.parse(value);}};
}

test('unauthorized request never fetches finance or sends notifications',async()=>{
  const res=response(), previous=global.fetch;
  global.fetch=async()=>{throw new Error('Unexpected network request');};
  try {
    await handler({method:'GET',headers:{}},res);
    assert.equal(res.statusCode,401);
  } finally {global.fetch=previous;}
});

test('WB inherited proposals also respect the new minimum and lowering approval',()=>{
  const filename=require.resolve('../api/bath-daily');
  const source=require('node:fs').readFileSync(filename,'utf8');
  const Module=require('node:module'), isolated=new Module(filename,module);
  isolated.filename=filename;isolated.paths=module.paths;
  isolated._compile(source+'\nmodule.exports={wbDryRun};',filename);
  const finance={items:[{nmID:'1',saleUnits:10,variableRetention:0.47,fixedMarketplaceCostPerSale:120}]};
  for(const current of [500,800]){
    const products={products:[{nmID:'1',priceLoaded:true,discountedPrice:current}]};
    const analytics={items:[{nmID:'1',history:Array.from({length:7},(_,i)=>({date:String(i),orders:current===800&&i>=5?1:10}))}]};
    const [d]=isolated.exports.wbDryRun(products,analytics,finance,true);
    assert.equal(d.action,'HOLD');assert.equal(d.recommended,current);
    assert.equal(!!d.requiresApproval,current===800);
  }
});

test('full daily pipeline asks about lowering without marketplace writes, even with enable flags',async()=>{
  const previousFetch=global.fetch;
  const names=['CRON_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','OZON_AUTOPRICE_ENABLED','OZON_MANAGE_PROMOS_ENABLED','OZON_PRICE_API_KEY'];
  const previousEnv=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  const previousProducts=structuredClone(config.products);
  const previousObservations=structuredClone(observations.products);
  Object.assign(process.env,{CRON_SECRET:'fixture',TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_CHAT_ID:'fixture',
    OZON_AUTOPRICE_ENABLED:'true',OZON_MANAGE_PROMOS_ENABLED:'true',OZON_PRICE_API_KEY:'fixture'});
  const ids=Object.keys(config.products), calls=[];
  const row=price=>({price,verified:true,finalBuyerPrice:true,inStock:true,source:'test fixture',
    contextKey:'Omsk|OzonCard|one-seat',observedAt:new Date().toISOString()});
  for(const id of ids){
    config.products[id].scheme='FBS';config.products[id].competitors=['peer'];
    observations.products[id]={own:row(260),competitors:{peer:row(250)}};
  }
  const products=ids.map((id,i)=>({productId:id,offerId:id,name:['Серая','Бежевая','Синяя','Оранжевая'][i],
    basePrice:800,sellerPrice:800,acquiring:8,salesPercentFbs:52}));
  const fixtures={
    '/api/seller-products':{ok:true,products},
    '/api/bath-finance':{ok:true,items:ids.map(productId=>({productId,postingHits:10,avgDeliveryAndOther:120,unitEconomicsVerified:true}))},
    '/api/bath-analytics':{ok:true,dateTo:'2026-10-12',rows:ids.flatMap(productId=>Array.from({length:14},(_,i)=>({
      productId,day:new Date(Date.parse('2026-09-29')+i*86400000).toISOString().slice(0,10),metrics:{ordered_units:10,revenue:1000}
    })))},
    '/api/bath-promos':{ok:true,found:[]},'/api/bath-search':{ok:true},
    '/api/wb-analytics':{ok:true,items:[]},'/api/wb-products':{ok:true,products:[]},
    '/api/wb-finance':{ok:true,items:[]},'/api/yandex-market':{ok:false,error:'fixture unavailable'}
  };
  // Ensure a scheduled change day without modifying the wall clock used by observation freshness.
  const file=require('node:fs').readFileSync(require.resolve('../api/bath-daily'),'utf8');
  const Module=require('node:module');const isolated=new Module(require.resolve('../api/bath-daily'),module);
  isolated.filename=require.resolve('../api/bath-daily');isolated.paths=module.paths;
  isolated._compile(file.replace('new Set([1,3,5])','new Set([0,1,2,3,4,5,6])'),isolated.filename);
  global.fetch=async(url,options)=>{
    calls.push({url,options});
    if(String(url).startsWith('https://api.telegram.org/'))
      return {ok:true,status:200,json:async()=>({ok:true})};
    const body=fixtures[new URL(url).pathname];
    assert.ok(body,'Unexpected outbound call: '+url);
    return {ok:true,status:200,json:async()=>body};
  };
  try {
    const res=response();await isolated.exports({method:'GET',headers:{authorization:'Bearer fixture'}},res);
    assert.equal(res.statusCode,200);assert.equal(res.body.unifiedDryRun,true);
    assert.deepEqual(res.body.writes,[]);assert.equal(res.body.promoRemoved,false);
    assert.equal(res.body.decisions.length,4);
    for(const d of res.body.decisions){assert.equal(d.action,'HOLD');assert.equal(d.requiresApproval,true);}
    assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
    assert.ok(calls.every(c=>!String(c.url).includes('api-seller.ozon.ru')));
    for(const p of products) assert.ok(res.body.report.includes(p.name));
    assert.match(res.body.report,/ВОПРОС ВЛАДЕЛЬЦУ/);
    assert.ok(res.body.report.length<3900,'Approval questions must not be truncated');
  } finally {
    global.fetch=previousFetch;config.products=previousProducts;observations.products=previousObservations;
    for(const name of names){if(previousEnv[name]===undefined)delete process.env[name];else process.env[name]=previousEnv[name];}
  }
});

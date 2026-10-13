'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {policyFor, economics, marketFor, stageFor, decide} = require('../lib/bath-pricing');
const NOW = Date.parse('2026-10-13T04:00:00Z');
const id = '3768184568';
test('selected grey competitor is registered only for the matching grey product',()=>{
  const config=require('../config/bath-pricing.json');
  assert.deepEqual(policyFor('2808600941').competitors,['5459795463']);
  for(const other of ['3768184568','3826876199','3768033857']) assert.deepEqual(policyFor(other).competitors,[]);
  const ref=config.competitorCatalog['5459795463'].referenceObservation;
  assert.equal(ref.bankOfferPrice,255);assert.equal(ref.otherBanksPrice,280);
  assert.equal(ref.liveEligible,false);assert.equal(ref.region,null);
  const market=marketFor(policyFor('2808600941'),require('../config/bath-market-observations.json').products['2808600941'],Date.now());
  assert.equal(market.ready,false);
});
const policy = () => ({...policyFor(id), scheme:'FBS', competitors:['peer']});
const observation = price => ({price, verified:true, finalBuyerPrice:true, inStock:true,
  source:'test fixture', contextKey:'Omsk|OzonCard|one-seat|public-discounts', observedAt:'2026-10-13T03:00:00Z'});
const history = (recent=10, previous=10) => ({dateTo:'2026-10-12', rows:Array.from({length:14},(_,i)=>({
  productId:id, day:new Date(Date.parse('2026-09-29')+i*86400000).toISOString().slice(0,10),
  metrics:{ordered_units:i<7?previous:recent,revenue:1000}
}))});
function fixture(overrides={}) {
  return {product:{productId:id,basePrice:800,sellerPrice:800,salesPercentFbo:60,salesPercentFbs:52,acquiring:8},
    finance:{postingHits:10,avgDeliveryAndOther:120,unitEconomicsVerified:true},
    analytics:history(),promo:null,fallbackFixed:120,changeDay:true,policy:policy(),
    snapshot:{own:observation(230),competitors:{peer:observation(250)}},now:NOW,...overrides};
}

test('server defaults replace the 150/200 policy with 100 and increments of 10',()=>{
  const p=policyFor(id);
  assert.equal(p.minProfit,100);assert.equal(p.targetProfit,100);assert.equal(p.profitStep,10);
  assert.equal(p.stageStartedAt,null);assert.equal(policyFor('unrelated'),null);
});
for(const buyer of [219.99,220,230,240,240.01,290]) {
  test('market target follows competitor, not a hardcoded band: '+buyer,()=>{
    const f=fixture();f.snapshot.own=observation(buyer);f.snapshot.competitors.peer=observation(buyer+10);
    const d=decide(f);assert.equal(d.market.targetBuyerPrice,buyer);assert.equal(d.action,'HOLD');
  });
}
test('250 and 300 competitors produce 240 and 290 targets respectively',()=>{
  for(const price of [250,300]) {
    const f=fixture();f.snapshot.competitors.peer.price=price;
    assert.equal(marketFor(f.policy,f.snapshot,NOW).targetBuyerPrice,price-10);
  }
});
test('lowest of ALL selected comparable competitors sets the reference',()=>{
  const f=fixture();f.policy.competitors.push('second');f.snapshot.competitors.second=observation(240);
  assert.equal(marketFor(f.policy,f.snapshot,NOW).targetBuyerPrice,230);
  delete f.snapshot.competitors.peer;
  assert.equal(marketFor(f.policy,f.snapshot,NOW).ready,false);
});
for(const mutation of [
  row=>row.observedAt='2026-10-11T00:00:00Z', row=>row.observedAt='2026-10-14T00:00:00Z',
  row=>row.price=NaN, row=>row.price=0, row=>row.finalBuyerPrice=false,
  row=>row.inStock=false, row=>row.verified=false, row=>row.contextKey='other card or region', row=>row.source=''
]) {
  test('invalid, stale or incomparable observation blocks decisions: '+mutation.toString(),()=>{
    const f=fixture();mutation(f.snapshot.competitors.peer);
    assert.equal(decide(f).action,'HOLD');assert.equal(decide(f).market.ready,false);
  });
}
test('missing own observation or empty watchlist cannot use an assumed 250–300 range',()=>{
  const f=fixture();delete f.snapshot.own;assert.equal(decide(f).market.ready,false);
  f.policy.competitors=[];assert.equal(decide(f).market.ready,false);
});
test('all lowering proposals require owner approval even with ample profit',()=>{
  for(const promo of [null,{actionPrice:800,maxActionPrice:900}]) {
    const f=fixture({promo});f.snapshot.own.price=260;f.snapshot.promoSettlementVerified=true;
    const d=decide(f);
    assert.equal(d.action,'HOLD');assert.equal(d.requiresApproval,true);assert.equal(d.executable,false);
    assert.equal(d.proposal.action,promo?'LOWER_PROMO':'LOWER');
    assert.equal(d.proposal.price,760);assert.equal(d.proposal.expectedProfit,182.2);
  }
});
test('competitor lowering is reported even on an observation-only day',()=>{
  const f=fixture({changeDay:false});f.snapshot.own.price=260;
  const d=decide(f);assert.equal(d.requiresApproval,true);assert.equal(d.action,'HOLD');
});
test('promo prediction uses proposed price, not previous effective price',()=>{
  const f=fixture({promo:{actionPrice:800,maxActionPrice:900}});
  f.product.basePrice=900;f.snapshot.promoSettlementVerified=true;
  const d=decide(f);
  assert.equal(d.action,'RAISE_PROMO');assert.equal(d.currentProfit,201);
  assert.equal(d.recommendedPromoPrice,834);assert.equal(d.recommendedProfit,216.98);
});
test('unknown promo payout relationship blocks changes',()=>{
  const f=fixture({promo:{actionPrice:800,maxActionPrice:900}});
  assert.equal(decide(f).proposal,null);assert.equal(decide(f).action,'HOLD');
});
test('unmodelled seller discounts block base price changes',()=>{
  const f=fixture();f.product.sellerActionsExist=true;assert.equal(decide(f).action,'HOLD');
});
test('lowering may not cross the 100 ruble profit floor',()=>{
  const f=fixture();Object.assign(f.product,{basePrice:600,sellerPrice:600,acquiring:6});
  f.snapshot.own.price=260;
  const d=decide(f);assert.equal(d.proposal.expectedProfit,92.9);assert.equal(d.action,'HOLD');
  assert.match(d.reason,/100/);assert.equal(d.requiresApproval,false);
});
test('raising below the required floor is also blocked',()=>{
  const f=fixture();Object.assign(f.product,{basePrice:550,sellerPrice:550,acquiring:5.5});
  f.snapshot.own.price=210;
  const d=decide(f);assert.ok(d.proposal.expectedProfit<100);assert.equal(d.action,'HOLD');
});
test('profit check occurs before rounding the display to two decimals',()=>{
  for(const [profit,allowed] of [[99.99,false],[99.999,false],[100,true],[100.01,true]]) {
    const f=fixture();Object.assign(f.product,{basePrice:600,sellerPrice:600,acquiring:0,salesPercentFbs:0});
    f.snapshot.own.price=230;f.policy.cogs=626-profit-120;
    const d=decide(f);assert.equal(d.action,allowed?'RAISE':'HOLD');
  }
});
test('fallback 120 is preview-only, even with good sales and market data',()=>{
  const f=fixture({finance:null});const d=decide(f);
  assert.equal(d.fixed,120);assert.equal(d.financeReliable,false);assert.equal(d.action,'HOLD');
  assert.ok(d.proposal);assert.equal(d.executable,false);
});
test('real fixed costs 150 change 800-ruble profit from 201 to 171',()=>{
  const f=fixture();const a=economics(f.product,f.finance,f.policy,120);
  f.finance.avgDeliveryAndOther=150;const b=economics(f.product,f.finance,f.policy,120);
  assert.equal(a.profitAt(800),201);assert.equal(b.profitAt(800),171);
});
test('zero own fixed cost is not replaced by fallback 120',()=>{
  const f=fixture();f.finance.avgDeliveryAndOther=0;
  assert.equal(economics(f.product,f.finance,f.policy,120).fixed,0);
});
test('aggregated finance without per-unit verification and unknown scheme cannot authorize changes',()=>{
  const f=fixture();delete f.finance.unitEconomicsVerified;
  assert.equal(decide(f).action,'HOLD');f.finance.unitEconomicsVerified=true;f.policy.scheme=null;
  assert.equal(decide(f).action,'HOLD');
});
test('known FBS commission is used instead of FBO',()=>{
  const f=fixture();assert.equal(economics(f.product,f.finance,f.policy,120).commissionPct,52);
});
test('invalid rates and absent acquiring are blocked rather than zero-filled',()=>{
  for(const rate of [100,NaN,Infinity,-1]) {
    const f=fixture();f.product.salesPercentFbs=rate;assert.equal(decide(f).action,'HOLD');
    assert.equal(decide(f).safeFloor,null);
  }
  const f=fixture();delete f.product.acquiring;assert.equal(decide(f).safeFloor,null);
});
test('100-ruble stage cannot auto-advance during dry-run',()=>{
  const f=fixture();const d=decide(f);assert.equal(d.stage.eligible,false);
  assert.equal(d.stage.nextTarget,100);
});
test('two complete weeks with stable sales propose exactly +10 and do not mutate state',()=>{
  const f=fixture();f.policy.stageStartedAt='2026-10-06T00:00:00Z';
  const a=decide(f),b=decide(f);
  assert.equal(a.stage.eligible,true);assert.equal(a.stage.nextTarget,110);
  assert.deepEqual(a.stage,b.stage);assert.equal(f.policy.targetProfit,100);
});
test('next stage waits for a full observation period',()=>{
  const f=fixture();f.policy.stageStartedAt='2026-10-07T00:00:00Z';assert.equal(decide(f).stage.eligible,false);
});
test('stale history cannot authorize raising or a profit step',()=>{
  const f=fixture();f.policy.stageStartedAt='2026-10-01T00:00:00Z';f.analytics.dateTo='2026-10-01';
  const d=decide(f);assert.equal(d.stage.eligible,false);assert.equal(d.action,'HOLD');
});
test('missing day, duplicated day, low volume or falling orders blocks +10',()=>{
  const p={...policy(),stageStartedAt:'2026-10-06T00:00:00Z'};
  const rows=h=>h.rows.map(r=>({day:r.day,orders:r.metrics.ordered_units}));
  for(const h of [history(8,10),history(1,1)]) assert.equal(stageFor(p,rows(h),h.dateTo).eligible,false);
  const h=history(),a=rows(h);a.pop();assert.equal(stageFor(p,a,h.dateTo).eligible,false);
  a.push(a[0]);assert.equal(stageFor(p,a,h.dateTo).eligible,false);
});
test('stable sales do not justify next stage if market price cannot support it',()=>{
  const f=fixture();f.policy.stageStartedAt='2026-10-06T00:00:00Z';
  Object.assign(f.product,{basePrice:600,sellerPrice:600,acquiring:6});
  f.snapshot.own.price=240;
  assert.equal(decide(f).stage.eligible,false);
});
test('no decision exposes an executable write while rollout remains dry-run',()=>{
  for(const buyer of [100,219.99,220,230,240,240.01,300,500]) {
    const f=fixture();f.snapshot.own.price=buyer;const d=decide(f);
    assert.equal(d.executable,false);
    if(d.action!=='HOLD') {
      assert.ok(d.recommendedProfit>=100);
      assert.ok(Math.abs(d.newPrice-f.product.basePrice)/f.product.basePrice<=0.05);
    }
  }
});

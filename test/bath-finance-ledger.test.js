'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {aggregateAccruals,cents}=require('../lib/bath-finance-ledger');
const product={productId:'2808600941',sku:'2921050259',offerId:'30092025',name:'Gray seat'};
const m=n=>({amount:String(n),currency:'RUB'});
function sale({id='sale',unit='p1',qty=1,price=480,commission=-249.6,delivery=-121}={}){
  return {accrual_id:id,unit_number:unit,total_amount:m(price*qty+commission+delivery),posting:{delivery_schema:'Fbs',products:[{
    sku:product.sku,quantity:qty,commission:{sale_amount:m(price*qty),seller_price:m(price),sale_price:m(187.26),bonus:m(292.74),coinvestment:m(0),sale_commission:m(commission)},
    delivery:{total_accrued:m(delivery),services:[{type_id:32,accrued:m(delivery)}]}}]}};
}
function fee(n=-5,unit='p1',id='fee'){
  return {accrual_id:id,unit_number:unit,total_amount:m(n),item_fees:{fees:[{sku:product.sku,fees:[{type_id:1,accrued:m(n)}]}]}};
}
const run=rows=>aggregateAccruals([product],rows,{'1':{name:'Эквайринг'}});
test('real Ozon amount shape reconciles without adding bonus twice',()=>{
 const r=run([sale()]).items[0];
 assert.equal(r.sales,480);assert.equal(r.netAccrued,109.4);assert.equal(r.profitPerSoldUnitEstimate,49.4);
 assert.equal(r.settlementReconciled,true);assert.equal(r.unitEconomicsVerified,false);
});
test('three units use sale_amount and divide expenses by units, not accrual rows',()=>{
 const r=run([sale({qty:3,commission:-748.8,delivery:-300}),fee(-15)]).items[0];
 assert.equal(r.sales,1440);assert.equal(r.soldUnits,3);assert.equal(r.postingHits,1);
 assert.equal(r.avgDeliveryAndOther,100);assert.equal(r.avgAcquiring,5);
 assert.equal(r.ownCostsEstimate,180);assert.equal(r.profitPerSoldUnitEstimate,65.4);
});
test('later delivery charge does not add another sale or packaging charge',()=>{
 const charge=sale({id:'delivery',price:0,commission:0,delivery:-10});charge.posting.products[0].commission=null;
 const r=run([sale(),charge,fee()]).items[0];
 assert.equal(r.soldUnits,1);assert.equal(r.shippedUnits,1);assert.equal(r.accrualProductRows,3);assert.equal(r.profitEstimate,34.4);
});
test('reimbursements keep their sign instead of being discarded',()=>{
 const r=run([sale(),fee(-5),fee(2,'p1','refund')]).items[0];
 assert.equal(r.itemFees,3);assert.equal(r.acquiring,3);assert.equal(r.profitEstimate,46.4);
});
test('return reverses sale and commission; recovered inventory is not assumed',()=>{
 const returned=sale({id:'return',price:-480,commission:249.6,delivery:-50});
 const r=run([sale(),returned]).items[0];
 assert.equal(r.sales,0);assert.equal(r.commission,0);assert.equal(r.returnedUnits,1);
 assert.equal(r.soldUnits,1);assert.equal(r.ownCostsEstimate,60);assert.equal(r.profitEstimate,-231);
});
test('same accrual replay is deduplicated; conflicting replay invalidates result',()=>{
 const row=sale();const r=run([row,row]);assert.equal(r.items[0].sales,480);assert.equal(r.reconciliation.duplicateRowsSkipped,1);
 const c=run([row,{...row,total_amount:m(1)}]).items[0];assert.equal(c.settlementReconciled,false);assert.equal(c.profitEstimate,null);
});
test('missing totals, currency, malformed quantities and missing amounts do not become verified zeros',()=>{
 for(const mutate of [x=>delete x.total_amount,x=>x.total_amount.currency='USD',x=>x.posting.products[0].quantity=0,x=>delete x.posting.products[0].commission.sale_amount]){
  const row=sale();mutate(row);const r=run([row]).items[0];assert.equal(r.settlementReconciled,false);assert.equal(r.profitEstimate,null);
 }
 assert.equal(cents(null),null);assert.equal(cents(''),null);assert.equal(cents(m(0)),0);
});
test('mixed SKU row must reconcile across all products before allocation',()=>{
 const row=sale();row.posting.products.push({...row.posting.products[0],sku:'other'});row.total_amount=m(218.8);
 assert.equal(run([row]).items[0].netAccrued,109.4);
 row.total_amount=m(200);assert.equal(run([row]).items[0].profitEstimate,null);
});
test('unlinked fees and duplicate sale events are not hidden behind profit',()=>{
 const unlinked=run([sale(),fee(-5,'')]).items[0];assert.equal(unlinked.profitEstimate,null);assert.equal(unlinked.unassignedAmount,-5);
 const repeated=run([sale(),sale({id:'second'})]).items[0];assert.equal(repeated.soldUnits,1);assert.equal(repeated.profitEstimate,null);
});
test('seller-wide costs are reported without arbitrary assignment to a SKU',()=>{
 const r=run([sale(),{accrual_id:'overhead',total_amount:m(-100),non_item_fee:{}}]);
 assert.equal(r.reconciliation.unallocatedSellerAmount,-100);assert.equal(r.items[0].profitEstimate,49.4);
 assert.ok(r.items[0].limitations.includes('seller_wide_expenses_not_allocated'));
});
test('return-only and fee-only periods have no fabricated per-unit profit',()=>{
 const r=run([sale({price:-480,commission:249.6})]).items[0];assert.equal(r.soldUnits,0);assert.equal(r.profitPerSoldUnitEstimate,null);
 assert.equal(run([fee()]).items[0].avgDeliveryAndOther,null);
});
test('policy route shares seller handler and remains read-only',async()=>{
 const handler=require('../api/seller-products');
 let body;const res={setHeader(){},end(v){body=JSON.parse(v);}};
 await handler({method:'GET',query:{policy:'1'}},res);assert.equal(body.policy.products[product.productId].extra,5);assert.equal(body.dryRun,true);
 await handler({method:'POST',query:{policy:'1'}},res);assert.equal(res.statusCode,405);
});
test('unverified ledger cannot feed a cheap fixed-cost estimate into repricing',()=>{
 const {economics,policyFor}=require('../lib/bath-pricing');
 const e=economics({sellerPrice:505,acquiring:5.05,salesPercentFbo:52,salesPercentFbs:52},
   {postingHits:200,avgDeliveryAndOther:0,unitEconomicsVerified:false},policyFor(product.productId),120);
 assert.equal(e.fixed,120);assert.equal(e.reliable,false);assert.ok(Math.abs(e.profitAt(470)-40.9)<0.001);
});
test('finance handler fails closed on repeated pagination cursor',async()=>{
 const oldFetch=global.fetch;const prev={id:process.env.OZON_CLIENT_ID,key:process.env.OZON_API_KEY};
 process.env.OZON_CLIENT_ID='test';process.env.OZON_API_KEY='test';let pages=0;
 global.fetch=async(url)=>({ok:true,text:async()=>JSON.stringify(
   url.endsWith('/v3/product/info/list')?{items:[{id:product.productId,sku:product.sku}]}:
   url.endsWith('/v1/finance/accrual/types')?{accrual_types:[]}:
   url.endsWith('/v4/posting/fbs/list')?{postings:[],has_next:false}:
   (++pages,{accruals:[sale()],last_id:'same'}))});
 try{
  let body;const res={setHeader(){},end(v){body=JSON.parse(v);}};
  await require('../api/bath-finance')({method:'GET'},res);
  assert.equal(res.statusCode,500);assert.equal(body.ok,false);assert.equal(pages,2);
  assert.match(body.error,/Неполная выгрузка/);
 }finally{global.fetch=oldFetch;if(prev.id===undefined)delete process.env.OZON_CLIENT_ID;else process.env.OZON_CLIENT_ID=prev.id;if(prev.key===undefined)delete process.env.OZON_API_KEY;else process.env.OZON_API_KEY=prev.key;}
});

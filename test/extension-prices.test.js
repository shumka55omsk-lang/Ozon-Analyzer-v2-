const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseVisiblePrices}=require('../extension/prices');

test('desktop screenshot: bank price and ordinary price with crossed-out old price',()=>{
  const d=parseVisiblePrices(['255 ₽ С банками 280 ₽ 1000 ₽ С другими банками Оплатить позже']);
  assert.equal(d.bankPartnerPrice,255);assert.equal(d.otherBanksPrice,280);assert.equal(d.priceType,'bank_partners');
});
test('mobile text, separate lines and nonbreaking spaces',()=>{
  const d=parseVisiblePrices(['255\n₽\nС банками\n280\u00a0₽\n1\u202f000 ₽\nС другими банками']);
  assert.equal(d.bankPartnerPrice,255);assert.equal(d.otherBanksPrice,280);
});
test('only a labelled bank price can supersede ordinary price',()=>{
  assert.equal(parseVisiblePrices(['280 ₽','От 20 ₽ в месяц']).bankPartnerPrice,null);
  assert.equal(parseVisiblePrices(['280 ₽ С другими банками']).priceType,'other_banks');
});
test('different Ozon Card label, thousands and decimal amounts',()=>{
  const d=parseVisiblePrices(['1 255,50 ₽ с Ozon Картой 1 280 ₽ без Ozon Карты']);
  assert.equal(d.bankPartnerPrice,1255.5);assert.equal(d.otherBanksPrice,1280);
});
test('conflicting visible prices do not silently choose the cheapest one',()=>{
  const d=parseVisiblePrices(['255 ₽ С банками','245 ₽ С банками']);
  assert.equal(d.priceType,'ambiguous');assert.equal(d.labelVerified,false);
});
test('duplicate sticky price widgets do not create a conflict',()=>{
  assert.equal(parseVisiblePrices(['255 ₽ С банками','255 ₽ С банками']).bankPartnerPrice,255);
});
test('installment and unrelated prices are not bank price candidates',()=>{
  assert.equal(parseVisiblePrices(['От 20 ₽ в месяц 255 ₽ С банками']).bankPartnerPrice,null);
  assert.equal(parseVisiblePrices(['20 ₽ '+ 'другой товар '.repeat(10)+'С банками']).bankPartnerPrice,null);
});
test('extension selects labelled 255 over JSON-LD 280 and returns both amounts',()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  const context={OzonPriceParser:require('../extension/prices'),Date,
    document:{querySelector:selector=>selector==='[data-widget="webPrice"]'
      ?{innerText:'255 ₽ С банками 280 ₽ 1000 ₽ С другими банками'}:null},
    chrome:{runtime:{onMessage:{addListener(){}}}},window:{addEventListener(){}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../extension/content'),'utf8'),context);
  const d=vm.runInContext('pickCurrentPrice({offers:{price:280}})',context);
  assert.equal(d.price,255);assert.equal(d.otherBanksPrice,280);
  assert.equal(d.comparisonReady,false);
});

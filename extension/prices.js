(function(root){
  'use strict';
  function parseVisiblePrices(texts){
    const banks=new Set(), ordinary=new Set();
    for(const raw of texts||[]){
      const text=String(raw||'').replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
      const labels=/с\s+другими\s+банками|без\s+(?:ozon|озон)[ -]*карт[ыа]|с\s+банками(?:[ -]партн[её]рами)?|с\s+(?:ozon|озон)[ -]*карт(?:ой|ою)/gi;
      let previousEnd=0, match;
      while((match=labels.exec(text))){
        const segment=text.slice(previousEnd,match.index);
        previousEnd=labels.lastIndex;
        const amounts=[...segment.matchAll(/(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d{1,2}))?\s*₽/g)]
          .map(x=>({value:Number(x[1].replace(/ /g,''))+Number('0.'+(x[2]||'0')),end:x.index+x[0].length}));
        const other=/другими|^без/i.test(match[0]);
        // The ordinary-price row may include a crossed-out old price AFTER its current price.
        // Do not pick a minimum from the whole page: installments and unrelated cards also contain rubles.
        if(!amounts.length||amounts.length>(other?2:1)) continue;
        if(segment.length-amounts.at(-1).end>30) continue;
        if(amounts.length===2&&amounts[1].value<=amounts[0].value) continue;
        const value=amounts[0].value;
        if(Number.isFinite(value)&&value>0&&value<=10000000) (other?ordinary:banks).add(value);
      }
    }
    const conflict=banks.size>1||ordinary.size>1;
    const bankPartnerPrice=banks.size===1?[...banks][0]:null;
    const otherBanksPrice=ordinary.size===1?[...ordinary][0]:null;
    if(conflict||(bankPartnerPrice&&otherBanksPrice&&bankPartnerPrice>otherBanksPrice))
      return {bankPartnerPrice:null,otherBanksPrice:null,priceType:'ambiguous',labelVerified:false};
    return {bankPartnerPrice,otherBanksPrice,
      priceType:bankPartnerPrice?'bank_partners':otherBanksPrice?'other_banks':'unclassified',
      labelVerified:!!bankPartnerPrice};
  }
  const api={parseVisiblePrices};
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.OzonPriceParser=api;
})(globalThis);

'use strict';
const {createHash}=require('node:crypto');
const {policyFor}=require('./bath-pricing');
// Amounts are signed ledger totals, in integer kopecks. Missing is not zero.
function cents(value){
  if(value && typeof value==='object'){
    if(value.currency && value.currency!=='RUB') return null;
    value=value.amount;
  }
  if((typeof value!=='string' && typeof value!=='number') || String(value).trim()==='') return null;
  const n=Number(value);return Number.isFinite(n)&&Number.isSafeInteger(Math.round(n*100))?Math.round(n*100):null;
}
const rub=n=>n===null?null:(Math.round(n)/100||0);
const ref=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,12);
function aggregateAccruals(products,accruals,typeMap={}){
  const stats=new Map(products.map(p=>[String(p.sku),{...p,sales:0,commission:0,delivery:0,itemFees:0,acquiring:0,
    rows:0,groups:new Map(),issues:new Set(),breakdown:new Map(),unassigned:0,reconciled:0}]));
  const seen=new Map();let duplicates=0,unallocated=0,unallocatedRows=0,unknownRows=0;
  const label=id=>typeMap[String(id)]?.description||typeMap[String(id)]?.name||('Тип '+id);
  const issueAll=reason=>{for(const s of stats.values())s.issues.add(reason);};
  for(const acc of accruals){
    const id=acc.accrual_id;
    if(id!==undefined && id!==null && String(id)!==''){
      const fingerprint=JSON.stringify(acc);
      if(seen.has(String(id))){if(seen.get(String(id))!==fingerprint)issueAll('conflicting_accrual_id');else duplicates++;continue;}
      seen.set(String(id),fingerprint);
    }else issueAll('missing_accrual_id');
    const lines=[];
    let invalid=false;
    const amount=v=>{const n=cents(v);if(n===null)invalid=true;return n??0;};
    for(const p of acc.posting?.products||[]){
      const c=p.commission;
      const sale=c?amount(c.sale_amount):0;
      const commission=c?amount(c.sale_commission):0;
      const delivery=p.delivery?amount(p.delivery.total_accrued):0;
      const qty=Number(p.quantity);
      if(!Number.isInteger(qty)||qty<=0)invalid=true;
      lines.push({sku:String(p.sku),sale,commission,delivery,itemFees:0,acquiring:0,qty,
        schema:String(acc.posting.delivery_schema||'').toUpperCase(),services:p.delivery?.services||[]});
      // bonus + coinvestment explain sale_amount; they are NOT extra revenue.
    }
    for(const group of acc.item_fees?.fees||[]){
      let fees=0,acquiring=0;
      for(const fee of group.fees||[]){const n=amount(fee.accrued);fees+=n;if(/эквайринг|acquir/i.test(label(fee.type_id)))acquiring+=n;}
      lines.push({sku:String(group.sku),sale:0,commission:0,delivery:0,itemFees:fees,acquiring,qty:0,services:group.fees||[],isFee:true});
    }
    const total=cents(acc.total_amount);
    if(!lines.length){
      if(total===null){unknownRows++;issueAll('unknown_unallocated_amount');}
      else if(total!==0){unallocated+=total;unallocatedRows++;}
      continue;
    }
    const computed=lines.reduce((n,l)=>n+l.sale+l.commission+l.delivery+l.itemFees,0);
    const reconciled=!invalid && total!==null && Math.abs(computed-total)<=1;
    for(const l of lines){
      const s=stats.get(l.sku);if(!s)continue;
      s.rows++;
      if(!reconciled)s.issues.add('accrual_total_mismatch_or_missing_fields');else s.reconciled++;
      for(const key of ['sales','commission','delivery','itemFees','acquiring'])s[key]+=l[key==='sales'?'sale':key];
      for(const srv of l.services){const n=cents(srv.accrued);if(n!==null){const name=label(srv.type_id);s.breakdown.set(name,(s.breakdown.get(name)||0)-n);}}
      const number=acc.unit_number;
      const grouped=typeof number==='string'&&number.trim()!=='';
      if(!grouped){s.unassigned+=l.sale+l.commission+l.delivery+l.itemFees;s.issues.add('missing_posting_link');continue;}
      let g=s.groups.get(number);
      if(!g){g={reference:ref(number+'|'+l.sku),sale:0,commission:0,delivery:0,itemFees:0,acquiring:0,
        sold:0,returned:0,shipped:0,saleEvents:0,returnEvents:0,schemas:new Set(),reconciled:true};s.groups.set(number,g);}
      g.reconciled=g.reconciled&&reconciled;
      for(const key of ['sale','commission','delivery','itemFees','acquiring'])g[key]+=l[key];
      if(l.schema)g.schemas.add(l.schema);
      if(Number.isInteger(l.qty)&&l.qty>0){
        g.shipped=Math.max(g.shipped,l.qty);
        if(l.sale>0){g.sold=Math.max(g.sold,l.qty);g.saleEvents++;}
        if(l.sale<0){g.returned+=l.qty;g.returnEvents++;}
      }
    }
  }
  const items=[...stats.values()].map(s=>{
    const groups=[...s.groups.values()];
    let sold=0,returned=0,shipped=0,open=0;
    const schemas=new Set();
    for(const g of groups){
      sold+=g.sold;returned+=g.returned;shipped+=g.shipped;
      if(!g.sold && (g.delivery!==0||g.sale!==0||g.itemFees!==0))open++;
      if(g.saleEvents>1)s.issues.add('multiple_sale_events_require_review');
      if(g.returned>g.sold)s.issues.add('return_without_sale_in_window');
      for(const schema of g.schemas)schemas.add(schema);
    }
    if(open)s.issues.add('open_postings_in_period');
    if(!sold)s.issues.add('no_sold_units');
    const costs=-s.commission-s.delivery-s.itemFees;
    const net=s.sales-costs;
    const p=policyFor(s.productId);
    const expensesKnown=p&&Number.isFinite(p.cogs)&&Number.isFinite(p.extra);
    // Do not credit returned goods back into stock without evidence of recoverability.
    const ownCosts=expensesKnown?Math.round((sold*p.cogs+shipped*p.extra)*100):null;
    const settlementReconciled=s.rows>0&&!s.issues.has('accrual_total_mismatch_or_missing_fields')&&!s.issues.has('conflicting_accrual_id')&&!s.issues.has('missing_accrual_id');
    const estimateAvailable=settlementReconciled&&sold>0&&ownCosts!==null&&!s.issues.has('missing_posting_link')&&!s.issues.has('multiple_sale_events_require_review');
    const profit=estimateAvailable?net-ownCosts:null;
    const fixed=sold?(-s.delivery-s.itemFees+s.acquiring)/sold:null;
    return {...Object.fromEntries(['productId','offerId','sku','name'].map(k=>[k,s[k]])),
      sales:rub(s.sales),commission:rub(-s.commission),delivery:rub(-s.delivery),itemFees:rub(-s.itemFees),acquiring:rub(-s.acquiring),costs:rub(costs),
      netAccrued:rub(net),postingHits:groups.length,accrualProductRows:s.rows,soldUnits:sold,returnedUnits:returned,shippedUnits:shipped,
      avgDeliveryAndOther:fixed===null?null:rub(fixed),avgAcquiring:sold?rub(-s.acquiring/sold):null,
      costRatio:s.sales>0?Math.round(costs/s.sales*10000)/100:null,
      nonCommissionCostRatio:s.sales>0?Math.round((-s.delivery-s.itemFees)/s.sales*10000)/100:null,
      settlementReconciled,unitEconomicsVerified:false,financeSource:'period_estimate',
      profitEstimate:rub(profit),profitPerSoldUnitEstimate:profit===null?null:rub(profit/sold),
      cogsPerUnit:p?.cogs??null,packagingPerShippedUnit:p?.extra??null,taxIncluded:false,
      ownCostsEstimate:rub(ownCosts),unassignedAmount:rub(s.unassigned),openPostings:open,deliverySchemas:[...schemas],
      limitations:[...s.issues,'period_is_not_closed_cohort','seller_wide_expenses_not_allocated','returned_stock_not_credited'],
      breakdown:[...s.breakdown].map(([name,amount])=>({name,amount:rub(amount)})).sort((a,b)=>b.amount-a.amount),
      postingSamples:groups.filter(g=>g.sold>0).slice(0,6).map(g=>({reference:g.reference,soldUnits:g.sold,returnedUnits:g.returned,
        sales:rub(g.sale),commission:rub(-g.commission),delivery:rub(-g.delivery),itemFees:rub(-g.itemFees),
        netAccrued:rub(g.sale+g.commission+g.delivery+g.itemFees),reconciled:g.reconciled}))};
  });
  return {items,reconciliation:{duplicateRowsSkipped:duplicates,unallocatedSellerAmount:rub(unallocated),unallocatedRows,unknownRows,
    allProductAmountsReconciled:items.filter(s=>s.accrualProductRows).every(s=>s.settlementReconciled)}};
}
module.exports={aggregateAccruals,cents};

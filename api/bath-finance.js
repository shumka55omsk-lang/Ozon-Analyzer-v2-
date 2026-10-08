const BASE='https://api-seller.ozon.ru';
const BATH_PRODUCT_IDS=['3768184568','3826876199','2808600941','3768033857'];

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}

async function ozonPost(path,body,kind='finance'){
  const clientId=process.env.OZON_CLIENT_ID;
  const apiKey=kind==='product'
    ? process.env.OZON_API_KEY
    : (process.env.OZON_FINANCE_API_KEY||process.env.OZON_API_KEY);
  if(!clientId||!apiKey){
    const e=new Error('Не настроены OZON_CLIENT_ID / OZON_API_KEY'); e.status=500; throw e;
  }
  const r=await fetch(BASE+path,{
    method:'POST',
    headers:{
      'Client-Id':clientId,
      'Api-Key':apiKey,
      'Content-Type':'application/json',
      'Accept':'application/json'
    },
    body:JSON.stringify(body||{})
  });
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch{data={raw:text.slice(0,1200)}}
  if(!r.ok){
    const e=new Error(data?.message||data?.error?.message||data?.error||('Ozon API HTTP '+r.status));
    e.status=r.status; e.details=data; throw e;
  }
  return data;
}

function money(v){
  if(v&&typeof v==='object') v=v.amount;
  const n=Number(v);
  return Number.isFinite(n)?n:0;
}
function r2(v){return Math.round((Number(v)||0)*100)/100}

async function bathProducts(){
  const data=await ozonPost('/v3/product/info/list',{product_id:BATH_PRODUCT_IDS},'product');
  const items=data?.items||data?.result?.items||[];
  return items.map(x=>({
    productId:String(x?.id??x?.product_id??''),
    offerId:String(x?.offer_id??''),
    sku:String(x?.sku??''),
    name:String(x?.name??'Сидушка для бани')
  })).filter(x=>x.sku);
}

async function accrualTypes(){
  const data=await ozonPost('/v1/finance/accrual/types',{});
  const map={};
  for(const t of data?.accrual_types||[]){
    map[String(t.id)]={name:t.name||'',description:t.description||t.name||''};
  }
  return map;
}

function sampleStats(values){
  const a=(values||[]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length) return {count:0,min:0,max:0,avg:0,median:0,in220to240:0,common:[]};
  const avg=a.reduce((x,y)=>x+y,0)/a.length;
  const median=a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
  const freq={};
  for(const x of a){const k=String(r2(x));freq[k]=(freq[k]||0)+1;}
  return {
    count:a.length,min:r2(a[0]),max:r2(a[a.length-1]),avg:r2(avg),median:r2(median),
    in220to240:a.filter(x=>x>=220&&x<=240).length,
    common:Object.entries(freq).map(([price,count])=>({price:Number(price),count}))
      .sort((x,y)=>y.count-x.count||x.price-y.price).slice(0,12)
  };
}

async function dayAccruals(date){
  const out=[];
  let lastId='';
  for(let page=0;page<100;page++){
    const data=await ozonPost('/v1/finance/accrual/by-day',{date,last_id:lastId});
    const part=Array.isArray(data?.accruals)?data.accruals:[];
    out.push(...part);
    const next=String(data?.last_id||'');
    if(!next||!part.length||next===lastId) break;
    lastId=next;
  }
  return out;
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});

  try{
    const products=await bathProducts();
    const typeMap=await accrualTypes();
    const skuSet=new Set(products.map(x=>x.sku));
    const stats={};

    for(const p of products){
      stats[p.sku]={
        ...p,
        sales:0,
        commission:0,
        delivery:0,
        itemFees:0,
        acquiring:0,
        costs:0,
        postingHits:0,
        feeBreakdown:{},
        sellerPriceSamples:[],
        salePriceSamples:[],
        saleAmountSamples:[],
        coinvestmentSamples:[],
        bonusSamples:[],
        quantities:[],
        commissionFieldNames:new Set(),
        productFieldNames:new Set()
      };
    }

    const today=new Date();
    const days=14;
    let accrualRows=0;

    for(let offset=days-1;offset>=0;offset--){
      const d=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()-offset));
      const date=d.toISOString().slice(0,10);
      const accruals=await dayAccruals(date);
      accrualRows+=accruals.length;

      for(const acc of accruals){
        const posting=acc?.posting;
        if(posting&&Array.isArray(posting.products)){
          for(const prod of posting.products){
            const sku=String(prod?.sku??'');
            if(!skuSet.has(sku)) continue;
            const s=stats[sku];
            const comm=prod?.commission||{};
            const delivery=prod?.delivery||{};
            const sale=money(comm?.seller_price);
            const commission=money(comm?.sale_commission);
            for(const k of Object.keys(comm||{})) s.commissionFieldNames.add(String(k));
            for(const k of Object.keys(prod||{})) s.productFieldNames.add(String(k));
            if(sale>0) s.sellerPriceSamples.push(sale);
            const salePrice=money(comm?.sale_price);
            const saleAmount=money(comm?.sale_amount);
            const coinvestment=money(comm?.coinvestment);
            const bonus=money(comm?.bonus);
            const qty=Math.max(1,Number(prod?.quantity)||1);
            if(salePrice>0) s.salePriceSamples.push(salePrice);
            if(saleAmount>0) s.saleAmountSamples.push(saleAmount/qty);
            if(coinvestment!==0) s.coinvestmentSamples.push(coinvestment/qty);
            if(bonus!==0) s.bonusSamples.push(bonus/qty);
            s.quantities.push(qty);
            const deliveryTotal=money(delivery?.total_accrued);

            if(sale>0) s.sales+=sale;
            if(commission<0) s.commission+=-commission;
            if(deliveryTotal<0) s.delivery+=-deliveryTotal;
            s.postingHits+=1;

            for(const srv of delivery?.services||[]){
              const val=money(srv?.accrued);
              if(val>=0) continue;
              const typeId=String(srv?.type_id??'');
              const label=typeMap[typeId]?.description||typeMap[typeId]?.name||('Тип '+typeId);
              s.feeBreakdown[label]=(s.feeBreakdown[label]||0)+(-val);
            }
          }
        }

        for(const grp of acc?.item_fees?.fees||[]){
          const sku=String(grp?.sku??'');
          if(!skuSet.has(sku)) continue;
          const s=stats[sku];
          for(const fee of grp?.fees||[]){
            const val=money(fee?.accrued);
            if(val>=0) continue;
            const cost=-val;
            s.itemFees+=cost;
            const typeId=String(fee?.type_id??'');
            const label=typeMap[typeId]?.description||typeMap[typeId]?.name||('Тип '+typeId);
            if(/эквайринг|acquir/i.test(label)) s.acquiring+=cost;
            s.feeBreakdown[label]=(s.feeBreakdown[label]||0)+cost;
          }
        }
      }
    }

    const items=Object.values(stats).map(s=>{
      s.costs=s.commission+s.delivery+s.itemFees;
      const ratio=s.sales>0?s.costs/s.sales:0;
      const nonCommission=s.delivery+s.itemFees;
      const nonCommissionRatio=s.sales>0?nonCommission/s.sales:0;
      const count=Math.max(1,s.postingHits);
      const avgDeliveryAndOther=(s.delivery+Math.max(0,s.itemFees-s.acquiring))/count;
      const avgAcquiring=s.acquiring/count;
      const breakdown=Object.entries(s.feeBreakdown)
        .map(([name,amount])=>({name,amount:r2(amount)}))
        .sort((a,b)=>b.amount-a.amount)
        .slice(0,12);

      const sellerStats=sampleStats(s.sellerPriceSamples);
      const salePriceStats=sampleStats(s.salePriceSamples);
      const saleAmountStats=sampleStats(s.saleAmountSamples);
      const coinvestmentStats=sampleStats(s.coinvestmentSamples);
      const bonusStats=sampleStats(s.bonusSamples);

      return {
        productId:s.productId,
        offerId:s.offerId,
        sku:s.sku,
        name:s.name,
        sales:r2(s.sales),
        commission:r2(s.commission),
        delivery:r2(s.delivery),
        itemFees:r2(s.itemFees),
        acquiring:r2(s.acquiring),
        costs:r2(s.costs),
        avgDeliveryAndOther:r2(avgDeliveryAndOther),
        avgAcquiring:r2(avgAcquiring),
        costRatio:r2(ratio*100),
        nonCommissionCostRatio:r2(nonCommissionRatio*100),
        postingHits:s.postingHits,
        realizedPriceFields:{
          seller_price:sellerStats,
          sale_price:salePriceStats,
          sale_amount_per_unit:saleAmountStats,
          coinvestment_per_unit:coinvestmentStats,
          bonus_per_unit:bonusStats
        },
        financeFields:{
          commission:[...s.commissionFieldNames].sort(),
          product:[...s.productFieldNames].sort()
        },
        breakdown
      };
    });

    return send(res,200,{
      ok:true,
      periodDays:days,
      accrualRows,
      items,
      note:'Фактические удержания по finance/accrual/by-day. realizedPriceFields сравнивает seller_price, sale_price, sale_amount, coinvestment и bonus из реальных начислений. Расходы уровня продавца без привязки к SKU не распределяются.'
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,
      error:e?.message||'Не удалось получить начисления Ozon',
      hint:(status===401||status===403)
        ?'Текущий ключ не имеет доступа к финансовым начислениям. Создайте отдельный ключ с правом чтения финансов и замените OZON_API_KEY в Vercel.'
        :'',
      details:e?.details||undefined
    });
  }
};

const {aggregateAccruals}=require('../lib/bath-finance-ledger');
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
    if(!next) return out;
    if(!part.length||next===lastId) throw new Error('Неполная выгрузка начислений: курсор не продвигается');
    lastId=next;
  }
  throw new Error('Неполная выгрузка начислений: превышен лимит страниц');
}


async function fbsCustomerPrices(products){
  const skuSet=new Set(products.map(x=>String(x.sku)));
  const rows={};
  for(const p of products) rows[String(p.sku)]={
    ...p,
    customerPrices:[],
    customerPrices48h:[],
    sellerPrices:[],
    sellerPrices48h:[],
    units:0,
    units48h:0
  };

  const now=new Date();
  const since=new Date(now.getTime()-7*24*60*60*1000).toISOString();
  const to=now.toISOString();
  let cursor='';
  const seenPostings=new Set();
  let complete=false;

  try{
    for(let page=0;page<20;page++){
      const body={
        filter:{since,to},
        limit:100,
        cursor,
        sort_dir:'DESC',
        with:{
          analytics_data:false,
          barcodes:false,
          financial_data:true,
          legal_info:false,
          translit:false
        }
      };
      const data=await ozonPost('/v4/posting/fbs/list',body,'finance');
      const postings=Array.isArray(data?.postings)?data.postings:[];
      for(const posting of postings){
        if(posting.status!=='delivered') continue;
        const postingId=String(posting.posting_number||'');
        if(!postingId) throw new Error('Отправление без идентификатора');
        if(seenPostings.has(postingId)) continue;
        seenPostings.add(postingId);
        const postingTime=Date.parse(
          posting?.in_process_at||
          posting?.order_date||
          posting?.created_at||
          ''
        );
        const is48h=Number.isFinite(postingTime)&&postingTime>=(Date.now()-48*60*60*1000);
        const fp=Array.isArray(posting?.financial_data?.products)?posting.financial_data.products:[];
        for(const x of fp){
          const sku=String(x?.product_id??x?.sku??'');
          if(!skuSet.has(sku)) continue;
          const r=rows[sku];
          const qty=Number(x?.quantity);
          if(!Number.isInteger(qty)||qty<=0) throw new Error('Не указано количество товара в отправлении');
          const customer=money(x?.customer_price);
          const seller=money(x?.price??x?.seller_price);
          if(customer>0){
            for(let i=0;i<qty;i++) r.customerPrices.push(customer);
            r.units+=qty;
            if(is48h){
              for(let i=0;i<qty;i++) r.customerPrices48h.push(customer);
              r.units48h+=qty;
            }
          }
          if(seller>0){
            for(let i=0;i<qty;i++) r.sellerPrices.push(seller);
            if(is48h){
              for(let i=0;i<qty;i++) r.sellerPrices48h.push(seller);
            }
          }
        }
      }

      const next=String(data?.cursor||'');
      const hasNext=!!data?.has_next;
      if(!hasNext){complete=true;break;}
      if(!next||next===cursor||!postings.length) throw new Error('Неполная выгрузка отправлений');
      cursor=next;
    }

    if(!complete) throw new Error('Превышен лимит страниц отправлений');
    return {
      ok:true,
      scope:'delivered_fbs_only',
      finalBuyerPriceVerified:false,
      periodDays:7,
      items:Object.values(rows).map(r=>({
        productId:r.productId,
        offerId:r.offerId,
        sku:r.sku,
        name:r.name,
        units:r.units,
        units48h:r.units48h,
        customerPrice:sampleStats(r.customerPrices),
        customerPrice48h:sampleStats(r.customerPrices48h),
        sellerPrice:sampleStats(r.sellerPrices),
        sellerPrice48h:sampleStats(r.sellerPrices48h)
      }))
    };
  }catch(e){
    return {
      ok:false,
      periodDays:7,
      error:e?.message||String(e),
      status:Number(e?.status)||0,
      items:[]
    };
  }
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});

  try{
    const products=await bathProducts();
    const [typeMap,fbsBuyerPrices]=await Promise.all([
      accrualTypes(),
      fbsCustomerPrices(products)
    ]);
    const today=new Date();
    const q=req.query||{};
    const datePattern=/^\d{4}-\d{2}-\d{2}$/;
    const parseDay=value=>{
      if(typeof value!=='string'||!datePattern.test(value))return null;
      const t=Date.parse(value+'T00:00:00Z');
      return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===value?t:null;
    };
    const hasRange=q.dateFrom!==undefined||q.dateTo!==undefined;
    if(hasRange&&(!parseDay(q.dateFrom)||!parseDay(q.dateTo)))
      return send(res,400,{ok:false,error:'Укажите корректные dateFrom и dateTo в формате YYYY-MM-DD'});
    const yesterday=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()-1);
    const end=hasRange?parseDay(q.dateTo):yesterday;
    const start=hasRange?parseDay(q.dateFrom):end-13*86400000;
    const days=Math.round((end-start)/86400000)+1;
    if(days<1||days>31||end>yesterday)
      return send(res,400,{ok:false,error:'Период: от 1 до 31 дня, без будущих и незавершённых дат'});
    const accruals=[];
    // Completed UTC days only; today's incomplete accruals are not a full day's economics.
    const dateFrom=new Date(start).toISOString().slice(0,10);
    const dateTo=new Date(end).toISOString().slice(0,10);
    for(let time=start;time<=end;time+=86400000){
      const date=new Date(time).toISOString().slice(0,10);
      accruals.push(...await dayAccruals(date));
    }
    const ledger=aggregateAccruals(products,accruals,typeMap);
    return send(res,200,{
      ok:true,calculationVersion:3,periodDays:days,dateFrom,dateTo,periodTimezone:'UTC',
      fetchedAt:new Date().toISOString(),accrualRows:accruals.length,fbsBuyerPrices,...ledger,
      note:'Суммы sale_amount, sale_commission, delivery.total_accrued и услуги учитываются со знаком и сверяются с total_amount. Бонусы и соинвест уже входят в sale_amount. Прибыль — оценка по начислениям периода до налога и нераспределённых расходов продавца; это не закрытая экономика отправлений. Возврат себестоимости в остатки не предполагается. Автоизменение цен запрещено.'
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

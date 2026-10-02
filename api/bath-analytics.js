const BASE='https://api-seller.ozon.ru';
const BATH_IDS=['3768184568','3826876199','2808600941','3768033857'];

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
async function post(path,body,kind='admin'){
  const clientId=process.env.OZON_CLIENT_ID;
  const apiKey=kind==='product'
    ? process.env.OZON_API_KEY
    : (process.env.OZON_FINANCE_API_KEY||process.env.OZON_API_KEY);
  if(!clientId||!apiKey){const e=new Error('Не настроен API-ключ Ozon');e.status=500;throw e;}
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
    e.status=r.status;e.details=data;throw e;
  }
  return data;
}
function dstr(d){return d.toISOString().slice(0,10)}
function number(v){const n=Number(v);return Number.isFinite(n)?n:0}

async function bathSkuMap(){
  const data=await post('/v3/product/info/list',{product_id:BATH_IDS},'product');
  const items=data?.items||data?.result?.items||[];
  const bySku={};
  for(const x of items){
    const sku=String(x?.sku??'');
    if(!sku) continue;
    bySku[sku]={
      productId:String(x?.id??x?.product_id??''),
      offerId:String(x?.offer_id??''),
      name:String(x?.name??'Сидушка')
    };
  }
  return bySku;
}

function parseRows(data,metricNames,skuMap){
  const rows=data?.result?.data||[];
  const out=[];
  for(const row of rows){
    const dims=row?.dimensions||row?.dimension||[];
    let sku='',day='';
    for(const dim of dims){
      const id=String(dim?.id??dim?.value??'');
      const name=String(dim?.name??'');
      if(/^\d{6,}$/.test(id)&&skuMap[id]) sku=id;
      if(/^\d{4}-\d{2}-\d{2}$/.test(id)) day=id;
      if(/^\d{4}-\d{2}-\d{2}$/.test(name)) day=name;
    }
    if(!sku||!skuMap[sku]) continue;
    const values=Array.isArray(row?.metrics)?row.metrics:[];
    const metrics={};
    metricNames.forEach((m,i)=>metrics[m]=number(values[i]));
    out.push({...skuMap[sku],sku,day,metrics});
  }
  return out;
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const skuMap=await bathSkuMap();
    const today=new Date();
    const yesterday=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()-1));
    const from=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()-8));
    const base={
      date_from:dstr(from),
      date_to:dstr(yesterday),
      dimension:['sku','day'],
      filters:[],
      sort:[],
      limit:1000,
      offset:0
    };

    const premiumMetrics=[
      'ordered_units','revenue','hits_view_search','hits_view_pdp',
      'hits_tocart_search','session_view_search','conv_tocart_search',
      'returns','cancellations','position_category'
    ];
    let metrics=premiumMetrics;
    let analytics;
    let limited=false;
    let warning='';
    try{
      analytics=await post('/v1/analytics/data',{...base,metrics});
    }catch(e){
      metrics=['ordered_units','revenue'];
      limited=true;
      warning='Расширенные метрики Ozon недоступны для текущего ключа/подписки; используются заказы и выручка.';
      analytics=await post('/v1/analytics/data',{...base,metrics});
    }

    const rows=parseRows(analytics,metrics,skuMap);
    return send(res,200,{
      ok:true,
      limited,
      warning,
      dateFrom:base.date_from,
      dateTo:base.date_to,
      metrics,
      rows
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,error:e?.message||'Не удалось получить аналитику Ozon',
      details:e?.details||undefined
    });
  }
};

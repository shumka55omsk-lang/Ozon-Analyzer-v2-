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
  if(!r.ok){const e=new Error(data?.message||data?.error?.message||data?.error||('Ozon API HTTP '+r.status));e.status=r.status;e.details=data;throw e;}
  return data;
}
function dstr(d){return d.toISOString().slice(0,10)}

async function bathProducts(){
  const data=await post('/v3/product/info/list',{product_id:BATH_IDS},'product');
  return (data?.items||data?.result?.items||[]).map(x=>({
    productId:String(x?.id??x?.product_id??''),
    offerId:String(x?.offer_id??''),
    sku:String(x?.sku??''),
    name:String(x?.name??'Сидушка')
  })).filter(x=>x.sku);
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const products=await bathProducts();
    const skuToProduct=Object.fromEntries(products.map(x=>[String(x.sku),x]));
    const now=new Date();
    const to=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
    const from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-7));
    const body={
      date_from:dstr(from),
      date_to:dstr(to),
      page:0,
      page_size:1000,
      skus:products.map(x=>String(x.sku)),
      sort_by:'BY_SEARCHES',
      sort_dir:'DESCENDING'
    };
    const data=await post('/v1/analytics/product-queries',body);
    const items=Array.isArray(data?.items)?data.items:[];
    const mapped=items.map(x=>({
      ...skuToProduct[String(x?.sku??'')],
      sku:String(x?.sku??''),
      category:x?.category||'',
      searches:Number(x?.unique_search_users)||0,
      views:Number(x?.unique_view_users)||0,
      position:Number(x?.position)||0,
      conversion:Number(x?.view_conversion)||0,
      gmv:Number(x?.gmv)||0
    }));
    return send(res,200,{
      ok:true,
      dateFrom:body.date_from,
      dateTo:body.date_to,
      items:mapped,
      rawCount:items.length
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,
      error:e?.message||'Не удалось получить поисковую аналитику Ozon',
      hint:(status===403)?'Для поисковой аналитики Ozon может требоваться Premium/Premium Plus.':'',
      details:e?.details||undefined
    });
  }
};

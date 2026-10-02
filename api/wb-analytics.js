const ANALYTICS='https://seller-analytics-api.wildberries.ru';
const PRICE='https://discounts-prices-api.wildberries.ru';

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function token(){
  const t=process.env.WB_READ_API_TOKEN;
  if(!t){const e=new Error('Не настроен WB_READ_API_TOKEN');e.status=500;throw e;}
  return t;
}
async function wb(url,opts={}){
  const r=await fetch(url,{
    ...opts,
    headers:{
      'Authorization':token(),
      'Accept':'application/json',
      ...(opts.body?{'Content-Type':'application/json'}:{}),
      ...(opts.headers||{})
    }
  });
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):{}}catch{data={raw:text.slice(0,1200)}}
  if(!r.ok){
    const e=new Error(data?.detail||data?.message||data?.errorText||('WB API HTTP '+r.status));
    e.status=r.status;e.details=data;throw e;
  }
  return data;
}
function d(d){return d.toISOString().slice(0,10)}

function isBathCard(c){
  const s=(String(c?.title||'')+' '+String(c?.vendorCode||'')).toLowerCase();
  return (s.includes('сидуш')||s.includes('коврик')) && (s.includes('бан')||s.includes('саун'));
}
async function loadBathIds(){
  const ids=[];
  let cursor={limit:100};
  for(let i=0;i<50;i++){
    const data=await wb('https://content-api.wildberries.ru/content/v2/get/cards/list',{
      method:'POST',
      body:JSON.stringify({settings:{cursor,filter:{withPhoto:-1}}})
    });
    const cards=Array.isArray(data?.cards)?data.cards:[];
    for(const c of cards){
      if(isBathCard(c)&&Number(c?.nmID)) ids.push(Number(c.nmID));
    }
    const cur=data?.cursor||{};
    if(cards.length<100||Number(cur.total||0)<100||!cur.updatedAt||!cur.nmID) break;
    cursor={limit:100,updatedAt:cur.updatedAt,nmID:cur.nmID};
  }
  return [...new Set(ids)].slice(0,20);
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const nmIds=await loadBathIds();
    if(!nmIds.length) return send(res,200,{ok:true,readOnly:true,items:[],warning:'Сидушки на WB пока не найдены автоматически.'});

    const now=new Date();
    const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
    const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-7));
    const data=await wb(ANALYTICS+'/api/analytics/v3/sales-funnel/products/history',{
      method:'POST',
      body:JSON.stringify({
        selectedPeriod:{start:d(start),end:d(end)},
        nmIds,
        skipDeletedNm:true,
        aggregationLevel:'day'
      })
    });

    const arr=Array.isArray(data)?data:(Array.isArray(data?.data)?data.data:[]);
    const items=arr.map(x=>({
      nmID:String(x?.product?.nmId||''),
      title:String(x?.product?.title||''),
      vendorCode:String(x?.product?.vendorCode||''),
      subjectName:String(x?.product?.subjectName||''),
      currency:String(x?.currency||'RUB'),
      history:(Array.isArray(x?.history)?x.history:[]).map(h=>({
        date:String(h?.date||''),
        opens:Number(h?.openCount||0),
        carts:Number(h?.cartCount||0),
        orders:Number(h?.orderCount||0),
        orderSum:Number(h?.orderSum||0),
        buyouts:Number(h?.buyoutCount||0),
        buyoutSum:Number(h?.buyoutSum||0),
        buyoutPercent:Number(h?.buyoutPercent||0),
        addToCartConversion:Number(h?.addToCartConversion||0),
        cartToOrderConversion:Number(h?.cartToOrderConversion||0),
        wishlist:Number(h?.addToWishlistCount||0)
      }))
    }));

    return send(res,200,{
      ok:true,
      readOnly:true,
      period:{start:d(start),end:d(end)},
      items
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,
      readOnly:true,
      error:e?.message||'Не удалось получить аналитику Wildberries',
      hint:(status===401||status===403)
        ?'Проверьте WB_READ_API_TOKEN: нужна категория «Аналитика», токен только на чтение.'
        :'',
      details:e?.details||undefined
    });
  }
};
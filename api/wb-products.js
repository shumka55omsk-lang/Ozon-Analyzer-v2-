const PRICE_BASE='https://discounts-prices-api.wildberries.ru';
const CONTENT_BASE='https://content-api.wildberries.ru';

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
  try{data=text?JSON.parse(text):{}}catch{data={raw:text.slice(0,1500)}}
  if(!r.ok){
    const e=new Error(data?.detail||data?.message||data?.errorText||('WB API HTTP '+r.status));
    e.status=r.status;e.details=data;throw e;
  }
  return data;
}
function isBath(title,vendor){
  const s=(String(title||'')+' '+String(vendor||'')).toLowerCase();
  return (s.includes('сидуш')||s.includes('коврик')) && (s.includes('бан')||s.includes('саун'));
}

async function loadPricesByIds(nmIds){
  if(!nmIds.length) return [];
  const data=await wb(PRICE_BASE+'/api/v2/list/goods/filter',{
    method:'POST',
    body:JSON.stringify({nmList:nmIds.map(Number)})
  });
  return data?.data?.listGoods||data?.listGoods||[];
}
async function loadCards(){
  const all=[];
  let cursor={limit:100};
  for(let i=0;i<100;i++){
    const data=await wb(CONTENT_BASE+'/content/v2/get/cards/list',{
      method:'POST',
      body:JSON.stringify({
        settings:{
          cursor,
          filter:{withPhoto:-1}
        }
      })
    });
    const cards=Array.isArray(data?.cards)?data.cards:[];
    all.push(...cards);
    const c=data?.cursor||{};
    if(cards.length<100||Number(c.total||0)<100) break;
    cursor={limit:100,updatedAt:c.updatedAt,nmID:c.nmID};
    if(!cursor.updatedAt||!cursor.nmID) break;
  }
  return all;
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const cards=await loadCards();
    const bathCards=cards.filter(c=>isBath(c.title,c.vendorCode)).slice(0,50);
    const nmIds=bathCards.map(c=>Number(c.nmID)).filter(Boolean);
    let prices=[];
    let priceWarning='';
    try{
      prices=await loadPricesByIds(nmIds);
    }catch(e){
      if(Number(e?.status)===429){
        priceWarning='WB временно ограничил запрос цен по rate limit. Карточки и аналитика доступны; цены обновятся при следующем разрешённом запросе.';
      }else throw e;
    }
    const priceMap=new Map(prices.map(g=>[String(g.nmID),g]));
    const bathSeats=bathCards.map(c=>{
      const g=priceMap.get(String(c.nmID))||{};
      const sizes=Array.isArray(g.sizes)?g.sizes:[];
      const first=sizes[0]||{};
      const photos=Array.isArray(c.photos)?c.photos:[];
      const p0=photos[0]||{};
      return {
        nmID:String(c.nmID||''),
        vendorCode:String(g.vendorCode||c.vendorCode||''),
        title:String(c.title||''),
        brand:String(c.brand||''),
        subjectName:String(c.subjectName||''),
        basePrice:Number(first.price||0),
        discountedPrice:Number(first.discountedPrice||0),
        clubPrice:Number(first.clubDiscountedPrice||0),
        discount:Number(g.discount||0),
        clubDiscount:Number(g.clubDiscount||0),
        currency:String(g.currencyIsoCode4217||'RUB'),
        editableSizePrice:!!g.editableSizePrice,
        badTurnover:!!g.isBadTurnover,
        image:p0.big||p0.square||p0['c516x688']||'',
        isBathSeat:true,
        priceLoaded:!!priceMap.get(String(c.nmID))
      };
    });
    return send(res,200,{
      ok:true,
      readOnly:true,
      total:cards.length,
      bathSeatTotal:bathSeats.length,
      products:bathSeats,
      warning:priceWarning
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,
      readOnly:true,
      error:e?.message||'Не удалось получить товары Wildberries',
      hint:(status===401||status===403)
        ?'Проверьте WB_READ_API_TOKEN: нужны категории «Контент» и «Цены и скидки», токен только на чтение.'
        :'',
      details:e?.details||undefined
    });
  }
};
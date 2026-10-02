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

async function loadPrices(){
  const all=[];
  const limit=1000;
  for(let offset=0;offset<100000;offset+=limit){
    const data=await wb(PRICE_BASE+'/api/v2/list/goods/filter?limit='+limit+'&offset='+offset,{method:'GET'});
    const part=data?.data?.listGoods||data?.listGoods||[];
    all.push(...part);
    if(part.length<limit) break;
  }
  return all;
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
    const [prices,cards]=await Promise.all([loadPrices(),loadCards()]);
    const cardMap=new Map(cards.map(c=>[String(c.nmID),c]));
    const products=prices.map(g=>{
      const c=cardMap.get(String(g.nmID))||{};
      const sizes=Array.isArray(g.sizes)?g.sizes:[];
      const first=sizes[0]||{};
      const basePrice=Number(first.price||0);
      const discountedPrice=Number(first.discountedPrice||0);
      const clubPrice=Number(first.clubDiscountedPrice||0);
      const photos=Array.isArray(c.photos)?c.photos:[];
      const p0=photos[0]||{};
      return {
        nmID:String(g.nmID||''),
        vendorCode:String(g.vendorCode||c.vendorCode||''),
        title:String(c.title||''),
        brand:String(c.brand||''),
        subjectName:String(c.subjectName||''),
        basePrice,
        discountedPrice,
        clubPrice,
        discount:Number(g.discount||0),
        clubDiscount:Number(g.clubDiscount||0),
        currency:String(g.currencyIsoCode4217||'RUB'),
        editableSizePrice:!!g.editableSizePrice,
        badTurnover:!!g.isBadTurnover,
        image:p0.big||p0.square||p0['c516x688']||'',
        isBathSeat:isBath(c.title,g.vendorCode||c.vendorCode)
      };
    });
    const bathSeats=products.filter(x=>x.isBathSeat);
    return send(res,200,{
      ok:true,
      readOnly:true,
      total:products.length,
      bathSeatTotal:bathSeats.length,
      products:bathSeats,
      allProductsPreview:products.slice(0,20)
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
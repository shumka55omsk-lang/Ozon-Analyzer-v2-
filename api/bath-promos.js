const BASE='https://api-seller.ozon.ru';
const BATH_IDS=new Set(['3768184568','3826876199','2808600941','3768033857']);

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}

async function request(path,{method='POST',body}={}){
  const clientId=process.env.OZON_CLIENT_ID;
  const apiKey=process.env.OZON_FINANCE_API_KEY||process.env.OZON_API_KEY;
  if(!clientId||!apiKey){const e=new Error('Не настроен ключ товаров Ozon');e.status=500;throw e;}
  const r=await fetch(BASE+path,{
    method,
    headers:{'Client-Id':clientId,'Api-Key':apiKey,'Content-Type':'application/json','Accept':'application/json'},
    body:method==='GET'?undefined:JSON.stringify(body||{})
  });
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch{data={raw:text.slice(0,1000)}}
  if(!r.ok){const e=new Error(data?.message||data?.error?.message||data?.error||('Ozon API HTTP '+r.status));e.status=r.status;e.details=data;throw e;}
  return data;
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const data=await request('/v1/actions',{method:'GET'});
    const all=Array.isArray(data?.result)?data.result:[];
    const now=Date.now();
    const active=all.filter(a=>{
      const start=a?.date_start?Date.parse(a.date_start):0;
      const end=a?.date_end?Date.parse(a.date_end):Infinity;
      return (!start||start<=now) && (!end||end>=now);
    }).slice(0,30);

    const found=[];
    for(const action of active){
      let lastId='';
      for(let page=0;page<5;page++){
        const resp=await request('/v1/actions/products',{
          body:{action_id:Number(action.id),limit:1000,last_id:lastId}
        });
        const result=resp?.result||{};
        const products=Array.isArray(result?.products)?result.products:[];
        for(const p of products){
          const id=String(p?.id??p?.product_id??'');
          if(BATH_IDS.has(id)){
            found.push({
              actionId:action.id,
              title:action.title||'Акция Ozon',
              actionType:action.action_type||'',
              dateStart:action.date_start||'',
              dateEnd:action.date_end||'',
              productId:id,
              price:Number(p?.price)||0,
              actionPrice:Number(p?.action_price)||0,
              maxActionPrice:Number(p?.max_action_price)||0,
              addMode:p?.add_mode||'',
              stock:Number(p?.stock)||0
            });
          }
        }
        const next=String(result?.last_id||'');
        if(!next||!products.length||next===lastId) break;
        lastId=next;
      }
    }

    return send(res,200,{ok:true,activeActionsChecked:active.length,found});
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{ok:false,error:e?.message||'Не удалось проверить акции',details:e?.details||undefined});
  }
};

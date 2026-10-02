const BASE = 'https://api-seller.ozon.ru';
const BATH_NAMES = ['сидушка для бани','сидушка для сауны'];
const BATH_OFFERS = new Set(['1403261','20032026','30092025','140326']);

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}

async function ozonPost(path,body){
  const clientId=process.env.OZON_CLIENT_ID;
  const apiKey=process.env.OZON_API_KEY;
  if(!clientId||!apiKey){
    const e=new Error('Не настроены OZON_CLIENT_ID / OZON_API_KEY');
    e.status=500; throw e;
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

function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function isBathItem(item){
  const name=String(item?.name||item?.product_name||'').toLowerCase();
  const offer=String(item?.offer_id||item?.offerId||'');
  return BATH_OFFERS.has(offer) || BATH_NAMES.some(x=>name.includes(x));
}
function add(map,key,delta){
  map[key]=(map[key]||0)+n(delta);
}
function serviceName(s){
  return String(s?.name||s?.service_name||s?.type||s?.service_type||s?.operation_type||'Прочая услуга');
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const to=new Date();
    const from=new Date(to.getTime()-30*24*60*60*1000);
    const fromIso=from.toISOString();
    const toIso=to.toISOString();

    const all=[];
    let page=1;
    for(let i=0;i<20;i++){
      let data;
      try{
        data=await ozonPost('/v3/finance/transaction/list',{
        filter:{
          date:{from:fromIso,to:toIso},
          operation_type:[],
          posting_number:'',
          transaction_type:'all'
        },
        page,
        page_size:1000
      });
      }catch(firstErr){
        if(Number(firstErr?.status)!==404) throw firstErr;
        data=await ozonPost('/v3/finance/transaction/list/',{
          filter:{
            date:{from:fromIso,to:toIso},
            operation_type:[],
            posting_number:'',
            transaction_type:'all'
          },
          page,
          page_size:1000
        });
      }
      const result=data?.result||{};
      const ops=Array.isArray(result?.operations)?result.operations:[];
      all.push(...ops);
      const pageCount=Number(result?.page_count||1);
      if(page>=pageCount||!ops.length) break;
      page++;
    }

    const matched=[];
    for(const op of all){
      const items=Array.isArray(op?.items)?op.items:[];
      const bathItems=items.filter(isBathItem);
      if(!bathItems.length) continue;
      matched.push({...op,items:bathItems});
    }

    const byOffer={};
    for(const op of matched){
      for(const item of op.items){
        const offer=String(item?.offer_id||item?.offerId||item?.sku||item?.name||'unknown');
        if(!byOffer[offer]) byOffer[offer]={
          offerId:String(item?.offer_id||item?.offerId||''),
          sku:String(item?.sku||''),
          name:String(item?.name||item?.product_name||'Сидушка'),
          orders:0,
          amount:0,
          commission:0,
          servicesTotal:0,
          services:{}
        };
        const rec=byOffer[offer];
        rec.orders+=1;
        rec.amount+=n(op?.amount);
        rec.commission+=Math.abs(n(op?.commission_amount));
        const services=Array.isArray(op?.services)?op.services:[];
        for(const s of services){
          const val=Math.abs(n(s?.price??s?.amount??s?.total));
          rec.servicesTotal+=val;
          add(rec.services,serviceName(s),val);
        }
      }
    }

    const items=Object.values(byOffer).map(x=>{
      const divisor=Math.max(1,x.orders);
      const servicesPerSale={};
      for(const [k,v] of Object.entries(x.services)) servicesPerSale[k]=Math.round(v/divisor*100)/100;
      return {
        ...x,
        amount:Math.round(x.amount*100)/100,
        commission:Math.round(x.commission*100)/100,
        servicesTotal:Math.round(x.servicesTotal*100)/100,
        avgCommissionPerSale:Math.round(x.commission/divisor*100)/100,
        avgServicesPerSale:Math.round(x.servicesTotal/divisor*100)/100,
        servicesPerSale
      };
    });

    return send(res,200,{
      ok:true,
      period:{from:fromIso,to:toIso,days:30},
      operationsScanned:all.length,
      matchedOperations:matched.length,
      items
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,
      error:e?.message||'Не удалось получить финансовые операции',
      hint:(status===401||status===403)?'Текущий API-ключ не имеет доступа к финансам. Нужно добавить роль Finance read-only / Финансы: чтение.':'',
      details:e?.details||undefined
    });
  }
};

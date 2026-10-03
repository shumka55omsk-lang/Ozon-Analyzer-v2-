const BASE='https://api.partner.market.yandex.ru';

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function token(){
  const t=process.env.YANDEX_MARKET_API_KEY;
  if(!t){const e=new Error('Не настроен YANDEX_MARKET_API_KEY');e.status=500;throw e;}
  return t;
}
async function ym(path,{method='GET',body}={}){
  const r=await fetch(BASE+path,{
    method,
    headers:{
      'Api-Key':token(),
      'Accept':'application/json',
      ...(body!==undefined?{'Content-Type':'application/json'}:{})
    },
    ...(body!==undefined?{body:JSON.stringify(body)}:{})
  });
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):{}}catch{data={raw:text.slice(0,1500)}}
  if(!r.ok||data?.status==='ERROR'){
    const msg=(Array.isArray(data?.errors)&&data.errors.map(x=>x?.message||x?.code).filter(Boolean).join('; '))
      ||data?.message||data?.error||('Yandex Market API HTTP '+r.status);
    const e=new Error(msg);e.status=r.status;e.details=data;throw e;
  }
  return data;
}
function isBath(name,offerId,vendorCode){
  const s=(String(name||'')+' '+String(offerId||'')+' '+String(vendorCode||'')).toLowerCase();
  return (s.includes('сидуш')||s.includes('коврик'))&&(s.includes('бан')||s.includes('саун'));
}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function dstr(d){return d.toISOString().slice(0,10)}

async function getCampaigns(){
  const out=[],seen=new Set();
  let pageToken='';
  for(let i=0;i<20;i++){
    const q=new URLSearchParams({limit:'100'});
    if(pageToken) q.set('pageToken',pageToken);
    const data=await ym('/v2/campaigns?'+q.toString());
    const part=Array.isArray(data?.campaigns)?data.campaigns:[];
    for(const c of part){
      const k=String(c?.id||'');
      if(k&&!seen.has(k)){seen.add(k);out.push(c);}
    }
    pageToken=String(data?.paging?.nextPageToken||'');
    if(!pageToken||!part.length) break;
  }
  return out;
}

async function getBathCatalog(businessId){
  const out=[],seen=new Set();
  let pageToken='';
  for(let i=0;i<50;i++){
    const q=new URLSearchParams({limit:'100',language:'RU'});
    if(pageToken) q.set('pageToken',pageToken);
    const data=await ym('/v2/businesses/'+businessId+'/offer-mappings?'+q.toString(),{
      method:'POST',body:{archived:false}
    });
    const part=data?.result?.offerMappings||[];
    for(const m of part){
      const o=m?.offer||{};
      const mp=m?.mapping||{};
      const name=o?.name||mp?.marketSkuName||'';
      if(isBath(name,o?.offerId,o?.vendorCode)){
        const k=String(o?.offerId||'');
        if(k&&!seen.has(k)){
          seen.add(k);
          out.push({
            offerId:k,
            name:String(name||'Сидушка для бани'),
            vendorCode:String(o?.vendorCode||''),
            marketSku:mp?.marketSku||null,
            categoryName:String(mp?.marketCategoryName||''),
            pictures:Array.isArray(o?.pictures)?o.pictures:[]
          });
        }
      }
    }
    pageToken=String(data?.result?.paging?.nextPageToken||'');
    if(!pageToken||!part.length) break;
  }
  return out;
}

async function getDefaultPrices(businessId,offerIds){
  if(!offerIds.length) return {};
  const data=await ym('/v2/businesses/'+businessId+'/offer-prices',{method:'POST',body:{offerIds}});
  const offers=data?.result?.offers||[];
  return Object.fromEntries(offers.map(x=>[String(x.offerId),{
    value:n(x?.price?.value),
    discountBase:n(x?.price?.discountBase),
    currency:String(x?.price?.currencyId||'RUR'),
    updatedAt:String(x?.updatedAt||'')
  }]));
}

async function getCampaignPrices(campaignId,offerIds){
  if(!offerIds.length) return {};
  try{
    const data=await ym('/v2/campaigns/'+campaignId+'/offer-prices',{method:'POST',body:{offerIds}});
    const offers=data?.result?.offers||[];
    return Object.fromEntries(offers.map(x=>[String(x.offerId),{
      value:n(x?.price?.value),
      discountBase:n(x?.price?.discountBase),
      currency:String(x?.price?.currencyId||'RUR'),
      updatedAt:String(x?.updatedAt||'')
    }]));
  }catch{return {}}
}

function orderIsCancelled(status){
  return String(status||'').startsWith('CANCELLED')||String(status||'')==='RETURNED';
}

async function getYesterdayOrders(campaignId,offerSet,date){
  let pageToken='',orders=0,units=0,revenue=0,cancelledUnits=0,commission=0;
  const byOffer={};
  for(let i=0;i<30;i++){
    const q=new URLSearchParams({limit:'200'});
    if(pageToken) q.set('pageToken',pageToken);
    const data=await ym('/v2/campaigns/'+campaignId+'/stats/orders?'+q.toString(),{
      method:'POST',body:{dateFrom:date,dateTo:date}
    });
    const part=data?.result?.orders||[];
    for(const order of part){
      if(order?.fake) continue;
      let matchedOrder=false;
      const cancelled=orderIsCancelled(order?.status);
      const orderCommission=(order?.commissions||[]).reduce((s,x)=>s+n(x?.actual),0);
      for(const item of (order?.items||[])){
        const sku=String(item?.shopSku||'');
        if(!offerSet.has(sku)) continue;
        matchedOrder=true;
        const c=Math.max(0,n(item?.count));
        const buyer=(item?.prices||[]).find(x=>String(x?.type||'')==='BUYER');
        const rev=n(buyer?.total)||(n(buyer?.costPerItem)*c);
        if(!byOffer[sku]) byOffer[sku]={offerId:sku,orders:0,units:0,revenue:0,cancelledUnits:0,commission:0};
        if(cancelled){
          byOffer[sku].cancelledUnits+=c;
          cancelledUnits+=c;
        }else{
          byOffer[sku].units+=c;
          byOffer[sku].revenue+=rev;
          units+=c;
          revenue+=rev;
        }
      }
      if(matchedOrder&&!cancelled){orders++;commission+=orderCommission;}
    }
    for(const sku of Object.keys(byOffer)){
      // commission is order-level; retained only in aggregate to avoid false per-SKU allocation.
    }
    pageToken=String(data?.result?.paging?.nextPageToken||'');
    if(!pageToken||!part.length) break;
  }
  return {orders,units,revenue:Math.round(revenue*100)/100,cancelledUnits,commission:Math.round(commission*100)/100,byOffer};
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    let authScopes=[];
    try{
      const auth=await ym('/v2/auth/token',{method:'POST'});
      authScopes=auth?.result?.apiKey?.authScopes||[];
    }catch{}
    const campaigns=await getCampaigns();
    const available=campaigns.filter(c=>String(c?.apiAvailability||'AVAILABLE')==='AVAILABLE');
    if(!available.length) return send(res,200,{ok:true,readOnly:true,authScopes,campaigns,products:[],warning:'Нет магазинов Яндекс Маркета с доступным API.'});

    const businessId=Number(available[0]?.business?.id||0);
    const catalog=businessId?await getBathCatalog(businessId):[];
    const offerIds=catalog.map(x=>x.offerId);
    const offerSet=new Set(offerIds);
    let defaultPrices={};
    try{defaultPrices=await getDefaultPrices(businessId,offerIds)}catch{}

    const now=new Date();
    const y=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
    const yesterday=dstr(y);
    const campaignData=[];
    for(const c of available){
      const prices=await getCampaignPrices(c.id,offerIds);
      let stats={orders:0,units:0,revenue:0,cancelledUnits:0,commission:0,byOffer:{}};
      try{stats=await getYesterdayOrders(c.id,offerSet,yesterday)}catch(e){stats.error=e?.message||String(e)}
      campaignData.push({
        campaignId:Number(c.id),
        domain:String(c.domain||''),
        placementType:String(c.placementType||''),
        businessId:Number(c?.business?.id||0),
        prices,
        yesterday:stats
      });
    }

    const products=catalog.map(p=>{
      let price=defaultPrices[p.offerId]||null;
      const stores=[];
      for(const c of campaignData){
        const cp=c.prices?.[p.offerId]||null;
        if(cp) price=cp;
        const os=c.yesterday?.byOffer?.[p.offerId]||{};
        stores.push({
          campaignId:c.campaignId,
          domain:c.domain,
          placementType:c.placementType,
          price:cp,
          yesterday:{
            units:n(os.units),
            revenue:n(os.revenue),
            cancelledUnits:n(os.cancelledUnits)
          }
        });
      }
      return {...p,price,stores};
    });

    const total={orders:0,units:0,revenue:0,cancelledUnits:0,commission:0};
    for(const c of campaignData){
      total.orders+=n(c.yesterday?.orders);
      total.units+=n(c.yesterday?.units);
      total.revenue+=n(c.yesterday?.revenue);
      total.cancelledUnits+=n(c.yesterday?.cancelledUnits);
      total.commission+=n(c.yesterday?.commission);
    }
    total.revenue=Math.round(total.revenue*100)/100;
    total.commission=Math.round(total.commission*100)/100;

    return send(res,200,{
      ok:true,
      readOnly:true,
      authScopes,
      businessId,
      campaigns:available.map(c=>({
        id:Number(c.id),domain:String(c.domain||''),placementType:String(c.placementType||''),business:c.business||null
      })),
      yesterday,
      total,
      products,
      note:'Яндекс Маркет подключён только на чтение. Комиссия из stats/orders пока показывается агрегированно по заказам; финансовую модель по услугам подключим отдельно.'
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,readOnly:true,error:e?.message||'Не удалось подключиться к Яндекс Маркету',
      hint:(status===401||status===403)?'Проверьте YANDEX_MARKET_API_KEY и права токена.':'',
      details:e?.details||undefined
    });
  }
};
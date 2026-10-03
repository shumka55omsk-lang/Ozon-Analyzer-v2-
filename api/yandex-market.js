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
const zlib=require('zlib');

function unzipJsonEntries(buf){
  const sig=0x06054b50;
  let eocd=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--){
    if(buf.readUInt32LE(i)===sig){eocd=i;break;}
  }
  if(eocd<0) throw new Error('ZIP EOCD not found');
  const total=buf.readUInt16LE(eocd+10);
  let off=buf.readUInt32LE(eocd+16);
  const out=[];
  for(let i=0;i<total;i++){
    if(buf.readUInt32LE(off)!==0x02014b50) throw new Error('ZIP central directory invalid');
    const method=buf.readUInt16LE(off+10);
    const compSize=buf.readUInt32LE(off+20);
    const nameLen=buf.readUInt16LE(off+28);
    const extraLen=buf.readUInt16LE(off+30);
    const commentLen=buf.readUInt16LE(off+32);
    const localOff=buf.readUInt32LE(off+42);
    const name=buf.slice(off+46,off+46+nameLen).toString('utf8');
    if(buf.readUInt32LE(localOff)!==0x04034b50) throw new Error('ZIP local header invalid');
    const localNameLen=buf.readUInt16LE(localOff+26);
    const localExtraLen=buf.readUInt16LE(localOff+28);
    const dataStart=localOff+30+localNameLen+localExtraLen;
    const comp=buf.slice(dataStart,dataStart+compSize);
    let raw;
    if(method===0) raw=comp;
    else if(method===8) raw=zlib.inflateRawSync(comp);
    else throw new Error('Unsupported ZIP compression method '+method);
    if(name.toLowerCase().endsWith('.json')){
      let json=null;
      try{json=JSON.parse(raw.toString('utf8'))}catch{}
      out.push({name,json});
    }
    off+=46+nameLen+extraLen+commentLen;
  }
  return out;
}
function collectObjects(v,out=[]){
  if(Array.isArray(v)){for(const x of v) collectObjects(x,out);return out;}
  if(v&&typeof v==='object'){
    out.push(v);
    for(const x of Object.values(v)) if(x&&typeof x==='object') collectObjects(x,out);
  }
  return out;
}
function safeNum(v){const x=Number(v);return Number.isFinite(x)?x:0}

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

async function getOrdersPeriod(campaignId,offerSet,dateFrom,dateTo){
  let pageToken='',orders=0,units=0,revenue=0,cancelledUnits=0,commission=0;
  const byOffer={};
  for(let i=0;i<30;i++){
    const q=new URLSearchParams({limit:'200'});
    if(pageToken) q.set('pageToken',pageToken);
    const data=await ym('/v2/campaigns/'+campaignId+'/stats/orders?'+q.toString(),{
      method:'POST',body:{dateFrom,dateTo}
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

    if(String(req.query?.finance||'')==='parse' && String(req.query?.reportId||'')){
      const reportId=encodeURIComponent(String(req.query.reportId));
      const info=await ym('/v2/reports/info/'+reportId+'?sourceType=SELLER');
      const file=String(info?.result?.file||'');
      if(!file) return send(res,409,{ok:false,readOnly:true,error:'Финансовый отчёт ещё не готов'});
      const rr=await fetch(file);
      if(!rr.ok) throw new Error('Не удалось скачать финансовый отчёт Яндекс Маркета: HTTP '+rr.status);
      const buf=Buffer.from(await rr.arrayBuffer());
      const entries=unzipJsonEntries(buf);
      const bath=new Set(['140326','1403261','20032026','30092025']);
      const docs=entries.map(e=>({name:e.name,objects:collectObjects(e.json,[])}));
      const orderToSkus=new Map();
      for(const d of docs){
        for(const o of d.objects){
          const sku=String(o.shopSku??o.shopSKU??'');
          const order=String(o.orderId??o.orderID??'');
          if(bath.has(sku)&&order){
            if(!orderToSkus.has(order)) orderToSkus.set(order,new Set());
            orderToSkus.get(order).add(sku);
          }
        }
      }
      const perSku={};
      for(const sku of bath) perSku[sku]={sku,rows:0,costs:0,serviceBreakdown:{},merchantPrice:0,buyerPaid:0};
      const files=[];
      for(const d of docs){
        let matched=0,costs=0;
        for(const o of d.objects){
          let sku=String(o.shopSku??o.shopSKU??'');
          const order=String(o.orderId??o.orderID??'');
          if(!bath.has(sku)&&order&&orderToSkus.get(order)?.size===1) sku=[...orderToSkus.get(order)][0];
          if(!bath.has(sku)) continue;
          matched++;
          const service=safeNum(o.servicePrice);
          const full=safeNum(o.fullPrice);
          const cost=Math.abs(service||full||0);
          const bucket=perSku[sku];
          bucket.rows++;
          bucket.costs+=cost;
          bucket.merchantPrice+=safeNum(o.merchantPrice);
          bucket.buyerPaid+=safeNum(o.buyerPaid);
          const key=d.name.replace(/\.json$/i,'');
          bucket.serviceBreakdown[key]=(bucket.serviceBreakdown[key]||0)+cost;
          costs+=cost;
        }
        files.push({name:d.name,objects:d.objects.length,matchedRows:matched,costs:Math.round(costs*100)/100});
      }
      for(const b of Object.values(perSku)){
        b.costs=Math.round(b.costs*100)/100;
        b.merchantPrice=Math.round(b.merchantPrice*100)/100;
        b.buyerPaid=Math.round(b.buyerPaid*100)/100;
        b.serviceBreakdown=Object.entries(b.serviceBreakdown)
          .map(([name,value])=>({name,value:Math.round(value*100)/100}))
          .sort((a,b)=>b.value-a.value);
      }
      return send(res,200,{ok:true,readOnly:true,files,perSku:Object.values(perSku)});
    }

    if(String(req.query?.reportId||'')){
      const reportId=encodeURIComponent(String(req.query.reportId));
      const info=await ym('/v2/reports/info/'+reportId+'?sourceType=SELLER');
      return send(res,200,{ok:true,readOnly:true,report:info?.result||{}});
    }

    if(String(req.query?.finance||'')==='generate'){
      const now=new Date();
      const to=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
      const from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-14));
      const body={
        businessId,
        dateFrom:dstr(from),
        dateTo:dstr(to),
        placementPrograms:[...new Set(available.map(c=>String(c.placementType||'')).filter(Boolean))],
        campaignIds:available.map(c=>Number(c.id)).filter(Boolean)
      };
      const generated=await ym('/v2/reports/united-marketplace-services/generate?format=JSON&language=RU',{
        method:'POST',body
      });
      return send(res,200,{
        ok:true,
        readOnly:true,
        period:{from:dstr(from),to:dstr(to)},
        reportId:String(generated?.result?.reportId||''),
        estimatedGenerationTime:n(generated?.result?.estimatedGenerationTime)
      });
    }

    const catalog=businessId?await getBathCatalog(businessId):[];
    const offerIds=catalog.map(x=>x.offerId);
    const offerSet=new Set(offerIds);
    let defaultPrices={};
    try{defaultPrices=await getDefaultPrices(businessId,offerIds)}catch{}

    const now=new Date();
    const y=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
    const yesterday=dstr(y);
    const h=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-14));
    const historyFrom=dstr(h);
    const campaignData=[];
    for(const c of available){
      const prices=await getCampaignPrices(c.id,offerIds);
      let stats={orders:0,units:0,revenue:0,cancelledUnits:0,commission:0,byOffer:{}};
      let history={orders:0,units:0,revenue:0,cancelledUnits:0,commission:0,byOffer:{}};
      try{stats=await getOrdersPeriod(c.id,offerSet,yesterday,yesterday)}catch(e){stats.error=e?.message||String(e)}
      try{history=await getOrdersPeriod(c.id,offerSet,historyFrom,yesterday)}catch(e){history.error=e?.message||String(e)}
      campaignData.push({
        campaignId:Number(c.id),
        domain:String(c.domain||''),
        placementType:String(c.placementType||''),
        businessId:Number(c?.business?.id||0),
        prices,
        yesterday:stats,
        history14:history
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
          },
          history14:{
            units:n(c.history14?.byOffer?.[p.offerId]?.units),
            revenue:n(c.history14?.byOffer?.[p.offerId]?.revenue),
            cancelledUnits:n(c.history14?.byOffer?.[p.offerId]?.cancelledUnits)
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

    const history14={orders:0,units:0,revenue:0,cancelledUnits:0,commission:0};
    for(const c of campaignData){
      history14.orders+=n(c.history14?.orders);
      history14.units+=n(c.history14?.units);
      history14.revenue+=n(c.history14?.revenue);
      history14.cancelledUnits+=n(c.history14?.cancelledUnits);
      history14.commission+=n(c.history14?.commission);
    }
    history14.revenue=Math.round(history14.revenue*100)/100;
    history14.commission=Math.round(history14.commission*100)/100;
    history14.avgRevenuePerUnit=history14.units?Math.round(history14.revenue/history14.units*100)/100:0;
    history14.avgCommissionPerUnit=history14.units?Math.round(history14.commission/history14.units*100)/100:0;

    return send(res,200,{
      ok:true,
      readOnly:true,
      authScopes,
      businessId,
      campaigns:available.map(c=>({
        id:Number(c.id),domain:String(c.domain||''),placementType:String(c.placementType||''),business:c.business||null
      })),
      yesterday,
      historyFrom,
      total,
      history14,
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
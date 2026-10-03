const APP_BASE=process.env.APP_BASE_URL||'https://ozon-analyzer-v2.vercel.app';
const OZON_BASE='https://api-seller.ozon.ru';
const BATH_IDS=new Set(['3768184568','3826876199','2808600941','3768033857']);
const TARGET_PROFIT=200;
const COGS=55;
const PRICE_STEP=0.05;
const CHANGE_WEEKDAYS=new Set([1,3,5]); // Mon/Wed/Fri in Omsk morning run
const ELASTIC_BOOSTING_ACTION_ID=1977747;

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function r2(v){return Math.round(n(v)*100)/100}
function round10(v){return Math.ceil(n(v)/10)*10}
function pct(v){return Math.round(n(v)*10)/10}
function rub(v){return Math.round(n(v))+' ₽'}
function colorName(name){
  const s=String(name||'').toLowerCase();
  if(s.includes('сер')) return 'Серая';
  if(s.includes('беж')) return 'Бежевая';
  if(s.includes('син')) return 'Синяя';
  if(s.includes('оранж')) return 'Оранжевая';
  return 'Сидушка';
}
function avg(arr){
  const a=arr.map(n).filter(Number.isFinite);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
}
function median(arr){
  const a=arr.map(n).filter(x=>x>0).sort((x,y)=>x-y);
  if(!a.length) return 0;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}

async function jsonGet(url){
  const r=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store'});
  const data=await r.json().catch(()=>({ok:false,error:'Bad JSON'}));
  if(!r.ok||!data.ok) throw new Error(data.error||('HTTP '+r.status));
  return data;
}
async function jsonGetCron(url,{allowPending=false}={}){
  const secret=process.env.CRON_SECRET;
  const r=await fetch(url,{
    headers:{Accept:'application/json',Authorization:'Bearer '+secret},
    cache:'no-store'
  });
  const data=await r.json().catch(()=>({ok:false,error:'Bad JSON'}));
  if(allowPending&&r.status===409) return data;
  if(!r.ok||!data.ok) throw new Error(data.error||('HTTP '+r.status));
  return data;
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function loadYmFinance(){
  try{
    const g=await jsonGetCron(APP_BASE+'/api/yandex-market?finance=generate');
    const id=String(g?.reportId||'');
    if(!id) return {ok:false,error:'Яндекс Маркет не вернул reportId'};
    for(let i=0;i<6;i++){
      if(i) await sleep(1000);
      const p=await jsonGetCron(
        APP_BASE+'/api/yandex-market?finance=parse&reportId='+encodeURIComponent(id),
        {allowPending:true}
      );
      if(p?.ok) return p;
    }
    return {ok:false,error:'Финансовый отчёт Яндекс Маркета не успел сформироваться'};
  }catch(e){
    return {ok:false,error:e?.message||String(e)};
  }
}
async function ozonWrite(path,body){
  const clientId=process.env.OZON_CLIENT_ID;
  const apiKey=process.env.OZON_PRICE_API_KEY;
  if(!clientId||!apiKey) throw new Error('OZON_PRICE_API_KEY не настроен');
  const r=await fetch(OZON_BASE+path,{
    method:'POST',
    headers:{
      'Client-Id':clientId,
      'Api-Key':apiKey,
      'Content-Type':'application/json',
      'Accept':'application/json'
    },
    body:JSON.stringify(body)
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
async function telegram(text){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не настроены в этом Vercel-проекте');
  const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      chat_id:chatId,
      text,
      disable_web_page_preview:true
    })
  });
  const data=await r.json().catch(()=>({ok:false}));
  if(!r.ok||!data.ok) throw new Error(data?.description||('Telegram HTTP '+r.status));
  return {sent:true};
}

function analyticsFor(productId,analytics){
  const rows=(analytics?.rows||[])
    .filter(x=>String(x.productId)===String(productId))
    .sort((a,b)=>String(a.day).localeCompare(String(b.day)));
  const daily=rows.map(x=>({
    day:x.day,
    orders:n(x?.metrics?.ordered_units),
    revenue:n(x?.metrics?.revenue)
  }));
  const last2=daily.slice(-2);
  const before=daily.slice(0,-2);
  const baselineOrders=avg(before.map(x=>x.orders));
  const recentOrders=avg(last2.map(x=>x.orders));
  const yesterday=daily[daily.length-1]||{orders:0,revenue:0,day:analytics?.dateTo||''};
  return {
    daily,
    baselineOrders,
    recentOrders,
    yesterday,
    ratio:baselineOrders>0?recentOrders/baselineOrders:0
  };
}

function wbSummary(item){
  const h=(Array.isArray(item?.history)?item.history:[])
    .slice()
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const last=h[h.length-1]||{};
  const last2=h.slice(-2);
  const before=h.slice(0,-2);
  const baseline=avg(before.map(x=>x.orders));
  const recent=avg(last2.map(x=>x.orders));
  const ratio=baseline>0?recent/baseline:0;
  return {
    nmID:String(item?.nmID||''),
    vendorCode:String(item?.vendorCode||''),
    title:String(item?.title||'Сидушка WB'),
    date:String(last.date||''),
    orders:n(last.orders),
    revenue:n(last.orderSum),
    opens:n(last.opens),
    carts:n(last.carts),
    cartToOrder:n(last.cartToOrderConversion),
    baseline:r2(baseline),
    recent:r2(recent),
    trendPct:baseline>0?r2((ratio-1)*100):0
  };
}

function decisionFor(p,fin,analytics,promoActive,fallbackFixed,changeDay){
  const currentBase=n(p.basePrice||p.price);
  const effective=n(p.sellerPrice||p.price||currentBase);
  const commissionPct=n(p.salesPercentFbo||p.salesPercentFbs||52);
  const acquiringRate=effective>0?n(p.acquiring)/effective:0.01;
  const ownFixed=fin&&n(fin.postingHits)>=5?n(fin.avgDeliveryAndOther):0;
  const fixed=ownFixed||fallbackFixed||120;
  const denom=1-commissionPct/100-acquiringRate;
  const safeFloor=denom>0?round10((COGS+fixed+TARGET_PROFIT)/denom):0;
  const currentProfit=effective-(effective*commissionPct/100)-n(p.acquiring)-fixed-COGS;

  const a=analyticsFor(p.productId,analytics);
  const enoughData=a.baselineOrders>=3;
  const stable=enoughData&&a.ratio>=0.80;
  const softDrop=enoughData&&a.ratio>=0.60&&a.ratio<0.80;
  const hardDrop=enoughData&&a.ratio<0.60;

  let action='HOLD',reason='',newPrice=currentBase;
  if(promoActive){
    reason='Товар ещё в «Эластичном бустинге»: сначала убрать из акции, затем наблюдать 24 часа.';
  }else if(!enoughData){
    reason='Недостаточно заказов для безопасного автоматического изменения цены.';
  }else if(!changeDay){
    reason='День наблюдения: изменение цены разрешено Пн/Ср/Пт, сегодня только контроль.';
  }else if(currentBase<safeFloor&&stable){
    newPrice=Math.min(safeFloor,round10(currentBase*(1+PRICE_STEP)));
    if(newPrice>currentBase){
      action='RAISE';
      reason='Продажи стабильны относительно фона, цена ниже уровня прибыли '+TARGET_PROFIT+' ₽.';
    }else{
      reason='Цена уже у расчётного защитного уровня.';
    }
  }else if(currentBase<safeFloor&&softDrop){
    reason='Заказы снизились на '+pct((1-a.ratio)*100)+'%: цену не повышаем, ждём следующий цикл.';
  }else if(currentBase<safeFloor&&hardDrop){
    reason='Сильная просадка заказов: повышение заморожено для защиты выдачи.';
  }else if(currentBase>=safeFloor){
    if(hardDrop&&currentBase>safeFloor){
      const candidate=Math.max(safeFloor,Math.floor((currentBase*(1-PRICE_STEP))/10)*10);
      if(candidate<currentBase){action='LOWER';newPrice=candidate;reason='Цена выше защитного уровня, а продажи просели; откат на один шаг.';}
      else reason='Цена на минимальном прибыльном уровне — ниже не опускаем.';
    }else reason='Целевая прибыль защищена; текущую цену сохраняем.';
  }

  return {
    productId:String(p.productId),
    offerId:String(p.offerId||''),
    name:p.name,
    color:colorName(p.name),
    currentBase:r2(currentBase),
    effective:r2(effective),
    commissionPct:r2(commissionPct),
    fixed:r2(fixed),
    safeFloor:r2(safeFloor),
    currentProfit:r2(currentProfit),
    baselineOrders:r2(a.baselineOrders),
    recentOrders:r2(a.recentOrders),
    yesterdayOrders:r2(a.yesterday.orders),
    yesterdayRevenue:r2(a.yesterday.revenue),
    trendPct:a.baselineOrders>0?r2((a.recentOrders/a.baselineOrders-1)*100):0,
    action,
    newPrice:r2(newPrice),
    reason
  };
}

function buildReport(date,decisions,mode,promoRemoved,analyticsLimited,wbAnalytics,ym,ymFinance){
  const lines=[
    'Маркетплейсы — сидушки для бани · '+date,
    'Ozon: '+mode,
    'Цель: не менее '+TARGET_PROFIT+' ₽ прибыли/шт.',
    '',
    'OZON'
  ];
  for(const d of decisions){
    const arrow=d.action==='RAISE'?' ↑':d.action==='LOWER'?' ↓':'';
    lines.push(
      d.color+': '+d.yesterdayOrders+' заказ(ов) вчера · '+rub(d.yesterdayRevenue),
      'Цена: '+rub(d.effective)+' · защита ≈ '+rub(d.safeFloor)+' · прибыль ≈ '+rub(d.currentProfit),
      '2 дня к фону: '+(d.baselineOrders>0?(d.trendPct>=0?'+':'')+d.trendPct+'%':'нет базы'),
      'Решение: '+d.action+arrow+(d.newPrice!==d.currentBase?' → '+rub(d.newPrice):'')+' — '+d.reason,
      ''
    );
  }
  if(promoRemoved) lines.push('Акция: товары удалены из «Эластичного бустинга»; изменение цены отложено до следующего цикла.','');
  if(analyticsLimited) lines.push('Примечание Ozon: поисковые позиции недоступны без Premium; контроль ведётся по заказам/выручке и экономике.','');

  lines.push('WILDBERRIES');
  if(wbAnalytics?.ok&&Array.isArray(wbAnalytics.items)&&wbAnalytics.items.length){
    for(const item of wbAnalytics.items){
      const w=wbSummary(item);
      lines.push(
        'WB '+(w.vendorCode||w.nmID)+': '+w.orders+' заказ(ов) вчера · '+rub(w.revenue),
        'Переходы: '+w.opens+' · корзины: '+w.carts+' · корзина→заказ: '+(w.cartToOrder?pct(w.cartToOrder)+'%':'—'),
        '2 дня к фону: '+(w.baseline>0?(w.trendPct>=0?'+':'')+w.trendPct+'%':'нет базы'),
        'Решение: наблюдение — автоцена WB пока отключена.',
        ''
      );
    }
  }else{
    lines.push('WB: аналитика временно недоступна; Ozon-автоматика продолжает работать.','');
  }
  lines.push('ЯНДЕКС МАРКЕТ');
  if(ym?.ok){
    lines.push(
      'Заказы вчера: '+n(ym?.total?.orders)+' · штук: '+n(ym?.total?.units)+' · выручка: '+rub(ym?.total?.revenue),
      'Отменено, шт.: '+n(ym?.total?.cancelledUnits)
    );
    const financeRows=Array.isArray(ymFinance?.perSku)?ymFinance.perSku:[];
    const financeMap=Object.fromEntries(financeRows.map(x=>[String(x.sku),x]));
    const fallback=financeMap['30092025']&&n(financeMap['30092025'].placementUnits)>0?financeMap['30092025']:null;
    for(const p of (ym.products||[]).slice(0,6)){
      const units=(p.stores||[]).reduce((s,x)=>s+n(x?.yesterday?.units),0);
      const revenue=(p.stores||[]).reduce((s,x)=>s+n(x?.yesterday?.revenue),0);
      const own=financeMap[String(p.offerId||'')];
      const sample=own&&n(own.placementUnits)>0?own:fallback;
      const current=n(p?.price?.value);
      let econ='финансы: нет выборки';
      if(sample&&current>0){
        const rate=n(sample.variableRate);
        const fixed=n(sample.fixedCostPerUnit);
        const safe=rate<1?round10((COGS+TARGET_PROFIT+fixed)/(1-rate)):0;
        const profit=current*(1-rate)-fixed-COGS;
        econ='защита ≈ '+rub(safe)+' · прибыль ≈ '+rub(profit)+(sample===own?'':' · ориентир по серой');
      }
      lines.push(
        (p.name||p.offerId||'Сидушка')+': '+units+' шт. · '+rub(revenue)+' · цена '+(current?rub(current):'—'),
        econ
      );
    }
    if(!ymFinance?.ok) lines.push('Финансы Яндекс Маркета: '+String(ymFinance?.error||'временно недоступны').slice(0,180));
    lines.push('Решение: наблюдение — автоцена Яндекс Маркета пока отключена.','');
  }else{
    lines.push('Яндекс Маркет: ещё не подключён или временно недоступен.','');
  }
  lines.push('Автоматика Ozon затрагивает только 4 SKU сидушек. WB и Яндекс Маркет пока только чтение. Остальные товары исключены.');
  return lines.join('\n').slice(0,3900);
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  const secret=process.env.CRON_SECRET;
  const auth=String(req.headers?.authorization||'');
  if(!secret||auth!=='Bearer '+secret) return send(res,401,{ok:false,error:'Unauthorized'});

  try{
    const [seller,finance,analytics,promos,search,wbAnalytics,ym]=await Promise.all([
      jsonGet(APP_BASE+'/api/seller-products'),
      jsonGet(APP_BASE+'/api/bath-finance'),
      jsonGet(APP_BASE+'/api/bath-analytics'),
      jsonGet(APP_BASE+'/api/bath-promos'),
      jsonGet(APP_BASE+'/api/bath-search').catch(e=>({ok:false,error:e?.message||String(e)})),
      jsonGet(APP_BASE+'/api/wb-analytics').catch(e=>({ok:false,error:e?.message||String(e),items:[]})),
      jsonGet(APP_BASE+'/api/yandex-market').catch(e=>({ok:false,error:e?.message||String(e),products:[],total:{}}))
    ]);

    const ymFinance=ym?.ok?await loadYmFinance():{ok:false,error:'Яндекс Маркет недоступен'};
    const products=(seller.products||[]).filter(p=>BATH_IDS.has(String(p.productId)));
    const finMap=Object.fromEntries((finance.items||[]).map(x=>[String(x.productId),x]));
    let reliable=(finance.items||[]).filter(x=>n(x.postingHits)>=5).map(x=>n(x.avgDeliveryAndOther));
    if(!reliable.length) reliable=(finance.items||[]).filter(x=>n(x.postingHits)>0).map(x=>n(x.avgDeliveryAndOther));
    const fallbackFixed=median(reliable)||120;

    const promoItems=(promos.found||[]).filter(x=>Number(x.actionId)===ELASTIC_BOOSTING_ACTION_ID);
    const promoSet=new Set(promoItems.map(x=>String(x.productId)));
    const managePromos=String(process.env.OZON_MANAGE_PROMOS_ENABLED||'').toLowerCase()==='true';
    const autoprice=String(process.env.OZON_AUTOPRICE_ENABLED||'').toLowerCase()==='true';
    const hasWriteKey=!!process.env.OZON_PRICE_API_KEY;

    let promoRemoved=false;
    let promoResult=null;
    if(managePromos&&hasWriteKey&&promoSet.size){
      try{
        promoResult=await ozonWrite('/v1/actions/products/deactivate',{
          action_id:ELASTIC_BOOSTING_ACTION_ID,
          product_ids:[...promoSet].map(Number)
        });
        promoRemoved=true;
      }catch(e){
        promoResult={ok:false,error:e?.message||String(e)};
      }
    }

    const nowOmsk=new Date(Date.now()+6*60*60*1000);
    const changeDay=CHANGE_WEEKDAYS.has(nowOmsk.getUTCDay())&&!promoRemoved;
    const decisions=products.map(p=>decisionFor(
      p,finMap[String(p.productId)],analytics,promoSet.has(String(p.productId))&&!promoRemoved,fallbackFixed,changeDay
    ));

    const writes=[];
    if(autoprice&&hasWriteKey&&!promoRemoved){
      for(const d of decisions){
        if(!['RAISE','LOWER'].includes(d.action)||d.newPrice===d.currentBase) continue;
        const p=products.find(x=>String(x.productId)===d.productId);
        const minPrice=Math.min(d.newPrice,d.safeFloor);
        const result=await ozonWrite('/v1/product/import/prices',{
          prices:[{
            offer_id:String(d.offerId),
            price:String(Math.round(d.newPrice)),
            old_price:String(Math.round(n(p?.oldPrice)||0)),
            min_price:String(Math.round(minPrice)),
            currency_code:'RUB'
          }]
        });
        writes.push({productId:d.productId,offerId:d.offerId,newPrice:d.newPrice,minPrice,result});
      }
    }

    const date=analytics.dateTo||new Date(Date.now()-86400000).toISOString().slice(0,10);
    const mode=autoprice&&hasWriteKey?'АВТОЦЕНА ВКЛ':'наблюдение / без записи';
    const report=buildReport(date,decisions,mode,promoRemoved,!search?.ok,wbAnalytics,ym,ymFinance);
    const tg=await telegram(report);

    return send(res,200,{
      ok:true,
      date,
      mode,
      changeDay,
      fallbackFixed:r2(fallbackFixed),
      promoRemoved,
      promoResult,
      decisions,
      writes,
      wbAnalyticsOk:!!wbAnalytics?.ok,
      wbItems:Array.isArray(wbAnalytics?.items)?wbAnalytics.items.length:0,
      yandexMarketOk:!!ym?.ok,
      yandexMarketItems:Array.isArray(ym?.products)?ym.products.length:0,
      yandexFinanceOk:!!ymFinance?.ok,
      yandexFinanceItems:Array.isArray(ymFinance?.perSku)?ymFinance.perSku.length:0,
      telegram:tg,
      report
    });
  }catch(e){
    let tg={sent:false};
    try{tg=await telegram('Ozon — ошибка автоматизации сидушек\n'+String(e?.message||e).slice(0,3000));}catch{}
    return send(res,500,{ok:false,error:e?.message||String(e),telegram:tg});
  }
};

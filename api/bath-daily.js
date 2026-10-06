const APP_BASE=process.env.APP_BASE_URL||'https://ozon-analyzer-v2.vercel.app';
const OZON_BASE='https://api-seller.ozon.ru';
const BATH_IDS=new Set(['3768184568','3826876199','2808600941','3768033857']);
const TARGET_PROFIT=200;
const COGS=55;
const PRICE_STEP=0.05;
const CHANGE_WEEKDAYS=new Set([1,3,5]); // Mon/Wed/Fri in Omsk morning run
const ELASTIC_BOOSTING_ACTION_ID=1977747;
const UNIFIED_DRY_RUN=true; // Hard safety lock: no marketplace writes while validating recommendations.
const OZON_BUYER_TARGET_MIN=220;
const OZON_BUYER_TARGET_MAX=240;

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function r2(v){return Math.round(n(v)*100)/100}
function round10(v){return Math.ceil(n(v)/10)*10}
function raiseStepPrice(current){
  const c=n(current);
  const cap=c*(1+PRICE_STEP);
  const rounded=Math.floor(cap/10)*10;
  return Math.max(c,rounded);
}
function lowerStepPrice(current){
  const c=n(current);
  const floor=c*(1-PRICE_STEP);
  const rounded=Math.ceil(floor/10)*10;
  return Math.min(c,rounded);
}
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
  const buyerPrice=n(p.buyerPriceObserved);
  const buyerPriceObservable=!!p.buyerPriceReliable&&buyerPrice>0;

  if(!buyerPriceObservable){
    reason='Цель покупателя '+OZON_BUYER_TARGET_MIN+'–'+OZON_BUYER_TARGET_MAX+' ₽. Надёжная конечная цена покупателя пока не получена — только HOLD.';
  }else if(!enoughData){
    reason='Цена покупателя видна ('+rub(buyerPrice)+'), но заказов недостаточно для безопасного изменения.';
  }else if(!changeDay){
    reason='Цена покупателя '+rub(buyerPrice)+'. День наблюдения: сегодня только расчёт, без изменения.';
  }else if(hardDrop){
    reason='Цена покупателя '+rub(buyerPrice)+', но продажи сильно просели — изменение цены заморожено.';
  }else if(buyerPrice<OZON_BUYER_TARGET_MIN){
    newPrice=raiseStepPrice(currentBase);
    if(newPrice>currentBase){
      action='RAISE';
      reason='Цена покупателя ниже целевого коридора; повышаем цену продавца не более чем на '+Math.round(PRICE_STEP*100)+'%.';
    }
  }else if(buyerPrice>OZON_BUYER_TARGET_MAX){
    if(currentProfit<TARGET_PROFIT){
      reason='Цена покупателя выше '+OZON_BUYER_TARGET_MAX+' ₽, но прибыль уже ниже '+TARGET_PROFIT+' ₽. Условия конфликтуют — HOLD и сигнал владельцу.';
    }else{
      const candidate=Math.max(safeFloor,lowerStepPrice(currentBase));
      if(candidate<currentBase){
        action='LOWER';
        newPrice=candidate;
        reason='Цена покупателя выше целевого коридора; снижаем цену продавца одним безопасным шагом.';
      }else{
        reason='Цена покупателя выше цели, но ниже защитной цены продавца опускаться нельзя.';
      }
    }
  }else if(currentProfit<TARGET_PROFIT){
    const buyerHeadroomRatio=OZON_BUYER_TARGET_MAX/buyerPrice;
    const maxByBuyer=currentBase*buyerHeadroomRatio;
    const maxStep=currentBase*(1+PRICE_STEP);
    const candidate=Math.floor(Math.min(maxByBuyer,maxStep)/5)*5;
    if(candidate>currentBase&&stable){
      action='RAISE';
      newPrice=candidate;
      reason='Цена покупателя в коридоре, но прибыль ниже '+TARGET_PROFIT+' ₽. Dry-run использует оставшийся запас до '+OZON_BUYER_TARGET_MAX+' ₽.';
    }else if(!stable){
      reason='Цена покупателя в коридоре, прибыль ниже цели, но динамика продаж недостаточно стабильна — HOLD.';
    }else{
      reason='Цена покупателя уже у верхней границы '+OZON_BUYER_TARGET_MAX+' ₽; повышать цену продавца без выхода из коридора нельзя.';
    }
  }else{
    reason='Цена покупателя в целевом коридоре и прибыль не ниже '+TARGET_PROFIT+' ₽ — HOLD.';
  }

  const recommendedPrice=action==='HOLD'?effective:newPrice;
  const recommendedProfit=recommendedPrice-(recommendedPrice*commissionPct/100)-(recommendedPrice*acquiringRate)-fixed-COGS;
  const recommendedBuyerEstimate=buyerPriceObservable&&effective>0
    ?buyerPrice*(recommendedPrice/effective)
    :0;
  return {
    marketplace:'Ozon',
    buyerTargetMin:OZON_BUYER_TARGET_MIN,
    buyerTargetMax:OZON_BUYER_TARGET_MAX,
    buyerPriceObserved:buyerPriceObservable?r2(buyerPrice):null,
    buyerPriceReliable:buyerPriceObservable,
    buyerPriceType:String(p.buyerPriceType||''),
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
    recommendedPrice:r2(recommendedPrice),
    recommendedProfit:r2(recommendedProfit),
    recommendedBuyerEstimate:r2(recommendedBuyerEstimate),
    promoActive:!!promoActive,
    reason
  };
}


function genericPriceDecision({
  marketplace,id,name,current,safe,currentProfit,baseline,recent,hasOwnFinance,financeUnits,changeDay,extraHoldReason=''
}){
  current=n(current); safe=n(safe); currentProfit=n(currentProfit);
  baseline=n(baseline); recent=n(recent);
  const ratio=baseline>0?recent/baseline:0;
  const enoughTrend=baseline>=3;
  let action='HOLD',recommended=current,reason='';

  if(!current){
    reason='Нет свежей цены — изменение запрещено.';
  }else if(!hasOwnFinance){
    reason=extraHoldReason||'Нет собственной достаточной финансовой выборки — только наблюдение.';
  }else if(financeUnits<3){
    reason='Финансовая выборка слишком мала ('+financeUnits+' шт.) — только наблюдение.';
  }else if(!enoughTrend){
    reason=extraHoldReason||'Недостаточно данных по динамике продаж для безопасного изменения.';
  }else if(!changeDay){
    reason='День наблюдения: сегодня только расчёт, без шага цены.';
  }else if(current<safe&&ratio>=0.80){
    recommended=Math.min(safe,raiseStepPrice(current));
    if(recommended>current){
      action='RAISE';
      reason='Продажи стабильны, цена ниже защитного уровня.';
    }else reason='Цена уже у защитного уровня.';
  }else if(current<safe&&ratio<0.80){
    reason='Продажи просели — повышение цены заморожено.';
  }else if(current>=safe&&ratio<0.60&&current>safe){
    recommended=Math.max(safe,lowerStepPrice(current));
    if(recommended<current){
      action='LOWER';
      reason='Цена выше защитного уровня и продажи заметно просели; dry-run предлагает один шаг вниз.';
    }else reason='Ниже защитной цены опускаться нельзя.';
  }else{
    reason='Целевая прибыль защищена; текущую цену сохраняем.';
  }

  if(current>0&&recommended>0){
    const delta=Math.abs(recommended-current)/current;
    if(delta>PRICE_STEP+0.000001){
      action='HOLD';
      recommended=current;
      reason='Защитный стоп: рассчитанный шаг превысил лимит '+Math.round(PRICE_STEP*100)+'%.';
    }
  }
  const expectedProfit=current>0&&safe>0&&currentProfit!==0
    ?currentProfit
    :0;
  return {
    marketplace,id:String(id||''),name:String(name||''),current:r2(current),safe:r2(safe),
    currentProfit:r2(currentProfit),recommended:r2(recommended),expectedProfit:r2(expectedProfit),
    baseline:r2(baseline),recent:r2(recent),trendPct:baseline>0?r2((ratio-1)*100):0,
    action,reason,financeUnits:n(financeUnits)
  };
}

function wbDryRun(wbProducts,wbAnalytics,wbFinance,changeDay){
  const products=Array.isArray(wbProducts?.products)?wbProducts.products:[];
  const analyticsMap=Object.fromEntries((wbAnalytics?.items||[]).map(x=>[String(x.nmID||''),x]));
  const financeMap=Object.fromEntries((wbFinance?.items||[]).map(x=>[String(x.nmID||''),x]));
  const reliable=(wbFinance?.items||[]).filter(x=>n(x.saleUnits)>=5&&n(x.variableRetention)>0);
  const fallback=reliable.sort((a,b)=>n(b.saleUnits)-n(a.saleUnits))[0]||null;

  return products.map(p=>{
    const id=String(p.nmID||'');
    const a=wbSummary(analyticsMap[id]||{nmID:id,history:[]});
    const own=financeMap[id];
    const ownReliable=!!(own&&n(own.saleUnits)>=3&&n(own.variableRetention)>0);
    const sample=ownReliable?own:fallback;
    const current=p.priceLoaded?n(p.discountedPrice||p.basePrice):0;
    const retention=n(sample?.variableRetention);
    const fixed=n(sample?.fixedMarketplaceCostPerSale);
    const safe=sample&&retention>0?round10((COGS+TARGET_PROFIT+fixed)/retention):0;
    const profit=current&&sample&&retention>0?current*retention-fixed-COGS:0;
    const d=genericPriceDecision({
      marketplace:'Wildberries',
      id,
      name:p.title||p.vendorCode||id,
      current,safe,currentProfit:profit,
      baseline:a.baseline,recent:a.recent,
      hasOwnFinance:ownReliable,
      financeUnits:n(own?.saleUnits),
      changeDay,
      extraHoldReason:sample&&!ownReliable
        ?'Экономика рассчитана по ориентиру другой сидушки; для автошага нужна собственная выборка.'
        :'Недостаточно собственной финансовой выборки.'
    });
    if(d.recommended&&sample&&retention>0) d.expectedProfit=r2(d.recommended*retention-fixed-COGS);
    d.vendorCode=String(p.vendorCode||'');
    d.priceLoaded=!!p.priceLoaded;
    d.financeSource=ownReliable?'own':(sample?'fallback':'none');
    return d;
  });
}

function ymDryRun(ym,ymFinance,changeDay){
  const financeRows=Array.isArray(ymFinance?.perSku)?ymFinance.perSku:[];
  const financeMap=Object.fromEntries(financeRows.map(x=>[String(x.sku),x]));
  const fallback=financeRows
    .filter(x=>n(x.placementUnits)>=3&&n(x.variableRate)>=0&&n(x.variableRate)<1)
    .sort((a,b)=>n(b.placementUnits)-n(a.placementUnits))[0]||null;

  return (ym?.products||[]).map(p=>{
    const id=String(p.offerId||'');
    const own=financeMap[id];
    const ownReliable=!!(own&&n(own.placementUnits)>=3&&n(own.variableRate)<1);
    const sample=ownReliable?own:fallback;
    const current=n(p?.price?.value);
    const rate=n(sample?.variableRate);
    const fixed=n(sample?.fixedCostPerUnit);
    const safe=sample&&rate<1?round10((COGS+TARGET_PROFIT+fixed)/(1-rate)):0;
    const profit=current&&sample&&rate<1?current*(1-rate)-fixed-COGS:0;
    const histUnits=(p.stores||[]).reduce((s,x)=>s+n(x?.history14?.units),0);
    const yUnits=(p.stores||[]).reduce((s,x)=>s+n(x?.yesterday?.units),0);

    // Yandex currently has only sparse 14-day history, not a robust daily baseline.
    // Keep HOLD even when economics are available; still show safe/current/projected profit.
    const d=genericPriceDecision({
      marketplace:'Яндекс Маркет',
      id,
      name:p.name||id,
      current,safe,currentProfit:profit,
      baseline:0,recent:0,
      hasOwnFinance:ownReliable,
      financeUnits:n(own?.placementUnits),
      changeDay:false,
      extraHoldReason:ownReliable
        ?'Экономика рассчитана, но дневной истории пока недостаточно для автоматического шага цены.'
        :(sample?'Используется финансовый ориентир другой сидушки; автошаг запрещён.':'Нет финансовой выборки.')
    });
    d.history14Units=r2(histUnits);
    d.yesterdayUnits=r2(yUnits);
    d.financeSource=ownReliable?'own':(sample?'fallback':'none');
    return d;
  });
}

function buildReport(date,decisions,mode,promoRemoved,analyticsLimited,wbAnalytics,ym,ymFinance,wbDecisions,ymDecisions){
  const lines=[
    'Маркетплейсы — сидушки для бани · '+date,
    'Режим: ЕДИНЫЙ DRY-RUN · без изменения цен',
    'Цель: покупателю '+OZON_BUYER_TARGET_MIN+'–'+OZON_BUYER_TARGET_MAX+' ₽ · продавцу не менее '+TARGET_PROFIT+' ₽ прибыли/шт.',
    '',
    'OZON'
  ];
  for(const d of decisions){
    const arrow=d.action==='RAISE'?' ↑':d.action==='LOWER'?' ↓':'';
    lines.push(
      d.color+': '+d.yesterdayOrders+' заказ(ов) вчера · '+rub(d.yesterdayRevenue),
      'Покупатель: '+(d.buyerPriceReliable?rub(d.buyerPriceObserved)+' ('+(d.buyerPriceType||'наблюдение')+')':'не удалось получить')+' · цель '+OZON_BUYER_TARGET_MIN+'–'+OZON_BUYER_TARGET_MAX+' ₽',
      'Цена продавца: '+rub(d.effective)+' → '+rub(d.recommendedPrice)+(d.recommendedBuyerEstimate?' · покупателю оценочно '+rub(d.recommendedBuyerEstimate):''),
      'Прибыль: сейчас ≈ '+rub(d.currentProfit)+' · при рекомендации ≈ '+rub(d.recommendedProfit),
      '2 дня к фону: '+(d.baselineOrders>0?(d.trendPct>=0?'+':'')+d.trendPct+'%':'нет базы'),
      'DRY-RUN: '+d.action+arrow+' — '+d.reason,
      ''
    );
  }
  if(promoRemoved) lines.push('Акция: товары удалены из «Эластичного бустинга»; изменение цены отложено до следующего цикла.','');
  if(analyticsLimited) lines.push('Примечание Ozon: поисковые позиции недоступны без Premium; контроль ведётся по заказам/выручке и экономике.','');

  lines.push('WILDBERRIES');
  if(Array.isArray(wbDecisions)&&wbDecisions.length){
    for(const d of wbDecisions){
      lines.push(
        'WB '+(d.vendorCode||d.id)+': цена '+(d.current?rub(d.current):'—')+' → '+(d.recommended?rub(d.recommended):'—')+' · защита '+(d.safe?rub(d.safe):'—'),
        'Прибыль: '+(d.current?rub(d.currentProfit):'—')+' → '+(d.recommended?rub(d.expectedProfit):'—'),
        '2 дня к фону: '+(d.baseline>0?(d.trendPct>=0?'+':'')+d.trendPct+'%':'нет базы'),
        'DRY-RUN: '+d.action+' — '+d.reason,
        ''
      );
    }
  }else{
    lines.push('WB: нет свежих данных для dry-run; никаких изменений не выполняется.','');
  }
  lines.push('ЯНДЕКС МАРКЕТ');
  if(ym?.ok){
    lines.push(
      'Заказы вчера: '+n(ym?.total?.orders)+' · штук: '+n(ym?.total?.units)+' · выручка: '+rub(ym?.total?.revenue),
      'Отменено, шт.: '+n(ym?.total?.cancelledUnits)
    );
    if(Array.isArray(ymDecisions)&&ymDecisions.length){
      for(const d of ymDecisions){
        lines.push(
          (d.name||d.id)+': '+d.yesterdayUnits+' шт. вчера · цена '+(d.current?rub(d.current):'—')+' → '+(d.recommended?rub(d.recommended):'—'),
          'Защита: '+(d.safe?rub(d.safe):'—')+' · прибыль '+(d.current?rub(d.currentProfit):'—')+' → '+(d.recommended?rub(d.expectedProfit):'—'),
          'DRY-RUN: '+d.action+' — '+d.reason,
          ''
        );
      }
    }else{
      lines.push('Нет данных для расчёта рекомендаций по товарам.','');
    }
    if(!ymFinance?.ok) lines.push('Финансы Яндекс Маркета: '+String(ymFinance?.error||'временно недоступны').slice(0,180));
  }else{
    lines.push('Яндекс Маркет: ещё не подключён или временно недоступен.','');
  }
  lines.push('ИТОГ: единый dry-run активен. Ни Ozon, ни WB, ни Яндекс Маркет этим циклом цены не изменяют. Остальные товары исключены.');
  return lines.join('\n').slice(0,3900);
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  const secret=process.env.CRON_SECRET;
  const auth=String(req.headers?.authorization||'');
  if(!secret||auth!=='Bearer '+secret) return send(res,401,{ok:false,error:'Unauthorized'});

  try{
    const [seller,finance,analytics,promos,search,wbAnalytics,wbProducts,wbFinance,ym]=await Promise.all([
      jsonGet(APP_BASE+'/api/seller-products?storefront=1'),
      jsonGet(APP_BASE+'/api/bath-finance'),
      jsonGet(APP_BASE+'/api/bath-analytics'),
      jsonGet(APP_BASE+'/api/bath-promos'),
      jsonGet(APP_BASE+'/api/bath-search').catch(e=>({ok:false,error:e?.message||String(e)})),
      jsonGet(APP_BASE+'/api/wb-analytics').catch(e=>({ok:false,error:e?.message||String(e),items:[]})),
      jsonGet(APP_BASE+'/api/wb-products').catch(e=>({ok:false,error:e?.message||String(e),products:[]})),
      jsonGetCron(APP_BASE+'/api/wb-finance').catch(e=>({ok:false,error:e?.message||String(e),items:[]})),
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
    if(!UNIFIED_DRY_RUN&&managePromos&&hasWriteKey&&promoSet.size){
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
    if(!UNIFIED_DRY_RUN&&autoprice&&hasWriteKey&&!promoRemoved){
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

    const wbDecisions=wbDryRun(wbProducts,wbAnalytics,wbFinance,changeDay);
    const ymDecisions=ymDryRun(ym,ymFinance,changeDay);
    const date=analytics.dateTo||new Date(Date.now()-86400000).toISOString().slice(0,10);
    const mode='ЕДИНЫЙ DRY-RUN / без записи';
    const report=buildReport(date,decisions,mode,promoRemoved,!search?.ok,wbAnalytics,ym,ymFinance,wbDecisions,ymDecisions);
    const tg=await telegram(report);

    return send(res,200,{
      ok:true,
      date,
      mode,
      changeDay,
      fallbackFixed:r2(fallbackFixed),
      promoRemoved,
      promoResult,
      unifiedDryRun:UNIFIED_DRY_RUN,
      decisions,
      wbDecisions,
      ymDecisions,
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

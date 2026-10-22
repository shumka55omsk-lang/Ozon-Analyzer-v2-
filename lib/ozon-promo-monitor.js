'use strict';

// Promotions API lists ordinary Ozon discounts, NOT the separate
// "Сбор первых отзывов" and other Ozon Ads / Performance campaigns.
const MAX_DETAILS = 12;
const MAX_PAGES = 3;
const DAY = 86400000;
const number = v => Number.isFinite(Number(v)) ? Number(v) : 0;

function identifyActions(data, nowMs = Date.now()) {
  if (!Array.isArray(data?.result)) throw new Error('Ozon не вернул список акций');
  const today = new Date(nowMs).toISOString().slice(0,10);
  const until = nowMs + 14*DAY;
  const all = data.result;
  const participating = [];
  const plannedAutoAdd = [];
  for (const a of all) {
    const start = Date.parse(a.date_start || '');
    const end = Date.parse(a.date_end || '');
    const active = (!Number.isFinite(start) || start <= nowMs) && (!Number.isFinite(end) || end >= nowMs);
    const imminent = Number.isFinite(start) && start > nowMs && start <= until;
    const dates = (Array.isArray(a.auto_add_dates) ? a.auto_add_dates : [])
      .filter(x => Number.isFinite(Date.parse(x)))
      .filter(x => Date.parse(x) >= nowMs - 7*DAY && Date.parse(x) <= until)
      .map(x => String(x));
    const summary = {
      id: String(a.id || ''),
      title: String(a.title || 'Акция Ozon').slice(0,160),
      start: String(a.date_start || ''),
      end: String(a.date_end || ''),
      actionType: String(a.action_type || ''),
      count: number(a.participating_products_count),
      potentialCount: number(a.potential_products_count),
      active,
      imminent,
      autoAddDates: dates,
      isParticipating: a.is_participating === true || number(a.participating_products_count) > 0,
    };
    if (summary.isParticipating && (active || imminent)) participating.push(summary);
    if (dates.length && summary.potentialCount > 0) plannedAutoAdd.push(summary);
  }
  return {
    day: today,
    totalActions: all.length,
    participating: participating.sort((a,b) => Number(b.active)-Number(a.active) || b.count-a.count),
    plannedAutoAdd: plannedAutoAdd.sort((a,b)=>a.autoAddDates[0].localeCompare(b.autoAddDates[0])),
  };
}

async function inspectAction(fetchJson, a) {
  let cursor = '', checked = 0, auto = 0, sample = [];
  const ids = new Set();
  for(let page=0;page<MAX_PAGES;page++) {
    const resp = await fetchJson('/v1/actions/products', {
      method:'POST', body:{action_id:Number(a.id),limit:1000,last_id:cursor},
    });
    const result = resp?.result;
    if(!Array.isArray(result?.products)) throw new Error('Ozon не вернул товары акции '+a.id);
    checked += result.products.length;
    for(const p of result.products) {
      const id=String(p.id ?? p.product_id ?? '');
      if (id && ids.has(id)) continue;
      if(id) ids.add(id);
      const mode=String(p.add_mode||'');
      if (/AUTO/i.test(mode)) auto++;
      if(sample.length<4) sample.push({productId:id,mode,price:number(p.price),actionPrice:number(p.action_price)});
    }
    const next=String(result.last_id||'');
    if(!next) return {...a, productsChecked:checked, autoProducts:auto, samples:sample, complete:true};
    if(next===cursor || result.products.length===0) throw new Error('Неполная выгрузка товаров акции '+a.id);
    cursor=next;
  }
  return {...a, productsChecked:checked, autoProducts:auto, samples:sample, complete:false};
}

async function checkPromotions(fetchJson, nowMs=Date.now()) {
  const data=await fetchJson('/v1/actions',{method:'GET'});
  const found=identifyActions(data,nowMs);
  const candidates=found.participating.slice(0,MAX_DETAILS);
  const results=await Promise.all(candidates.map(async a=>{
    try {return await inspectAction(fetchJson,a);}
    catch(e){return {...a, error:String(e.message||e).slice(0,140),complete:false};}
  }));
  const warnings=[
    ...(found.participating.length>MAX_DETAILS?['Проверены товары только первых '+MAX_DETAILS+' акций, всего с участием: '+found.participating.length]:[]),
    ...results.filter(a=>a.complete===false).map(a=>'Состав акции '+a.id+' проверен не полностью: '+(a.error||'лимит страниц')),
  ];
  return {...found, details:results, warnings, apiCoverage:'regular_promotion_only'};
}

function formatPromotionReport(result) {
  if (!result?.ok) return [
    '⚠️ АКЦИИ OZON: проверить участие через API не удалось.',
    'Причина: '+String(result?.error||'неизвестная ошибка').slice(0,120),
  ].join('\n');
  const p = result.data;
  const l=['', '🛍 АКЦИИ И ПРОДВИЖЕНИЕ OZON (проверка через API)',
    'Найдено акций с участием: '+p.participating.length+'.'];
  if (p.participating.length) {
    for(const a of p.details.slice(0,8)) {
      l.push('• '+a.title+' [№'+a.id+'] · товаров '+a.count+
       (a.autoProducts?' · ⚠️ добавлены автоматически: '+a.autoProducts:'')+
       (a.start?' · начало '+a.start.slice(0,10):''));
      if(a.samples?.length) l.push('  ID товаров: '+a.samples.map(x=>x.productId).filter(Boolean).slice(0,4).join(', '));
    }
    if (p.participating.length>8) l.push('…и ещё '+(p.participating.length-8)+' акций.');
    l.push('⚠️ Проверьте, все ли участия разрешены вами. API не определяет факт согласия.');
  } else l.push('Обычных акций с подтверждённым участием API не обнаружил.');
  if(p.plannedAutoAdd.length){
    l.push('⚠️ Автодобавление товаров запланировано/недавно происходило:');
    for(const a of p.plannedAutoAdd.slice(0,5)) l.push('• '+a.title+' [№'+a.id+']: '+a.autoAddDates.map(x=>x.slice(0,10)).join(', '));
  }
  for(const w of p.warnings.slice(0,3)) l.push('⚠️ '+w);
  l.push('«Сбор первых отзывов», рекламные кампании Ozon Ads и личные уведомления могут НЕ входить в этот список.');
  return l.join('\n');
}
module.exports={identifyActions,inspectAction,checkPromotions,formatPromotionReport};

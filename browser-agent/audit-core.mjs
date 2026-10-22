import {createHash} from 'node:crypto';

const PAID=/сбор первых отзывов|первые отзывы|отзывы за баллы|ускоренн.{0,25}отзыв|балл.{0,20}отзыв|закреплен.{0,15}отзыв|подписк|платн|продвижен|реклам|бустинг|ставк|бюджет|оплат.{0,10}клик|автоматическ.{0,30}добав|подключен|автовключ|списан|платеж|изменен.{0,20}тариф|рост.{0,15}стоим|покупк.{0,10}отзыв/i;
const STRONG=/сбор первых отзывов|отзывы за баллы|ускоренн.{0,25}отзыв|закреплен.{0,15}отзыв|платн|автоматическ.{0,30}подключ|подключен|списан|включен|увеличен.{0,15}бюджет|автодобав|без.{0,10}соглас/i;
const ACTIVE=/(?:^|[^а-яё])(?:активен|активна|активно|работает|запущен[аоы]?|идет|идёт|в работе|подключен[аоы]?|включен[аоы]?)(?=$|[^а-яё])/i;
const STOPPED=/(?:остановлен|отключен[аоы]?|заверш[её]н[аоы]?|не активен|неактивен|в архиве)/i;

export const SECTIONS=[
  {id:'firstReviews',name:'Сбор первых отзывов'},
  {id:'notifications',name:'Уведомления'},
  {id:'promotionNews',name:'Новости продвижения'},
  {id:'campaigns',name:'Рекламные кампании'},
  {id:'paidServices',name:'Платные услуги и подписки'},
];
export function sellerUrl(input) {
  const url=new URL(input);
  if(url.protocol!=='https:'||url.hostname!=='seller.ozon.ru'||url.username||url.password) {
    throw new Error('Разрешены только страницы https://seller.ozon.ru');
  }
  if(/(?:token|access_token|authorization|code=)/i.test(url.hash+url.search)) throw new Error('URL содержит потенциальный секрет — сохранение запрещено');
  return url.toString();
}
export function normalize(text) {
  return String(text||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,' ').trim();
}
export function digest(section,text) {
  return createHash('sha256').update(section+'\n'+normalize(text).toLowerCase()).digest('hex').slice(0,24);
}
export function extractFindings(section,snapshot) {
  const rows=Array.isArray(snapshot.rows)?snapshot.rows:[];
  const lines=Array.isArray(snapshot.lines)?snapshot.lines:[];
  const texts=[...rows.map(normalize).filter(Boolean),...lines.map(normalize).filter(Boolean)];
  const seen=new Set();
  const findings=[];
  for(const full of texts) {
    const s=full.slice(0,340);
    if(s.length<10||s.length>340||seen.has(s.toLowerCase()))continue;
    seen.add(s.toLowerCase());
    let match=false,level='notice';
    if(section==='firstReviews'){
      const inRow=rows.some(x=>normalize(x)===full);
      match=(inRow&&ACTIVE.test(s)&&!STOPPED.test(s))||
            (STRONG.test(s)&&ACTIVE.test(s)&&!STOPPED.test(s));
      level=match?'urgent':'notice';
    } else if(section==='campaigns'||section==='paidServices'){
      match=PAID.test(s)&&ACTIVE.test(s)&&!STOPPED.test(s);
      level=STRONG.test(s)?'urgent':'warning';
    } else {
      match=PAID.test(s);
      level=STRONG.test(s)?'urgent':'warning';
    }
    if(!match)continue;
    findings.push({section,level,text:s,id:digest(section,s)});
    if(findings.length>=28)break;
  }
  return findings;
}
export function compareFindings(oldState,currentBySection,firstRun=false) {
  const fresh=[],totals={};
  for(const [section,items] of Object.entries(currentBySection)) {
    const previous=new Set(oldState?.sections?.[section]||[]);
    totals[section]=items.length;
    for(const f of items) if(!previous.has(f.id)) {
      // On the first run the baseline is unknown. Keep critical active risks
      // and sample other notices; never claim a new change existed yesterday.
      if(!firstRun||f.level==='urgent')fresh.push({...f,baseline:firstRun});
    }
  }
  return {fresh:fresh.slice(0,30),totals};
}
export function formatReport({time,checked,errors,fresh,totals,firstRun}) {
  const lines=[
    '🔐 OZON SELLER — браузерный контроль',
    'Проверка: '+time,
    'Разделов проверено: '+checked.length+'/5',
    firstRun?'Первый запуск: сохранён исходный снимок. Старые уведомления не считаются новыми.':'Изменения по сравнению с предыдущим успешным просмотром.',
  ];
  if(fresh.length) {
    lines.push('⚠️ Найдено потенциально важное:');
    for(const f of fresh.slice(0,12)) {
      const section=SECTIONS.find(s=>s.id===f.section)?.name||f.section;
      lines.push((f.level==='urgent'?'🚨 ':'• ')+section+': '+f.text.slice(0,180)+(f.baseline?' [существовало до первой проверки]':''));
    }
    if(fresh.length>12)lines.push('… ещё '+(fresh.length-12)+' записей.');
  } else lines.push('Новых подозрительных записей в успешно открытых разделах не обнаружено.');
  if(errors.length) {
    lines.push('❗ НЕ УДАЛОСЬ ПРОВЕРИТЬ:');
    for(const e of errors)lines.push('• '+e.section+': '+e.reason.slice(0,130));
    lines.push('Вывод «платных услуг нет» делать нельзя.');
  }
  lines.push('Критические записи требуют проверки владельцем: видимый статус не доказывает согласие/несогласие.');
  lines.push('Цены, акции и услуги НЕ менялись.');
  return lines.join('\n').slice(0,3900);
}

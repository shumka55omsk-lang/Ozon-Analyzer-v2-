'use strict';
const HIGH_RISK = /подписк|премиум|premium|subscription|отзыв|закрепл.{0,18}отзыв|топ.?автор|review|review.{0,15}manage|реклам|продвиж|маркетинг|promo|promot|advert|boost|буст|трафик|инструмент|выплат.*кажд|daily.*payout/i;

function rubleAmount(input) {
  if (input && typeof input === 'object') {
    if (input.currency && input.currency !== 'RUB') return null;
    input = input.amount;
  }
  if (typeof input !== 'number' && typeof input !== 'string') return null;
  if (String(input).trim() === '') return null;
  const num = Number(input);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

function indexCharges(accruals, typeMap) {
  const chargeMap = new Map();
  let unclassified = 0;
  function add(scope, typeId, money) {
    const amount = rubleAmount(money);
    if (amount === null) { unclassified++; return; }
    if (amount >= 0) return;
    const id = String(typeId ?? 'unknown');
    const type = typeMap[id] || {name: 'Тип ' + id, description: ''};
    const label = String(type.description || type.name || ('Тип ' + id)).trim();
    // Item-level fees include ordinary transaction processing. Include only
    // names pointing to optional paid services; retain all seller-level fees.
    if (scope === 'item' && !HIGH_RISK.test(type.name + ' ' + type.description)) return;
    const key = scope + ':' + id;
    const row = chargeMap.get(key) || {key, typeId: id, scope, name: label, amount: 0, count: 0};
    row.amount = Math.round((row.amount - amount) * 100) / 100;
    row.count++;
    chargeMap.set(key, row);
  }
  for (const acc of accruals || []) {
    if (acc?.non_item_fee) add('seller', acc.non_item_fee.type_id, acc.non_item_fee.accrued);
    for (const group of acc?.item_fees?.fees || []) {
      for (const fee of group?.fees || []) add('item', fee.type_id, fee.accrued);
    }
  }
  return {chargeMap, unclassified};
}

function analyze({recent, history, types, subscription, expectedSubscription = '', allowedTypes = ''}) {
  const typeMap = Object.fromEntries((types || []).map(t => [String(t.id), {name: String(t.name || ''), description: String(t.description || '')}]));
  const newCharges = indexCharges(recent, typeMap);
  const oldCharges = indexCharges(history, typeMap);
  const allowed = new Set(String(allowedTypes).split(',').map(s => s.trim()).filter(Boolean));
  const charges = [...newCharges.chargeMap.values()].sort((a,b) => b.amount - a.amount);
  const suspicious = charges.filter(c => !allowed.has(c.typeId) && !oldCharges.chargeMap.has(c.key));
  const isPremium = subscription?.is_premium === true;
  const tier = String(subscription?.type || (isPremium ? 'Premium' : 'без Premium'));
  const expected = String(expectedSubscription).trim();
  const unexpectedPremium = isPremium && (!expected || expected !== tier);
  return {
    tier, isPremium, unexpectedPremium,
    expectedTier: expected || null, charges, suspicious,
    unclassified: newCharges.unclassified,
    warnings: [
      ...(newCharges.unclassified ? ['Некоторые суммы списаний не удалось распознать.'] : []),
      ...(!Array.isArray(recent) || !Array.isArray(history) ? ['Неполные данные начислений.'] : []),
    ],
  };
}

function formatMoney(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' ₽';
}

function composeReport(date, report) {
  const lines = [
    '🔎 Ozon · проверка платных услуг (' + date + ', UTC)',
    'Подписка: ' + report.tier + (report.isPremium ? ' (активна)' : ' (Premium нет)'),
  ];
  const reviewCharges=report.charges.filter(c=>/отзыв|топ.?автор|review|закрепл/i.test(c.name));
  if (reviewCharges.length) lines.push('🚨 ПЛАТНЫЕ ОТЗЫВЫ: обнаружены начисления '+formatMoney(reviewCharges.reduce((s,c)=>s+c.amount,0))+'. Проверьте «Сбор первых отзывов» и «Закрепление отзывов» в кабинете.');
    if (report.unexpectedPremium) {
    lines.push('⚠️ Активная Premium-подписка не подтверждена в списке разрешённых. Проверьте её в Seller.');
  }
  if (report.suspicious.length) {
    lines.push('⚠️ Новые виды списаний (не встречались за предыдущие 7 дней):');
    for (const c of report.suspicious.slice(0, 12)) {
      lines.push('• ' + c.name + ' [' + c.typeId + '] — ' + formatMoney(c.amount) + (c.scope === 'seller' ? ' · по кабинету' : ' · по товарам'));
    }
    if (report.suspicious.length > 12) lines.push('…ещё ' + (report.suspicious.length - 12) + ' вида(-ов)');
  } else {
    lines.push('Новых видов списаний в отслеживаемых категориях за день не обнаружено.');
  }
  if (report.charges.length) {
    lines.push('Всего отслеживаемых платных начислений за день: ' + formatMoney(report.charges.reduce((sum,c) => sum + c.amount, 0)) + '.');
    lines.push('Все обнаруженные категории за день:');
    for (const c of report.charges.slice(0, 10)) lines.push('• ' + c.name + ' [' + c.typeId + '] — ' + formatMoney(c.amount));
    if (report.charges.length > 10) lines.push('…ещё ' + (report.charges.length - 10) + ' категорий');
  } else lines.push('Отслеживаемых платных начислений за день не обнаружено.');
  for (const w of report.warnings) lines.push('⚠️ ' + w);
  lines.push('Проверьте в Seller → Товары → «Сбор первых отзывов»: через обычный API этот инструмент не проверяется до начисления.');
  lines.push('Уведомления/«Новости продвижения» личного кабинета также не доступны через Seller API.');
  lines.push('Никакие услуги, цены и рекламные кампании не изменены.');
  return lines.join('\n').slice(0, 3950);
}

module.exports = {rubleAmount, indexCharges, analyze, composeReport};

'use strict';

const config = require('../config/bath-pricing.json');
const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const r2 = value => finite(value) ? Math.round(value * 100) / 100 : null;
const ceil10 = value => Math.ceil(value / 10) * 10;

function policyFor(productId) {
  const product = config.products[String(productId)];
  if (!product) return null;
  return {...config, ...product, products: undefined, productId: String(productId)};
}

function economics(product, finance, policy, fallbackFixed) {
  const effective = Number(product.sellerPrice || product.price);
  const own = finance && finance.unitEconomicsVerified === true && Number(finance.postingHits) >= 5 &&
    finite(finance.avgDeliveryAndOther) && finance.avgDeliveryAndOther >= 0;
  const fixed = own ? finance.avgDeliveryAndOther :
    (finite(fallbackFixed) && fallbackFixed >= 0 ? fallbackFixed : 120);
  const field = {FBO:'salesPercentFbo', FBS:'salesPercentFbs', RFBS:'salesPercentRfbs'}[policy.scheme];
  const rates = [product.salesPercentFbo, product.salesPercentFbs].filter(positive);
  // Unknown scheme: conservative preview only, never an executable decision.
  const commissionPct = field ? product[field] : (rates.length ? Math.max(...rates) : NaN);
  const acquiringRate = positive(effective) && finite(product.acquiring) && product.acquiring >= 0
    ? product.acquiring / effective : NaN;
  const retention = 1 - commissionPct / 100 - acquiringRate;
  const valid = positive(effective) && finite(commissionPct) && commissionPct >= 0 &&
    positive(retention) && retention <= 1 && finite(policy.cogs) && policy.cogs >= 0 &&
    finite(policy.extra) && policy.extra >= 0 && positive(policy.minProfit) &&
    finite(policy.targetProfit) && policy.targetProfit >= policy.minProfit;
  const profitAt = price => valid && positive(price)
    ? price * retention - fixed - policy.cogs - policy.extra : null;
  const floorAt = profit => valid && finite(profit)
    ? ceil10((fixed + policy.cogs + policy.extra + profit) / retention) : null;
  return {
    valid, effective, fixed, commissionPct, retention, acquiringRate,
    financeSource: own ? 'own_estimate' : 'fallback',
    settlementReconciled: finance?.settlementReconciled === true && finance?.unallocatedCostsReviewed === true,
    // Aggregated accruals do not yet establish per-unit completeness or settlement mapping.
    reliable: !!(valid && own && field && finance.unitEconomicsVerified === true &&
      finance.settlementReconciled === true && finance.unallocatedCostsReviewed === true),
    profitAt, floorAt
  };
}

function freshObservation(row, now, hours) {
  const time = Date.parse(row?.observedAt);
  return !!(row && row.verified === true && row.inStock === true &&
    row.finalBuyerPrice === true && positive(row.price) &&
    typeof row.source === 'string' && row.source.trim() &&
    typeof row.contextKey === 'string' && row.contextKey.trim() &&
    Number.isFinite(time) && time <= now && now - time <= hours * 3600000);
}

function marketFor(policy, snapshot, now = Date.now()) {
  const missing = reason => ({ready:false, targetBuyerPrice:null, reason});
  if (!policy.competitors?.length) return missing('Не выбраны сопоставимые конкуренты.');
  const own = snapshot?.own;
  if (!freshObservation(own, now, policy.observationMaxAgeHours))
    return missing('Нет свежей подтверждённой цены нашего товара со всеми скидками.');
  const peers = [];
  for (const id of policy.competitors) {
    const row = snapshot?.competitors?.[id];
    if (!freshObservation(row, now, policy.observationMaxAgeHours) || row.contextKey !== own.contextKey)
      return missing('Неполные или несопоставимые цены выбранных конкурентов.');
    peers.push({...row, id});
  }
  peers.sort((a,b) => a.price - b.price);
  const competitor = peers[0];
  const target = r2(competitor.price - policy.competitorGap);
  if (!positive(target)) return missing('Цена конкурента не позволяет применить отступ 10 ₽.');
  return {ready:true, ownBuyerPrice:own.price, competitor, targetBuyerPrice:target,
    contextKey:own.contextKey, observedAt:own.observedAt,
    reason:'Минимальная сопоставимая цена выбранных конкурентов минус '+policy.competitorGap+' ₽.'};
}

function stageFor(policy, daily, dateTo) {
  const no = reason => ({eligible:false, nextTarget:policy.targetProfit, reason});
  if (!policy.stageStartedAt) return no('Отсчёт ступени ещё не запущен: dry-run не считается периодом продаж по новой стратегии.');
  const end = Date.parse(dateTo + 'T00:00:00Z');
  const start = Date.parse(policy.stageStartedAt);
  const days = policy.observationDays;
  if (!Number.isFinite(end) || !Number.isFinite(start) || !Number.isInteger(days) || days < 1 ||
      end + DAY - start < days * DAY) return no('Период наблюдения ещё не завершён.');
  const map = new Map();
  for (const row of daily || []) {
    if (map.has(row.day)) return no('Повторяющиеся дни в истории заказов.');
    map.set(row.day, row);
  }
  let previous = 0, recent = 0;
  for (let i = 0; i < days * 2; i++) {
    const day = new Date(end - i * DAY).toISOString().slice(0,10);
    const row = map.get(day);
    // A missing day is not silently converted to zero sales.
    if (!row || !finite(row.orders) || row.orders < 0) return no('Нужны две полные недели дневной истории.');
    if (i < days) recent += row.orders; else previous += row.orders;
  }
  if (previous < policy.minWindowOrders || recent < policy.minWindowOrders)
    return no('Недостаточно заказов для оценки стабильности.');
  if (recent / previous < policy.stableOrderRatio) return no('Заказы снизились более допустимого уровня.');
  return {eligible:true, nextTarget:policy.targetProfit + policy.profitStep,
    previousOrders:previous, recentOrders:recent,
    reason:'Заказы стабильны; можно проверить следующую ступень прибыли.'};
}

function decide({product, finance, analytics, promo, fallbackFixed, changeDay, policy,
  snapshot, now = Date.now()}) {
  const model = economics(product, finance, policy, fallbackFixed);
  const daily = (analytics?.rows || []).filter(x => String(x.productId) === String(product.productId))
    .map(x => ({day:x.day, orders:x.metrics?.ordered_units, revenue:x.metrics?.revenue}));
  daily.sort((a,b) => a.day.localeCompare(b.day));
  const stage = stageFor(policy, daily, analytics?.dateTo);
  const historyEnd = Date.parse(analytics?.dateTo + 'T00:00:00Z');
  const historyFresh = Number.isFinite(historyEnd) && historyEnd <= now && now - historyEnd < 2 * DAY;
  if (!historyFresh) {
    stage.eligible = false;
    stage.reason = 'Дневная история заказов устарела или отсутствует.';
  }
  const market = marketFor(policy, snapshot, now);
  const base = Number(product.basePrice || product.price);
  const promoPrice = Number(promo?.actionPrice || 0);
  const current = promo ? promoPrice : base;
  const currentProfit = model.profitAt(model.effective);
  if (stage.eligible) {
    const nextFloor = model.floorAt(stage.nextTarget);
    const buyerCap = market.ready && positive(current)
      ? current * market.targetBuyerPrice / market.ownBuyerPrice : null;
    stage.safePrice = nextFloor;
    if (!model.reliable || !market.ready || !positive(nextFloor) || nextFloor > buyerCap ||
        nextFloor > current * (1 + policy.maxPriceStep) ||
        (promo && (snapshot?.promoSettlementVerified !== true || nextFloor > Number(promo.maxActionPrice)))) {
      stage.eligible = false;
      stage.reason = 'Следующая ступень пока не подтверждена расходами, рыночной ценой или лимитом шага.';
    }
  }
  const result = {
    marketplace:'Ozon', productId:String(product.productId), offerId:String(product.offerId || ''), name:product.name,
    action:'HOLD', reason:'', executable:false, requiresApproval:false,
    currentBase:base, effective:model.effective, currentPromoPrice:promoPrice,
    promoActive:!!promo, promoMaxActionPrice:Number(promo?.maxActionPrice || 0),
    newPrice:base, recommendedPrice:model.effective, recommendedPromoPrice:promoPrice,
    currentProfit:r2(currentProfit), recommendedProfit:r2(currentProfit),
    safeFloor:model.floorAt(policy.targetProfit), minProfit:policy.minProfit, targetProfit:policy.targetProfit,
    fixed:model.fixed, commissionPct:model.commissionPct, financeSource:model.financeSource,
    financeReliable:model.reliable, settlementReconciled:model.settlementReconciled,
    financeAuditStatus:model.settlementReconciled ? 'reconciled' : 'pending_settlement_reconciliation',
    market, stage, proposal:null,
    buyerPriceReliable:market.ready, buyerPriceObserved:market.ready ? market.ownBuyerPrice : null,
    yesterdayOrders:daily.at(-1)?.orders || 0, yesterdayRevenue:daily.at(-1)?.revenue || 0
  };
  const hold = reason => ({...result, reason});
  if (!model.valid || !positive(current)) return hold('Некорректные финансовые данные — изменение запрещено.');
  if (!model.reliable) return hold('Финансовый аудит не завершён: необходима сверка начислений, себестоимости и нераспределённых расходов. Только dry-run.');
  if (!market.ready) return hold(market.reason);
  // Moving action_price is not assumed to move seller settlement one-to-one.
  if (promo && snapshot?.promoSettlementVerified !== true)
    return hold('Не подтверждена связь action_price с выплатой продавцу.');
  if (!promo && (product.ozonActionsExist || product.sellerActionsExist || Math.abs(base - model.effective) > 0.01))
    return hold('Есть скидка или акция: влияние базовой цены на выплату не подтверждено.');
  const target = market.targetBuyerPrice;
  const buyer = market.ownBuyerPrice;
  const step = policy.maxPriceStep;
  let candidate = current;
  let action;
  if (buyer > target) {
    candidate = Math.ceil(Math.max(current * target / buyer, current * (1-step)));
    action = promo ? 'LOWER_PROMO' : 'LOWER';
  } else if (buyer < target || (currentProfit !== null && currentProfit < policy.targetProfit)) {
    candidate = Math.floor(Math.min(current * target / buyer, current * (1+step)));
    action = promo ? 'RAISE_PROMO' : 'RAISE';
  } else return hold('Цена покупателя соответствует ориентиру; текущую цену сохраняем.');
  if (promo) candidate = Math.min(candidate, base, Number(promo.maxActionPrice || 0));
  if (candidate === current || candidate <= 0 || (action.startsWith('RAISE') && candidate < current))
    return hold('Нет допустимого шага в пределах рыночной цели и лимитов акции.');
  const candidateProfit = model.profitAt(candidate);
  const buyerEstimate = buyer * candidate / current;
  result.proposal = {action, price:candidate, expectedProfit:r2(candidateProfit),
    buyerEstimate:r2(buyerEstimate), targetBuyerPrice:target, competitorId:market.competitor.id,
    competitorPrice:market.competitor.price, observedAt:market.competitor.observedAt,
    contextKey:market.contextKey};
  if (Math.abs(candidate-current)/current > step + 1e-9)
    return hold('Округление нарушает лимит шага цены.');
  if (!finite(candidateProfit) || candidateProfit < policy.targetProfit)
    return hold('Рыночная цена конфликтует с текущей целью прибыли '+policy.targetProfit+' ₽. Снижение защиты не разрешено.');
  if (action.startsWith('LOWER')) {
    result.requiresApproval = true;
    return hold('Конкурент '+market.competitor.price+' ₽; наша цель '+target+' ₽. Снизить цену? Требуется отдельное подтверждение владельца.');
  }
  if (!changeDay) return hold('День наблюдения: предложение рассчитано, цены не меняем.');
  if (!historyFresh) return hold('Повышение запрещено: дневная история заказов устарела.');
  if (!model.reliable) return hold('Расходы или схема не подтверждены; предложение не допускается к исполнению.');
  const last = daily.slice(-2), previous = daily.slice(0,-2);
  const avg = rows => rows.length ? rows.reduce((s,x)=>s+x.orders,0)/rows.length : 0;
  if (last.length < 2 || previous.length < 5 || avg(previous) < 3 || avg(last)/avg(previous) < policy.stableOrderRatio)
    return hold('Недостаточно стабильных заказов для повышения цены.');
  result.action = action;
  result.newPrice = promo ? base : candidate;
  result.recommendedPrice = candidate;
  result.recommendedPromoPrice = promo ? candidate : promoPrice;
  result.recommendedProfit = r2(candidateProfit);
  result.recommendedBuyerEstimate = r2(buyerEstimate);
  result.reason = 'Dry-run: шаг к цене конкурента минус 10 ₽; прибыль после шага проверена.';
  // Even verified recommendations remain non-executable until a live executor is separately enabled.
  return result;
}

module.exports = {policyFor, economics, marketFor, stageFor, decide};

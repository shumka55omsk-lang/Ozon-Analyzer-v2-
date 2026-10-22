'use strict';
const {analyze, composeReport} = require('../lib/ozon-paid-audit');
const OZON_URL = 'https://api-seller.ozon.ru';

function respond(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function postOzon(path, body, key, method='POST') {
  const clientId = process.env.OZON_CLIENT_ID;
  if (!clientId || !key) throw new Error('Ключ для чтения Ozon API не настроен');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(OZON_URL + path, {
      method,
      headers: {'Client-Id': clientId, 'Api-Key': key, 'Content-Type': 'application/json'},
      body: method==='GET' ? undefined : JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Ozon API ' + path + ': HTTP ' + r.status);
    return data;
  } finally { clearTimeout(timer); }
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('Telegram-бот не настроен');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({chat_id: chat, text: message, disable_web_page_preview: true}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Telegram HTTP ' + response.status);
    const result = await response.json();
    if (!result.ok) throw new Error('Telegram отклонил сообщение');
  } finally { clearTimeout(timer); }
}

async function loadDay(date, key) {
  const result = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < 80; page++) {
    const data = await postOzon('/v1/finance/accrual/by-day', {date, last_id: cursor}, key);
    if (!Array.isArray(data.accruals)) throw new Error('Неполные начисления Ozon за ' + date);
    result.push(...data.accruals);
    const next = String(data.last_id || '');
    if (!next) return result;
    if (!data.accruals.length || next === cursor || seen.has(next)) throw new Error('Сбой курсора Ozon за ' + date);
    seen.add(next);
    cursor = next;
  }
  throw new Error('Превышен лимит страниц Ozon за ' + date);
}

function daysAgo(n) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - n)).toISOString().slice(0,10);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return respond(res, 405, {ok:false, error:'GET only'});
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) return respond(res, 401, {ok:false, error:'Unauthorized'});
  let telegramSent = false;
  try {
    const financeKey = process.env.OZON_FINANCE_API_KEY || process.env.OZON_API_KEY;
    const sellerKey = process.env.OZON_API_KEY || financeKey;
    if (!financeKey || !sellerKey) throw new Error('Ozon API ключи отсутствуют');
    const [seller, types] = await Promise.all([
      postOzon('/v1/seller/info', {}, sellerKey),
      postOzon('/v1/finance/accrual/types', {}, financeKey),
    ]);
    if (!seller.subscription || !Array.isArray(types.accrual_types)) throw new Error('Ozon не вернул статус подписки или справочник начислений');
    const recentDay = daysAgo(1);
    const recent = await loadDay(recentDay, financeKey);
    // Seven-day historical baseline, separate from yesterday's statement.
    const history = [];
    for (let d = 2; d <= 8; d++) history.push(...await loadDay(daysAgo(d), financeKey));
    const report = analyze({
      recent, history, types: types.accrual_types, subscription: seller.subscription,
      expectedSubscription: process.env.OZON_EXPECTED_SUBSCRIPTION || '',
      allowedTypes: process.env.OZON_ALLOWED_ACCRUAL_TYPE_IDS || '',
    });
    const {checkPromotions,formatPromotionReport}=require('./ozon-promo-monitor');
    let promo;
    try {
      promo={ok:true,data:await checkPromotions((path,opts={})=>
        postOzon(path,opts.body,sellerKey,opts.method||'POST'))};
    } catch(e) {
      promo={ok:false,error:String(e.message||e).slice(0,140)};
    }
    await sendTelegram(composeReport(recentDay, report));
    telegramSent = true;
    await sendTelegram(formatPromotionReport(promo));
    return respond(res, 200, {ok:true, telegramSent, reviewedDay: recentDay,
      detectedNewTypes: report.suspicious.length, premium: report.isPremium,
      sellerLevelFees: report.charges.filter(c => c.scope === 'seller').length,
      promotionsChecked:promo.ok,promotionsParticipating:promo.ok?promo.data.participating.length:null,
      limitations: ['Некоторые платные услуги, рекламные кампании и личные уведомления видны только в кабинете Ozon']});
  } catch (e) {
    const message = String(e?.message || e).replace(/(?:Api-Key|Client-Id|Bearer)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 180);
    try {
      await sendTelegram('⚠️ Ozon: ежедневная проверка платных услуг НЕ ЗАВЕРШЕНА. Данные не подтверждены. Ошибка: ' + message);
      telegramSent = true;
    } catch (_) { /* Failure is visible in response/runtime logs. */ }
    return respond(res, 503, {ok:false, telegramSent, error:'Проверка не завершена, см. Vercel Logs'});
  }
};

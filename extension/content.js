function txt(v) {
  return String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
function num(v) {
  const s = txt(v).replace(/[^0-9,.-]/g, '').replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function rubles(v) {
  const raw = txt(v);
  const matches = [...raw.matchAll(/(\d[\d\s\u00a0]{0,12})\s*₽/g)]
    .map(m => Number(m[1].replace(/[\s\u00a0]/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  return matches;
}
function meta(name, attr = 'property') {
  return document.querySelector(`meta[${attr}="${name}"]`)?.content || '';
}
function getJsonLd() {
  const out = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent || '');
      if (Array.isArray(j)) out.push(...j); else if (j) out.push(j);
    } catch {}
  }
  const flat = [];
  const walk = x => {
    if (!x || typeof x !== 'object') return;
    flat.push(x);
    if (Array.isArray(x['@graph'])) x['@graph'].forEach(walk);
  };
  out.forEach(walk);
  return flat.find(x => x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product'))) || null;
}
function getWidget(name) {
  return document.querySelector(`[data-widget="${name}"]`);
}
function getSku() {
  const m = location.pathname.match(/-(\d{6,})(?:\/|$)/) || location.pathname.match(/\/(\d{6,})(?:\/|$)/);
  return m ? m[1] : '';
}
function parseWeightKg(text) {
  let m = text.match(/(?:Вес товара с упаковкой|Вес в упаковке|Вес товара)[^\d]{0,40}(\d+(?:[.,]\d+)?)\s*(кг|г)\b/i);
  if (!m) return null;
  let n = Number(m[1].replace(',', '.'));
  if (m[2].toLowerCase() === 'г') n /= 1000;
  return Number.isFinite(n) ? n : null;
}
function parseDims(text) {
  const patterns = [
    /(?:Габариты упаковки|Размер упаковки|Размеры упаковки)[^\d]{0,60}(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(мм|см|м)?/i,
    /(?:Длина упаковки)[^\d]{0,30}(\d+(?:[.,]\d+)?)[\s\S]{0,140}?(?:Ширина упаковки)[^\d]{0,30}(\d+(?:[.,]\d+)?)[\s\S]{0,140}?(?:Высота упаковки)[^\d]{0,30}(\d+(?:[.,]\d+)?)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let vals = [1,2,3].map(i => Number(m[i].replace(',', '.')));
    const unit = (m[4] || 'см').toLowerCase();
    if (unit === 'мм') vals = vals.map(v => v / 10);
    if (unit === 'м') vals = vals.map(v => v * 100);
    if (vals.every(Number.isFinite)) return { lengthCm: vals[0], widthCm: vals[1], heightCm: vals[2] };
  }
  return { lengthCm: null, widthCm: null, heightCm: null };
}
function pickCurrentPrice(ld) {
  const values = [];
  const push = v => { const n = Number(String(v ?? '').replace(/[^0-9.,]/g, '').replace(',', '.')); if (Number.isFinite(n) && n > 0) values.push(n); };
  push(ld?.offers?.price);
  push(meta('product:price:amount'));
  for (const name of ['webPrice','webSale','webStickyProducts']) {
    const node = getWidget(name);
    if (node) values.push(...rubles(node.innerText));
  }
  if (!values.length) {
    const topText = txt(document.body?.innerText || '').slice(0, 12000);
    values.push(...rubles(topText).slice(0, 8));
  }
  const sane = values.filter(n => n >= 10 && n <= 10000000);
  return sane.length ? sane[0] : null;
}
function extractCategory() {
  const links = [...document.querySelectorAll('a[href*="/category/"]')]
    .map(a => txt(a.textContent))
    .filter(x => x && x.length < 80);
  return [...new Set(links)].slice(-3).join(' → ');
}
function extractSeller(bodyText) {
  const w = getWidget('webCurrentSeller') || getWidget('webSeller') || document.querySelector('[data-widget*="Seller"]');
  if (w) {
    const lines = txt(w.innerText).split(/\n+/).map(txt).filter(Boolean);
    if (lines.length) return lines[0].slice(0, 120);
  }
  const m = bodyText.match(/(?:Продавец|Магазин)\s*[:\n]?\s*([^\n]{2,100})/i);
  return m ? txt(m[1]) : '';
}
function extractRating(ld) {
  const n = Number(ld?.aggregateRating?.ratingValue);
  if (Number.isFinite(n)) return n;
  const w = getWidget('webSingleProductScore') || document.querySelector('[data-widget*="Score"]');
  const m = txt(w?.innerText).match(/\b([1-5](?:[.,]\d)?)\b/);
  return m ? Number(m[1].replace(',', '.')) : null;
}
function extractOzonProduct() {
  if (!/(^|\.)ozon\.ru$/i.test(location.hostname)) return { ok: false, error: 'Открыта не страница Ozon' };
  const bodyText = txt(document.body?.innerText || '');
  if (/доступ к сайту ограничен|проверяем, что вы не робот|captcha|ошибка 403/i.test(bodyText.slice(0, 5000))) {
    return { ok: false, error: 'Ozon показал проверку/антибот даже в браузере' };
  }
  const ld = getJsonLd();
  const heading = getWidget('webProductHeading')?.querySelector('h1') || document.querySelector('h1');
  const name = txt(heading?.innerText || ld?.name || meta('og:title') || document.title).replace(/\s*[|—-]\s*OZON.*$/i, '');
  const price = pickCurrentPrice(ld);
  const weightKg = parseWeightKg(bodyText);
  const dims = parseDims(bodyText);
  const image = txt(Array.isArray(ld?.image) ? ld.image[0] : ld?.image || meta('og:image'));
  const product = {
    sku: txt(ld?.sku) || getSku(),
    name,
    price,
    category: txt(ld?.category) || extractCategory(),
    seller: extractSeller(bodyText),
    rating: extractRating(ld),
    image,
    weightKg,
    ...dims
  };
  if (!product.name && !product.price) return { ok: false, error: 'Карточка открылась, но название и цена не найдены' };
  return { ok: true, source: 'Chrome / страница Ozon', product, warning: (!weightKg && !dims.lengthCm) ? 'Название и цена получены; габариты/вес не найдены на видимой странице — проверьте вручную.' : '' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OZON_EXTRACT_PAGE') {
    try { sendResponse(extractOzonProduct()); }
    catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
  }
  if (msg?.type === 'OZON_CONTENT_PING') sendResponse({ ok: true });
});

window.addEventListener('message', event => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== 'OZON_ANALYZER_PAGE') return;
  if (msg.type === 'OZON_ANALYZER_PING') {
    chrome.runtime.sendMessage({ type: 'OZON_EXTENSION_PING' }, response => {
      window.postMessage({ source: 'OZON_ANALYZER_EXTENSION', type: 'OZON_ANALYZER_PONG', requestId: msg.requestId, response: response || null }, '*');
    });
  }
  if (msg.type === 'OZON_ANALYZER_REQUEST') {
    chrome.runtime.sendMessage({ type: 'OZON_FETCH_PRODUCT', url: msg.url }, response => {
      const err = chrome.runtime.lastError?.message;
      window.postMessage({ source: 'OZON_ANALYZER_EXTENSION', type: 'OZON_ANALYZER_RESPONSE', requestId: msg.requestId, response: response || { ok: false, error: err || 'Нет ответа расширения' } }, '*');
    });
  }
});

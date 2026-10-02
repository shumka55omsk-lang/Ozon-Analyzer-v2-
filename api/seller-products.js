const BASE = 'https://api-seller.ozon.ru';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function ozonPost(path, body) {
  const clientId = process.env.OZON_CLIENT_ID;
  const apiKey = process.env.OZON_API_KEY;

  if (!clientId || !apiKey) {
    const err = new Error('На сервере не настроены OZON_CLIENT_ID / OZON_API_KEY');
    err.status = 500;
    throw err;
  }

  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body || {})
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text.slice(0, 1200) }; }

  if (!r.ok) {
    const err = new Error(
      data?.message ||
      data?.error?.message ||
      data?.error ||
      ('Ozon API HTTP ' + r.status)
    );
    err.status = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeItems(data) {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.result?.items)) return data.result.items;
  if (Array.isArray(data?.result)) return data.result;
  return [];
}

async function loadAllPrices() {
  const all = [];
  let cursor = '';

  for (let page = 0; page < 20; page++) {
    const body = {
      filter: { visibility: 'ALL' },
      limit: 1000
    };
    if (cursor) body.cursor = cursor;

    const data = await ozonPost('/v5/product/info/prices', body);
    const items = normalizeItems(data);
    all.push(...items);

    const next = data?.cursor || data?.result?.cursor || '';
    if (!next || next === cursor || items.length === 0) break;
    cursor = next;
  }

  return all;
}

async function loadInfo(productIds) {
  const map = new Map();

  for (let i = 0; i < productIds.length; i += 1000) {
    const ids = productIds.slice(i, i + 1000);
    if (!ids.length) continue;

    const candidates = [
      { product_id: ids.map(String) },
      { filter: { product_id: ids.map(String) }, limit: 1000 }
    ];

    let data = null;
    let lastErr = null;

    for (const body of candidates) {
      try {
        data = await ozonPost('/v3/product/info/list', body);
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!data) throw lastErr || new Error('Не удалось получить информацию о товарах');

    for (const item of normalizeItems(data)) {
      const id = String(item?.id ?? item?.product_id ?? '');
      if (id) map.set(id, item);
    }
  }

  return map;
}

function imageOf(item) {
  const candidates = [
    item?.primary_image,
    item?.primary_image?.[0],
    item?.images?.[0],
    item?.images360?.[0]
  ];

  for (const x of candidates) {
    if (typeof x === 'string' && x) return x;
    if (x && typeof x === 'object') {
      if (typeof x.file_name === 'string') return x.file_name;
      if (typeof x.url === 'string') return x.url;
    }
  }
  return '';
}

function priceObj(p) {
  return p?.price || p?.prices || {};
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { ok: false, error: 'Используйте GET' });
  }

  try {
    const prices = await loadAllPrices();
    const ids = [...new Set(
      prices.map(x => String(x?.product_id ?? x?.id ?? '')).filter(Boolean)
    )];

    let info = new Map();
    let warning = '';

    try {
      info = await loadInfo(ids);
    } catch (e) {
      warning = 'Цены получены, но подробные названия товаров загрузились не полностью: ' + (e?.message || 'ошибка Ozon API');
    }

    const products = prices.map(p => {
      const id = String(p?.product_id ?? p?.id ?? '');
      const d = info.get(id) || {};
      const pr = priceObj(p);
      const commissions = p?.commissions || {};
      const indexes = p?.price_indexes || {};

      const currentPrice = num(
        pr?.marketing_seller_price ??
        pr?.price ??
        p?.marketing_seller_price ??
        p?.price
      );

      return {
        productId: id,
        offerId: String(p?.offer_id ?? d?.offer_id ?? ''),
        name: d?.name || p?.name || ('Товар ' + (p?.offer_id || id)),
        image: imageOf(d),
        currency: pr?.currency_code || p?.currency_code || 'RUB',

        price: currentPrice,
        sellerPrice: num(pr?.price ?? p?.price),
        oldPrice: num(pr?.old_price ?? p?.old_price),
        minPrice: num(pr?.min_price ?? p?.min_price),
        marketingSellerPrice: num(pr?.marketing_seller_price ?? p?.marketing_seller_price),
        netPrice: num(pr?.net_price ?? p?.net_price),

        acquiring: num(p?.acquiring),
        volumeWeight: num(p?.volume_weight),
        salesPercentFbo: num(commissions?.sales_percent_fbo),
        salesPercentFbs: num(commissions?.sales_percent_fbs),
        salesPercentRfbs: num(commissions?.sales_percent_rfbs),

        priceIndexColor: indexes?.color_index || '',
        ozonIndexPrice: num(indexes?.ozon_index_data?.min_price),
        externalIndexPrice: num(indexes?.external_index_data?.min_price),

        autoActionEnabled: !!pr?.auto_action_enabled,
        archived: !!d?.is_archived
      };
    });

    products.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    return send(res, 200, {
      ok: true,
      readOnly: true,
      total: products.length,
      products,
      warning,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    const status = Number(e?.status) || 500;
    let hint = '';

    if (status === 401 || status === 403) {
      hint = 'Проверьте Client ID, API-ключ и права ключа на чтение товаров/цен.';
    }

    return send(res, status >= 400 && status < 600 ? status : 500, {
      ok: false,
      error: e?.message || 'Не удалось получить данные Ozon',
      hint,
      details: e?.details || undefined
    });
  }
};

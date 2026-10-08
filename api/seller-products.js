const BASE = 'https://api-seller.ozon.ru';
const BATH_SKUS = {
  '2808600941':'2921050259',
  '3768033857':'3649421296',
  '3768184568':'3649561177',
  '3826876199':'3695855321'
};

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


function storefrontNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return 0;
  const s = v.replace(/\u00a0/g, ' ').replace(/[^\d.,]/g, '').replace(',', '.');
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}

function collectPriceFields(v, path = '', out = []) {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) collectPriceFields(v[i], path + '[' + i + ']', out);
    return out;
  }
  if (!v || typeof v !== 'object') return out;

  for (const [k, val] of Object.entries(v)) {
    const p = path ? path + '.' + k : k;
    const key = k.toLowerCase();
    if (
      key.includes('price') ||
      key.includes('cost') ||
      key.includes('card') ||
      key.includes('buyer') ||
      key.includes('customer') ||
      key.includes('final')
    ) {
      if (typeof val === 'string' || typeof val === 'number') {
        const price = storefrontNum(val);
        if (price >= 50 && price <= 5000) out.push({ path: p, value: String(val), price });
      }
    }
    if (val && typeof val === 'object') collectPriceFields(val, p, out);
  }
  return out;
}

function strongBuyerField(path) {
  return /(ozon.?card|card.?price|buyer|customer|final.?price|client.?price|price.?with.?card)/i.test(String(path || ''));
}

async function fetchStorefront(url) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
    },
    redirect: 'follow'
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, finalUrl: r.url, text, data };
}


function pickPrice(record, names) {
  if (!record || typeof record !== 'object') return 0;
  const lower = Object.fromEntries(Object.entries(record).map(([k,v]) => [String(k).toLowerCase(), v]));
  for (const name of names) {
    const v = lower[String(name).toLowerCase()];
    const x = storefrontNum(v);
    if (x >= 50 && x <= 5000) return x;
  }
  return 0;
}

async function observeBrightDataPrices(items, existingSnapshotId = '') {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) {
    return {
      configured: false,
      reliableCount: 0,
      error: 'BRIGHTDATA_API_TOKEN not configured',
      items: []
    };
  }

  const datasetId = process.env.BRIGHTDATA_OZON_DATASET_ID || 'gd_lutq85sl13rlndbzai';
  const input = items.map(x => ({
    url: 'https://www.ozon.ru/product/' + encodeURIComponent(String(x.sku)) + '/'
  }));
  const endpoint =
    'https://api.brightdata.com/datasets/v3/scrape?dataset_id=' +
    encodeURIComponent(datasetId) +
    '&format=json&include_errors=true';

  let response = null;
  let text = '';

  if (existingSnapshotId) {
    response = {
      status: 202,
      text: JSON.stringify({ snapshot_id: String(existingSnapshotId) })
    };
  } else {
    for (const body of [input, { input }]) {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Accept': 'application/json,text/plain,*/*'
        },
        body: JSON.stringify(body)
      });
      text = await r.text();
      if (r.ok || r.status === 202) {
        response = { status: r.status, text };
        break;
      }
      response = { status: r.status, text };
    }
  }

  if (!response) {
    return { configured: true, reliableCount: 0, error: 'No Bright Data response', items: [] };
  }

  let data = null;
  try { data = JSON.parse(response.text); } catch {}

  if (response.status === 202) {
    const snapshotId = String(data?.snapshot_id || '');
    if (!snapshotId) {
      return {
        configured: true,
        reliableCount: 0,
        pending: true,
        error: 'Bright Data returned 202 without snapshot_id',
        items: []
      };
    }

    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json,text/plain,*/*'
    };

    let readyData = null;
    let lastStatus = 'starting';

    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500));

      const progressResp = await fetch(
        'https://api.brightdata.com/datasets/v3/progress/' + encodeURIComponent(snapshotId),
        { headers }
      );
      const progressText = await progressResp.text();
      let progress = null;
      try { progress = JSON.parse(progressText); } catch {}
      lastStatus = String(progress?.status || '').toLowerCase();

      if (lastStatus === 'failed') {
        return {
          configured: true,
          reliableCount: 0,
          pending: false,
          snapshotId,
          error: 'Bright Data snapshot failed',
          items: []
        };
      }

      if (lastStatus === 'ready') {
        const snapResp = await fetch(
          'https://api.brightdata.com/datasets/v3/snapshot/' +
            encodeURIComponent(snapshotId) +
            '?format=json',
          { headers }
        );
        const snapText = await snapResp.text();

        if (snapResp.status === 200) {
          try { readyData = JSON.parse(snapText); }
          catch {
            readyData = snapText
              .split(/\r?\n/)
              .filter(Boolean)
              .map(line => {
                try { return JSON.parse(line); } catch { return null; }
              })
              .filter(Boolean);
          }
          break;
        }
      }
    }

    if (!readyData) {
      return {
        configured: true,
        reliableCount: 0,
        pending: true,
        snapshotId,
        snapshotStatus: lastStatus || 'processing',
        error: 'Bright Data snapshot is still processing',
        items: []
      };
    }

    data = readyData;
    response = { status: 200, text: JSON.stringify(readyData) };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      configured: true,
      reliableCount: 0,
      error: 'Bright Data HTTP ' + response.status + ': ' + response.text.slice(0, 300),
      items: []
    };
  }

  const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  const out = [];
  for (const item of items) {
    const sku = String(item.sku);
    const row = rows.find(r => {
      const url = String(r?.url || r?.product_url || r?.link || '');
      const rowSku = String(r?.sku || r?.product_id || r?.id || '');
      return rowSku === sku || url.includes(sku);
    }) || null;

    const membership = pickPrice(row, [
      'membership_price','member_price','ozon_card_price','card_price',
      'price_with_card','ozoncard_price'
    ]);
    const finalPrice = pickPrice(row, [
      'final_price','actual_price','sale_price','current_price','price'
    ]);
    const observed = membership || finalPrice;

    out.push({
      sku,
      reliable: !!observed,
      buyerPriceObserved: observed || null,
      buyerPriceType: membership ? 'membership/card' : (finalPrice ? 'final' : ''),
      finalPrice: finalPrice || null,
      membershipPrice: membership || null,
      recordKeys: row ? Object.keys(row).slice(0, 40) : []
    });
  }

  return {
    configured: true,
    reliableCount: out.filter(x => x.reliable).length,
    items: out
  };
}

async function observeStorefrontPrice(sku) {
  const path = '/product/' + encodeURIComponent(String(sku)) + '/';
  const urls = [
    ['composer', 'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(path)],
    ['page', 'https://www.ozon.ru' + path]
  ];
  const attempts = [];
  const evidence = [];

  for (const [kind, url] of urls) {
    try {
      const r = await fetchStorefront(url);
      let fields = r.data ? collectPriceFields(r.data) : [];
      if (!fields.length && r.text) {
        const rx = /"([^"]*(?:price|Price|card|Card|buyer|Buyer|customer|Customer|final|Final)[^"]*)":(?:"([^"]+)"|(\d+(?:\.\d+)?))/g;
        let m;
        while ((m = rx.exec(r.text)) && fields.length < 120) {
          const price = storefrontNum(m[2] ?? m[3]);
          if (price >= 50 && price <= 5000) fields.push({ path: m[1], value: String(m[2] ?? m[3]), price });
        }
      }
      const strong = fields.filter(x => strongBuyerField(x.path));
      evidence.push(...strong);
      attempts.push({ kind, status: r.status, finalUrl: r.finalUrl, bytes: r.text.length, strongFields: strong.slice(0, 8) });
    } catch (e) {
      attempts.push({ kind, error: e?.message || String(e) });
    }
  }

  const prices = evidence.map(x => x.price).filter(x => x >= 50 && x <= 5000);
  const observed = prices.length ? Math.min(...prices) : 0;
  return {
    sku: String(sku),
    reliable: !!observed,
    buyerPriceObserved: observed || null,
    evidence: evidence.slice(0, 12),
    attempts
  };
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

      const basePrice = num(pr?.price ?? p?.price);
      const marketingSellerPrice = num(pr?.marketing_seller_price ?? p?.marketing_seller_price);
      const marketingPrice = num(pr?.marketing_price ?? p?.marketing_price);
      const storefrontPrice = marketingPrice || marketingSellerPrice || basePrice;
      const sellerPromoPrice = marketingSellerPrice || basePrice;
      const marketingActions = p?.marketing_actions || {};

      return {
        productId: id,
        offerId: String(p?.offer_id ?? d?.offer_id ?? ''),
        name: d?.name || p?.name || ('Товар ' + (p?.offer_id || id)),
        image: imageOf(d),
        currency: pr?.currency_code || p?.currency_code || 'RUB',

        price: storefrontPrice,
        storefrontPrice,
        sellerPrice: sellerPromoPrice,
        basePrice,
        oldPrice: num(pr?.old_price ?? p?.old_price),
        minPrice: num(pr?.min_price ?? p?.min_price),
        marketingPrice,
        marketingSellerPrice,
        retailPrice: num(pr?.retail_price ?? p?.retail_price),
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
        ozonActionsExist: !!marketingActions?.ozon_actions_exist,
        sellerActionsExist: !!marketingActions?.current_period_from || !!marketingActions?.current_period_to,
        archived: !!d?.is_archived
      };
    });

    products.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    let storefront = null;
    if (String(req.query?.storefront || '') === '1') {
      const bath = products
        .filter(p => BATH_SKUS[String(p.productId)])
        .map(p => ({...p, sku:BATH_SKUS[String(p.productId)]}));

      const bright = await observeBrightDataPrices(
        bath,
        String(req.query?.snapshotId || '')
      );
      let observed = [];

      if (bright.configured) {
        observed = bath.map(p => {
          const o = bright.items.find(x => String(x.sku) === String(p.sku)) || {
            sku:p.sku,reliable:false,buyerPriceObserved:null,buyerPriceType:''
          };
          const target = products.find(x => String(x.productId) === String(p.productId));
          if (target) {
            target.buyerPriceObserved = o.buyerPriceObserved;
            target.buyerPriceReliable = !!o.reliable;
            target.buyerPriceType = o.buyerPriceType || '';
            target.buyerPriceSku = p.sku;
          }
          return {productId:p.productId,offerId:p.offerId,...o};
        });
      } else {
        for (const p of bath) {
          const o = await observeStorefrontPrice(p.sku);
          const target = products.find(x => String(x.productId) === String(p.productId));
          if (target) {
            target.buyerPriceObserved = o.buyerPriceObserved;
            target.buyerPriceReliable = o.reliable;
            target.buyerPriceType = o.reliable ? 'direct' : '';
            target.buyerPriceSku = o.sku;
          }
          observed.push({ productId:p.productId, offerId:p.offerId, ...o });
        }
      }

      storefront = {
        ok: true,
        source: bright.configured ? 'brightdata' : 'direct',
        configured: bright.configured,
        pending: !!bright.pending,
        snapshotId: bright.snapshotId || '',
        snapshotStatus: bright.snapshotStatus || '',
        error: bright.error || '',
        targetMin: 220,
        targetMax: 240,
        reliableCount: observed.filter(x => x.reliable).length,
        observed
      };
    }

    return send(res, 200, {
      ok: true,
      readOnly: true,
      total: products.length,
      products,
      warning,
      storefront,
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

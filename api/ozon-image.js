const ALLOWED = /(^|\.)(ozone\.ru|ozon\.ru)$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const raw = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url;
  if (!raw) {
    res.statusCode = 400;
    return res.end('Missing url');
  }

  let url;
  try { url = new URL(raw); }
  catch {
    res.statusCode = 400;
    return res.end('Bad url');
  }

  if (url.protocol !== 'https:' || !ALLOWED.test(url.hostname)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  try {
    const r = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.ozon.ru/'
      }
    });

    if (!r.ok) {
      res.statusCode = r.status;
      return res.end('Image fetch failed');
    }

    const type = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());

    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    res.end(buf);
  } catch {
    res.statusCode = 502;
    res.end('Image proxy error');
  }
};

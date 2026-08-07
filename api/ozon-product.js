const ALLOWED_HOSTS = new Set(['ozon.ru','www.ozon.ru']);

function send(res, status, body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}

function cleanText(v){
  if(v == null) return '';
  if(Array.isArray(v)) return v.map(cleanText).filter(Boolean).join(', ');
  if(typeof v === 'object'){
    if('text' in v) return cleanText(v.text);
    if('value' in v) return cleanText(v.value);
    if('title' in v) return cleanText(v.title);
    return '';
  }
  return String(v).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function numberFrom(v){
  const s=cleanText(v).replace(/\u00a0/g,' ').replace(/[₽рР]/g,'').replace(/\s/g,'').replace(',','.');
  const m=s.match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):null;
}
function rubFrom(v){const n=numberFrom(v);return Number.isFinite(n)?n:null;}
function parseMaybeJson(v){
  if(typeof v!=='string') return v;
  const t=v.trim(); if(!t || !['{','['].includes(t[0])) return v;
  try{return JSON.parse(t)}catch{return v}
}
function deepWalk(root, cb, max=80000){
  const stack=[root], seen=new Set(); let count=0;
  while(stack.length && count++<max){
    const cur=stack.pop(); if(!cur||typeof cur!=='object'||seen.has(cur))continue; seen.add(cur); cb(cur);
    if(Array.isArray(cur)){for(const x of cur) if(x&&typeof x==='object') stack.push(x)}
    else for(const x of Object.values(cur)){const p=parseMaybeJson(x); if(p&&typeof p==='object') stack.push(p)}
  }
}
function unitToCm(label, value){
  const n=numberFrom(value); if(!Number.isFinite(n))return null;
  const s=(cleanText(label)+' '+cleanText(value)).toLowerCase();
  if(/\bмм\b|millimeter/.test(s)) return n/10;
  if(/\bм\b|meter/.test(s) && !/\bсм\b|\bмм\b/.test(s)) return n*100;
  return n; // cm is the marketplace's usual display unit for package dimensions
}
function weightToKg(label, value){
  const n=numberFrom(value); if(!Number.isFinite(n))return null;
  const s=(cleanText(label)+' '+cleanText(value)).toLowerCase();
  if(/\bмг\b/.test(s)) return n/1e6;
  if(/\bг\b|gram/.test(s) && !/\bкг\b/.test(s)) return n/1000;
  return n;
}
function normalizeLabel(s){return cleanText(s).toLowerCase().replace(/ё/g,'е');}

function collectAttributes(root){
  const out=[];
  deepWalk(root,obj=>{
    if(Array.isArray(obj)) return;
    const label=cleanText(obj.title ?? obj.name ?? obj.label ?? obj.key);
    let value=obj.value ?? obj.values ?? obj.text ?? obj.subtitle ?? obj.description;
    if(label && value != null){
      const val=cleanText(value); if(val && val!==label && val.length<500) out.push([label,val]);
    }
  });
  return out;
}
function pickAttr(attrs, patterns){
  for(const re of patterns){
    const hit=attrs.find(([k,v])=>re.test(normalizeLabel(k)) && cleanText(v)); if(hit)return hit;
  }
  return null;
}
function findFirst(root, keys){
  let result=null;
  deepWalk(root,obj=>{
    if(result!==null||Array.isArray(obj))return;
    for(const k of keys){if(obj[k]!=null && cleanText(obj[k])){result=obj[k];break;}}
  });
  return result;
}
function parseLdFromComposer(data){
  const scripts=[];
  if(Array.isArray(data?.seo?.script)) scripts.push(...data.seo.script);
  for(const s of scripts){
    const raw=s?.innerHTML ?? s?.text ?? s;
    if(typeof raw!=='string')continue;
    try{
      const j=JSON.parse(raw);
      const arr=Array.isArray(j)?j:[j];
      for(const x of arr){if(x && (x['@type']==='Product' || (Array.isArray(x['@type'])&&x['@type'].includes('Product')))) return x;}
    }catch{}
  }
  return null;
}
function parseProduct(data, fallbackSku){
  const ld=parseLdFromComposer(data);
  const widgets={};
  for(const [k,v] of Object.entries(data?.widgetStates||{})) widgets[k]=parseMaybeJson(v);
  const root={data,widgets};
  const attrs=collectAttributes(root);

  const name=cleanText(ld?.name)||cleanText(data?.seo?.title)?.replace(/\s*купить на OZON.*$/i,'')||cleanText(findFirst(root,['productName','title']));
  const priceCandidates=[];
  const addPrice=v=>{const n=rubFrom(v);if(Number.isFinite(n)&&n>0&&!priceCandidates.includes(n))priceCandidates.push(n)};
  addPrice(ld?.offers?.price); addPrice(findFirst(root,['finalPrice','webPrice','cardPrice','salePrice','price']));
  let price=priceCandidates[0]||null;

  let category=cleanText(ld?.category)||cleanText(findFirst(root,['categoryName','category']));
  if(category && category.length>140) category='';
  const seller=cleanText(findFirst(root,['sellerName','shopName','sellerTitle']));
  const rating=numberFrom(ld?.aggregateRating?.ratingValue ?? findFirst(root,['ratingValue','rating']));
  const sku=cleanText(ld?.sku)||cleanText(findFirst(root,['sku','productId','id']))||fallbackSku||'';

  const wHit=pickAttr(attrs,[/вес.*упаков/,/вес товара/,/^вес/]);
  const lHit=pickAttr(attrs,[/длина.*упаков/,/габарит.*длина/,/^длина,/]);
  const wiHit=pickAttr(attrs,[/ширина.*упаков/,/габарит.*ширина/,/^ширина,/]);
  const hHit=pickAttr(attrs,[/высота.*упаков/,/габарит.*высота/,/^высота,/]);

  return {
    sku,name,price,
    priceCandidates:priceCandidates.slice(0,6),
    category,seller,rating:Number.isFinite(rating)?rating:null,
    image:cleanText(Array.isArray(ld?.image)?ld.image[0]:ld?.image),
    weightKg:wHit?weightToKg(wHit[0],wHit[1]):null,
    lengthCm:lHit?unitToCm(lHit[0],lHit[1]):null,
    widthCm:wiHit?unitToCm(wiHit[0],wiHit[1]):null,
    heightCm:hHit?unitToCm(hHit[0],hHit[1]):null,
    matchedAttributes:{weight:wHit,length:lHit,width:wiHit,height:hHit}
  };
}
function parseHtml(html, fallbackSku){
  const scripts=[...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let ld=null;
  for(const m of scripts){try{const j=JSON.parse(m[1]);const a=Array.isArray(j)?j:[j];ld=a.find(x=>x&&x['@type']==='Product');if(ld)break;}catch{}}
  const title=((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return {
    sku:cleanText(ld?.sku)||fallbackSku||'',
    name:cleanText(ld?.name)||title.replace(/\s*купить на OZON.*$/i,''),
    price:rubFrom(ld?.offers?.price),
    priceCandidates:[],category:cleanText(ld?.category),seller:'',
    rating:numberFrom(ld?.aggregateRating?.ratingValue),image:cleanText(Array.isArray(ld?.image)?ld.image[0]:ld?.image),
    weightKg:null,lengthCm:null,widthCm:null,heightCm:null,matchedAttributes:{}
  };
}
async function fetchTimed(url, opts={}){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12000);
  try{return await fetch(url,{...opts,signal:controller.signal,redirect:'follow'});}finally{clearTimeout(timer)}
}
function skuFromPath(path){const m=path.match(/-(\d{6,})(?:\/|$)/)||path.match(/\/(\d{6,})(?:\/|$)/);return m?m[1]:'';}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  const raw=Array.isArray(req.query?.url)?req.query.url[0]:req.query?.url;
  if(!raw) return send(res,400,{ok:false,error:'Не передана ссылка Ozon'});
  let u; try{u=new URL(raw)}catch{return send(res,400,{ok:false,error:'Некорректная ссылка'})}
  const host=u.hostname.toLowerCase(); if(!ALLOWED_HOSTS.has(host)) return send(res,400,{ok:false,error:'Разрешены только ссылки ozon.ru'});
  if(!u.pathname.includes('/product/')) return send(res,400,{ok:false,error:'Ссылка не похожа на карточку товара Ozon'});
  const sku=skuFromPath(u.pathname);
  const headers={
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept':'application/json,text/plain,*/*','Accept-Language':'ru-RU,ru;q=0.9,en;q=0.7','Referer':'https://www.ozon.ru/'
  };
  const relative=u.pathname+(u.search||'');
  let warning='';
  try{
    const apiUrl='https://www.ozon.ru/api/composer-api.bx/page/json/v2?url='+encodeURIComponent(relative);
    const r=await fetchTimed(apiUrl,{headers});
    const text=await r.text();
    if(r.ok){
      try{
        const data=JSON.parse(text); const product=parseProduct(data,sku);
        if(product.name||product.price) return send(res,200,{ok:true,source:'Ozon frontend JSON',product,warning:(!product.weightKg&&!product.lengthCm)?'Габариты в открытом ответе не найдены — проверьте их вручную.':''});
      }catch{}
    }
    warning='Внутренний JSON Ozon недоступен; использован запасной разбор страницы.';
  }catch{warning='Внутренний JSON Ozon недоступен; использован запасной разбор страницы.'}

  try{
    const r=await fetchTimed(u.toString(),{headers:{...headers,Accept:'text/html,application/xhtml+xml'}}); const html=await r.text();
    if(!r.ok) return send(res,502,{ok:false,error:`Ozon вернул HTTP ${r.status}. Вероятно, сработала антибот-защита.`});
    const product=parseHtml(html,sku);
    if(product.name||product.price) return send(res,200,{ok:true,source:'Ozon HTML / JSON-LD',product,warning});
    return send(res,502,{ok:false,error:'Страница открылась, но данные товара не удалось распознать. Введите их вручную.'});
  }catch(e){
    return send(res,502,{ok:false,error:'Не удалось получить карточку Ozon. Возможна временная антибот-блокировка.'});
  }
};

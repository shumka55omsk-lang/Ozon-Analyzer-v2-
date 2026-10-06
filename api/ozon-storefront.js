const ITEMS=[
  {offerId:'30092025',sku:'2921050259',name:'Серая'},
  {offerId:'140326',sku:'3649421296',name:'Синяя'},
  {offerId:'1403261',sku:'3649561177',name:'Бежевая'},
  {offerId:'20032026',sku:'3695855321',name:'Оранжевая'}
];

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function n(v){
  if(typeof v==='number'&&Number.isFinite(v)) return v;
  if(typeof v!=='string') return 0;
  const s=v.replace(/\u00a0/g,' ').replace(/[^\d.,]/g,'').replace(',','.');
  const x=Number(s); return Number.isFinite(x)?x:0;
}
function plausiblePrice(v){
  const x=n(v);
  return x>=50&&x<=5000?x:0;
}
function walk(v,path='',out=[]){
  if(Array.isArray(v)){
    for(let i=0;i<v.length;i++) walk(v[i],path+'['+i+']',out);
    return out;
  }
  if(v&&typeof v==='object'){
    for(const [k,val] of Object.entries(v)){
      const p=path?path+'.'+k:k;
      const key=k.toLowerCase();
      if(
        key.includes('price')||
        key.includes('cost')||
        key.includes('ozoncard')||
        key.includes('cardprice')||
        key.includes('final')
      ){
        if(typeof val==='string'||typeof val==='number'){
          const pv=plausiblePrice(val);
          if(pv) out.push({path:p,key,value:val,price:pv});
        }
      }
      if(val&&typeof val==='object') walk(val,p,out);
    }
  }
  return out;
}
function uniqueCandidates(arr){
  const seen=new Set();
  return arr.filter(x=>{
    const k=x.path+'|'+x.price;
    if(seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0,80);
}
async function getJson(url){
  const r=await fetch(url,{
    headers:{
      'Accept':'application/json,text/plain,*/*',
      'Accept-Language':'ru-RU,ru;q=0.9',
      'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
    },
    redirect:'follow'
  });
  const text=await r.text();
  let data=null;
  try{data=JSON.parse(text)}catch{}
  return {status:r.status,url:r.url,text,data};
}
async function observe(item){
  const productPath='/product/'+item.sku+'/';
  const composer='https://www.ozon.ru/api/composer-api.bx/page/json/v2?url='+encodeURIComponent(productPath);
  const direct='https://www.ozon.ru'+productPath;
  const attempts=[];
  for(const [kind,url] of [['composer',composer],['page',direct]]){
    try{
      const r=await getJson(url);
      let candidates=[];
      if(r.data) candidates=uniqueCandidates(walk(r.data));
      if(!candidates.length&&r.text){
        const rx=/"([^"]*(?:price|Price|cost|Cost)[^"]*)":(?:"([^"]+)"|(\d+(?:\.\d+)?))/g;
        let m;
        while((m=rx.exec(r.text))&&candidates.length<80){
          const pv=plausiblePrice(m[2]??m[3]);
          if(pv) candidates.push({path:m[1],key:m[1],value:m[2]??m[3],price:pv});
        }
      }
      attempts.push({
        kind,status:r.status,finalUrl:r.url,
        contentType:r.data?'json':'text',
        bytes:r.text.length,
        candidates:uniqueCandidates(candidates)
      });
    }catch(e){
      attempts.push({kind,error:e?.message||String(e),candidates:[]});
    }
  }

  const all=attempts.flatMap(a=>a.candidates||[]);
  // Only accept an observed buyer price when the field name explicitly signals buyer/card/final price.
  const strong=all.filter(x=>/(buyer|card|final|client|customer|ozoncard|cardprice|saleprice|marketing)/i.test(x.path));
  const prices=strong.map(x=>x.price).filter(Boolean);
  const observed=prices.length?Math.min(...prices):0;
  return {
    offerId:item.offerId,sku:item.sku,name:item.name,
    observedBuyerPrice:observed||null,
    reliable:!!observed,
    evidence:strong.slice(0,20),
    attempts
  };
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'GET only'});
  const secret=process.env.CRON_SECRET;
  const auth=String(req.headers?.authorization||'');
  if(!secret||auth!=='Bearer '+secret) return send(res,401,{ok:false,error:'Unauthorized'});
  const items=[];
  for(const item of ITEMS) items.push(await observe(item));
  return send(res,200,{
    ok:true,readOnly:true,
    source:'Ozon public storefront',
    note:'Цена считается наблюдаемой только при явном поле buyer/card/final/customer. При сомнении reliable=false.',
    items
  });
};
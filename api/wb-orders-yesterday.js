const BASE='https://statistics-api.wildberries.ru';
const BATH=new Set(['803971219','919647983']);
function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'GET only'});
  const token=process.env.WB_READ_API_TOKEN;
  if(!token) return send(res,500,{ok:false,error:'WB_READ_API_TOKEN missing'});
  const now=new Date();
  const y=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
  const date=y.toISOString().slice(0,10);
  const url=BASE+'/api/v1/supplier/orders?dateFrom='+encodeURIComponent(date)+'&flag=1';
  const r=await fetch(url,{headers:{Authorization:token,Accept:'application/json'}});
  const text=await r.text();
  let data=[];
  try{data=text?JSON.parse(text):[]}catch{}
  if(!r.ok) return send(res,r.status,{ok:false,error:'WB Statistics HTTP '+r.status,details:data});
  const rows=(Array.isArray(data)?data:[]).filter(x=>BATH.has(String(x.nmId||x.nmID||'')));
  const items={};
  for(const x of rows){
    const id=String(x.nmId||x.nmID||'');
    if(!items[id]) items[id]={nmID:id,orders:0,revenue:0,cancelled:0};
    if(x.isCancel){items[id].cancelled++;continue;}
    items[id].orders++;
    items[id].revenue+=Number(x.priceWithDisc||x.finishedPrice||x.totalPrice||0)||0;
  }
  return send(res,200,{ok:true,date,items:Object.values(items).map(x=>({...x,revenue:Math.round(x.revenue*100)/100}))});
};
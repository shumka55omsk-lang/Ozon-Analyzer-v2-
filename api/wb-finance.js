const FIN='https://finance-api.wildberries.ru';
const BATH_IDS=new Set(['803971219','919647983']);

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function token(){
  const t=process.env.WB_READ_API_TOKEN;
  if(!t){const e=new Error('Не настроен WB_READ_API_TOKEN');e.status=500;throw e;}
  return t;
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function r2(v){return Math.round(num(v)*100)/100}
function dstr(d){return d.toISOString().slice(0,10)}
async function wbFinance(body){
  const r=await fetch(FIN+'/api/finance/v1/sales-reports/detailed',{
    method:'POST',
    headers:{
      'Authorization':token(),
      'Accept':'application/json',
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });
  if(r.status===204) return [];
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):[]}catch{data={raw:text.slice(0,1500)}}
  if(!r.ok){
    const e=new Error(data?.detail||data?.message||data?.errorText||('WB Finance HTTP '+r.status));
    e.status=r.status;e.details=data;throw e;
  }
  return Array.isArray(data)?data:[];
}
function add(map,key,val){
  const k=String(key||'Прочая операция');
  map[k]=(map[k]||0)+num(val);
}

module.exports=async function handler(req,res){
  if(req.method!=='GET') return send(res,405,{ok:false,error:'Используйте GET'});
  try{
    const now=new Date();
    const to=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
    const from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-14));
    const fields=[
      'rrdId','nmId','vendorCode','title','docTypeName','quantity',
      'retailAmount','retailPriceWithDisc','commissionPercent',
      'ppvzSalesCommission','forPay','acquiringFee','sellerOperName',
      'rrDate','deliveryAmount','returnAmount','penalty','additionalPayment',
      'rebillLogisticCost','paidStorage','deduction','paidAcceptance','srid'
    ];
    const rows=await wbFinance({
      dateFrom:dstr(from),
      dateTo:dstr(to),
      limit:100000,
      rrdId:0,
      period:'daily',
      fields
    });
    const bath=rows.filter(x=>BATH_IDS.has(String(x?.nmId??'')));
    const stats={};
    for(const row of bath){
      const id=String(row.nmId);
      if(!stats[id]) stats[id]={
        nmID:id,
        vendorCode:String(row.vendorCode||''),
        title:String(row.title||''),
        rows:0,
        quantity:0,
        retailAmount:0,
        forPay:0,
        commission:0,
        acquiring:0,
        rebillLogistics:0,
        storage:0,
        deductions:0,
        penalties:0,
        paidAcceptance:0,
        operations:{},
        operationSums:{}
      };
      const s=stats[id];
      s.rows++;
      s.quantity+=num(row.quantity);
      s.retailAmount+=num(row.retailAmount);
      s.forPay+=num(row.forPay);
      s.commission+=Math.abs(num(row.ppvzSalesCommission));
      s.acquiring+=Math.abs(num(row.acquiringFee));
      s.rebillLogistics+=Math.abs(num(row.rebillLogisticCost));
      s.storage+=Math.abs(num(row.paidStorage));
      s.deductions+=Math.abs(num(row.deduction));
      s.penalties+=Math.abs(num(row.penalty));
      s.paidAcceptance+=Math.abs(num(row.paidAcceptance));
      const op=String(row.sellerOperName||row.docTypeName||'Прочая операция');
      add(s.operations,op,1);
      if(!s.operationSums[op]) s.operationSums[op]={
        rows:0,quantity:0,retailAmount:0,forPay:0,commission:0,acquiring:0,
        logistics:0,storage:0,deductions:0,penalties:0,acceptance:0,additionalPayment:0
      };
      const o=s.operationSums[op];
      o.rows++;
      o.quantity+=num(row.quantity);
      o.retailAmount+=num(row.retailAmount);
      o.forPay+=num(row.forPay);
      o.commission+=Math.abs(num(row.ppvzSalesCommission));
      o.acquiring+=Math.abs(num(row.acquiringFee));
      o.logistics+=Math.abs(num(row.rebillLogisticCost));
      o.storage+=Math.abs(num(row.paidStorage));
      o.deductions+=Math.abs(num(row.deduction));
      o.penalties+=Math.abs(num(row.penalty));
      o.acceptance+=Math.abs(num(row.paidAcceptance));
      o.additionalPayment+=num(row.additionalPayment);
    }
    const items=Object.values(stats).map(s=>({
      ...s,
      retailAmount:r2(s.retailAmount),
      forPay:r2(s.forPay),
      commission:r2(s.commission),
      acquiring:r2(s.acquiring),
      rebillLogistics:r2(s.rebillLogistics),
      storage:r2(s.storage),
      deductions:r2(s.deductions),
      penalties:r2(s.penalties),
      paidAcceptance:r2(s.paidAcceptance),
      avgForPayPerRow:s.rows?r2(s.forPay/s.rows):0,
      topOperations:Object.entries(s.operations)
        .sort((a,b)=>b[1]-a[1])
        .slice(0,12)
        .map(([name,count])=>({name,count})),
      operationSums:Object.entries(s.operationSums)
        .map(([name,o])=>({
          name,
          rows:o.rows,
          quantity:r2(o.quantity),
          retailAmount:r2(o.retailAmount),
          forPay:r2(o.forPay),
          commission:r2(o.commission),
          acquiring:r2(o.acquiring),
          logistics:r2(o.logistics),
          storage:r2(o.storage),
          deductions:r2(o.deductions),
          penalties:r2(o.penalties),
          acceptance:r2(o.acceptance),
          additionalPayment:r2(o.additionalPayment)
        }))
        .sort((a,b)=>b.rows-a.rows)
    }));
    return send(res,200,{
      ok:true,
      readOnly:true,
      period:{from:dstr(from),to:dstr(to)},
      reportRows:rows.length,
      matchedRows:bath.length,
      items,
      note:'Диагностика WB Finance. До проверки структуры реальных операций эти суммы не используются для автоматического изменения цены.'
    });
  }catch(e){
    const status=Number(e?.status)||500;
    return send(res,status>=400&&status<600?status:500,{
      ok:false,
      readOnly:true,
      error:e?.message||'Не удалось получить финансовый отчёт Wildberries',
      hint:(status===401||status===403)?'Для WB_READ_API_TOKEN нужна категория «Финансы».':'',
      details:e?.details||undefined
    });
  }
};
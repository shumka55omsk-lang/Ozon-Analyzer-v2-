module.exports=async function handler(req,res){
  if(req.method!=='GET'){res.statusCode=405;return res.end('GET only');}
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){res.statusCode=500;return res.end('telegram env missing');}
  const text="Маркетплейсы — сидушки для бани · 02.10.2026\nРежим: наблюдение / без записи\nЦель: не менее 200 ₽ прибыли/шт.\n\nOZON\n\nСерая: 14 заказов · 6 810 ₽\nЦена: 505 ₽ · защита ≈ 790 ₽ · прибыль ≈ 67 ₽/шт.\n2 последних дня к фону: −55,8%\nРешение: HOLD — товар ещё в «Эластичном бустинге», цену не повышаем.\n\nБежевая: 0 заказов · 0 ₽\nЦена: 450 ₽ · защита ≈ 790 ₽ · прибыль ≈ 41 ₽/шт.\nРешение: HOLD — недостаточно продаж, товар в «Эластичном бустинге».\n\nОранжевая: 0 заказов · 0 ₽\nЦена: 450 ₽ · защита ≈ 790 ₽ · прибыль ≈ 41 ₽/шт.\nРешение: HOLD — недостаточно продаж, товар в «Эластичном бустинге».\n\nСиняя: 0 заказов · 0 ₽\nЦена продажи: 358 ₽ · базовая 482 ₽ · защита ≈ 790 ₽\nПрибыль ≈ −2 ₽/шт.\nРешение: HOLD — товар в «Эластичном бустинге», цена слишком низкая для цели 200 ₽.\n\nПоисковые позиции Ozon недоступны без Premium.\n\nWILDBERRIES\n\nАртикул 04022026 · nmID 803971219\n19 заказов · 5 035 ₽ · отмен 0\nПосле 2 и 3 заказов в два предыдущих дня продажи восстановились.\nРешение: наблюдение — автоцена WB пока отключена.\n\nАртикул 280326 · nmID 919647983\n0 заказов · 0 ₽\nРешение: наблюдение — данных для изменения цены недостаточно.\n\nВоронка WB за 2 октября сейчас временно недоступна из-за rate limit API; заказы подтверждены отдельным оперативным Statistics API.\n\nИТОГО\n33 заказа · 11 845 ₽ выручки по двум маркетплейсам.\nЦены и акции не изменялись.";
  const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})
  });
  const data=await r.json().catch(()=>({ok:false}));
  res.statusCode=r.ok&&data.ok?200:500;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify({ok:!!data.ok}));
};
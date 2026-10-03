module.exports=async function handler(req,res){
  res.statusCode=200;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify({
    ok:true,
    telegramBotConfigured:!!process.env.TELEGRAM_BOT_TOKEN,
    telegramChatConfigured:!!process.env.TELEGRAM_CHAT_ID,
    cronSecretConfigured:!!process.env.CRON_SECRET,
    ozonPriceKeyConfigured:!!process.env.OZON_PRICE_API_KEY,
    wbReadConfigured:!!process.env.WB_READ_API_TOKEN
  }));
};
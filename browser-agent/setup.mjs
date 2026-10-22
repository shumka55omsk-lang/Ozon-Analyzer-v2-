import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {chromium} from 'playwright';
import {SECTIONS,sellerUrl} from './audit-core.mjs';
import {ROOT,CONFIG_FILE,PROFILE_DIR,ENV_FILE,ensureFolders} from './agent.mjs';

await ensureFolders();
const rl=createInterface({input,output});
console.log('\nНастройка браузерного контроля Ozon Seller.');
console.log('Для Ozon будет запущен ОТДЕЛЬНЫЙ профиль Chrome в '+PROFILE_DIR);
console.log('Пароль, код из SMS, cookies и профиль НЕЛЬЗЯ отправлять в чат, GitHub или Telegram.');
let ctx;
try{
  ctx=await chromium.launchPersistentContext(PROFILE_DIR,{
    channel:'chrome',headless:false,locale:'ru-RU',viewport:{width:1440,height:920},
  });
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto('https://seller.ozon.ru/',{waitUntil:'domcontentloaded',timeout:30000});
  await rl.question('\nВ открывшемся Chrome войдите в Ozon Seller. Когда откроется кабинет, нажмите Enter здесь...');
  const config={version:1,sections:{}};
  if(existsSync(CONFIG_FILE)){
    try{
      const saved=JSON.parse(await fs.readFile(CONFIG_FILE,'utf8'));
      if(saved?.sections)config.sections=saved.sections;
    }catch{}
  }
  console.log('\nДля каждого раздела найдите его в ОТКРЫТОМ Chrome; затем нажмите Enter здесь.');
  console.log('Это сохраняет только адрес страницы, не текст, не токены и не cookies.');
  console.log('Если нужный раздел пока не найден — введите s, позже можно повторить настройку.');
  for(const s of SECTIONS){
    const line=(await rl.question('\nОткройте «'+s.name+'» в Chrome. Enter = записать адрес, s = пропустить: ')).trim().toLowerCase();
    if(line==='s')continue;
    try{
      const url=sellerUrl(page.url());
      const section={url};
      if(s.id==='notifications'){
        console.log('Если уведомления открываются только значком колокольчика, агент сможет нажимать его.');
        console.log('Открытие может пометить уведомления просмотренными (Ozon определяет поведение).');
        const answer=(await rl.question('Разрешить открывать колокольчик автоматически? y/N: ')).trim().toLowerCase();
        section.openBell=answer==='y'||answer==='д';
      }
      config.sections[s.id]=section;
      console.log('Сохранено: '+url);
    }catch(e){console.error('Адрес не сохранён: '+e.message);}
  }
  await fs.writeFile(CONFIG_FILE,JSON.stringify(config,null,2),'utf8');
  if(!existsSync(ENV_FILE)){
    await fs.writeFile(ENV_FILE,'# Данные Telegram остаются только на компьютере.\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\nOZON_HEADLESS=1\n','utf8');
  }
  console.log('\nНастройка маршрутов сохранена. '+Object.keys(config.sections).length+' / 5.');
  console.log('Данные Telegram для утреннего отчёта укажите в локальном файле: '+ENV_FILE);
  console.log('Затем проверьте: node agent.mjs');
  console.log('Для ежедневного запуска: PowerShell -ExecutionPolicy Bypass -File .\\schedule.ps1');
} finally {
  await ctx?.close().catch(()=>{});
  rl.close();
}

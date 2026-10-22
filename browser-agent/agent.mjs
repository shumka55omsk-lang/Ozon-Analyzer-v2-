import fs from 'node:fs/promises';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import process from 'node:process';
import {chromium} from 'playwright';
import {SECTIONS,extractFindings,compareFindings,formatReport,sellerUrl} from './audit-core.mjs';

const ROOT=process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA,'OzonSellerAudit')
  : path.join(os.homedir(),'.ozon-seller-audit');
const DATA_DIR=path.join(ROOT,'data');
const PROFILE_DIR=path.join(ROOT,'chrome-profile');
const CONFIG_FILE=path.join(DATA_DIR,'routes.json');
const STATE_FILE=path.join(DATA_DIR,'state.json');
const ENV_FILE=path.join(ROOT,'.env.local');

export {ROOT,DATA_DIR,PROFILE_DIR,CONFIG_FILE,STATE_FILE,ENV_FILE};

export async function ensureFolders() {
  await fs.mkdir(DATA_DIR,{recursive:true});
}
export function loadLocalEnv(){
  if(existsSync(ENV_FILE)&&typeof process.loadEnvFile==='function')process.loadEnvFile(ENV_FILE);
}
async function sendTelegram(message) {
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw Error('Telegram: заполните TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в '+ENV_FILE);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
      method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text:message,disable_web_page_preview:true}),
    });
    const answer=await r.json().catch(()=>({}));
    if(!r.ok||!answer.ok)throw Error('Telegram HTTP '+r.status+': '+String(answer.description||'').slice(0,120));
  } finally {clearTimeout(timer);}
}
async function extractPage(page,includeOverlay=false){
  return page.evaluate(({includeOverlay})=>{
    const root=includeOverlay?document.body:(document.querySelector('main')||document.body);
    const body=document.body;
    const text=(root?.innerText||body?.innerText||'').slice(0,120000);
    const lines=text.split(/\n+/).map(x=>x.trim()).filter(x=>x.length>=12).map(x=>x.slice(0,340)).slice(0,1200);
    const rows=[...(body?.querySelectorAll('tr, [role="row"], article, [role="listitem"]')||[])].slice(0,450)
      .map(e=>(e.innerText||'').replace(/\s+/g,' ').trim())
      .filter(x=>x.length>=12).map(x=>x.slice(0,340));
    return {lines,rows,length:text.length};
  },{includeOverlay});
}
async function openBellIfConfigured(page,sectionConfig){
  if(!sectionConfig.openBell)return;
  // Clicking the bell only opens a navigation UI. Some Seller versions may
  // mark notifications "seen" when opened; setup makes this opt-in.
  const selectors=[
    'button[aria-label*="Уведомлен"]',
    'button[title*="Уведомлен"]',
    '[role="button"][aria-label*="Уведомлен"]',
    'button[aria-label*="Notification"]',
  ];
  let clicked=false;
  for(const selector of selectors){
    const loc=page.locator(selector).first();
    if(await loc.count()) {
      await loc.click({timeout:4000});
      clicked=true;
      break;
    }
  }
  if(!clicked)throw Error('Не найден значок уведомлений — обновите страницу при настройке');
  await page.waitForTimeout(900);
}
function checkSession(url,snapshot) {
  if(!url.startsWith('https://seller.ozon.ru/'))throw Error('Сессия Ozon не открылась: требуется вход заново');
  if(/\/(?:login|signin|auth)(?:[/?#]|$)/i.test(url))throw Error('Сессия Ozon истекла — выполните setup');
  const text=snapshot.lines.slice(0,12).join(' ').toLowerCase();
  if(/(?:войти в аккаунт|введите номер телефона|вход в озон|sign in|начать продавать на ozon)/i.test(text))
    throw Error('Появилась страница входа Ozon — обновите авторизацию');
  if(snapshot.length<80||!snapshot.lines.length)throw Error('В кабинете нет читаемого содержимого (возможно блокировка/загрузка)');
}
export async function runAudit() {
  await ensureFolders();
  loadLocalEnv();
  const config=JSON.parse(await fs.readFile(CONFIG_FILE,'utf8'));
  const old=await fs.readFile(STATE_FILE,'utf8').then(JSON.parse).catch(()=>({sections:{},initialized:false}));
  const sectionFindings={};
  const checked=[],errors=[];
  const browser=await chromium.launchPersistentContext(PROFILE_DIR,{
    channel:'chrome',
    headless:process.env.OZON_HEADLESS!=='0',
    locale:'ru-RU',
    viewport:{width:1440,height:920},
    acceptDownloads:false,
  });
  try {
    for(const section of SECTIONS){
      const route=config?.sections?.[section.id];
      if(!route?.url){errors.push({section:section.name,reason:'Адрес раздела не настроен'});continue;}
      const page=await browser.newPage();
      try{
        const url=sellerUrl(route.url);
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
        await page.waitForTimeout(1800);
        await openBellIfConfigured(page,route);
        const snapshot=await extractPage(page,section.id==='notifications'&&route.openBell===true);
        checkSession(page.url(),snapshot);
        sectionFindings[section.id]=extractFindings(section.id,snapshot);
        checked.push(section.name);
      }catch(e){
        errors.push({section:section.name,reason:String(e?.message||e).slice(0,170)});
      }finally{await page.close().catch(()=>{});}
    }
  }finally{await browser.close();}
  const firstRun=!old.initialized;
  const analysis=compareFindings(old,sectionFindings,firstRun);
  // Only replace successful sections: failed pages cannot erase yesterday's baseline.
  const sections={...(old.sections||{})};
  for(const [key,items] of Object.entries(sectionFindings))sections[key]=items.map(x=>x.id);
  const result={
    time:new Date().toISOString(),checked,errors,firstRun,
    ...analysis,
  };
  await fs.writeFile(STATE_FILE,JSON.stringify({initialized:true,sections,updatedAt:result.time},null,2),'utf8');
  const message=formatReport(result);
  await fs.writeFile(path.join(DATA_DIR,'last-report.txt'),message,'utf8');
  await sendTelegram(message);
  console.log(message);
  if(errors.length)process.exitCode=2;
  return result;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runAudit().catch(async(e)=>{
    const message='🚨 Ozon: БРАУЗЕРНЫЙ АГЕНТ НЕ СМОГ ВЫПОЛНИТЬ ПРОВЕРКУ.\n'+String(e?.message||e).slice(0,350)+
      '\nНет оснований считать, что платные услуги отсутствуют.';
    console.error(message);
    try{loadLocalEnv();await sendTelegram(message);}catch(t){console.error(String(t?.message||t));}
    process.exitCode=1;
  });
}

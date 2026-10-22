import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sellerUrl,extractFindings,compareFindings,formatReport} from '../audit-core.mjs';

test('only safe seller addresses are accepted',()=>{
  assert.equal(sellerUrl('https://seller.ozon.ru/app/goods?tab=all'),'https://seller.ozon.ru/app/goods?tab=all');
  assert.throws(()=>sellerUrl('https://seller.ozon.ru.evil.com/app'),/Разрешены/);
  assert.throws(()=>sellerUrl('http://seller.ozon.ru/app'),/Разрешены/);
  assert.throws(()=>sellerUrl('https://seller.ozon.ru/app#access_token=secret'),/секрет/);
});
test('Cyrillic active review status is detected and stopped status is ignored',()=>{
  const found=extractFindings('firstReviews',{rows:[
    'Сидушка серая — Сбор первых отзывов — Активен — 3 отзыва',
    'Сидушка синяя — Сбор первых отзывов — Остановлен',
  ],lines:[]});
  assert.equal(found.length,1);
  assert.match(found[0].text,/Активен/);
  assert.equal(found[0].level,'urgent');
});
test('notices find Ozon automatic paid service activation',()=>{
  const found=extractFindings('notifications',{rows:[],lines:[
    'Ozon автоматически подключает платный Сбор первых отзывов для товаров с 26 октября',
    'Заказ подготовлен к отгрузке'
  ]});
  assert.equal(found.length,1);
  assert.equal(found[0].level,'urgent');
});
test('compare does not mistake initial notices for newly received events',()=>{
  const notices=extractFindings('notifications',{rows:[],lines:['Изменение тарифа: платное продвижение на Ozon']});
  const first=compareFindings({sections:{}},{notifications:notices},true);
  assert.equal(first.fresh.length,0);
  const later=compareFindings({sections:{notifications:[]}},{notifications:notices},false);
  assert.equal(later.fresh.length,1);
  const stable=compareFindings({sections:{notifications:[notices[0].id]}},{notifications:notices},false);
  assert.equal(stable.fresh.length,0);
});
test('failure reporting does not claim full clean account',()=>{
  const s=formatReport({time:'2026-10-22T08:30:00Z',checked:['Сбор первых отзывов'],errors:[{section:'Уведомления',reason:'Авторизация истекла'}],fresh:[],firstRun:false,totals:{}});
  assert.match(s,/НЕ УДАЛОСЬ ПРОВЕРИТЬ/);
  assert.match(s,/платных услуг нет/);
});

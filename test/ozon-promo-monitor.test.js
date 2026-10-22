'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {identifyActions,checkPromotions,formatPromotionReport}=require('../lib/ozon-promo-monitor');

test('detect participating and upcoming automatic enrollment while ignoring offers only',()=>{
  const now=Date.parse('2026-10-22T12:00:00Z');
  const a=identifyActions({result:[
    {id:1,title:'Осенняя акция',date_start:'2026-10-20T00:00:00Z',date_end:'2026-11-01T00:00:00Z',is_participating:true,participating_products_count:5},
    {id:2,title:'Будущая акция',date_start:'2026-11-01T00:00:00Z',date_end:'2026-12-01T00:00:00Z',potential_products_count:15,auto_add_dates:['2026-10-25T05:00:00Z']},
    {id:3,title:'Неактуальная',date_end:'2026-01-01T00:00:00Z',is_participating:true,participating_products_count:10},
  ]},now);
  assert.equal(a.participating.length,1);
  assert.equal(a.plannedAutoAdd.length,1);
  assert.equal(a.plannedAutoAdd[0].title,'Будущая акция');
});
test('read-only scan detects auto add_mode for participating products and warns on limitations',async()=>{
  const now=Date.parse('2026-10-22T12:00:00Z');
  const paths=[];
  const result=await checkPromotions(async(path,{method,body})=>{
    paths.push({path,method,body});
    if(path==='/v1/actions')return {result:[{id:33,title:'Акция',is_participating:true,participating_products_count:2,date_start:'2026-10-20T00:00:00Z',date_end:'2026-10-31T00:00:00Z'}]};
    if(path==='/v1/actions/products')return {result:{products:[{id:100,add_mode:'AUTO',action_price:220,price:250},{id:101,add_mode:'MANUAL',action_price:225,price:260}],last_id:''}};
    throw new Error('Unexpected method');
  },now);
  assert.equal(result.details[0].autoProducts,1);
  assert.equal(result.details[0].productsChecked,2);
  assert.equal(paths.length,2);
  assert.equal(paths[0].method,'GET');
  assert.equal(paths[1].method,'POST');
  const report=formatPromotionReport({ok:true,data:result});
  assert.match(report,/добавлены автоматически/);
  assert.match(report,/Сбор первых отзывов/);
});
test('API failure must be explicitly reported, not represented as a clean result',()=>{
  assert.match(formatPromotionReport({ok:false,error:'HTTP 403'}),/проверить участие через API не удалось/);
});

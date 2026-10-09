import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerDisplay, limitHomeBanners } from '../src/home-banners.js';

const settings = {upper_count:4,lower_count:2,center_upper_count:1,center_lower_count:3,transition_seconds:4};

test('each of the four positions has an independent limit; legacy entries remain upper', () => {
  const banners = [
    ...Array.from({length:5}, (_,id)=>({id,position:'UPPER'})),
    {id:6},
    ...Array.from({length:4}, (_,id)=>({id:id+10,position:'CENTER_UPPER'})),
    ...Array.from({length:4}, (_,id)=>({id:id+20,position:'CENTER_LOWER'})),
    ...Array.from({length:4}, (_,id)=>({id:id+30,position:'LOWER'})),
    {id:40,position:'UNKNOWN'}
  ];
  assert.deepEqual(limitHomeBanners(banners,settings).map(b=>b.id), [0,1,2,3,10,20,21,22,30,31]);
  assert.deepEqual(limitHomeBanners([{id:6}],settings), [{id:6}]);
});

test('empty central positions do not borrow banners from another position', () => {
  assert.deepEqual(limitHomeBanners([{id:1,position:'UPPER'}],settings), [{id:1,position:'UPPER'}]);
  assert.deepEqual(limitHomeBanners([],settings), []);
});

test('showcase uses only central areas and has an independent three-second interval', () => {
  const display=bannerDisplay(settings);
  assert.equal(display.transitionSeconds,4);
  assert.equal(display.centerUpperCount,1);
  assert.equal(display.centerLowerCount,3);
  assert.deepEqual(display.productShowcase.positions,['CENTER_UPPER','CENTER_LOWER']);
  assert.equal(display.productShowcase.transitionSeconds,3);
  assert.equal(display.productShowcase.when,'NO_ELIGIBLE_BANNER');
  assert.equal(display.productShowcase.source,'CATALOG_PRODUCTS_WITH_IMAGE');
});

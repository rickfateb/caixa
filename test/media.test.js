import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {normalized,localBanner} from '../src/media.js';

test('padroniza foto de produto sem deformar e banner horizontal',async()=>{
  const input=await sharp({create:{width:800,height:300,channels:4,background:'#ec8200'}}).png().toBuffer();
  const product=await normalized(input,'PRODUCT');
  const banner=await normalized(input,'CATEGORY_BANNER');
  const background=await normalized(input,'OTHER');
  assert.deepEqual([product.width,product.height,product.data.length>0],[500,500,true]);
  assert.deepEqual([banner.width,banner.height,banner.data.length>0],[1200,400,true]);
  assert.deepEqual([background.width,background.height],[1200,400]);
  assert.equal((await sharp(product.data).metadata()).format,'jpeg');
  const configured=await normalized(input,'PRODUCT',{product_width:400,product_height:400,
    jpeg_quality:75,product_fit:'cover',background_color:'#eeeeee'});
  assert.deepEqual([configured.width,configured.height],[400,400]);
});

test('gera banner local a partir da categoria sem chave externa',async()=>{
  const result=await localBanner({name:'Bebidas & sucos',description:'Água, sucos e refrigerantes'});
  const meta=await sharp(result).metadata();
  assert.equal(meta.width,1200);
  assert.equal(meta.height,400);
});

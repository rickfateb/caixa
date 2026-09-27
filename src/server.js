import express from 'express';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pickPromotion, quotePrice } from './pricing.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { DATABASE_URL, GOOGLE_CLIENT_ID, ADMIN_EMAIL } = process.env;
if (!DATABASE_URL || !GOOGLE_CLIENT_ID || !ADMIN_EMAIL) {
  console.error('Configure DATABASE_URL, GOOGLE_CLIENT_ID e ADMIN_EMAIL.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const google = new OAuth2Client(GOOGLE_CLIENT_ID);
const sha = value => createHash('sha256').update(value).digest('hex');
const positiveId = value => /^\d+$/.test(String(value)) && Number(value) > 0;
const cent = value => Number.isSafeInteger(value) && value >= 0;
const failure = (code, status = 400) => Object.assign(new Error(code), { status });
const text = (value, max = 250) => typeof value === 'string' ? value.trim().slice(0, max) : '';

async function initialize() {
  await pool.query(readFileSync(path.join(root, 'sql/001_initial.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/002_promotions.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/003_units.sql'), 'utf8'));
  await pool.query(`INSERT INTO users(email,name,role) VALUES($1,$2,'ADMINISTRADOR')
    ON CONFLICT(email) DO NOTHING`, [ADMIN_EMAIL.trim().toLowerCase(), 'Administrador']);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(root, 'public'), { index: false }));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});
app.get('/api/public-config', (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

async function requireGoogle(req, _res, next) {
  try {
    const token = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
    if (!token) throw failure('LOGIN_REQUIRED', 401);
    const ticket = await google.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const identity = ticket.getPayload();
    if (!identity?.email_verified || !identity.email) throw failure('GOOGLE_IDENTITY_INVALID', 403);
    const { rows } = await pool.query('SELECT email,name,role FROM users WHERE email=$1 AND active=true', [identity.email.toLowerCase()]);
    if (!rows.length) throw failure('ACCESS_DENIED', 403);
    req.user = rows[0]; next();
  } catch (err) { next(err.status ? err : failure('GOOGLE_TOKEN_INVALID', 401)); }
}
function admin(req, _res, next) {
  if (req.user.role !== 'ADMINISTRADOR') return next(failure('ADMIN_REQUIRED', 403));
  next();
}
async function audit(client, actor, action, entity, id, details = {}) {
  await client.query('INSERT INTO audit_logs(actor,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)',
    [actor, action, entity, String(id), JSON.stringify(details)]);
}
app.get('/api/me', requireGoogle, (req, res) => res.json(req.user));
app.get('/api/admin/units', requireGoogle, async (_req, res, next) => {
  try { res.json((await pool.query('SELECT * FROM units ORDER BY name')).rows); } catch (e) { next(e); }
});
app.post('/api/admin/units', requireGoogle, admin, async (req, res, next) => {
  try {
    const { externalId, name, acronym, document, active } = req.body;
    if (!text(name,120) || !text(acronym,16)) throw failure('UNIT_NAME_AND_ACRONYM_REQUIRED');
    const { rows } = await pool.query(`INSERT INTO units(external_id,name,acronym,document,active)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [text(externalId,80) || null,text(name,120),text(acronym,16).toUpperCase(),text(document,30)||null,active !== false]);
    await audit(pool,req.user.email,'CREATE','units',rows[0].id); res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});
app.patch('/api/admin/units/:id', requireGoogle, admin, async (req, res, next) => {
  try {
    if (!positiveId(req.params.id)) throw failure('INVALID_ID');
    const { name, acronym, document, active, externalId } = req.body;
    if (!text(name,120) || !text(acronym,16)) throw failure('UNIT_NAME_AND_ACRONYM_REQUIRED');
    const { rows } = await pool.query(`UPDATE units SET name=$2,acronym=$3,document=$4,active=$5,external_id=$6,updated_at=now()
      WHERE id=$1 RETURNING *`,[req.params.id,text(name,120),text(acronym,16).toUpperCase(),text(document,30)||null,active !== false,text(externalId,80)||null]);
    if (!rows.length) throw failure('NOT_FOUND',404);
    await audit(pool,req.user.email,'UPDATE','units',req.params.id); res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/admin/products', requireGoogle, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit)||50,1),200);
    const offset = Math.min(Math.max(Number(req.query.offset)||0,0),100000);
    const query = text(req.query.q,120);
    const { rows } = await pool.query(`SELECT p.*,COALESCE(array_agg(b.barcode) FILTER(WHERE b.barcode IS NOT NULL),'{}') AS barcodes
      FROM products p LEFT JOIN product_barcodes b ON b.product_id=p.id
      WHERE $1='' OR p.description ILIKE '%'||$1||'%' OR p.code ILIKE '%'||$1||'%' OR b.barcode=$1
      GROUP BY p.id ORDER BY p.description LIMIT $2 OFFSET $3`,[query,limit,offset]);
    res.json(rows);
  } catch (e) { next(e); }
});
async function saveProduct(req, res, next) {
  let client;
  try {
    client = await pool.connect();
    const b = req.body;
    if (!text(b.description,250)) throw failure('PRODUCT_DESCRIPTION_REQUIRED');
    if (b.id && !positiveId(b.id)) throw failure('INVALID_ID');
    if (b.defaultPriceCents != null && !cent(b.defaultPriceCents)) throw failure('INVALID_PRICE');
    if (b.purchaseCostCents != null && !cent(b.purchaseCostCents)) throw failure('INVALID_COST');
    if (b.costCents != null && !cent(b.costCents)) throw failure('INVALID_COST');
    if (!Array.isArray(b.barcodes) || b.barcodes.length > 20) throw failure('INVALID_BARCODES');
    const codes = [...new Set(b.barcodes.map(v=>text(v,80)).filter(Boolean))];
    await client.query('BEGIN');
    let result;
    const values=[text(b.externalId,80)||null,text(b.status,30)||'ATIVO',text(b.itemType,50)||null,text(b.code,80)||null,
      text(b.description,250),text(b.registeredDescription,250)||null,text(b.ncm,20)||null,
      text(b.category,120)||null,text(b.subcategory,120)||null,text(b.brand,120)||null,text(b.unitOfMeasure,30)||null,
      b.purchaseCostCents??null,b.costCents??null,b.active!==false,b.defaultPriceCents??null];
    if (b.id) {
      result=await client.query(`UPDATE products SET external_id=$2,status=$3,item_type=$4,code=$5,description=$6,
        registered_description=$7,ncm=$8,category=$9,subcategory=$10,brand=$11,unit_of_measure=$12,
        purchase_cost_cents=$13,cost_cents=$14,active=$15,default_sale_price_cents=$16,updated_at=now() WHERE id=$1 RETURNING *`,[b.id,...values]);
      if (!result.rows.length) throw failure('NOT_FOUND',404);
      await client.query('DELETE FROM product_barcodes WHERE product_id=$1',[b.id]);
    } else {
      result=await client.query(`INSERT INTO products(external_id,status,item_type,code,description,registered_description,
        ncm,category,subcategory,brand,unit_of_measure,purchase_cost_cents,cost_cents,active,default_sale_price_cents)
        VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values);
    }
    for (const code of codes) await client.query('INSERT INTO product_barcodes(barcode,product_id) VALUES($1,$2)',[code,result.rows[0].id]);
    await audit(client,req.user.email,b.id?'UPDATE':'CREATE','products',result.rows[0].id);
    await client.query('COMMIT');res.status(b.id?200:201).json({...result.rows[0],barcodes:codes});
  } catch(e) { if(client) await client.query('ROLLBACK').catch(()=>{});next(e); }
  finally { client?.release(); }
}
app.post('/api/admin/products',requireGoogle,admin,saveProduct);
app.put('/api/admin/products/:id',requireGoogle,admin,(req,res,next)=>{req.body.id=req.params.id;saveProduct(req,res,next);});

app.get('/api/admin/unit-products/:unitId',requireGoogle,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.unitId)) throw failure('INVALID_ID');
    res.json((await pool.query(`SELECT up.*,p.description,p.code,p.category FROM unit_products up
      JOIN products p ON p.id=up.product_id WHERE up.unit_id=$1 ORDER BY p.description`,[req.params.unitId])).rows);
  } catch(e){next(e);}
});
app.put('/api/admin/unit-products/:unitId/:productId',requireGoogle,admin,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.unitId)||!positiveId(req.params.productId)||!cent(req.body.salePriceCents)) throw failure('INVALID_PRICE_OR_ID');
    const {rows}=await pool.query(`INSERT INTO unit_products(unit_id,product_id,sale_price_cents,active)
      VALUES($1,$2,$3,$4) ON CONFLICT(unit_id,product_id) DO UPDATE SET sale_price_cents=excluded.sale_price_cents,
      active=excluded.active,updated_at=now() RETURNING *`,[req.params.unitId,req.params.productId,req.body.salePriceCents,req.body.active!==false]);
    await audit(pool,req.user.email,'UPSERT','unit_products',`${req.params.unitId}:${req.params.productId}`);res.json(rows[0]);
  } catch(e){next(e);}
});
app.delete('/api/admin/unit-products/:unitId/:productId',requireGoogle,admin,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.unitId)||!positiveId(req.params.productId)) throw failure('INVALID_ID');
    const result=await pool.query('DELETE FROM unit_products WHERE unit_id=$1 AND product_id=$2',[req.params.unitId,req.params.productId]);
    if(!result.rowCount) throw failure('NOT_FOUND',404);
    await audit(pool,req.user.email,'DELETE','unit_products',`${req.params.unitId}:${req.params.productId}`);
    res.status(204).end();
  }catch(e){next(e);}
});
const promotionsSql = `SELECT p.*,
  COALESCE((SELECT array_agg(product_id ORDER BY product_id) FROM promotion_products WHERE promotion_id=p.id),'{}') AS product_ids,
  COALESCE((SELECT array_agg(unit_id ORDER BY unit_id) FROM promotion_units WHERE promotion_id=p.id),'{}') AS unit_ids
  FROM promotions p`;
async function promotionsForUnit(unitId) {
  const { rows } = await pool.query(`${promotionsSql} WHERE p.active=true AND p.ends_at>now()
    AND (NOT EXISTS (SELECT 1 FROM promotion_units WHERE promotion_id=p.id)
      OR EXISTS (SELECT 1 FROM promotion_units WHERE promotion_id=p.id AND unit_id=$1)) ORDER BY p.id`,[unitId]);
  return rows;
}
app.get('/api/admin/promotions',requireGoogle,async(_req,res,next)=>{
  try {res.json((await pool.query(`${promotionsSql} ORDER BY p.id DESC`)).rows);}catch(e){next(e);}
});
async function savePromotion(req,res,next) {
  let client;
  try {
    const b=req.body;
    if(b.id && !positiveId(b.id)) throw failure('INVALID_ID');
    const type=b.type, scope=b.scope;
    if(!text(b.name,120)||!['PRICE','PERCENT','BUY_N_PAY_M','SECOND_UNIT_PRICE'].includes(type)||!['ALL','PRODUCTS'].includes(scope)) throw failure('INVALID_PROMOTION');
    const starts=new Date(b.startsAt), ends=new Date(b.endsAt);
    if(!Number.isFinite(starts.getTime())||!Number.isFinite(ends.getTime())||ends<=starts) throw failure('INVALID_PERIOD');
    const ids=(value)=>Array.isArray(value)&&value.every(positiveId)&&new Set(value.map(String)).size===value.length;
    if(!ids(b.productIds)||!ids(b.unitIds)||scope==='PRODUCTS'&&!b.productIds.length||scope==='ALL'&&b.productIds.length) throw failure('INVALID_TARGETS');
    const recurrent=b.weekdays!=null;
    if(recurrent&&(!Array.isArray(b.weekdays)||!b.weekdays.length||new Set(b.weekdays).size!==b.weekdays.length||
      !b.weekdays.every(d=>Number.isInteger(d)&&d>=0&&d<=6)||
      !/^\d{2}:\d{2}$/.test(b.localStart)||!/^\d{2}:\d{2}$/.test(b.localEnd)||b.localStart>=b.localEnd||
      b.localEnd>'23:59')) throw failure('INVALID_RECURRENCE');
    if(!Number.isInteger(b.priority)||b.priority < -1000||b.priority > 1000) throw failure('INVALID_PRIORITY');
    if(type==='PRICE'&&!cent(b.priceCents)||type==='PERCENT'&&(!Number.isFinite(b.percentOff)||b.percentOff<=0||b.percentOff>100)||
      type==='BUY_N_PAY_M'&&(!Number.isInteger(b.buyQuantity)||b.buyQuantity<2||b.buyQuantity>100||!Number.isInteger(b.payQuantity)||b.payQuantity<1||b.payQuantity>=b.buyQuantity)||
      type==='SECOND_UNIT_PRICE'&&!cent(b.secondUnitPriceCents)) throw failure('INVALID_RULE');
    client=await pool.connect();await client.query('BEGIN');
    const args=[text(b.name,120),type,scope,b.priority,type==='PRICE'?b.priceCents:null,
      type==='PERCENT'?b.percentOff:null,type==='BUY_N_PAY_M'?b.buyQuantity:null,type==='BUY_N_PAY_M'?b.payQuantity:null,
      type==='SECOND_UNIT_PRICE'?b.secondUnitPriceCents:null,starts.toISOString(),ends.toISOString(),
      recurrent?b.weekdays:null,recurrent?b.localStart:null,recurrent?b.localEnd:null,b.active!==false];
    const fields='name,type,scope,priority,price_cents,percent_off,buy_quantity,pay_quantity,second_unit_price_cents,starts_at,ends_at,weekdays,local_start,local_end,active';
    let result;
    if(b.id){
      result=await client.query(`UPDATE promotions SET ${fields.split(',').map((field,i)=>`${field}=$${i+2}`).join(',')},updated_at=now() WHERE id=$1 RETURNING *`,[b.id,...args]);
      if(!result.rows.length) throw failure('NOT_FOUND',404);
      await client.query('DELETE FROM promotion_products WHERE promotion_id=$1',[b.id]);
      await client.query('DELETE FROM promotion_units WHERE promotion_id=$1',[b.id]);
    }else result=await client.query(`INSERT INTO promotions(${fields}) VALUES(${args.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,args);
    for(const id of b.productIds) await client.query('INSERT INTO promotion_products(promotion_id,product_id) VALUES($1,$2)',[result.rows[0].id,id]);
    for(const id of b.unitIds) await client.query('INSERT INTO promotion_units(promotion_id,unit_id) VALUES($1,$2)',[result.rows[0].id,id]);
    await audit(client,req.user.email,b.id?'UPDATE':'CREATE','promotions',result.rows[0].id);
    await client.query('COMMIT');res.status(b.id?200:201).json({...result.rows[0],product_ids:b.productIds,unit_ids:b.unitIds});
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}finally{client?.release();}
}
app.post('/api/admin/promotions',requireGoogle,admin,savePromotion);
app.put('/api/admin/promotions/:id',requireGoogle,admin,(req,res,next)=>{req.body.id=req.params.id;savePromotion(req,res,next);});
app.get('/api/admin/settings/:unitId',requireGoogle,async(req,res,next)=>{
  try {res.json((await pool.query('SELECT settings,updated_at FROM unit_settings WHERE unit_id=$1',[req.params.unitId])).rows[0]||{settings:{}});}catch(e){next(e);}
});
app.put('/api/admin/settings/:unitId',requireGoogle,admin,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.unitId)||!req.body.settings||Array.isArray(req.body.settings)||typeof req.body.settings!=='object') throw failure('INVALID_SETTINGS');
    const {rows}=await pool.query(`INSERT INTO unit_settings(unit_id,settings) VALUES($1,$2)
      ON CONFLICT(unit_id) DO UPDATE SET settings=excluded.settings,updated_at=now() RETURNING *`,[req.params.unitId,JSON.stringify(req.body.settings)]);
    await audit(pool,req.user.email,'UPSERT','unit_settings',req.params.unitId);res.json(rows[0]);
  }catch(e){next(e);}
});
app.get('/api/admin/registers',requireGoogle,async(_req,res,next)=>{
  try{res.json((await pool.query('SELECT id,unit_id,name,external_number,active,created_at FROM registers ORDER BY unit_id,name')).rows);}catch(e){next(e);}
});
app.post('/api/admin/registers',requireGoogle,admin,async(req,res,next)=>{
  try{
    if(!positiveId(req.body.unitId)||!text(req.body.name,80)) throw failure('INVALID_REGISTER');
    const token='fcx_'+randomBytes(32).toString('base64url');
    const {rows}=await pool.query(`INSERT INTO registers(unit_id,name,external_number,token_hash)
      VALUES($1,$2,$3,$4) RETURNING id,unit_id,name,external_number,active`,
      [req.body.unitId,text(req.body.name,80),text(req.body.externalNumber,80)||null,sha(token)]);
    await audit(pool,req.user.email,'CREATE','registers',rows[0].id);res.status(201).json({...rows[0],token});
  }catch(e){next(e);}
});
app.patch('/api/admin/registers/:id',requireGoogle,admin,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.id)||typeof req.body.active!=='boolean') throw failure('INVALID_REGISTER');
    const {rows}=await pool.query('UPDATE registers SET active=$2 WHERE id=$1 RETURNING id,unit_id,name,active',[req.params.id,req.body.active]);
    if(!rows.length) throw failure('NOT_FOUND',404);
    await audit(pool,req.user.email,'STATUS','registers',req.params.id);res.json(rows[0]);
  }catch(e){next(e);}
});
app.get('/api/admin/sales',requireGoogle,async(req,res,next)=>{
  try {
    const unitId=req.query.unitId;
    if(unitId && !positiveId(unitId)) throw failure('INVALID_ID');
    const {rows}=await pool.query(`SELECT s.id,s.client_sale_id,s.unit_id,u.name AS unit_name,r.name AS register_name,
      s.occurred_at,s.received_at,s.status,s.total_cents FROM sales s JOIN units u ON u.id=s.unit_id
      JOIN registers r ON r.id=s.register_id WHERE $1::bigint IS NULL OR s.unit_id=$1
      ORDER BY s.received_at DESC LIMIT 100`,[unitId||null]);res.json(rows);
  }catch(e){next(e);}
});

async function requireRegister(req,_res,next){
  try {
    const token=/^Bearer (fcx_[A-Za-z0-9_-]+)$/.exec(req.get('authorization')||'')?.[1];
    if(!token) throw failure('REGISTER_TOKEN_REQUIRED',401);
    const hash=sha(token);
    const {rows}=await pool.query(`SELECT r.id,r.unit_id,r.name FROM registers r JOIN units u ON u.id=r.unit_id
      WHERE r.token_hash=$1 AND r.active=true AND u.active=true`,[hash]);
    if(!rows.length) throw failure('REGISTER_NOT_AUTHORIZED',403);
    req.register=rows[0];next();
  }catch(e){next(e);}
}
app.get('/api/v1/catalog',requireRegister,async(req,res,next)=>{
  try {
    const {rows}=await pool.query(`SELECT p.id,p.external_id,p.status,p.item_type,p.code,p.description,
      p.registered_description,p.ncm,p.category,p.subcategory,p.brand,p.unit_of_measure,
      p.default_sale_price_cents,up.sale_price_cents AS unit_sale_price_cents,
      COALESCE(up.sale_price_cents,p.default_sale_price_cents) AS base_price_cents,
      GREATEST(p.updated_at,COALESCE(up.updated_at,p.updated_at)) AS updated_at,
      COALESCE(array_agg(b.barcode) FILTER(WHERE b.barcode IS NOT NULL),'{}') AS barcodes
      FROM products p LEFT JOIN unit_products up ON up.product_id=p.id AND up.unit_id=$1
      LEFT JOIN product_barcodes b ON b.product_id=p.id
      WHERE p.active=true AND (up.active IS NULL OR up.active=true)
        AND COALESCE(up.sale_price_cents,p.default_sale_price_cents) IS NOT NULL
      GROUP BY p.id,up.sale_price_cents,up.updated_at ORDER BY p.id`,[req.register.unit_id]);
    const promotions=await promotionsForUnit(req.register.unit_id);
    const at=new Date();
    const products=rows.map(p=>{
      const selected=pickPromotion(promotions,p.id,at);
      const quote=quotePrice(Number(p.base_price_cents),selected);
      return {...p,sale_price_cents:quote.totalCents,price_source:selected?'PROMOTION':p.unit_sale_price_cents!=null?'UNIT':'DEFAULT',promotion_id:selected?.id||null};
    });
    res.json({unitId:req.register.unit_id,registerId:req.register.id,generatedAt:at.toISOString(),timeZone:'America/Sao_Paulo',products,promotions});
  }catch(e){next(e);}
});
app.get('/api/v1/config',requireRegister,async(req,res,next)=>{
  try {
    const {rows}=await pool.query(`SELECT u.id,u.external_id,u.name,u.acronym,u.document,
      COALESCE(s.settings,'{}'::jsonb) AS settings,s.updated_at FROM units u
      LEFT JOIN unit_settings s ON s.unit_id=u.id WHERE u.id=$1`,[req.register.unit_id]);
    res.json({unit:rows[0],register:{id:req.register.id,name:req.register.name}});
  }catch(e){next(e);}
});
app.post('/api/v1/sales',requireRegister,async(req,res,next)=>{
  let client;
  try {
    client=await pool.connect();
    const b=req.body;
    if(!b||!text(b.clientSaleId,100)||!['APPROVED','CANCELLED'].includes(b.status)||
      !b.occurredAt||Number.isNaN(Date.parse(b.occurredAt))||!cent(b.totalCents)||
      !Array.isArray(b.items)||!b.items.length||b.items.length>200||
      !Array.isArray(b.payments)||b.payments.length>20) throw failure('INVALID_SALE');
    const occurredAt=new Date(b.occurredAt).toISOString();
    if(Date.parse(occurredAt)>Date.now()+300000) throw failure('SALE_DATE_IN_FUTURE');
    let itemTotal=0,paymentTotal=0;
    for(const item of b.items){
      if(!text(item.description,250)||!Number.isFinite(item.quantity)||item.quantity<=0||
        !/^\d+(\.\d{1,3})?$/.test(String(item.quantity))||!cent(item.unitPriceCents)||!cent(item.totalCents)||
        (item.discountCents!=null&&!cent(item.discountCents))) throw failure('INVALID_ITEM');
      if(Math.round(item.quantity*item.unitPriceCents)-(item.discountCents||0)!==item.totalCents) throw failure('ITEM_TOTAL_MISMATCH');
      if(item.productId!=null&&!positiveId(item.productId)) throw failure('INVALID_PRODUCT');
      if(item.promotionId!=null&&!positiveId(item.promotionId)) throw failure('INVALID_PROMOTION');
      itemTotal+=item.totalCents;
    }
    for(const payment of b.payments){
      if(!text(payment.method,60)||!cent(payment.amountCents)) throw failure('INVALID_PAYMENT');
      paymentTotal+=payment.amountCents;
    }
    if(itemTotal!==b.totalCents || (b.status==='APPROVED' && paymentTotal!==b.totalCents)) throw failure('SALE_TOTAL_MISMATCH');
    if(b.status==='CANCELLED' && paymentTotal!==0) throw failure('CANCELLED_PAYMENT_NOT_ZERO');
    const payloadHash=sha(JSON.stringify(b));
    await client.query('BEGIN');
    const inserted=await client.query(`INSERT INTO sales(register_id,unit_id,client_sale_id,occurred_at,status,total_cents,payload_hash,raw_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(register_id,client_sale_id) DO NOTHING RETURNING id`,
      [req.register.id,req.register.unit_id,text(b.clientSaleId,100),occurredAt,b.status,b.totalCents,payloadHash,JSON.stringify(b)]);
    if(!inserted.rows.length){
      const existing=await client.query('SELECT id,payload_hash FROM sales WHERE register_id=$1 AND client_sale_id=$2',
        [req.register.id,text(b.clientSaleId,100)]);
      await client.query('COMMIT');
      if(existing.rows[0].payload_hash!==payloadHash) throw failure('SALE_ID_CONFLICT',409);
      return res.json({id:existing.rows[0].id,duplicate:true});
    }
    const saleId=inserted.rows[0].id;
    for(let i=0;i<b.items.length;i++){
      const item=b.items[i];
      if(item.productId){
        const product=await client.query(`SELECT 1 FROM products p
          LEFT JOIN unit_products up ON up.product_id=p.id AND up.unit_id=$1
          WHERE p.id=$2 AND p.active=true AND (up.active IS NULL OR up.active=true)
          AND COALESCE(up.sale_price_cents,p.default_sale_price_cents) IS NOT NULL`,[req.register.unit_id,item.productId]);
        if(!product.rows.length) throw failure('PRODUCT_NOT_IN_UNIT');
      }
      await client.query(`INSERT INTO sale_items(sale_id,line_number,product_id,barcode,description,quantity,unit_price_cents,total_cents,discount_cents,promotion_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[saleId,i+1,item.productId||null,text(item.barcode,80)||null,
        text(item.description,250),item.quantity,item.unitPriceCents,item.totalCents,item.discountCents||0,item.promotionId||null]);
    }
    for(let i=0;i<b.payments.length;i++){
      const p=b.payments[i];
      await client.query(`INSERT INTO sale_payments(sale_id,line_number,method,amount_cents,provider_reference,metadata)
        VALUES($1,$2,$3,$4,$5,$6)`,[saleId,i+1,text(p.method,60),p.amountCents,text(p.providerReference,120)||null,
        JSON.stringify(p.metadata && typeof p.metadata==='object'&&!Array.isArray(p.metadata)?p.metadata:{})]);
    }
    await client.query('COMMIT');res.status(201).json({id:saleId,duplicate:false});
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
});

app.get('/',(_req,res)=>res.sendFile(path.join(root,'public/index.html')));
app.use((err,_req,res,_next)=>{
  if(err.type==='entity.too.large') return res.status(413).json({error:'PAYLOAD_TOO_LARGE'});
  if(err instanceof SyntaxError && 'body' in err) return res.status(400).json({error:'INVALID_JSON'});
  if(err.code==='23505') return res.status(409).json({error:'DUPLICATE_VALUE'});
  if(err.code==='23503') return res.status(400).json({error:'UNKNOWN_REFERENCE'});
  if(err.code==='23514'||err.code==='22P02') return res.status(400).json({error:'INVALID_VALUE'});
  if(err.status) return res.status(err.status).json({error:err.message});
  console.error(err);res.status(500).json({error:'INTERNAL_ERROR'});
});
initialize().then(()=>app.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Facinho caixa portal ready')))
  .catch(err=>{console.error('Database initialization failed:',err.message);process.exit(1);});

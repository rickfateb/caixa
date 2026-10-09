import express from 'express';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pickPromotion, quotePrice } from './pricing.js';
import { createRegisterToken, readRegisterToken } from './register-token.js';
import { isSimulatedPayment, simulatedPaymentConfig } from './payment-policy.js';
import { normalizeSaurusSale } from './saurus-import.js';
import { installMediaRoutes } from './media.js';
import { publishSyncRevision } from './sync.js';
import { BANNER_POSITIONS, bannerDisplay, limitHomeBanners } from './home-banners.js';
import { installFiscalRoutes } from './fiscal-routes.js';
import { enqueueFiscal, publicFiscal } from './fiscal-store.js';

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
function imageUrl(value, required = false) {
  if ((value == null || value === '') && !required) return null;
  if (typeof value !== 'string' || value.length > 2048) throw failure('INVALID_IMAGE_URL');
  if (/^\/api\/media\/[1-9]\d*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw Error();
    return url.href;
  } catch { throw failure('INVALID_IMAGE_URL'); }
}
const optionalUrl = value => value == null || value === '' ? null : imageUrl(value, true);
function productImages(value) {
  if (!Array.isArray(value) || value.length > 8) throw failure('INVALID_PRODUCT_IMAGES');
  return value.map((item, index) => ({
    image_url: imageUrl(item?.imageUrl, true), alt_text: text(item?.altText, 150),
    sort_order: index, active: item?.active !== false
  }));
}

async function initialize() {
  await pool.query(readFileSync(path.join(root, 'sql/001_initial.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/002_promotions.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/003_units.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/004_sales_saurus.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/005_media_pos.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/006_sync_dispatch.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/007_media_library.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/008_home_banners.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/009_center_banners.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(root, 'sql/010_fiscal_homologation.sql'), 'utf8'));
  await pool.query("UPDATE media_jobs SET status='PENDING',started_at=NULL WHERE status='RUNNING'");
  await pool.query(`INSERT INTO users(email,name,role) VALUES($1,$2,'ADMINISTRADOR')
    ON CONFLICT(email) DO NOTHING`, [ADMIN_EMAIL.trim().toLowerCase(), 'Administrador']);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(root, 'public'), { index: false }));
installMediaRoutes(app, pool, requireGoogle, admin, audit);
installFiscalRoutes(app, pool, {requireGoogle, admin, requireRegister, audit});
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
    const { rows } = await pool.query(`SELECT p.*,COALESCE(array_agg(b.barcode) FILTER(WHERE b.barcode IS NOT NULL),'{}') AS barcodes,
      COALESCE((SELECT json_agg(json_build_object('id',i.id,'imageUrl',i.image_url,'altText',i.alt_text,'sortOrder',i.sort_order,'active',i.active) ORDER BY i.sort_order,i.id)
        FROM product_images i WHERE i.product_id=p.id),'[]'::json) AS images
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
    const images = b.images === undefined ? null : productImages(b.images);
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
    if (images !== null) {
      await client.query('DELETE FROM product_images WHERE product_id=$1',[result.rows[0].id]);
      for (const image of images) await client.query(`INSERT INTO product_images(product_id,image_url,alt_text,sort_order,active)
        VALUES($1,$2,$3,$4,$5)`,[result.rows[0].id,image.image_url,image.alt_text,image.sort_order,image.active]);
      await publishSyncRevision(client,{actor:req.user.email});
    }
    await client.query(`INSERT INTO media_jobs(job_type,entity_type,entity_id)
      SELECT 'CAPTURE_PRODUCTS','PRODUCT',$1 WHERE (SELECT auto_capture_products FROM media_settings WHERE id=1)
      AND NOT EXISTS
        (SELECT 1 FROM product_images WHERE product_id=$1 AND active)
      AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE entity_type='PRODUCT' AND entity_id=$1 AND status IN ('PENDING','RUNNING'))`,
      [result.rows[0].id]);
    await audit(client,req.user.email,b.id?'UPDATE':'CREATE','products',result.rows[0].id);
    await client.query('COMMIT');res.status(b.id?200:201).json({...result.rows[0],barcodes:codes,images:images??[]});
  } catch(e) { if(client) await client.query('ROLLBACK').catch(()=>{});next(e); }
  finally { client?.release(); }
}
app.post('/api/admin/products',requireGoogle,admin,saveProduct);
app.put('/api/admin/products/:id',requireGoogle,admin,(req,res,next)=>{req.body.id=req.params.id;saveProduct(req,res,next);});

app.get('/api/admin/categories',requireGoogle,async(_req,res,next)=>{
  try { res.json((await pool.query('SELECT * FROM categories ORDER BY sort_order,name')).rows); }
  catch(e){next(e);}
});
async function saveCategory(req,res,next) {
  let client;
  try {
    const b=req.body;
    if(!text(b.name,120)||!Number.isInteger(b.sortOrder)||Math.abs(b.sortOrder)>100000) throw failure('INVALID_CATEGORY');
    const url=optionalUrl(b.imageUrl);
    client=await pool.connect();await client.query('BEGIN');
    let result;
    if(b.id){
      if(!positiveId(b.id)) throw failure('INVALID_ID');
      result=await client.query(`UPDATE categories SET name=$2,image_url=$3,sort_order=$4,active=$5,
        description=$6,updated_at=now() WHERE id=$1 RETURNING *`,
        [b.id,text(b.name,120),url,b.sortOrder,b.active!==false,text(b.description,500)]);
      if(!result.rows.length) throw failure('NOT_FOUND',404);
    } else result=await client.query(`INSERT INTO categories(name,image_url,sort_order,active,description)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[text(b.name,120),url,b.sortOrder,b.active!==false,text(b.description,500)]);
    await client.query(`INSERT INTO media_jobs(job_type,entity_type,entity_id)
      SELECT 'GENERATE_BANNERS','CATEGORY',$1 WHERE (SELECT auto_generate_categories FROM media_settings WHERE id=1)
      AND NOT EXISTS
        (SELECT 1 FROM category_banners WHERE category_id=$1)
      AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE entity_type='CATEGORY' AND entity_id=$1 AND status IN ('PENDING','RUNNING'))`,
      [result.rows[0].id]);
    await publishSyncRevision(client,{actor:req.user.email});
    await audit(client,req.user.email,b.id?'UPDATE':'CREATE','categories',result.rows[0].id);
    await client.query('COMMIT');
    res.status(b.id?200:201).json(result.rows[0]);
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
}
app.post('/api/admin/categories',requireGoogle,admin,saveCategory);
app.put('/api/admin/categories/:id',requireGoogle,admin,(req,res,next)=>{req.body.id=req.params.id;saveCategory(req,res,next);});

const bannersSql=`SELECT b.*,COALESCE((SELECT array_agg(unit_id ORDER BY unit_id)
  FROM banner_units WHERE banner_id=b.id),'{}') AS unit_ids FROM banners b`;
app.get('/api/admin/banner-settings',requireGoogle,async(_req,res,next)=>{
  try{res.json((await pool.query('SELECT * FROM home_banner_settings WHERE id=1')).rows[0]);}catch(e){next(e);}
});
app.put('/api/admin/banner-settings',requireGoogle,admin,async(req,res,next)=>{
  const {upperCount,lowerCount,transitionSeconds}=req.body||{};
  const {centerUpperCount,centerLowerCount}=req.body||{};
  if(![upperCount,lowerCount,...[centerUpperCount,centerLowerCount].filter(n=>n!==undefined)].every(n=>Number.isInteger(n)&&n>=1&&n<=20)||
     !Number.isInteger(transitionSeconds)||transitionSeconds<2||transitionSeconds>120)
    return next(failure('INVALID_BANNER_SETTINGS'));
  const client=await pool.connect();
  try{await client.query('BEGIN');
    const {rows}=await client.query(`UPDATE home_banner_settings SET upper_count=$1,lower_count=$2,
      transition_seconds=$3,center_upper_count=COALESCE($4,center_upper_count),center_lower_count=COALESCE($5,center_lower_count),updated_at=now() WHERE id=1 RETURNING *`,
      [upperCount,lowerCount,transitionSeconds,centerUpperCount,centerLowerCount]);
    await publishSyncRevision(client,{actor:req.user.email});
    await audit(client,req.user.email,'UPDATE','home_banner_settings',1);
    await client.query('COMMIT');res.json(rows[0]);
  }catch(e){await client.query('ROLLBACK').catch(()=>{});next(e);}finally{client.release();}
});
app.get('/api/admin/banners',requireGoogle,async(_req,res,next)=>{
  try {res.json((await pool.query(`${bannersSql} ORDER BY b.sort_order,b.id`)).rows);}catch(e){next(e);}
});
async function saveBanner(req,res,next) {
  let client;
  try {
    const b=req.body;
    if(!text(b.title,120)||!Number.isInteger(b.sortOrder)||Math.abs(b.sortOrder)>100000||
      !Array.isArray(b.unitIds)||b.unitIds.length>100||!b.unitIds.every(positiveId)||
      new Set(b.unitIds.map(String)).size!==b.unitIds.length) throw failure('INVALID_BANNER');
    const url=imageUrl(b.imageUrl,true),target=optionalUrl(b.targetUrl);
    const position=b.position||'UPPER';
    if(!BANNER_POSITIONS.includes(position))throw failure('INVALID_BANNER_POSITION');
    const starts=b.startsAt?new Date(b.startsAt):null,ends=b.endsAt?new Date(b.endsAt):null;
    if((starts&&!Number.isFinite(starts.getTime()))||(ends&&!Number.isFinite(ends.getTime()))||
      (starts&&ends&&ends<=starts)) throw failure('INVALID_PERIOD');
    client=await pool.connect();await client.query('BEGIN');
    let result;
    const args=[text(b.title,120),url,target,b.sortOrder,starts?.toISOString()||null,ends?.toISOString()||null,b.active!==false,position];
    if(b.id){
      if(!positiveId(b.id)) throw failure('INVALID_ID');
      result=await client.query(`UPDATE banners SET title=$2,image_url=$3,target_url=$4,sort_order=$5,
        starts_at=$6,ends_at=$7,active=$8,position=$9,updated_at=now() WHERE id=$1 RETURNING *`,[b.id,...args]);
      if(!result.rows.length) throw failure('NOT_FOUND',404);
      await client.query('DELETE FROM banner_units WHERE banner_id=$1',[b.id]);
    }else result=await client.query(`INSERT INTO banners(title,image_url,target_url,sort_order,starts_at,ends_at,active,position)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,args);
    for(const id of b.unitIds) await client.query('INSERT INTO banner_units(banner_id,unit_id) VALUES($1,$2)',[result.rows[0].id,id]);
    await publishSyncRevision(client,{actor:req.user.email});
    await audit(client,req.user.email,b.id?'UPDATE':'CREATE','banners',result.rows[0].id);
    await client.query('COMMIT');res.status(b.id?200:201).json({...result.rows[0],unit_ids:b.unitIds});
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
}
app.post('/api/admin/banners',requireGoogle,admin,saveBanner);
app.put('/api/admin/banners/:id',requireGoogle,admin,(req,res,next)=>{req.body.id=req.params.id;saveBanner(req,res,next);});

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
  let client;
  try {
    if(!positiveId(req.params.unitId)||!req.body.settings||Array.isArray(req.body.settings)||typeof req.body.settings!=='object') throw failure('INVALID_SETTINGS');
    validateAppSettings(req.body.settings);
    client=await pool.connect();await client.query('BEGIN');
    const {rows}=await client.query(`INSERT INTO unit_settings(unit_id,settings) VALUES($1,$2)
      ON CONFLICT(unit_id) DO UPDATE SET settings=excluded.settings,updated_at=now() RETURNING *`,[req.params.unitId,JSON.stringify(req.body.settings)]);
    await publishSyncRevision(client,{actor:req.user.email,unitId:req.params.unitId});
    await audit(client,req.user.email,'UPSERT','unit_settings',req.params.unitId);
    await client.query('COMMIT');res.json(rows[0]);
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
});
function validateAppSettings(settings) {
  const sync=settings.syncIntervalSeconds;
  if(sync!==undefined&&(!Number.isInteger(sync)||sync<60||sync>86400)) throw failure('INVALID_SYNC_INTERVAL');
  const theme=settings.theme;
  if(theme!==undefined&&(!theme||typeof theme!=='object'||Array.isArray(theme)||
    !['primaryColor','accentColor','backgroundColor','textColor'].every(key=>theme[key]===undefined||
      typeof theme[key]==='string'&&/^#[0-9a-fA-F]{6}$/.test(theme[key])))) throw failure('INVALID_THEME');
  const media=settings.media;
  if(media!==undefined){
    if(!media||typeof media!=='object'||Array.isArray(media)) throw failure('INVALID_MEDIA');
    for(const key of ['logoUrl','welcomeBackgroundUrl','homeBackgroundUrl','checkoutBackgroundUrl'])
      if(media[key]!==undefined) optionalUrl(media[key]);
  }
  if(settings.paymentMethods!==undefined&&(!Array.isArray(settings.paymentMethods)||
    !settings.paymentMethods.length||new Set(settings.paymentMethods).size!==settings.paymentMethods.length||
    !settings.paymentMethods.every(method=>['PIX','CREDIT','DEBIT'].includes(method)))) throw failure('INVALID_PAYMENT_METHODS');
}
function appSettings(settings) {
  return {
    syncIntervalSeconds:settings.syncIntervalSeconds??300,
    theme:{primaryColor:'#086B3A',accentColor:'#22B36D',backgroundColor:'#EAFAF8',textColor:'#173C31',...settings.theme},
    media:{logoUrl:null,welcomeBackgroundUrl:null,homeBackgroundUrl:null,checkoutBackgroundUrl:null,...settings.media},
    ...simulatedPaymentConfig()
  };
}
app.get('/api/admin/registers',requireGoogle,async(_req,res,next)=>{
  try{res.json((await pool.query('SELECT id,unit_id,name,external_number,active,created_at FROM registers ORDER BY unit_id,name')).rows);}catch(e){next(e);}
});
app.post('/api/admin/registers',requireGoogle,admin,async(req,res,next)=>{
  try{
    if(!positiveId(req.body.unitId)||!text(req.body.name,80)) throw failure('INVALID_REGISTER');
    const token=createRegisterToken();
    const {rows}=await pool.query(`INSERT INTO registers(unit_id,name,external_number,token_hash)
      VALUES($1,$2,$3,$4) RETURNING id,unit_id,name,external_number,active`,
      [req.body.unitId,text(req.body.name,80),text(req.body.externalNumber,80)||null,sha(token)]);
    await audit(pool,req.user.email,'CREATE','registers',rows[0].id);res.status(201).json({...rows[0],token});
  }catch(e){next(e);}
});
app.post('/api/admin/registers/:id/rotate-token',requireGoogle,admin,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.id)) throw failure('INVALID_REGISTER');
    const token=createRegisterToken();
    const {rows}=await pool.query('UPDATE registers SET token_hash=$2 WHERE id=$1 RETURNING id,unit_id,name,external_number,active',
      [req.params.id,sha(token)]);
    if(!rows.length) throw failure('NOT_FOUND',404);
    await audit(pool,req.user.email,'ROTATE_TOKEN','registers',req.params.id);
    res.json({...rows[0],token});
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
app.post('/api/admin/sync-dispatch',requireGoogle,admin,async(req,res,next)=>{
  let client;
  try {
    const unitId=req.body?.unitId??null;
    if(unitId!==null&&!positiveId(unitId)) throw failure('INVALID_ID');
    client=await pool.connect();await client.query('BEGIN');
    const {rows}=await client.query(`INSERT INTO unit_sync_state(unit_id,revision,requested_by)
      SELECT id,2,$2 FROM units WHERE active=true AND ($1::bigint IS NULL OR id=$1)
      ON CONFLICT(unit_id) DO UPDATE SET revision=unit_sync_state.revision+1,
        requested_at=now(),requested_by=excluded.requested_by
      RETURNING unit_id,revision,requested_at`,[unitId,req.user.email]);
    if(unitId!==null&&!rows.length) throw failure('UNIT_NOT_FOUND',404);
    await audit(client,req.user.email,'DISPATCH','unit_sync_state',unitId??'ALL',
      {unitIds:rows.map(row=>row.unit_id)});
    await client.query('COMMIT');res.json({units:rows});
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
});
app.get('/api/admin/sync-status',requireGoogle,async(_req,res,next)=>{
  try {
    const {rows}=await pool.query(`SELECT r.id AS register_id,r.name AS register_name,r.active AS register_active,
      u.id AS unit_id,u.name AS unit_name,u.acronym,s.revision AS current_revision,
      s.requested_at,a.revision AS acknowledged_revision,a.acknowledged_at
      FROM registers r JOIN units u ON u.id=r.unit_id
      LEFT JOIN unit_sync_state s ON s.unit_id=u.id
      LEFT JOIN register_sync_status a ON a.register_id=r.id
      ORDER BY u.name,r.name`);
    res.json(rows);
  }catch(e){next(e);}
});
app.get('/api/admin/sales',requireGoogle,async(req,res,next)=>{
  try {
    const unitId=req.query.unitId||null;
    if(unitId && !positiveId(unitId)) throw failure('INVALID_ID');
    const source=text(req.query.source,20);
    if(source&&!['POS','SAURUS'].includes(source)) throw failure('INVALID_SOURCE');
    const search=text(req.query.q,100);
    const offset=Math.min(Math.max(Number(req.query.offset)||0,0),100000);
    const {rows}=await pool.query(`SELECT s.id,s.source,s.external_sale_id,s.client_sale_id,s.external_store_id,
      s.external_register_number,s.source_status,s.unit_id,u.name AS unit_name,r.name AS register_name,
      s.occurred_at,s.received_at,s.status,s.total_cents,
      (SELECT count(*)::int FROM sale_items i WHERE i.sale_id=s.id) AS item_count
      FROM sales s LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN registers r ON r.id=s.register_id
      WHERE ($1::bigint IS NULL OR s.unit_id=$1) AND ($2::text='' OR s.source=$2)
        AND ($3::text='' OR s.external_sale_id ILIKE '%'||$3||'%' OR s.client_sale_id ILIKE '%'||$3||'%'
          OR s.external_register_number=$3)
      ORDER BY s.occurred_at DESC,s.id DESC LIMIT 100 OFFSET $4`,[unitId,source,search,offset]);res.json(rows);
  }catch(e){next(e);}
});
app.get('/api/admin/sales/:id',requireGoogle,async(req,res,next)=>{
  try {
    if(!positiveId(req.params.id)) throw failure('INVALID_ID');
    const sale=(await pool.query(`SELECT s.id,s.source,s.external_sale_id,s.client_sale_id,s.external_store_id,
      s.external_register_number,s.source_status,s.unit_id,u.name AS unit_name,r.name AS register_name,
      s.occurred_at,s.received_at,s.status,s.total_cents
      FROM sales s LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN registers r ON r.id=s.register_id
      WHERE s.id=$1`,[req.params.id])).rows[0];
    if(!sale) throw failure('NOT_FOUND',404);
    const [items,payments,installments,tef]=await Promise.all([
      pool.query(`SELECT line_number,external_item_id,external_product_id,product_id,product_code,barcode,
        description,unit_of_measure,quantity,unit_price_cents,source_unit_price,total_cents,discount_cents,promotion_id
        FROM sale_items WHERE sale_id=$1 ORDER BY line_number`,[req.params.id]),
      pool.query(`SELECT line_number,external_payment_id,method,amount_cents,provider_reference,simulated
        FROM sale_payments WHERE sale_id=$1 ORDER BY line_number`,[req.params.id]),
      pool.query(`SELECT line_number,external_id,external_payment_id,due_date,amount_cents,paid_cents,status
        FROM sale_installments WHERE sale_id=$1 ORDER BY line_number`,[req.params.id]),
      pool.query(`SELECT line_number,external_id,external_payment_id,transaction_id,authorization_code,
        nsu,control_code,status,transaction_type,occurred_at,simulated FROM sale_tef WHERE sale_id=$1 ORDER BY line_number`,[req.params.id])
    ]);
    res.json({...sale,items:items.rows,payments:payments.rows,installments:installments.rows,tef:tef.rows});
  }catch(e){next(e);}
});
app.get('/api/admin/saurus-mappings',requireGoogle,async(_req,res,next)=>{
  try {res.json((await pool.query(`SELECT m.external_store_id,m.external_register_number,m.unit_id,m.register_id,
    u.name AS unit_name,r.name AS register_name,m.updated_at,
    (SELECT count(*)::int FROM sales s WHERE s.source='SAURUS' AND s.external_store_id=m.external_store_id
      AND s.external_register_number=m.external_register_number) AS sale_count
    FROM saurus_register_mappings m LEFT JOIN units u ON u.id=m.unit_id
    LEFT JOIN registers r ON r.id=m.register_id ORDER BY m.external_store_id,m.external_register_number`)).rows);}
  catch(e){next(e);}
});
app.put('/api/admin/saurus-mappings/:storeId/:registerNumber',requireGoogle,admin,async(req,res,next)=>{
  let client;
  try {
    const storeId=text(req.params.storeId,80),number=text(req.params.registerNumber,80);
    const unitId=req.body.unitId||null,registerId=req.body.registerId||null;
    if(!storeId||!number||(unitId&&!positiveId(unitId))||(registerId&&!positiveId(registerId))||
      (registerId&&!unitId)) throw failure('INVALID_MAPPING');
    client=await pool.connect();await client.query('BEGIN');
    if(unitId){
      const found=await client.query('SELECT 1 FROM units WHERE id=$1',[unitId]);
      if(!found.rows.length) throw failure('UNIT_NOT_FOUND');
    }
    if(registerId){
      const found=await client.query('SELECT 1 FROM registers WHERE id=$1 AND unit_id=$2',[registerId,unitId]);
      if(!found.rows.length) throw failure('REGISTER_NOT_IN_UNIT');
    }
    const {rows}=await client.query(`INSERT INTO saurus_register_mappings(external_store_id,external_register_number,unit_id,register_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(external_store_id,external_register_number)
      DO UPDATE SET unit_id=excluded.unit_id,register_id=excluded.register_id,updated_at=now() RETURNING *`,
      [storeId,number,unitId,registerId]);
    await client.query(`UPDATE sales SET unit_id=$3,register_id=$4 WHERE source='SAURUS'
      AND external_store_id=$1 AND external_register_number=$2`,[storeId,number,unitId,registerId]);
    await audit(client,req.user.email,'MAP','saurus_register_mappings',`${storeId}/${number}`,{unitId,registerId});
    await client.query('COMMIT');res.json(rows[0]);
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
});
app.post('/api/admin/saurus-sales/import',requireGoogle,admin,async(req,res,next)=>{
  let client;
  try {
    if(!Array.isArray(req.body?.sales)||!req.body.sales.length||req.body.sales.length>20)
      throw failure('INVALID_SAURUS_BATCH');
    let imported=0,updated=0;
    client=await pool.connect();await client.query('BEGIN');
    for(const record of req.body.sales){
      let s;
      try{s=normalizeSaurusSale(record);}catch(e){throw failure(e.message);}
      await client.query(`INSERT INTO saurus_register_mappings(external_store_id,external_register_number)
        VALUES($1,$2) ON CONFLICT DO NOTHING`,[s.storeId,s.registerNumber]);
      const mapping=(await client.query(`SELECT unit_id,register_id FROM saurus_register_mappings
        WHERE external_store_id=$1 AND external_register_number=$2`,[s.storeId,s.registerNumber])).rows[0];
      const old=(await client.query(`SELECT id FROM sales WHERE source='SAURUS' AND external_sale_id=$1`,[s.externalId])).rows[0];
      const {rows}=await client.query(`INSERT INTO sales(source,external_sale_id,external_store_id,external_register_number,
        source_status,unit_id,register_id,client_sale_id,occurred_at,status,total_cents,payload_hash,raw_payload)
        VALUES('SAURUS',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(source,external_sale_id) WHERE external_sale_id IS NOT NULL DO UPDATE SET
          external_store_id=excluded.external_store_id,external_register_number=excluded.external_register_number,
          source_status=excluded.source_status,unit_id=excluded.unit_id,register_id=excluded.register_id,
          occurred_at=excluded.occurred_at,status=excluded.status,total_cents=excluded.total_cents,
          payload_hash=excluded.payload_hash,raw_payload=excluded.raw_payload RETURNING id`,
        [s.externalId,s.storeId,s.registerNumber,s.sourceStatus,mapping?.unit_id||null,mapping?.register_id||null,
          `SAURUS:${s.externalId}`.slice(0,100),s.occurredAt,s.status,s.totalCents,sha(JSON.stringify(s)),
          JSON.stringify({source:'SAURUS',externalSaleId:s.externalId,externalStoreId:s.storeId,
            externalRegisterNumber:s.registerNumber})]);
      const id=rows[0].id;
      for(const table of ['sale_items','sale_payments','sale_installments','sale_tef'])
        await client.query(`DELETE FROM ${table} WHERE sale_id=$1`,[id]);
      const externalProductIds=[...new Set(s.items.map(i=>i.externalProductId).filter(Boolean))];
      const productRows=externalProductIds.length?(await client.query('SELECT id,external_id FROM products WHERE external_id=ANY($1::text[])',[externalProductIds])).rows:[];
      const productIds=new Map(productRows.map(p=>[p.external_id,p.id]));
      for(const i of s.items)await client.query(`INSERT INTO sale_items(sale_id,line_number,external_item_id,external_product_id,
        product_id,product_code,description,unit_of_measure,quantity,unit_price_cents,source_unit_price,
        total_cents,discount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id,i.lineNumber,i.externalId,i.externalProductId,productIds.get(i.externalProductId)||null,i.productCode,
          i.description,i.unit,i.quantity,i.unitPriceCents,i.sourceUnitPrice,i.totalCents,i.discountCents]);
      for(const p of s.payments)await client.query(`INSERT INTO sale_payments(sale_id,line_number,external_payment_id,
        method,amount_cents,metadata) VALUES($1,$2,$3,$4,$5,$6)`,
        [id,p.lineNumber,p.externalId,p.method,p.amountCents,JSON.stringify(p.plan?{plan:p.plan}:{})]);
      for(const p of s.installments)await client.query(`INSERT INTO sale_installments(sale_id,line_number,external_id,
        external_payment_id,due_date,amount_cents,paid_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id,p.lineNumber,p.externalId,p.externalPaymentId,p.dueDate,p.amountCents,p.paidCents,p.status]);
      for(const p of s.tef)await client.query(`INSERT INTO sale_tef(sale_id,line_number,external_id,
        external_payment_id,transaction_id,authorization_code,nsu,control_code,status,transaction_type,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id,p.lineNumber,p.externalId,p.externalPaymentId,p.transactionId,p.authorizationCode,p.nsu,
          p.controlCode,p.status,p.transactionType,p.occurredAt]);
      if(old)updated++;else imported++;
    }
    await audit(client,req.user.email,'IMPORT','saurus_sales','batch',{imported,updated});
    await client.query('COMMIT');res.json({imported,updated});
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
});

async function requireRegister(req,_res,next){
  try {
    const authorization=req.get('authorization');
    const token=readRegisterToken(authorization);
    if(!token) {
      // Diagnose Android activation without recording credentials or personal data.
      console.warn('REGISTER_AUTH_REJECTED',JSON.stringify({
        path:req.path,authorizationPresent:Boolean(authorization),
        bearerScheme:/^\s*Bearer(?:\s|$)/i.test(authorization||''),
        headerLength:authorization?.length||0
      }));
      throw failure('REGISTER_TOKEN_REQUIRED',401);
    }
    const hash=sha(token);
    const {rows}=await pool.query(`SELECT r.id,r.unit_id,r.name FROM registers r JOIN units u ON u.id=r.unit_id
      WHERE r.token_hash=$1 AND r.active=true AND u.active=true`,[hash]);
    if(!rows.length) throw failure('REGISTER_NOT_AUTHORIZED',403);
    req.register=rows[0];next();
  }catch(e){next(e);}
}
app.get('/api/v1/sync-state',requireRegister,async(req,res,next)=>{
  try {
    await pool.query('INSERT INTO unit_sync_state(unit_id) VALUES($1) ON CONFLICT DO NOTHING',
      [req.register.unit_id]);
    const {rows}=await pool.query('SELECT revision,requested_at FROM unit_sync_state WHERE unit_id=$1',
      [req.register.unit_id]);
    res.json({unitId:req.register.unit_id,registerId:req.register.id,
      revision:rows[0].revision,requestedAt:rows[0].requested_at,checkIntervalSeconds:15});
  }catch(e){next(e);}
});
app.post('/api/v1/sync-ack',requireRegister,async(req,res,next)=>{
  try {
    const revision=String(req.body?.revision??'');
    if(!/^[1-9]\d{0,18}$/.test(revision)||BigInt(revision)>9223372036854775807n)
      throw failure('INVALID_REVISION');
    const current=(await pool.query('SELECT revision FROM unit_sync_state WHERE unit_id=$1',
      [req.register.unit_id])).rows[0];
    if(!current||BigInt(revision)>BigInt(current.revision)) throw failure('INVALID_REVISION');
    await pool.query(`INSERT INTO register_sync_status(register_id,revision) VALUES($1,$2)
      ON CONFLICT(register_id) DO UPDATE SET revision=excluded.revision,acknowledged_at=now()
      WHERE register_sync_status.revision<=excluded.revision`,[req.register.id,revision]);
    res.json({acknowledged:true,currentRevision:current.revision,upToDate:revision===String(current.revision)});
  }catch(e){next(e);}
});
app.get('/api/v1/catalog',requireRegister,async(req,res,next)=>{
  try {
    const mediaBase=process.env.PUBLIC_BASE_URL?.replace(/\/$/,'')||
      (process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:null);
    const mediaUrl=url=>url?.startsWith('/api/media/')&&mediaBase?mediaBase+url:url;
    const {rows}=await pool.query(`SELECT p.id,p.external_id,p.status,p.item_type,p.code,p.description,
      p.registered_description,p.ncm,p.category,p.subcategory,p.brand,p.unit_of_measure,
      p.default_sale_price_cents,up.sale_price_cents AS unit_sale_price_cents,
      COALESCE(up.sale_price_cents,p.default_sale_price_cents) AS base_price_cents,
      GREATEST(p.updated_at,COALESCE(up.updated_at,p.updated_at)) AS updated_at,
      COALESCE((SELECT json_agg(json_build_object('id',i.id,'imageUrl',i.image_url,'altText',i.alt_text,'sortOrder',i.sort_order)
        ORDER BY i.sort_order,i.id) FROM product_images i WHERE i.product_id=p.id AND i.active=true AND i.review_status='APPROVED'),'[]'::json) AS images,
      (SELECT i.image_url FROM product_images i WHERE i.product_id=p.id AND i.active=true
        AND i.review_status='APPROVED' ORDER BY i.sort_order,i.id LIMIT 1) AS image_url,
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
      return {...p,image_url:mediaUrl(p.image_url),images:p.images.map(i=>({...i,imageUrl:mediaUrl(i.imageUrl)})),
        sale_price_cents:quote.totalCents,price_source:selected?'PROMOTION':p.unit_sale_price_cents!=null?'UNIT':'DEFAULT',promotion_id:selected?.id||null};
    });
    const categoryNames=[...new Set(products.map(p=>p.category).filter(Boolean))];
    const categoryRows=categoryNames.length?(await pool.query(`SELECT id,name,image_url,sort_order,
      COALESCE((SELECT json_agg(json_build_object('id',b.id,'title',b.title,'imageUrl','/api/media/'||b.asset_id,
        'isPrimary',b.is_primary,'displayOrder',b.display_order) ORDER BY b.display_order,b.id)
        FROM category_banners b WHERE b.category_id=categories.id AND b.active
        AND (b.starts_at IS NULL OR b.starts_at<=now()) AND (b.ends_at IS NULL OR b.ends_at>now())),'[]'::json) AS banners
      FROM categories
      WHERE active=true AND name=ANY($1::text[])`,[categoryNames])).rows:[];
    const categoryByName=new Map(categoryRows.map(c=>[c.name,c]));
    const categories=categoryNames.map(name=>categoryByName.get(name)||{id:null,name,image_url:null,sort_order:0,banners:[]})
      .map(c=>({...c,image_url:mediaUrl(c.image_url),primary_banner_url:mediaUrl(c.image_url),
        banners:c.banners.map(b=>({...b,imageUrl:mediaUrl(b.imageUrl)}))}))
      .sort((a,b)=>a.sort_order-b.sort_order||a.name.localeCompare(b.name,'pt-BR'));
    const bannerSettings=(await pool.query('SELECT * FROM home_banner_settings WHERE id=1')).rows[0];
    const eligibleBanners=(await pool.query(`${bannersSql} WHERE b.active=true
      AND (b.starts_at IS NULL OR b.starts_at<=now()) AND (b.ends_at IS NULL OR b.ends_at>now())
      AND (NOT EXISTS(SELECT 1 FROM banner_units WHERE banner_id=b.id)
        OR EXISTS(SELECT 1 FROM banner_units WHERE banner_id=b.id AND unit_id=$1))
       ORDER BY b.sort_order,b.id`,[req.register.unit_id])).rows;
    const banners=limitHomeBanners(eligibleBanners,bannerSettings)
      .map(b=>({...b,image_url:mediaUrl(b.image_url)}));
    const display=bannerDisplay(bannerSettings);
    res.json({unitId:req.register.unit_id,registerId:req.register.id,generatedAt:at.toISOString(),
      timeZone:'America/Sao_Paulo',products,categories,banners,bannerDisplay:display,promotions});
  }catch(e){next(e);}
});
app.get('/api/v1/config',requireRegister,async(req,res,next)=>{
  try {
    const {rows}=await pool.query(`SELECT u.id,u.external_id,u.name,u.acronym,u.document,
      COALESCE(s.settings,'{}'::jsonb) AS settings,s.updated_at FROM units u
      LEFT JOIN unit_settings s ON s.unit_id=u.id WHERE u.id=$1`,[req.register.unit_id]);
    const bannerSettings=(await pool.query('SELECT * FROM home_banner_settings WHERE id=1')).rows[0];
    res.json({unit:rows[0],register:{id:req.register.id,name:req.register.name},
      appConfig:appSettings(rows[0].settings),
      bannerDisplay:bannerDisplay(bannerSettings),
      generatedAt:new Date().toISOString()});
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
      !Array.isArray(b.payments)||b.payments.length>20||
      (b.installments!==undefined&&(!Array.isArray(b.installments)||b.installments.length>50))||
      (b.tef!==undefined&&(!Array.isArray(b.tef)||b.tef.length>50))) throw failure('INVALID_SALE');
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
      if(!isSimulatedPayment(payment)) throw failure('INVALID_SIMULATED_PAYMENT');
      if(payment.clientPaymentId!==undefined&&!text(payment.clientPaymentId,80)) throw failure('INVALID_PAYMENT');
      paymentTotal+=payment.amountCents;
    }
    const paymentIds=b.payments.map(p=>text(p.clientPaymentId,80)).filter(Boolean);
    if(new Set(paymentIds).size!==paymentIds.length) throw failure('DUPLICATE_PAYMENT_ID');
    const validPaymentLine=value=>Number.isInteger(value)&&value>=1&&value<=b.payments.length;
    for(const installment of b.installments||[]){
      if(!validPaymentLine(installment.paymentLineNumber)||!cent(installment.amountCents)||
        !/^\d{4}-\d{2}-\d{2}$/.test(installment.dueDate)||
        Number.isNaN(Date.parse(`${installment.dueDate}T00:00:00Z`))||
        new Date(`${installment.dueDate}T00:00:00Z`).toISOString().slice(0,10)!==installment.dueDate||
        b.payments[installment.paymentLineNumber-1].method!=='CREDIT'||
        !text(b.payments[installment.paymentLineNumber-1].clientPaymentId,80)||
        (installment.status!==undefined&&!text(installment.status,40))) throw failure('INVALID_INSTALLMENT');
    }
    for(let line=1;line<=b.payments.length;line++){
      const parts=(b.installments||[]).filter(x=>x.paymentLineNumber===line);
      if(parts.length&&parts.reduce((sum,x)=>sum+x.amountCents,0)!==b.payments[line-1].amountCents)
        throw failure('INSTALLMENT_TOTAL_MISMATCH');
    }
    for(const entry of b.tef||[]){
      if(!validPaymentLine(entry.paymentLineNumber)||entry.simulated!==true||
        entry.status!=='SIMULATED'||!['PIX','CREDIT','DEBIT'].includes(entry.transactionType)||
        b.payments[entry.paymentLineNumber-1].method!==entry.transactionType||
        !isSimulatedPayment(b.payments[entry.paymentLineNumber-1])||
        !text(b.payments[entry.paymentLineNumber-1].clientPaymentId,80)||
        entry.authorizationCode||entry.nsu||entry.controlCode||
        (entry.occurredAt&&Number.isNaN(Date.parse(entry.occurredAt)))) throw failure('INVALID_SIMULATED_TEF');
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
      if(existing.rows[0].payload_hash!==payloadHash) throw failure('SALE_ID_CONFLICT',409);
      const fiscal=publicFiscal((await client.query('SELECT * FROM fiscal_documents WHERE sale_id=$1 AND environment=2',[existing.rows[0].id])).rows[0]);
      await client.query('COMMIT');
      return res.json({id:existing.rows[0].id,duplicate:true,fiscal});
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
      await client.query(`INSERT INTO sale_items(sale_id,line_number,external_item_id,external_product_id,product_id,
        product_code,barcode,description,unit_of_measure,quantity,unit_price_cents,total_cents,discount_cents,promotion_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[saleId,i+1,
        text(item.clientLineId,80)||null,text(item.externalProductId,80)||null,item.productId||null,
        text(item.productCode,80)||null,text(item.barcode,80)||null,text(item.description,250),
        text(item.unitOfMeasure,30)||null,item.quantity,item.unitPriceCents,item.totalCents,
        item.discountCents||0,item.promotionId||null]);
    }
    for(let i=0;i<b.payments.length;i++){
      const p=b.payments[i];
      await client.query(`INSERT INTO sale_payments(sale_id,line_number,external_payment_id,method,amount_cents,provider_reference,metadata,simulated)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[saleId,i+1,text(p.clientPaymentId,80)||null,
        text(p.method,60),p.amountCents,text(p.providerReference,120)||null,
        JSON.stringify(p.metadata && typeof p.metadata==='object'&&!Array.isArray(p.metadata)?p.metadata:{}),true]);
    }
    for(let i=0;i<(b.installments||[]).length;i++){
      const part=b.installments[i];
      await client.query(`INSERT INTO sale_installments(sale_id,line_number,external_id,external_payment_id,due_date,amount_cents,paid_cents,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[saleId,i+1,text(part.clientInstallmentId,80)||null,
        text(b.payments[part.paymentLineNumber-1].clientPaymentId,80)||null,part.dueDate,part.amountCents,0,
        text(part.status,40)||'SIMULATED']);
    }
    for(let i=0;i<(b.tef||[]).length;i++){
      const entry=b.tef[i];
      await client.query(`INSERT INTO sale_tef(sale_id,line_number,external_id,external_payment_id,transaction_id,
        status,transaction_type,occurred_at,simulated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)`,
        [saleId,i+1,text(entry.clientTransactionId,80)||null,
          text(b.payments[entry.paymentLineNumber-1].clientPaymentId,80)||null,
          text(entry.clientTransactionId,80)||null,'SIMULATED',entry.transactionType,
          entry.occurredAt?new Date(entry.occurredAt).toISOString():occurredAt]);
    }
    const fiscal=await enqueueFiscal(client,saleId);
    await client.query('COMMIT');res.status(201).json({id:saleId,duplicate:false,fiscal});
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}
  finally{client?.release();}
});

app.get('/',(_req,res)=>res.sendFile(path.join(root,'public/index.html')));
app.use((err,_req,res,_next)=>{
  if(err.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'IMAGE_TOO_LARGE'});
  if(err.code==='LIMIT_UNEXPECTED_FILE') return res.status(400).json({error:'INVALID_IMAGE_UPLOAD'});
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

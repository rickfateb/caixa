import multer from 'multer';
import sharp from 'sharp';

const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1}});
const validId = value => /^\d+$/.test(String(value)) && Number(value)>0;
const bad = (code,status=400) => Object.assign(new Error(code),{status});
const clean = (s,n=200) => typeof s==='string'?s.trim().slice(0,n):'';
const assetUrl = id => `/api/media/${id}`;
const authorizedFile = f => f && ['image/jpeg','image/png','image/webp'].includes(f.mimetype);
export async function normalized(buffer,kind,settings={}) {
  const original=sharp(buffer,{limitInputPixels:25e6,failOn:'error'});
  const info=await original.metadata();
  if(!['jpeg','png','webp'].includes(info.format))throw bad('INVALID_IMAGE');
  const banner=kind!=='PRODUCT';
  const width=banner?(settings.banner_width??1200):(settings.product_width??500);
  const height=banner?(settings.banner_height??400):(settings.product_height??500);
  const data=await original.rotate().resize(width,height,{fit:banner?'cover':settings.product_fit??'contain',
    background:settings.background_color??'#ffffff',withoutEnlargement:false})
    .flatten({background:settings.background_color??'#ffffff'})
    .jpeg({quality:settings.jpeg_quality??82,mozjpeg:true}).toBuffer();
  return {data,width,height};
}
async function store(pool,{buffer,kind,name='',source='UPLOADED',sourceUrl=null,attribution=null,keepOriginal=false}) {
  const settings=(await pool.query('SELECT * FROM media_settings WHERE id=1')).rows[0];
  const result=await normalized(buffer,kind,settings);
  const {rows}=await pool.query(`INSERT INTO media_assets(kind,original_name,original_data,original_mime,data,mime_type,width,height,bytes,source_type,source_url,attribution)
    VALUES($1,$2,$3,$4,$5,'image/jpeg',$6,$7,$8,$9,$10,$11) RETURNING id`,
    [kind,clean(name,250),keepOriginal?buffer:null,keepOriginal?'image/'+(await sharp(buffer).metadata()).format:null,
      result.data,result.width,result.height,result.data.length,source,sourceUrl,attribution]);
  return rows[0].id;
}
async function fetchImage(url) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:' || parsed.hostname!=='images.openfoodfacts.org' || parsed.port || parsed.username || parsed.password)
    throw bad('IMAGE_SOURCE_NOT_ALLOWED');
  const response=await fetch(url,{headers:{'User-Agent':process.env.MEDIA_USER_AGENT||'FacinhoCaixa/1.0 (https://facinho.com)'},signal:AbortSignal.timeout(12000),redirect:'error'});
  if(response.status===429||response.status===503)throw bad('IMAGE_SOURCE_RATE_LIMITED',429);
  if(!response.ok || !/^image\/(jpeg|png|webp)/.test(response.headers.get('content-type')||''))throw bad('IMAGE_DOWNLOAD_FAILED',502);
  if(Number(response.headers.get('content-length')||0)>5*1024*1024)throw bad('IMAGE_TOO_LARGE');
  const data=Buffer.from(await response.arrayBuffer());
  if(data.length>5*1024*1024)throw bad('IMAGE_TOO_LARGE');
  return data;
}
const offHeaders={'User-Agent':process.env.MEDIA_USER_AGENT||'FacinhoCaixa/1.0 (https://facinho.com)'};
let nextSearchAt=0;
async function throttleSearch(){
  const wait=Math.max(0,nextSearchAt-Date.now());
  nextSearchAt=Math.max(nextSearchAt,Date.now())+9000;
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
}
async function findProductImage(product,barcode) {
  let record=null,method='BARCODE';
  if(barcode){
    const response=await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}?fields=code,product_name,brands,image_front_url,image_url`,{headers:offHeaders,signal:AbortSignal.timeout(12000)});
    if(response.status===429||response.status===503)throw bad('IMAGE_SOURCE_RATE_LIMITED',429);
    if(response.ok){const data=await response.json();if(data.status===1 && data.product?.code?.replace(/^0+/,'')===barcode.replace(/^0+/,''))record=data.product;}
  }
  if(!record && barcode)throw bad('IMAGE_NOT_FOUND',404);
  if(!record){
    await throttleSearch();
    const query=[product.brand,product.description].filter(Boolean).join(' ');
    const url=`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=5&fields=code,product_name,brands,image_front_url,image_url`;
    const response=await fetch(url,{headers:offHeaders,signal:AbortSignal.timeout(12000)});
    if(response.status===429||response.status===503)throw bad('IMAGE_SOURCE_RATE_LIMITED',429);
    if(!response.ok)throw bad(`IMAGE_SEARCH_HTTP_${response.status}`,502);
    record=(await response.json()).products?.find(p=>p.image_front_url||p.image_url);
    method='DESCRIPTION';
  }
  const imageUrl=record?.image_front_url||record?.image_url;
  if(!imageUrl)throw bad('IMAGE_NOT_FOUND',404);
  return {imageUrl,method,foundBarcode:record.code};
}
export function installMediaRoutes(app,pool,requireGoogle,admin,audit){
  app.get('/api/admin/media/settings',requireGoogle,async(_req,res,next)=>{try{
    res.json((await pool.query('SELECT * FROM media_settings WHERE id=1')).rows[0]);
  }catch(e){next(e);}});
  app.put('/api/admin/media/settings',requireGoogle,admin,async(req,res,next)=>{try{
    const b=req.body;
    const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
    if(!integer(b.productWidth,200,1000)||!integer(b.productHeight,200,1000)||
      !integer(b.bannerWidth,600,2400)||!integer(b.bannerHeight,200,1200)||
      !integer(b.jpegQuality,60,95)||!/^#[0-9a-fA-F]{6}$/.test(b.backgroundColor)||
      !['contain','cover'].includes(b.productFit))throw bad('INVALID_MEDIA_SETTINGS');
    const {rows}=await pool.query(`UPDATE media_settings SET product_width=$1,product_height=$2,
      banner_width=$3,banner_height=$4,jpeg_quality=$5,background_color=$6,product_fit=$7,
      auto_generate_categories=$8,auto_capture_products=$9,updated_at=now() WHERE id=1 RETURNING *`,
      [b.productWidth,b.productHeight,b.bannerWidth,b.bannerHeight,b.jpegQuality,b.backgroundColor,b.productFit,
        b.autoGenerateCategories===true,b.autoCaptureProducts===true]);
    await audit(pool,req.user.email,'UPDATE','media_settings',1);res.json(rows[0]);
  }catch(e){next(e);}});
  // A URL é pública para o app e só serve registros que ainda são usados por uma mídia ativa.
  app.get('/api/media/:id',async(req,res,next)=>{try{
    if(!validId(req.params.id))throw bad('INVALID_ID');
    const {rows}=await pool.query('SELECT data,mime_type,created_at FROM media_assets WHERE id=$1',[req.params.id]);
    if(!rows.length)throw bad('NOT_FOUND',404);
    res.set('Content-Type',rows[0].mime_type).set('Cache-Control','public, max-age=3600').send(rows[0].data);
  }catch(e){next(e);}});
  app.get('/api/admin/media',requireGoogle,async(req,res,next)=>{try{
    const type=clean(req.query.type,30),q=clean(req.query.q,100),offset=Math.max(0,Math.min(Number(req.query.offset)||0,100000));
    const [assets,categories,products,banners,jobs]=await Promise.all([
      pool.query(`SELECT id,kind,original_name,mime_type,width,height,bytes,source_type,source_url,attribution,created_at
        FROM media_assets WHERE ($1='' OR kind=$1) ORDER BY id DESC LIMIT 100 OFFSET $2`,[type,offset]),
      pool.query(`SELECT c.*, (SELECT count(*)::int FROM category_banners b WHERE b.category_id=c.id) banner_count FROM categories c ORDER BY c.name`),
      pool.query(`SELECT p.id,p.description,p.brand,p.category,p.code,p.active,
        COALESCE((SELECT array_agg(barcode ORDER BY barcode) FROM product_barcodes WHERE product_id=p.id),'{}') barcodes,
        (SELECT json_agg(json_build_object('id',i.id,'imageUrl',i.image_url,'assetId',i.asset_id,'active',i.active,
          'barcode',i.barcode,'sourceType',i.source_type,'reviewStatus',i.review_status) ORDER BY i.id DESC)
          FROM product_images i WHERE i.product_id=p.id) images
        FROM products p WHERE $1='' OR p.description ILIKE '%'||$1||'%' OR p.code ILIKE '%'||$1||'%' OR
          EXISTS(SELECT 1 FROM product_barcodes b WHERE b.product_id=p.id AND b.barcode=$1)
        ORDER BY p.description LIMIT 100 OFFSET $2`,[q,offset]),
      pool.query(`SELECT b.*,c.name category_name FROM category_banners b JOIN categories c ON c.id=b.category_id ORDER BY c.name,b.display_order,b.id`),
      pool.query(`SELECT * FROM media_jobs ORDER BY id DESC LIMIT 30`)]);
    res.json({assets:assets.rows,categories:categories.rows,products:products.rows,banners:banners.rows,jobs:jobs.rows});
  }catch(e){next(e);}});
  app.post('/api/admin/media/upload',requireGoogle,admin,upload.single('file'),async(req,res,next)=>{try{
    if(!authorizedFile(req.file))throw bad('INVALID_IMAGE');
    const kind=clean(req.body.kind,30),entityId=req.body.entityId;
    if(!['PRODUCT','CATEGORY_BANNER','OTHER'].includes(kind))throw bad('INVALID_MEDIA_KIND');
    if(kind!=='OTHER'&&!validId(entityId))throw bad('INVALID_ID');
    const client=await pool.connect();let assetId;
    try{await client.query('BEGIN');
      assetId=await store(client,{buffer:req.file.buffer,kind,name:req.file.originalname,keepOriginal:true});
      if(kind==='PRODUCT'){
        const product=(await client.query('SELECT id FROM products WHERE id=$1',[entityId])).rows[0];if(!product)throw bad('NOT_FOUND',404);
        const barcode=clean(req.body.barcode,80)||(await client.query('SELECT barcode FROM product_barcodes WHERE product_id=$1 ORDER BY barcode LIMIT 1',[entityId])).rows[0]?.barcode||null;
        if(barcode){const owner=(await client.query('SELECT product_id FROM product_barcodes WHERE barcode=$1',[barcode])).rows[0];
          if(!owner||String(owner.product_id)!==String(entityId))throw bad('BARCODE_PRODUCT_MISMATCH',409);}
        await client.query('UPDATE product_images SET active=false WHERE product_id=$1',[entityId]);
        await client.query(`INSERT INTO product_images(product_id,image_url,asset_id,barcode,source_type,review_status)
          VALUES($1,$2,$3,$4,'UPLOADED','APPROVED')`,[entityId,assetUrl(assetId),assetId,barcode]);
        await client.query('UPDATE products SET updated_at=now() WHERE id=$1',[entityId]);
      }else if(kind==='CATEGORY_BANNER'){
        const category=(await client.query('SELECT id FROM categories WHERE id=$1',[entityId])).rows[0];if(!category)throw bad('NOT_FOUND',404);
        const {rows}=await client.query(`INSERT INTO category_banners(category_id,asset_id,title,source_type)
          VALUES($1,$2,$3,'UPLOADED') RETURNING id`,[entityId,assetId,clean(req.body.title,120)]);
        await audit(client,req.user.email,'CREATE','category_banners',rows[0].id);
      }
      await audit(client,req.user.email,'UPLOAD','media_assets',assetId);
      await client.query('COMMIT');res.status(201).json({id:assetId,url:assetUrl(assetId)});
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }catch(e){next(e);}});
  app.patch('/api/admin/media/product-images/:id',requireGoogle,admin,async(req,res,next)=>{try{
    if(!validId(req.params.id))throw bad('INVALID_ID');
    const client=await pool.connect();try{await client.query('BEGIN');
      const before=(await client.query('SELECT product_id FROM product_images WHERE id=$1',[req.params.id])).rows[0];
      if(!before)throw bad('NOT_FOUND',404);
      if(req.body.active===true)await client.query('UPDATE product_images SET active=false WHERE product_id=$1',[before.product_id]);
      const {rows}=await client.query(`UPDATE product_images SET active=$2,review_status=$3,updated_at=now()
        WHERE id=$1 RETURNING *`,[req.params.id,req.body.active===true,
          req.body.reviewStatus==='APPROVED'?'APPROVED':'PENDING']);
      await client.query('UPDATE products SET updated_at=now() WHERE id=$1',[rows[0].product_id]);
      await audit(client,req.user.email,'UPDATE','product_images',req.params.id);
      await client.query('COMMIT');res.json(rows[0]);
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }catch(e){next(e);}});
  app.patch('/api/admin/media/category-banners/:id',requireGoogle,admin,async(req,res,next)=>{
    const client=await pool.connect();try{
      if(!validId(req.params.id))throw bad('INVALID_ID');
      await client.query('BEGIN');
      const old=(await client.query('SELECT * FROM category_banners WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!old)throw bad('NOT_FOUND',404);
      const active=req.body.active===undefined?old.active:req.body.active===true;
      const primary=req.body.isPrimary===undefined?old.is_primary:req.body.isPrimary===true;
      if(primary&&!active)throw bad('PRIMARY_MUST_BE_ACTIVE');
      if(primary)await client.query('UPDATE category_banners SET is_primary=false WHERE category_id=$1',[old.category_id]);
      const {rows}=await client.query(`UPDATE category_banners SET active=$2,is_primary=$3,title=$4,
        display_order=$5,updated_at=now() WHERE id=$1 RETURNING *`,[old.id,active,primary,
        req.body.title===undefined?old.title:clean(req.body.title,120),
        Number.isInteger(req.body.displayOrder)?req.body.displayOrder:old.display_order]);
      await client.query(`UPDATE categories SET image_url=(SELECT '/api/media/'||asset_id FROM category_banners
        WHERE category_id=$1 AND active AND is_primary),updated_at=now() WHERE id=$1`,[old.category_id]);
      await audit(client,req.user.email,'UPDATE','category_banners',old.id);
      await client.query('COMMIT');res.json(rows[0]);
    }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
  });
  app.post('/api/admin/media/capture/:productId',requireGoogle,admin,async(req,res,next)=>{try{
    const result=await capture(pool,req.params.productId);
    await audit(pool,req.user.email,'CAPTURE','products',req.params.productId,result);
    res.status(201).json(result);
  }catch(e){next(e);}});
  app.post('/api/admin/media/generate/:categoryId',requireGoogle,admin,async(req,res,next)=>{try{
    const result=await generate(pool,req.params.categoryId);
    await audit(pool,req.user.email,'GENERATE','categories',req.params.categoryId,result);
    res.status(201).json(result);
  }catch(e){next(e);}});
  app.post('/api/admin/media/jobs',requireGoogle,admin,async(req,res,next)=>{try{
    const type=req.body.type;
    if(!['CAPTURE_PRODUCTS','GENERATE_BANNERS'].includes(type))throw bad('INVALID_JOB_TYPE');
    const query=type==='CAPTURE_PRODUCTS'?`SELECT p.id FROM products p WHERE p.active AND NOT EXISTS
      (SELECT 1 FROM product_images i WHERE i.product_id=p.id AND i.active AND i.review_status='APPROVED')
      AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.entity_type='PRODUCT' AND j.entity_id=p.id AND j.status IN ('PENDING','RUNNING'))
      ORDER BY p.id LIMIT 200`:`SELECT c.id FROM categories c WHERE c.active AND NOT EXISTS
      (SELECT 1 FROM category_banners b WHERE b.category_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.entity_type='CATEGORY' AND j.entity_id=c.id AND j.status IN ('PENDING','RUNNING'))
      ORDER BY c.id LIMIT 100`;
    const rows=(await pool.query(query)).rows;
    for(const row of rows)await pool.query(`INSERT INTO media_jobs(job_type,entity_type,entity_id) VALUES($1,$2,$3)`,
      [type,type==='CAPTURE_PRODUCTS'?'PRODUCT':'CATEGORY',row.id]);
    res.json({queued:rows.length});
  }catch(e){next(e);}});
  let working=false,completed=0;
  const timer=setInterval(async()=>{if(working)return;working=true;
    try{
      const {rows}=await pool.query(`UPDATE media_jobs SET status='RUNNING',started_at=now() WHERE id=(
        SELECT id FROM media_jobs WHERE status='PENDING' AND available_at<=now()
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
      if(rows.length){const job=rows[0];try{
        if(job.job_type==='CAPTURE_PRODUCTS')await capture(pool,job.entity_id);
        else await generate(pool,job.entity_id);
        await pool.query("UPDATE media_jobs SET status='DONE',finished_at=now() WHERE id=$1",[job.id]);
        completed++;if(completed===1||completed%25===0)console.log(`Media jobs completed: ${completed}`);
      }catch(e){console.error(`Media job ${job.id} failed: ${clean(e.message,100)}`);
        if(e.status===429)await pool.query(`UPDATE media_jobs SET status='PENDING',message=$2,
          available_at=now()+interval '10 minutes',started_at=NULL WHERE id=$1`,[job.id,clean(e.message,300)]);
        else await pool.query("UPDATE media_jobs SET status='ERROR',message=$2,finished_at=now() WHERE id=$1",[job.id,clean(e.message,300)]);}}
    }catch(e){console.error('Media worker:',e);}finally{working=false;}
  },3000);timer.unref();
}
async function capture(pool,id){
  if(!validId(id))throw bad('INVALID_ID');
  const product=(await pool.query(`SELECT p.*,COALESCE(array_agg(b.barcode) FILTER(WHERE b.barcode IS NOT NULL),'{}') barcodes
    FROM products p LEFT JOIN product_barcodes b ON b.product_id=p.id WHERE p.id=$1 GROUP BY p.id`,[id])).rows[0];
  if(!product)throw bad('NOT_FOUND',404);
  let result,barcode=null;
  for(const code of product.barcodes){try{result=await findProductImage(product,code);barcode=code;if(result.method==='BARCODE')break;}catch(e){if(e.message!=='IMAGE_NOT_FOUND')throw e;}}
  if(!result)result=await findProductImage(product,null);
  const bytes=await fetchImage(result.imageUrl);
  const client=await pool.connect();try{await client.query('BEGIN');
    const assetId=await store(client,{buffer:bytes,kind:'PRODUCT',name:`${barcode||id}.jpg`,source:'OPEN_FOOD_FACTS',
      sourceUrl:result.imageUrl,attribution:'Open Food Facts · ODbL / CC BY-SA'});
    const manual=(await client.query(`SELECT 1 FROM product_images WHERE product_id=$1 AND active AND source_type='UPLOADED' LIMIT 1`,[id])).rows.length>0;
    const approved=result.method==='BARCODE'&&!manual;
    if(approved)await client.query('UPDATE product_images SET active=false WHERE product_id=$1 AND source_type<>\'UPLOADED\'',[id]);
    await client.query(`INSERT INTO product_images(product_id,image_url,asset_id,barcode,source_type,review_status,active)
      VALUES($1,$2,$3,$4,'OPEN_FOOD_FACTS',$5,$6)`,[id,assetUrl(assetId),assetId,barcode,
        approved?'APPROVED':'PENDING',approved]);
    if(approved)await client.query('UPDATE products SET updated_at=now() WHERE id=$1',[id]);
    await client.query('COMMIT');return {id:assetId,url:assetUrl(assetId),reviewStatus:approved?'APPROVED':'PENDING',method:result.method};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function generate(pool,id){
  if(!validId(id))throw bad('INVALID_ID');
  const category=(await pool.query('SELECT * FROM categories WHERE id=$1',[id])).rows[0];if(!category)throw bad('NOT_FOUND',404);
  let bytes;
  if(process.env.OPENAI_API_KEY){
    const response=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-1.5',size:'1536x1024',quality:'low',output_format:'png',
        prompt:`Create a clean, polished horizontal grocery category banner image for a Brazilian self-service market. Category: ${category.name}. Description: ${category.description}. Show representative products, warm natural light, subtle Facinho orange and deep green accents. No words, text, logos, trademarks or people. Leave some calm negative space for app overlay text.`}),
      signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw bad('IMAGE_GENERATION_FAILED',502);
    const data=await response.json();if(!data.data?.[0]?.b64_json)throw bad('IMAGE_GENERATION_FAILED',502);
    bytes=Buffer.from(data.data[0].b64_json,'base64');
  }else bytes=await localBanner(category);
  const client=await pool.connect();try{await client.query('BEGIN');
    const assetId=await store(client,{buffer:bytes,kind:'CATEGORY_BANNER',name:`category_${id}.png`,source:'GENERATED'});
    const {rows}=await client.query(`INSERT INTO category_banners(category_id,asset_id,title,active,is_primary,source_type)
      VALUES($1,$2,$3,false,false,'GENERATED') RETURNING id`,[id,assetId,category.name]);
    await client.query('COMMIT');return {id:rows[0].id,url:assetUrl(assetId),active:false};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
function escapeXml(value){return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));}
export async function localBanner(category){
  const label=category.name.slice(0,40),description=category.description.slice(0,80);
  const seed=[...label.toLowerCase()].reduce((n,ch)=>n+ch.charCodeAt(0),0);
  const hue=(seed*17)%360;
  const tokens=(description||label).toLowerCase();
  const art=/bebid|água|suco|cerveja|refrigerante|energético/.test(tokens)?
    '<path d="M795 45h115l-12 70 35 48v175H772V163l35-48z"/><path d="M1000 115h99l-10 75 20 32v115H990V222l20-32z"/>':
    /sorvet|gelad|congel|freezer/.test(tokens)?
    '<path d="M820 205q-70-60 0-110 20-90 95-28 73-48 88 40 81 80-20 125z"/><path d="M850 220h135l-68 135z"/>':
    /limpez|sabão|detergente|higiene/.test(tokens)?
    '<path d="M835 20h95v60l55 50v210H785V130l50-50z"/><path d="M845 5h74v35h-74z"/><circle cx="1050" cy="80" r="28"/>':
    /doce|chocolat|biscoito|salgad|snack/.test(tokens)?
    '<path d="M770 140l70-60 62 45 68-50 70 70-60 65 40 80-85 50-70-43-70 38-50-80z"/><circle cx="860" cy="175" r="23"/><circle cx="960" cy="225" r="19"/>':
    '<path d="M810 90h255l-28 250H840z"/><path d="M845 55h187v60H845z"/><circle cx="890" cy="165" r="25"/><circle cx="985" cy="175" r="25"/>';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400">
    <defs><linearGradient id="g"><stop stop-color="#163c2a"/><stop offset="1" stop-color="hsl(${hue},36%,33%)"/></linearGradient></defs>
    <rect width="1200" height="400" fill="url(#g)"/><circle cx="1000" cy="190" r="280" fill="#ffffff" opacity=".06"/>
    <circle cx="1130" cy="65" r="180" fill="#ff873e" opacity=".72"/><g fill="#ffe6ca" opacity=".88" stroke="#ffffff" stroke-width="6">${art}</g>
    <rect x="70" y="65" width="5" height="270" rx="2" fill="#ff873e"/><text x="105" y="183" fill="#ffffff" font-family="sans-serif" font-weight="bold" font-size="58">${escapeXml(label)}</text>
    <text x="107" y="230" fill="#d8ebdc" font-family="sans-serif" font-size="23">${escapeXml(description.slice(0,55))}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

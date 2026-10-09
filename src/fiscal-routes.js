import {fiscalError, validateIssuer, validateProfile} from './fiscal-core.js';
import {enqueueFiscal, publicFiscal} from './fiscal-store.js';

const id = value => /^[1-9]\d*$/.test(String(value));
const handler = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);

export function installFiscalRoutes(app,pool,{requireGoogle,admin,requireRegister,audit}) {
  app.get('/api/admin/fiscal/issuers',requireGoogle,handler(async(_req,res) => {
    res.json((await pool.query(`SELECT f.id,f.unit_id,u.name AS unit_name,f.cnpj,f.series,f.next_number,
      f.enabled,f.config,f.reviewed_by,f.updated_at FROM fiscal_issuers f JOIN units u ON u.id=f.unit_id
      ORDER BY u.name`)).rows);
  }));
  app.post('/api/admin/fiscal/issuers',requireGoogle,admin,handler(async(req,res) => {
    if (!id(req.body?.unitId)) throw fiscalError('INVALID_UNIT');
    const config=validateIssuer(req.body.config);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const row=(await client.query(`INSERT INTO fiscal_issuers(unit_id,cnpj,series,next_number,config,enabled,reviewed_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[req.body.unitId,config.cnpj,config.series,config.nextNumber,
        JSON.stringify(config),config.enabled,req.user.email])).rows[0];
      await audit(client,req.user.email,'FISCAL_ISSUER_CREATED','fiscal_issuers',row.id,
        {unitId:req.body.unitId,environment:2});
      await client.query('COMMIT');res.status(201).json(row);
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }));
  app.patch('/api/admin/fiscal/issuers/:id',requireGoogle,admin,handler(async(req,res) => {
    if (!id(req.params.id) || typeof req.body?.enabled!=='boolean' || Object.keys(req.body).length!==1)
      throw fiscalError('ONLY_ENABLED_CAN_BE_CHANGED');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const row=(await client.query('UPDATE fiscal_issuers SET enabled=$2,updated_at=now() WHERE id=$1 RETURNING id',
        [req.params.id,req.body.enabled])).rows[0];
      if (!row) throw fiscalError('ISSUER_NOT_FOUND',404);
      await audit(client,req.user.email,'FISCAL_ISSUER_ENABLED','fiscal_issuers',row.id,{enabled:req.body.enabled});
      await client.query('COMMIT');res.json(row);
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }));
  app.put('/api/admin/fiscal/issuers/:id/products/:productId',requireGoogle,admin,handler(async(req,res) => {
    if (!id(req.params.id) || !id(req.params.productId)) throw fiscalError('INVALID_ID');
    const profile=validateProfile(req.body);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO fiscal_product_profiles(issuer_id,product_id,profile,reviewed_by)
        VALUES($1,$2,$3,$4) ON CONFLICT(issuer_id,product_id) DO UPDATE
        SET profile=excluded.profile,reviewed_by=excluded.reviewed_by,updated_at=now()`,
        [req.params.id,req.params.productId,JSON.stringify(profile),req.user.email]);
      await audit(client,req.user.email,'FISCAL_PROFILE_REVIEWED','fiscal_product_profiles',
        `${req.params.id}/${req.params.productId}`,{profile});
      await client.query('COMMIT');res.json({saved:true});
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }));
  app.get('/api/admin/fiscal/documents',requireGoogle,handler(async(req,res) => {
    if (req.query.unitId && !id(req.query.unitId)) throw fiscalError('INVALID_UNIT');
    const rows=(await pool.query(`SELECT d.id,d.sale_id,d.status,d.series,d.number,d.access_key,d.protocol,
      d.sefaz_code,d.sefaz_message,d.qr_code,d.last_error,d.updated_at,
      (d.danfe_pdf IS NOT NULL) AS danfe_available,u.name AS unit_name,s.client_sale_id FROM fiscal_documents d
      JOIN sales s ON s.id=d.sale_id JOIN units u ON u.id=s.unit_id
      WHERE ($1::bigint IS NULL OR s.unit_id=$1) ORDER BY d.id DESC LIMIT 100`,[req.query.unitId || null])).rows;
    res.json(rows.map(row=>({...publicFiscal(row),saleId:row.sale_id,unitName:row.unit_name,clientSaleId:row.client_sale_id})));
  }));
  app.post('/api/admin/fiscal/sales/:id/prepare',requireGoogle,admin,handler(async(req,res) => {
    if (!id(req.params.id)) throw fiscalError('INVALID_ID');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const document=await enqueueFiscal(client,req.params.id,{retryBlocked:true});
      await audit(client,req.user.email,'FISCAL_PREPARE','sales',req.params.id,{status:document.status,environment:2});
      await client.query('COMMIT');res.json(document);
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }));
  app.get('/api/v1/sales/:clientSaleId/fiscal',requireRegister,handler(async(req,res) => {
    const sale=(await pool.query(`SELECT id FROM sales WHERE register_id=$1 AND client_sale_id=$2`,
      [req.register.id,req.params.clientSaleId])).rows[0];
    if (!sale) throw fiscalError('SALE_NOT_FOUND',404);
    const doc=(await pool.query(`SELECT id,status,series,number,access_key,protocol,sefaz_code,sefaz_message,
      qr_code,last_error,updated_at,(danfe_pdf IS NOT NULL) AS danfe_available
      FROM fiscal_documents WHERE sale_id=$1 AND environment=2`,[sale.id])).rows[0];
    res.json(publicFiscal(doc));
  }));
  for (const type of ['xml','pdf']) {
    app.get(`/api/v1/sales/:clientSaleId/fiscal/${type}`,requireRegister,handler(async(req,res) => {
      const field=type==='xml'?'authorized_xml':'danfe_pdf';
      const row=(await pool.query(`SELECT d.id,d.${field} AS content FROM fiscal_documents d
        JOIN sales s ON s.id=d.sale_id WHERE s.register_id=$1 AND s.client_sale_id=$2
        AND d.environment=2 AND d.status='AUTHORIZED'`,[req.register.id,req.params.clientSaleId])).rows[0];
      if (!row?.content) throw fiscalError('FISCAL_FILE_NOT_AVAILABLE',404);
      res.set('Content-Disposition',`attachment; filename="nfce-homologacao-${row.id}.${type}"`);
      res.type(type==='xml'?'application/xml':'application/pdf').send(type==='pdf'?Buffer.from(row.content):row.content);
    }));
    app.get(`/api/admin/fiscal/documents/:id/${type}`,requireGoogle,handler(async(req,res) => {
      if (!id(req.params.id)) throw fiscalError('INVALID_ID');
      const field=type==='xml'?'authorized_xml':'danfe_pdf';
      const row=(await pool.query(`SELECT ${field} AS content FROM fiscal_documents WHERE id=$1 AND status='AUTHORIZED'`,
        [req.params.id])).rows[0];
      if (!row?.content) throw fiscalError('FISCAL_FILE_NOT_AVAILABLE',404);
      res.set('Content-Disposition',`attachment; filename="nfce-homologacao-${req.params.id}.${type}"`);
      res.type(type==='xml'?'application/xml':'application/pdf').send(type==='pdf'?Buffer.from(row.content):row.content);
    }));
  }
}

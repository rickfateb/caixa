// Dedicated process: synchronous native calls never block the Portal HTTP server.
import pg from 'pg';
import {createAcbrAdapter} from './fiscal-acbr.js';
import {processFiscalDocument} from './fiscal-processing.js';
import {setTimeout as delay} from 'node:timers/promises';

process.env.TZ='America/Sao_Paulo';
if (!process.env.DATABASE_URL || process.env.FISCAL_HOMOLOGATION_WORKER!=='1') {
  console.error('Configure DATABASE_URL e FISCAL_HOMOLOGATION_WORKER=1. Worker exclusivo de homologação.');
  process.exit(1);
}
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
let stopped=false;
process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
try {
  await client.connect();
  // Session lock releases on process/connection death. Only one native worker runs.
  const lock=(await client.query('SELECT pg_try_advisory_lock(80620261009::bigint) AS acquired')).rows[0].acquired;
  if (!lock) throw Error('FISCAL_WORKER_ALREADY_RUNNING');
  while (!stopped) {
    const document=(await client.query(`SELECT d.* FROM fiscal_documents d JOIN fiscal_issuers f ON f.id=d.issuer_id
      WHERE f.enabled=true AND d.retry_at<=now() AND
      (d.status IN ('PENDING','SIGNED','SUBMITTING','UNKNOWN') OR (d.status='AUTHORIZED' AND d.danfe_pdf IS NULL))
      ORDER BY d.id LIMIT 1`)).rows[0];
    if (!document) {await delay(2000);continue;}
    let adapter;
    try {
      if (document.attempts>=12) throw Error('FISCAL_RECONCILIATION_REQUIRED');
      adapter=createAcbrAdapter(document.snapshot.issuer);
      await processFiscalDocument(client,document,adapter);
    } catch(error) {
      const code=/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'ACBR_RUNTIME_FAILURE';
      // Do not log native exceptions: they can contain tax documents or credentials.
      await client.query(`UPDATE fiscal_documents SET status=CASE WHEN status='AUTHORIZED' THEN status ELSE 'MANUAL' END,
        last_error=$2,retry_at=now()+interval '1 minute',updated_at=now() WHERE id=$1`,[document.id,code]);
      console.warn('FISCAL_DOCUMENT_REQUIRES_REVIEW',{documentId:document.id,code});
    } finally {try {adapter?.close();} catch {}}
  }
} catch(error) {
  console.error('FISCAL_WORKER_STOPPED',/^[A-Z_]+$/.test(error.message)?error.message:'CHECK_RUNTIME_CONFIGURATION');
  process.exitCode=1;
} finally {await client.end().catch(()=>{});}

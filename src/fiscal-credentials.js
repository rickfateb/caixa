import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fiscalError} from './fiscal-core.js';

const maxPfxBytes=1024*1024;

export function fiscalSecretsKey(env=process.env) {
  const value=env.FISCAL_SECRETS_KEY;
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw fiscalError('FISCAL_SECRETS_NOT_CONFIGURED',503);
  const key=Buffer.from(value,'base64');
  if(key.length!==32)throw fiscalError('FISCAL_SECRETS_NOT_CONFIGURED',503);
  return key;
}

export function encryptFiscalSecret(value,key,issuerId,field) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`fiscal:${issuerId}:${field}`));
  const encrypted=Buffer.concat([cipher.update(value),cipher.final()]);
  return Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),encrypted]);
}

export function decryptFiscalSecret(value,key,issuerId,field) {
  try {
    if(!Buffer.isBuffer(value)||value.length<30||value[0]!==1)throw Error();
    const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(1,13));
    decipher.setAAD(Buffer.from(`fiscal:${issuerId}:${field}`));
    decipher.setAuthTag(value.subarray(13,29));
    return Buffer.concat([decipher.update(value.subarray(29)),decipher.final()]);
  } catch {throw fiscalError('FISCAL_CREDENTIALS_UNAVAILABLE',503);}
}

export function validateFiscalUpload(file,{password,csc,cscId}) {
  if(!file?.buffer||!/^.+\.(pfx|p12)$/i.test(file.originalname||'')||
    file.buffer.length<100||file.buffer.length>maxPfxBytes||file.buffer[0]!==0x30)
    throw fiscalError('INVALID_A1_FILE');
  if(typeof password!=='string'||!password||password.length>256||/[\0\r\n]/.test(password))
    throw fiscalError('INVALID_A1_PASSWORD');
  if(typeof csc!=='string'||!/^[A-Za-z0-9]{16,36}$/.test(csc))throw fiscalError('INVALID_HOMOLOGATION_CSC');
  if(typeof cscId!=='string'||!/^\d{6}$/.test(cscId))throw fiscalError('INVALID_HOMOLOGATION_CSC_ID');
  try {createSecureContext({pfx:file.buffer,passphrase:password});}
  catch {throw fiscalError('INVALID_CERTIFICATE_OR_PASSWORD');}
  return {pfx:file.buffer,password,csc,cscId,
    sha256:createHash('sha256').update(file.buffer).digest('hex')};
}

// ACBrLib accepts a file path, so the worker materializes A1 in a private
// temporary directory only for the lifetime of a single adapter call.
export async function runtimeCredentials(client,issuer,env=process.env) {
  const row=(await client.query('SELECT * FROM fiscal_credentials WHERE issuer_id=$1',[issuer.id])).rows[0];
  if(!row)return {env,cleanup(){}}; // Legacy worker environment variables remain supported.
  const key=fiscalSecretsKey(env),id=issuer.id;
  const pfx=decryptFiscalSecret(row.encrypted_pfx,key,id,'pfx');
  const password=decryptFiscalSecret(row.encrypted_password,key,id,'password').toString('utf8');
  const csc=decryptFiscalSecret(row.encrypted_csc,key,id,'csc').toString('utf8');
  const base=existsSync('/dev/shm')?'/dev/shm':tmpdir();
  const directory=mkdtempSync(path.join(base,'facinho-a1-'));
  const filename=path.join(directory,'certificate.pfx');
  try {writeFileSync(filename,pfx,{mode:0o600});}
  catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
  pfx.fill(0);
  const prefix=`FISCAL_${issuer.credentialsRef}_`;
  return {env:{...env,[prefix+'PFX_PATH']:filename,[prefix+'PFX_PASSWORD']:password,
    [prefix+'CSC']:csc,[prefix+'CSC_ID']:row.csc_id},
  cleanup(){rmSync(directory,{recursive:true,force:true});}};
}

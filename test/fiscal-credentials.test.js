import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fiscalSecretsKey,encryptFiscalSecret,decryptFiscalSecret,validateFiscalUpload,
  runtimeCredentials} from '../src/fiscal-credentials.js';

const key=randomBytes(32);
test('A1, senha e CSC são cifrados com vínculo ao emitente e tipo do segredo',async()=>{
  const pfx=Buffer.from([0x30,1,2,3]),password='senha privada',csc='ABCDEF0123456789';
  const row={issuer_id:'7',encrypted_pfx:encryptFiscalSecret(pfx,key,'7','pfx'),
    encrypted_password:encryptFiscalSecret(password,key,'7','password'),
    encrypted_csc:encryptFiscalSecret(csc,key,'7','csc'),csc_id:'000001'};
  assert.equal(decryptFiscalSecret(row.encrypted_password,key,'7','password').toString(),password);
  assert.throws(()=>decryptFiscalSecret(row.encrypted_password,key,'8','password'),/FISCAL_CREDENTIALS_UNAVAILABLE/);
  assert.throws(()=>decryptFiscalSecret(row.encrypted_password,key,'7','csc'),/FISCAL_CREDENTIALS_UNAVAILABLE/);
  const tampered=Buffer.from(row.encrypted_csc);tampered[tampered.length-1]^=1;
  assert.throws(()=>decryptFiscalSecret(tampered,key,'7','csc'),/FISCAL_CREDENTIALS_UNAVAILABLE/);
  const db={query:async()=>({rows:[row]})};
  const runtime=await runtimeCredentials(db,{id:'7',credentialsRef:'PORTAL_1'},
    {FISCAL_SECRETS_KEY:key.toString('base64')});
  try {
    assert.deepEqual(readFileSync(runtime.env.FISCAL_PORTAL_1_PFX_PATH),pfx);
    assert.equal(runtime.env.FISCAL_PORTAL_1_PFX_PASSWORD,password);
    assert.equal(runtime.env.FISCAL_PORTAL_1_CSC,csc);
    assert.equal(runtime.env.FISCAL_PORTAL_1_CSC_ID,'000001');
  } finally {const filename=runtime.env.FISCAL_PORTAL_1_PFX_PATH;runtime.cleanup();
    assert.equal(existsSync(filename),false);}
});

test('upload rejeita arquivo, senha e CSC inválidos sem guardar dados',()=>{
  assert.throws(()=>fiscalSecretsKey({FISCAL_SECRETS_KEY:'invalida'}),/FISCAL_SECRETS_NOT_CONFIGURED/);
  const file={originalname:'cert.pfx',buffer:Buffer.alloc(150,0x30)};
  assert.throws(()=>validateFiscalUpload(file,{password:'errada',csc:'ABCDEF0123456789',cscId:'000001'}),
    /INVALID_CERTIFICATE_OR_PASSWORD/);
  assert.throws(()=>validateFiscalUpload({...file,originalname:'cert.txt'},
    {password:'senha',csc:'ABCDEF0123456789',cscId:'000001'}),/INVALID_A1_FILE/);
  assert.throws(()=>validateFiscalUpload(file,{password:'senha',csc:'invalido',cscId:'000001'}),
    /INVALID_HOMOLOGATION_CSC/);
});

test('arquivo A1 válido aceita a senha correta e recusa a incorreta',t=>{
  if(spawnSync('openssl',['version'],{stdio:'ignore'}).status!==0)return t.skip('OpenSSL indisponível');
  const dir=mkdtempSync(path.join(tmpdir(),'facinho-test-a1-'));
  try {
    const cert=path.join(dir,'cert.pem'),privateKey=path.join(dir,'key.pem'),pfx=path.join(dir,'cert.pfx');
    assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',privateKey,
      '-out',cert,'-subj','/CN=TESTE SEM VALOR FISCAL','-days','1'],{stdio:'ignore'}).status,0);
    assert.equal(spawnSync('openssl',['pkcs12','-export','-inkey',privateKey,'-in',cert,
      '-out',pfx,'-passout','pass:senha-teste'],{stdio:'ignore'}).status,0);
    const file={originalname:'cert.pfx',buffer:readFileSync(pfx)};
    assert.equal(validateFiscalUpload(file,{password:'senha-teste',csc:'ABCDEF0123456789',cscId:'000001'}).pfx,
      file.buffer);
    assert.throws(()=>validateFiscalUpload(file,{password:'outra',csc:'ABCDEF0123456789',cscId:'000001'}),
      /INVALID_CERTIFICATE_OR_PASSWORD/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

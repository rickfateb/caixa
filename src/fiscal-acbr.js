// Official LGPL-2.1 wrapper, installed as an optional dependency.
// Native .so/.dll and current schemas must be supplied by the operator.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fiscalError} from './fiscal-core.js';

export function runtimeConfig(issuer,env=process.env) {
  if (issuer.environment!==2 || env.FISCAL_HOMOLOGATION_WORKER!=='1') throw fiscalError('HOMOLOGATION_ONLY');
  const prefix=`FISCAL_${issuer.credentialsRef}_`;
  const config={library:env.ACBR_NFE_LIBRARY_PATH,schemas:env.ACBR_NFE_SCHEMAS_PATH,
    pfx:env[prefix+'PFX_PATH'],password:env[prefix+'PFX_PASSWORD'],csc:env[prefix+'CSC'],
    cscId:env[prefix+'CSC_ID'],cryptKey:env.FISCAL_ACBR_CRYPT_KEY};
  if (Object.values(config).some(value=>typeof value!=='string'||!value)) throw fiscalError('FISCAL_RUNTIME_NOT_CONFIGURED');
  if (!/^\d{6}$/.test(config.cscId)) throw fiscalError('INVALID_CSC_ID');
  return config;
}

export function createAcbrAdapter(issuer,env=process.env) {
  const config=runtimeConfig(issuer,env);
  if (![config.library,config.schemas,config.pfx].every(existsSync)) throw fiscalError('FISCAL_RUNTIME_FILES_MISSING');
  const require=createRequire(import.meta.url);
  let Native;
  try {Native=require('@projetoacbr/acbrlib-nfe-node/dist/src').default;}
  catch {throw fiscalError('ACBR_OFFICIAL_WRAPPER_NOT_INSTALLED');}
  const directory=mkdtempSync(path.join(tmpdir(),'facinho-fiscal-'));
  let lib;
  try {
    lib=new Native(config.library,path.join(directory,'acbr.ini'),config.cryptKey);
    lib.inicializar();
    const set=(section,key,value)=>lib.configGravarValor(section,key,String(value));
    set('Principal','TipoResposta',0);set('Principal','CodificacaoResposta',0);set('Principal','LogNivel',0);
    set('DFe','ArquivoPFX',config.pfx);set('DFe','Senha',config.password);set('DFe','VerificarValidade',1);
    set('DFe','SSLCryptLib',1);set('DFe','SSLHttpLib',3);set('DFe','SSLXmlSignLib',4);set('DFe','UF','SP');
    set('DFe','TimeZone.Modo',2);set('DFe','TimeZone.Str','-03:00');
    set('NFe','ModeloDF',1);set('NFe','VersaoDF',3);set('NFe','Ambiente',2);
    set('NFe','FormaEmissao',0);set('NFe','ValidarDigest',1);set('NFe','SSLType',5);set('NFe','Timeout',30000);
    set('NFe','PathSchemas',config.schemas);set('NFe','IdCSC',config.cscId);set('NFe','CSC',config.csc);
    set('NFe','SalvarGer',0);set('NFe','SalvarArq',0);
    set('DANFE','PathPDF',directory);set('DANFE','TipoDANFE',4);
    set('DANFE','MostraSetup',0);set('DANFE','MostraPreview',0);set('DANFE','MostraStatus',0);
    // Do not export/save runtime configuration containing the certificate password or CSC.
  } catch(error) {
    try {lib?.finalizar();} catch {}
    rmSync(directory,{recursive:true,force:true});throw error;
  }
  return {
    sign(ini) {lib.limparLista();lib.carregarINI(ini);lib.assinar();lib.validar();return lib.obterXml(0);},
    load(xml) {lib.limparLista();lib.carregarXML(xml);},
    send() {return lib.enviar(1,false,true,false);},
    consult(key) {return lib.consultar(key,false);},
    xml() {return lib.obterXml(0);},
    pdf() {
      lib.imprimirPDF();
      const files=readdirSync(directory,{recursive:true}).filter(file=>String(file).toLowerCase().endsWith('.pdf'));
      if (files.length!==1) throw fiscalError('DANFE_GENERATION_FAILED');
      const pdf=readFileSync(path.join(directory,String(files[0])));
      if (!pdf.subarray(0,5).equals(Buffer.from('%PDF-'))) throw fiscalError('DANFE_GENERATION_FAILED');
      return pdf;
    },
    close() {try {lib.finalizar();} finally {rmSync(directory,{recursive:true,force:true});}}
  };
}

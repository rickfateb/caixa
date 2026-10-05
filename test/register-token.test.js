import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRegisterToken, readRegisterToken } from '../src/register-token.js';

test('chaves novas são curtas, sem caracteres ambíguos e não se repetem', () => {
  const tokens = Array.from({ length: 1000 }, createRegisterToken);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^FCX-(?:[A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(readRegisterToken(`Bearer ${token}`), token);
  }
});

test('caixas existentes continuam autenticando com a chave anterior', () => {
  const old = 'fcx_AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTt';
  assert.equal(readRegisterToken(`Bearer ${old}`), old);
  assert.equal(readRegisterToken('Bearer FCX-AAAA-AAAA-AAAA'), undefined);
  assert.equal(readRegisterToken('Bearer FCX-IIII-OOOO-1111-1111'), undefined);
});

test('variações do cabeçalho e da entrada Android preservam o hash da chave cadastrada', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (let i = 0; i < 100; i++) {
    const token = createRegisterToken();
    const inputs = [
      `bearer ${token}`, `BEARER ${token}`, `  Bearer ${token}  `,
      `Bearer\t${token}`, `Bearer   ${token}`, `Bearer ${token.toLowerCase()}`,
      `Bearer ${token.replace(/-/g, '')}`, `Bearer ${token.replace(/-/g, '').toLowerCase()}`
    ];
    for (const input of inputs) assert.equal(hash(readRegisterToken(input)), hash(token));
  }
});

test('chaves antigas conservam maiúsculas, minúsculas e separadores', () => {
  const token = 'fcx_AaBb_123-Zz';
  assert.equal(readRegisterToken(` bearer\t${token} `), token);
  assert.notEqual(readRegisterToken(`Bearer ${token.toLowerCase()}`), token);
  assert.equal(readRegisterToken(`Bearer ${token.toUpperCase()}`), undefined);
});

test('normalizar uma chave diferente não concede acesso à chave cadastrada', () => {
  const registered = 'FCX-ABCD-EFGH-JKLM-NPQR';
  const other = 'fcxabcdefghjklmnpqs';
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.notEqual(hash(readRegisterToken(`Bearer ${other}`)), hash(registered));
});

test('ausência de Bearer, tamanho incorreto e caracteres inválidos continuam recusados', () => {
  const token = 'FCX-ABCD-EFGH-JKLM-NPQR';
  for (const input of [undefined, null, {}, [], '', token, `Basic ${token}`,
    `Bearer Bearer ${token}`, `Bearer ${token} extra`, `Bearer ${token},${token}`,
    `Bearer ${token.slice(0, -1)}`, `Bearer ${token}A`,
    'Bearer FCX-IIII-OOOO-1111-1111', 'Bearer FCX--ABCD-EFGH-JKLM-NPQR',
    'Bearer FCX-ABCD EFGH-JKLM-NPQR']) {
    assert.equal(readRegisterToken(input), undefined);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSimulatedPayment, simulatedPaymentConfig } from '../src/payment-policy.js';

test('configuração do caixa disponibiliza Pix, crédito e débito em simulação', () => {
  const config = simulatedPaymentConfig();
  assert.deepEqual(config.paymentMethods, ['PIX', 'CREDIT', 'DEBIT']);
  assert.equal(config.paymentMode, 'SIMULATED');
  // A caller cannot accidentally disable the methods for the next register.
  config.paymentMethods.pop();
  assert.equal(simulatedPaymentConfig().paymentMethods.length, 3);
});

test('os três métodos aceitam simulação explícita e apps sem a flag antiga', () => {
  for (const method of ['PIX', 'CREDIT', 'DEBIT']) {
    assert.equal(isSimulatedPayment({ method, simulated: true }), true);
    assert.equal(isSimulatedPayment({ method }), true);
  }
});

test('pagamento real, flags inválidas e métodos desconhecidos são recusados', () => {
  for (const method of ['PIX', 'CREDIT', 'DEBIT']) {
    for (const simulated of [false, 'true', 'false', 1, null]) {
      assert.equal(isSimulatedPayment({ method, simulated }), false);
    }
  }
  assert.equal(isSimulatedPayment({ method: 'UNKNOWN', simulated: true }), false);
  assert.equal(isSimulatedPayment(null), false);
});

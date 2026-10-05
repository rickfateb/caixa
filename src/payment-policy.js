// The POS currently supports test payments only; there is no live payment capture.
export const SIMULATED_PAYMENT_METHODS = Object.freeze(['PIX', 'CREDIT', 'DEBIT']);

export function isSimulatedPayment(payment) {
  return Boolean(payment && SIMULATED_PAYMENT_METHODS.includes(payment.method) &&
    (payment.simulated === undefined || payment.simulated === true));
}

export function simulatedPaymentConfig() {
  return { paymentMethods: [...SIMULATED_PAYMENT_METHODS], paymentMode: 'SIMULATED' };
}

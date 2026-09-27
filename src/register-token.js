import { randomBytes } from 'node:crypto';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createRegisterToken() {
  // 16 base32 characters carry 80 bits of randomness. Grouping helps manual entry.
  const bytes = randomBytes(10);
  let bits = 0, buffer = 0, encoded = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffer >>> bits) & 31];
    }
  }
  return `FCX-${encoded.match(/.{4}/g).join('-')}`;
}

export function readRegisterToken(authorization = '') {
  // Keep existing fcx_ tokens valid for registers that are already installed.
  return /^Bearer (fcx_[A-Za-z0-9_-]+|FCX-(?:[A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4})$/.exec(authorization)?.[1];
}

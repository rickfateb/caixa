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
  if (typeof authorization !== 'string') return undefined;
  // Authentication schemes are case-insensitive; copied keys can carry edge spaces.
  const credential = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim())?.[1];
  if (!credential) return undefined;
  // Legacy credentials contain case-sensitive random data. Never uppercase them.
  if (/^fcx_[A-Za-z0-9_-]+$/.test(credential)) return credential;
  // Restore the canonical representation before hashing a human-readable key.
  // Some Android entry fields remove separators or change the letter case.
  const compact = credential.toUpperCase().replace(/-/g, '');
  if (!/^FCX[A-HJ-NP-Z2-9]{16}$/.test(compact)) return undefined;
  if (!/^FCX(?:-[A-HJ-NP-Z2-9]{4}){4}$/i.test(credential) &&
      !/^FCX[A-HJ-NP-Z2-9]{16}$/i.test(credential)) return undefined;
  return `FCX-${compact.slice(3).match(/.{4}/g).join('-')}`;
}

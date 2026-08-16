// TOTP di riferimento per i test (RFC 6238, SHA-1, 6 cifre, period 30).
// Serve SOLO negli spike, per generare un codice valido da presentare a
// better-auth e verificare il comportamento dei suoi hook. Non e' codice
// applicativo: in fase 1 il TOTP lo genera/verifica il plugin twoFactor.
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`carattere base32 non valido: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secretBase32: string, step: number, digits = 6): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function currentStep(period = 30): number {
  return Math.floor(Date.now() / 1000 / period);
}

export function totpNow(secretBase32: string): string {
  return totpAt(secretBase32, currentStep());
}

export function secretFromOtpauthUri(uri: string): string {
  const secret = new URL(uri.replace(/^otpauth:\/\//, 'https://')).searchParams.get('secret');
  if (!secret) throw new Error(`nessun parametro secret in ${uri}`);
  return secret;
}

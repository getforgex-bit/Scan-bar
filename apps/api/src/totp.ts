// TOTP (RFC 6238) sin dependencias: SHA-1, 6 dígitos, paso de 30 s, ventana ±1.
import crypto from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error('base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newSecret = () => base32(crypto.randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
export const totpNow = (secret: string, t = Date.now()) => hotp(secret, Math.floor(t / 30000));

/** Devuelve el paso (counter) válido o null. Ventana ±1 para tolerar deriva de reloj. */
export function verifyTotp(secret: string, code: string, t = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const c = Math.floor(t / 30000);
  for (const d of [0, -1, 1]) if (crypto.timingSafeEqual(Buffer.from(hotp(secret, c + d)), Buffer.from(code))) return c + d;
  return null;
}
export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/Codigos:${encodeURIComponent(account)}?secret=${secret}&issuer=Codigos&algorithm=SHA1&digits=6&period=30`;
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

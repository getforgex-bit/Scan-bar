// Endurecimiento (P4.3): cabeceras, límite de tasa, cifrado en reposo del secreto TOTP.
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors';
import { devSecret } from './env';

export const isLocalHost = (hostname: string) => /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(hostname) || hostname.endsWith('.localhost');

/** CSP de la PWA: sin scripts ni estilos en línea; Wasm permitido para el decodificador ZXing. */
export const APP_CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
/** Páginas HTML propias del resolver (404 y ficha de respaldo): sin scripts; solo su estilo en línea. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function securityHeaders(req: FastifyRequest, reply: FastifyReply) {
  reply.header('Content-Security-Policy', APP_CSP);
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  if (!isLocalHost(req.hostname)) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Ventana fija en memoria por clave (un solo proceso). Lanza 429 con Retry-After. */
export function rateLimiter() {
  const hits = new Map<string, { n: number; reset: number }>();
  return function limit(reply: FastifyReply, key: string, max: number, windowMs: number) {
    const now = Date.now();
    if (hits.size > 20_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    if (h.n > max) {
      reply.header('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      throw new HttpError(429, 'demasiadas_peticiones', 'Demasiadas peticiones; intenta de nuevo en un momento');
    }
  };
}

// ---- cifrado del secreto TOTP (AES-256-GCM, clave en TOTP_ENC_KEY) ----
/** 32 bytes en base64 se usan tal cual; cualquier otro secreto largo (p. ej. el que genera Render) se deriva con SHA-256. */
export function totpKey(secret: string): Buffer {
  const k = Buffer.from(secret, 'base64');
  if (k.length === 32 && k.toString('base64') === secret) return k;
  if (secret.length < 32) throw new Error('TOTP_ENC_KEY debe ser de 32 bytes en base64 o un secreto aleatorio de al menos 32 caracteres');
  return crypto.createHash('sha256').update(secret).digest();
}
function key(): Buffer { return totpKey(devSecret('TOTP_ENC_KEY', 32, 'base64')); }
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export const isEncrypted = (s: string) => s.startsWith('v1:');
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored; // secreto anterior al cifrado; migrate.ts lo re-cifra
  const [, iv, tag, ct] = stored.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Contraseñas triviales de 12+ caracteres que no se aceptan al registrarse. */
const COMMON = new Set(['123456789012', '1234567890123', 'password1234', 'password12345', 'contraseña123', 'contrasena123', 'qwertyuiop12', 'qwertyuiop123', 'aaaaaaaaaaaa', '111111111111', '000000000000', 'abcdefghijkl', 'iloveyou1234', 'administrador', 'administrator']);
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 12) return 'La contraseña debe tener al menos 12 caracteres';
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'Esa contraseña es demasiado común';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'La contraseña no debe contener tu correo';
  return null;
}

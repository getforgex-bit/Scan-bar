// Carga .env (si existe) sin sobrescribir variables ya definidas. Los secretos viven solo en el entorno.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
export const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { /* .env ilegible: se usan las variables del proceso */ } }

export const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Devuelve el secreto `name`. En desarrollo, si falta, lo genera y lo añade a .env (ignorado por git).
 * En producción nunca se inventa: falta = error explícito.
 */
export function devSecret(name: string, bytes = 24, encoding: BufferEncoding = 'base64url'): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd()) throw new Error(`Falta la variable de entorno ${name}`);
  const g = crypto.randomBytes(bytes).toString(encoding);
  fs.appendFileSync(envFile, `${name}=${g}\n`);
  process.env[name] = g;
  return g;
}

export const ROLE_ENV = { app_rw: 'DB_APP_RW_PASSWORD', admin_ro: 'DB_ADMIN_RO_PASSWORD', admin_rw: 'DB_ADMIN_RW_PASSWORD' } as const;
export type RoleName = keyof typeof ROLE_ENV;

export const ownerUrl = () => process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/codes'; // instancia embebida local
export function roleUrl(owner: string, role: string, password: string): string {
  const u = new URL(owner); u.username = role; u.password = password; return u.toString();
}

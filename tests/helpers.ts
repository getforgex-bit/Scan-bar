import pg from 'pg';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { migrate } from '../scripts/migrate';
import { roleUrl } from '../apps/api/src/env';
import { makeDb } from '../apps/api/src/db';
import { buildApp } from '../apps/api/src/app';

const port = () => process.env.TEST_PG_PORT ?? '5434';
export const ADMIN_PW = 'Admin-prueba-12345';
export const POS_PW = 'Caja-prueba-12345';
// Secretos solo de prueba, generados por ejecución (nunca se escriben en disco).
process.env.TOTP_ENC_KEY = crypto.randomBytes(32).toString('base64');
const ROLE_PW = { app_rw: crypto.randomBytes(18).toString('base64url'), admin_ro: crypto.randomBytes(18).toString('base64url'), admin_rw: crypto.randomBytes(18).toString('base64url') };

export async function freshDb(seed = true) {
  const name = 't_' + crypto.randomBytes(5).toString('hex');
  const root = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port()}/postgres` });
  await root.connect(); await root.query(`CREATE DATABASE ${name}`); await root.end();
  const ownerUrl = `postgres://postgres:postgres@localhost:${port()}/${name}`;
  await migrate(ownerUrl, ROLE_PW);
  if (seed) execFileSync('npx', ['tsx', 'db/seed.ts'], { env: { ...process.env, DATABASE_URL: ownerUrl, SEED_ADMIN_PASSWORD: ADMIN_PW, SEED_POS_PASSWORD: POS_PW }, shell: true, stdio: 'pipe' });
  const urls = { ownerUrl, appUrl: roleUrl(ownerUrl, 'app_rw', ROLE_PW.app_rw), adminUrl: roleUrl(ownerUrl, 'admin_ro', ROLE_PW.admin_ro), adminRwUrl: roleUrl(ownerUrl, 'admin_rw', ROLE_PW.admin_rw) };
  return urls;
}

export async function makeApp(opts: { logRequests?: boolean } = {}) {
  const urls = await freshDb();
  const db = makeDb(urls);
  const app = await buildApp({ db, logRequests: opts.logRequests ?? false });
  const owner = new pg.Pool({ connectionString: urls.ownerUrl });
  return { app, db, urls, owner, close: async () => { await app.close(); await db.close(); await owner.end(); } };
}

export const H = { 'x-requested-with': 'test' };

export async function login(app: any, email: string, password: string, ip = '10.0.0.1') {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: H, remoteAddress: ip, payload: { email, password } });
  const sid = r.cookies?.find((c: any) => c.name === 'sid')?.value;
  return { res: r, cookies: sid ? { sid } : {} };
}

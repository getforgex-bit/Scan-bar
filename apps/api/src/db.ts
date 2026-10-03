import pg from 'pg';
import { ownerUrl, roleUrl, ROLE_ENV, type RoleName } from './env';

export type Tx = pg.PoolClient;
export type DbUrls = { appUrl: string; adminUrl: string; adminRwUrl: string };
export type Db = { app: pg.Pool; admin: pg.Pool; adminRw: pg.Pool; urls: DbUrls; close(): Promise<void> };

/** URL de un rol: variable explícita o derivada de DATABASE_URL + contraseña del rol (ambas del entorno). */
function urlFor(explicit: string | undefined, role: RoleName): string {
  if (explicit) return explicit;
  const pw = process.env[ROLE_ENV[role]];
  if (!pw) throw new Error(`Falta ${ROLE_ENV[role]}: ejecuta "npm run migrate" (en desarrollo la genera en .env) o define la variable`);
  return roleUrl(ownerUrl(), role, pw);
}
export const envUrls = (): DbUrls => ({
  appUrl: urlFor(process.env.APP_DATABASE_URL, 'app_rw'),
  adminUrl: urlFor(process.env.ADMIN_DATABASE_URL, 'admin_ro'),
  adminRwUrl: urlFor(process.env.ADMIN_RW_DATABASE_URL, 'admin_rw'),
});

export function makeDb(urls: DbUrls = envUrls()): Db {
  const app = new pg.Pool({ connectionString: urls.appUrl, max: 10 });
  const admin = new pg.Pool({ connectionString: urls.adminUrl, max: 3 });
  const adminRw = new pg.Pool({ connectionString: urls.adminRwUrl, max: 3 });
  return { app, admin, adminRw, urls, close: async () => { await app.end(); await admin.end(); await adminRw.end(); } };
}

/** Única vía de acceso a tablas con tenant_id: abre transacción y fija app.tenant_id. */
export async function withTenant<T>(db: Db, tenantId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.app.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const r = await fn(tx);
    await tx.query('COMMIT');
    return r;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { tx.release(); }
}

/** Para funciones SECURITY DEFINER públicas (resolver, login). */
export async function publicQuery<R extends pg.QueryResultRow = any>(db: Db, sql: string, params: any[] = []) {
  return db.app.query<R>(sql, params);
}

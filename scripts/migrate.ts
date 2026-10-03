import pg from 'pg';
import fs from 'node:fs';
import { devSecret, ownerUrl, ROLE_ENV, type RoleName } from '../apps/api/src/env';
import { encryptSecret, isEncrypted } from '../apps/api/src/security';

export type RolePasswords = Record<RoleName, string>;

/**
 * Aplica las migraciones y fija las contraseñas de los roles de la aplicación desde el entorno
 * (las migraciones crean los roles sin contraseña). En desarrollo, si faltan, se generan en .env.
 */
export async function migrate(url: string, passwords?: RolePasswords) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).sort()) {
    if ((await c.query('SELECT 1 FROM _migrations WHERE name=$1', [f])).rowCount) continue;
    await c.query('BEGIN');
    try {
      await c.query(fs.readFileSync(new URL(f, dir), 'utf8'));
      await c.query('INSERT INTO _migrations VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log('migrado', f);
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  for (const role of Object.keys(ROLE_ENV) as RoleName[]) {
    const pw = passwords?.[role] ?? devSecret(ROLE_ENV[role]);
    const sql = (await c.query("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS q", [role, pw])).rows[0].q;
    await c.query(sql);
  }
  // Secretos TOTP anteriores al cifrado en reposo: se re-cifran.
  for (const u of (await c.query('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL')).rows)
    if (!isEncrypted(u.totp_secret)) await c.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [u.id, encryptSecret(u.totp_secret)]);
  await c.end();
}

if (process.argv[1]?.endsWith('migrate.ts')) { await migrate(ownerUrl()); console.log('Roles de base con contraseña del entorno; migraciones al día.'); }

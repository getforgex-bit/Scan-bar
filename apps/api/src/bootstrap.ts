// Datos mínimos de producción (idempotente): los seis negocios de las webs, un SuperAdmin y una caja por negocio.
// Las contraseñas solo llegan por variables de entorno (secretos del despliegue); nunca se guardan en el repositorio.
import argon2 from 'argon2';
import { SOURCES, ensureTenant, type Db } from './sync';
import { passwordProblem } from './security';

export const adminEmail = (env = process.env) => (env.ADMIN_EMAIL ?? 'admin@scanbar.mx').trim().toLowerCase();
export const cajaEmail = (slug: string) => `caja.${slug}@scanbar.mx`;
/** Correos de las cuentas que crea el despliegue: nadie puede registrarlos por su cuenta (se adueñaría del rol). */
export const isReservedEmail = (email: string, env = process.env) => {
  const e = email.trim().toLowerCase();
  return e.endsWith('@scanbar.mx') || e === adminEmail(env);
};

/**
 * ADMIN_PASSWORD crea el SuperAdmin (ADMIN_EMAIL, por defecto admin@scanbar.mx) con acceso a los seis negocios;
 * CAJA_PASSWORD crea caja.<negocio>@scanbar.mx para el modo Caja de cada negocio. El secreto manda: si la cuenta ya
 * existe con otra contraseña, toma la del secreto y se cierran sus sesiones (así se cambia una contraseña: nuevo secreto
 * y reinicio). Devuelve avisos legibles para el registro de arranque.
 */
export async function bootstrap(db: Db, env = process.env): Promise<string[]> {
  const notes: string[] = [];
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const tenants: { id: number; slug: string }[] = [];
    for (const src of SOURCES) tenants.push({ id: await ensureTenant(c, src), slug: src.slug });
    const account = async (email: string, password: string | undefined, role: 'superadmin' | 'operador_pos', ids: number[]) => {
      if (!password) return false;
      const weak = passwordProblem(password, email);
      if (weak) throw new Error(`La contraseña de ${email} no sirve: ${weak}`);
      let u = (await c.query('SELECT id, password_hash FROM users WHERE email=$1', [email])).rows[0];
      if (!u) u = (await c.query('INSERT INTO users (email,password_hash) VALUES ($1,$2) RETURNING id', [email, await argon2.hash(password, { type: argon2.argon2id })])).rows[0];
      else if (!(await argon2.verify(u.password_hash, password).catch(() => false))) {
        await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await argon2.hash(password, { type: argon2.argon2id })]);
        await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
        notes.push(`Contraseña actualizada: ${email}`);
      }
      for (const id of ids) await c.query('INSERT INTO memberships (user_id,tenant_id,role) VALUES ($1,$2,$3) ON CONFLICT (user_id,tenant_id) DO NOTHING', [u.id, id, role]);
      return true;
    };
    if (await account(adminEmail(env), env.ADMIN_PASSWORD, 'superadmin', tenants.map(t => t.id))) notes.push(`Administrador: ${adminEmail(env)}`);
    else notes.push('ADMIN_PASSWORD no está definida: no se creó el administrador');
    let cajas = 0;
    for (const t of tenants) if (await account(cajaEmail(t.slug), env.CAJA_PASSWORD, 'operador_pos', [t.id])) cajas++;
    notes.push(cajas ? `Cajas: ${tenants.map(t => cajaEmail(t.slug)).join(', ')}` : 'CAJA_PASSWORD no está definida: no se crearon las cuentas de caja');
    await c.query('COMMIT');
    return notes;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

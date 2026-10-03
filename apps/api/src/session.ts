import crypto from 'node:crypto';

export type Role = 'superadmin' | 'operador_pos' | 'integration' | 'cliente';
export type Session = {
  userId: number; tenantId: number; role: Role; exp: number; email?: string;
  totp?: boolean;        // SuperAdmin que pasó el segundo factor
  adminUntil?: number;   // funciones de administrador desbloqueadas con contraseña hasta este instante
  scope?: string[]; keyId?: string;
};
export const STAFF: Role[] = ['superadmin', 'operador_pos', 'integration'];
export const ADMIN_UNLOCK_MS = 15 * 60_000;

/**
 * Sesiones guardadas en la base (sobreviven reinicios del contenedor) con caché en memoria.
 * La cookie lleva un identificador aleatorio; la base solo guarda su sha256.
 */
export class SessionStore {
  private cache = new Map<string, { s: Session; saved: string; at: number }>();
  constructor(private pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) {}
  private static key = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex');
  private static data = (s: Session) => ({ tenantId: s.tenantId, role: s.role, email: s.email, totp: !!s.totp, adminUntil: s.adminUntil ?? 0 });
  private static snap = (s: Session) => JSON.stringify([SessionStore.data(s), s.exp]);
  private remember(sid: string, s: Session) {
    if (this.cache.size > 5000) for (const [k, v] of this.cache) if (v.s.exp <= Date.now()) this.cache.delete(k);
    this.cache.set(sid, { s, saved: SessionStore.snap(s), at: Date.now() });
  }

  async get(sid: string): Promise<Session | undefined> {
    const hit = this.cache.get(sid);
    if (hit) { if (hit.s.exp > Date.now()) return hit.s; this.cache.delete(sid); return undefined; }
    const r = (await this.pool.query('SELECT user_id, data, expires_at FROM sessions WHERE id=$1 AND expires_at > now()', [SessionStore.key(sid)])).rows[0];
    if (!r) return undefined;
    const s: Session = { ...r.data, userId: Number(r.user_id), exp: new Date(r.expires_at).getTime() };
    this.remember(sid, s);
    return s;
  }

  async create(s: Omit<Session, 'exp'>, ttlMs: number): Promise<string> {
    const sid = crypto.randomBytes(32).toString('base64url');
    const full: Session = { ...s, exp: Date.now() + ttlMs };
    await this.pool.query('INSERT INTO sessions (id, user_id, data, expires_at) VALUES ($1,$2,$3,$4)', [SessionStore.key(sid), s.userId, SessionStore.data(full), new Date(full.exp)]);
    this.remember(sid, full);
    return sid;
  }

  async destroy(sid: string) {
    this.cache.delete(sid);
    await this.pool.query('DELETE FROM sessions WHERE id=$1', [SessionStore.key(sid)]);
  }

  /** Guarda los cambios: bloquear, desbloquear y el segundo factor al momento; la renovación del vencimiento, a lo más cada 30 s. */
  async save(sid: string, s: Session) {
    const hit = this.cache.get(sid);
    if (!hit) return;
    const now = SessionStore.snap(s);
    if (now === hit.saved) return;
    const [prev] = JSON.parse(hit.saved) as [ReturnType<typeof SessionStore.data>, number];
    const unlocked = (s.adminUntil ?? 0) > Date.now() && prev.adminUntil <= Date.now();
    const urgent = prev.totp !== !!s.totp || (s.adminUntil ?? 0) < prev.adminUntil || unlocked;
    if (!urgent && Date.now() - hit.at < 30_000) return;
    hit.saved = now; hit.at = Date.now();
    await this.pool.query('UPDATE sessions SET data=$2, expires_at=$3 WHERE id=$1', [SessionStore.key(sid), SessionStore.data(s), new Date(s.exp)]);
  }
}

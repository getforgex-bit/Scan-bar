export type Role = 'superadmin' | 'operador_pos' | 'integration' | 'cliente';
export type Session = {
  userId: number; tenantId: number; role: Role; exp: number; email?: string;
  totp?: boolean;        // SuperAdmin que pasó el segundo factor
  adminUntil?: number;   // funciones de administrador desbloqueadas con contraseña hasta este instante
  scope?: string[]; keyId?: string;
};
export const STAFF: Role[] = ['superadmin', 'operador_pos', 'integration'];
export const ADMIN_UNLOCK_MS = 15 * 60_000;

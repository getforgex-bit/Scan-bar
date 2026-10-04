// Lógica pura del ciclo de captura (sección 4): consenso, validación y antirrebote.
import { isValidGtin13, parseDigitalLink } from '../../../../packages/codes/src/index';

export type RawReading = { format: 'ean_13' | 'qr_code' | string; rawValue: string };

/** Normaliza una lectura cruda a GTIN-13 válido; null si hay que ignorarla. */
export function toGtin(r: RawReading): { gtin: string } | { external: string } | null {
  if (r.format === 'ean_13') return isValidGtin13(r.rawValue) ? { gtin: r.rawValue } : null;
  if (r.format === 'qr_code') {
    const g = parseDigitalLink(r.rawValue);
    return g ? { gtin: g } : { external: r.rawValue };
  }
  return null;
}

export type Accepted = { gtin: string } | { external: string };

/**
 * Consenso: un EAN-13 solo se acepta con dos lecturas idénticas consecutivas
 * (los QR llevan corrección de errores, basta una). Antirrebote: el mismo código se ignora `debounceMs`.
 */
export function createConsensus(debounceMs = 1500) {
  let last: string | null = null;
  const recent = new Map<string, number>();
  return {
    feed(r: RawReading, now: number): Accepted | null {
      const v = toGtin(r);
      if (!v) { last = null; return null; }
      const key = 'gtin' in v ? v.gtin : 'ext:' + v.external;
      if (r.format === 'ean_13') {
        if (last !== key) { last = key; return null; }
      }
      last = key;
      const seen = recent.get(key);
      if (seen !== undefined && now - seen < debounceMs) { recent.set(key, now); return null; }
      recent.set(key, now);
      return v;
    },
    reset() { last = null; recent.clear(); },
  };
}

export const isManualGtinOk = (s: string) => /^\d{13}$/.test(s) && isValidGtin13(s);

/** Qué hay en un QR que no es de un producto: la tarjeta de acceso de un negocio, un enlace web, otra app o texto. */
export type QrContent =
  | { kind: 'acceso'; token: string }
  | { kind: 'web'; url: string; host: string; seguro: boolean }
  | { kind: 'app'; url: string; scheme: 'mailto' | 'tel' | 'sms' | 'geo' }
  | { kind: 'texto'; text: string };

/** Tarjeta de acceso: …/acceso#k=<43 caracteres> (cualquier dirección de Scan-bar; el servidor valida el token). */
export function accessToken(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/.test(u.protocol) || u.pathname.replace(/\/+$/, '') !== '/acceso') return null;
    return /^#k=([A-Za-z0-9_-]{43})$/.exec(u.hash)?.[1] ?? null;
  } catch { return null; }
}

/**
 * Clasifica el contenido de un QR. Solo se ofrecen para abrir los enlaces http(s) y los de correo, teléfono, SMS o mapa;
 * cualquier otro esquema (javascript:, data:, file:, intent:…) se muestra como texto y nunca se abre.
 */
export function classifyQr(raw: string): QrContent {
  const s = raw.trim();
  const token = accessToken(s);
  if (token) return { kind: 'acceso', token };
  const web = /^https?:\/\//i.test(s) ? s : /^www\.[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(s) ? `https://${s}` : null;
  if (web) {
    try { const u = new URL(web); if (u.hostname && !/\s/.test(s)) return { kind: 'web', url: u.href, host: u.hostname, seguro: u.protocol === 'https:' }; } catch { /* no es URL */ }
  }
  const app = /^(mailto|tel|sms|smsto|geo):(\S+)$/i.exec(s);
  if (app) return { kind: 'app', url: s, scheme: (app[1].toLowerCase() === 'smsto' ? 'sms' : app[1].toLowerCase()) as 'mailto' | 'tel' | 'sms' | 'geo' };
  return { kind: 'texto', text: s };
}

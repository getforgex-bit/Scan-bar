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

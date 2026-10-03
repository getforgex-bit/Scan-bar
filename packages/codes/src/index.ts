// Librería de GTIN sin dependencias de ejecución (sección 3 de docs/arquitectura.md)
export function checkDigit(d12: string): number {
  if (!/^\d{12}$/.test(d12)) throw new Error('Se esperan 12 dígitos');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export const isValidGtin13 = (g: string): boolean =>
  /^\d{13}$/.test(g) && checkDigit(g.slice(0, 12)) === Number(g[12]);

export function buildGtin13(gs1Prefix: string, companyPrefix: string, item: number): string {
  const body = gs1Prefix + companyPrefix;
  const width = 12 - body.length;
  if (width < 1) throw new Error('Prefijo demasiado largo');
  if (!Number.isInteger(item) || item < 0 || item >= 10 ** width) throw new Error('Rango de artículos agotado');
  const d12 = body + String(item).padStart(width, '0');
  return d12 + checkDigit(d12);
}

export const toDigitalLink = (gtin13: string, host: string): string =>
  `https://${host}/01/${gtin13.padStart(14, '0')}`;

/** Extrae el GTIN-13 del segmento /01/ de una URL (GS1 Digital Link). null si no es válido. */
export function parseDigitalLink(url: string): string | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  const m = /\/01\/(\d{14})(?:\/|$)/.exec(path);
  if (!m) return null;
  const g14 = m[1];
  if (g14[0] !== '0') return null;
  const g13 = g14.slice(1);
  return isValidGtin13(g13) ? g13 : null;
}

/** GTIN-13 → GTIN-14 (relleno con 0) para el resolver. */
export const toGtin14 = (g13: string): string => g13.padStart(14, '0');

/** Agrupación visual 1·6·6 */
export const formatGtin = (g: string): string => `${g[0]} ${g.slice(1, 7)} ${g.slice(7)}`;

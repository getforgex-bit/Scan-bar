// PDF mínimo sin dependencias: páginas, texto en Helvetica (fuente estándar, codificación WinAnsi) y trazos vectoriales.
// Alcanza para hojas de etiquetas; no es un generador de PDF general.
import zlib from 'node:zlib';

export const MM = 72 / 25.4; // puntos por milímetro

// Anchos de Helvetica y Helvetica-Bold (métricas AFM estándar, milésimas de em) para los caracteres 32–126.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// Caracteres de Windows-1252 fuera de Latin-1 que sí tiene WinAnsiEncoding.
const CP1252: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const WIDE: Record<number, number> = { 0x80: 556, 0x85: 1000, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000, 0xa1: 333, 0xbf: 611, 0xb0: 400, 0xd7: 584, 0xf7: 584, 0xc6: 1000, 0xe6: 889, 0xdf: 611 };

export type Font = 'F1' | 'F2'; // F1 = Helvetica, F2 = Helvetica-Bold

/** Texto → bytes WinAnsi (lo que no existe en esa codificación se vuelve "?"). */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (CP1252[ch]) out.push(CP1252[ch]);
    else if (c === 0x09 || c === 0x0a || c === 0x0d) out.push(0x20);
    else out.push(0x3f);
  }
  return out;
}

function charWidth(b: number, font: Font): number {
  const table = font === 'F2' ? W_BOLD : W_REG;
  if (b >= 0x20 && b <= 0x7e) return table[b - 0x20];
  if (WIDE[b]) return WIDE[b];
  if (b >= 0x91 && b <= 0x94) return font === 'F2' ? (b < 0x93 ? 278 : 500) : (b < 0x93 ? 222 : 333);
  // Letras acentuadas: mismo ancho que su letra base (á → a, Ñ → N).
  const base = String.fromCharCode(b).normalize('NFD').charCodeAt(0);
  return base >= 0x20 && base <= 0x7e ? table[base - 0x20] : 556;
}

/** Ancho del texto en puntos. */
export const textWidth = (s: string, font: Font, size: number) => winAnsi(s).reduce((a, b) => a + charWidth(b, font), 0) * size / 1000;

const num = (n: number) => (Math.round(n * 100) / 100).toString();

/** Operadores para escribir `s` con la esquina inferior izquierda de la línea base en (x, y). */
export function textOps(s: string, x: number, y: number, font: Font, size: number, gray = 0): string {
  const lit = winAnsi(s).map(b => (b === 0x28 || b === 0x29 || b === 0x5c ? '\\' + String.fromCharCode(b) : b < 0x20 || b > 0x7e ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b))).join('');
  return `BT ${num(gray)} g /${font} ${num(size)} Tf ${num(x)} ${num(y)} Td (${lit}) Tj ET\n`;
}

/** Corta el texto en a lo más `maxLines` líneas de ancho `maxW`; la última termina en "…" si no cupo todo. */
export function wrapText(s: string, font: Font, size: number, maxW: number, maxLines: number): string[] {
  const fits = (t: string) => textWidth(t, font, size) <= maxW;
  const lines: string[] = [];
  let cur = '';
  for (const w of s.trim().split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    while (cur.length > 1 && !fits(cur)) { // una palabra más ancha que la línea se parte
      let k = cur.length - 1;
      while (k > 1 && !fits(cur.slice(0, k))) k--;
      lines.push(cur.slice(0, k)); cur = cur.slice(k);
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  let last = lines[maxLines - 1];
  while (last.length > 0 && !fits(last + '…')) last = last.slice(0, -1).trimEnd();
  return [...lines.slice(0, maxLines - 1), last + '…'];
}

/**
 * Traduce un SVG de bwip-js (solo <path> con comandos absolutos M, L, Q, Z) a operadores PDF en unidades del viewBox.
 * Así el PDF usa exactamente el mismo dibujo que el SVG que la API sirve en pantalla.
 */
export function svgToPdf(svg: string): { ops: string; width: number; height: number } {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) throw new Error('SVG sin viewBox');
  let ops = '';
  for (const m of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1];
    const d = attr('d'); if (!d) continue;
    let cx = 0, cy = 0, path = '';
    const t = d.match(/[MLQZ]|-?\d*\.?\d+/g) ?? [];
    for (let i = 0; i < t.length;) {
      const c = t[i++];
      const n = () => Number(t[i++]);
      if (c === 'M' || c === 'L') { cx = n(); cy = n(); path += `${num(cx)} ${num(cy)} ${c === 'M' ? 'm' : 'l'} `; }
      else if (c === 'Q') { // cuadrática → cúbica
        const qx = n(), qy = n(), x = n(), y = n();
        path += `${num(cx + 2 / 3 * (qx - cx))} ${num(cy + 2 / 3 * (qy - cy))} ${num(x + 2 / 3 * (qx - x))} ${num(y + 2 / 3 * (qy - y))} ${num(x)} ${num(y)} c `;
        cx = x; cy = y;
      } else if (c === 'Z') path += 'h ';
      else throw new Error(`Comando SVG no soportado: ${c}`);
    }
    const sw = attr('stroke-width');
    ops += attr('stroke') && sw ? `${sw} w ${path}S\n` : `${path}f\n`;
  }
  return { ops, width: Number(vb[1]), height: Number(vb[2]) };
}

/** Coloca un dibujo de svgToPdf con su esquina inferior izquierda en (x, y) y escala `s` (puntos por unidad). */
export const placeOps = (g: { ops: string; height: number }, x: number, y: number, s: number) =>
  `q 0 g 0 G ${num(s)} 0 0 ${num(-s)} ${num(x)} ${num(y + g.height * s)} cm\n${g.ops}Q\n`;

/** Rectángulo punteado (guía de corte). */
export const cutGuide = (x: number, y: number, w: number, h: number) => `q 0.75 G 0.4 w [2 2] 0 d ${num(x)} ${num(y)} ${num(w)} ${num(h)} re S Q\n`;

/** Texto UTF-16BE para el diccionario Info (títulos con acentos). */
const pdfString = (s: string) => '<FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase() + '>';

/** Ensambla el archivo: catálogo, páginas, dos fuentes estándar, contenido comprimido y tabla xref. */
export function buildPdf(pages: { width: number; height: number; content: string }[], info: { title: string }): Buffer {
  const objs: Buffer[] = [];
  const add = (b: Buffer | string) => { objs.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b); return objs.length; };
  const catalog = add(''), pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const infoObj = add(`<< /Title ${pdfString(info.title)} /Producer (Scan-bar) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const data = zlib.deflateSync(Buffer.from(p.content, 'latin1'));
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1');
  objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length; const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b); offset += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

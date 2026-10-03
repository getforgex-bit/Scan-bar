// Hoja de etiquetas para recortar y pegar en los productos físicos: nombre arriba, EAN-13 (y QR opcional) abajo.
import { gtinSvg } from './svg';
import { MM, buildPdf, cutGuide, placeOps, svgToPdf, textOps, textWidth, wrapText } from './pdf';

export type LabelItem = { gtin: string; name: string; sku: string };
export type LabelOptions = {
  tenantName: string; paper: 'letter' | 'a4'; qr: boolean;
  /** Escala del EAN-13 respecto al tamaño nominal (módulo de 0.33 mm): 0.8–1. */
  scale: number;
};

const PAPER = { letter: [215.9, 279.4], a4: [210, 297] } as const;
const MARGIN = 10 * MM;
const PAD = 2.5 * MM;
const NAME_SIZE = 8, NAME_LEAD = 9.5, SKU_SIZE = 6;
export const MAX_LABELS = 2000;

/** Genera el PDF: cuadrícula con guías de corte; cada celda lleva el nombre del producto encima de su código. */
export function labelSheet(items: LabelItem[], o: LabelOptions): Buffer {
  const [pw, ph] = PAPER[o.paper].map(v => v * MM);
  const cols = o.qr ? 2 : 3;
  const cellW = (pw - 2 * MARGIN) / cols;
  // EAN-13 de bwip-js: 3 unidades del viewBox por módulo; a escala 1 el módulo mide 0.33 mm (tamaño nominal GS1).
  const eanScale = (0.33 * o.scale * MM) / 3;
  const sample = svgToPdf(gtinSvg(items[0]?.gtin ?? '7500002000891', 'ean13')); // todos los EAN-13 miden lo mismo
  const eanH = sample.height * eanScale;
  const qrSide = o.qr ? 18 * o.scale * MM : 0;
  const codeH = Math.max(eanH, qrSide);
  const cellH = PAD + 2 * NAME_LEAD + SKU_SIZE + 3.5 + 1.5 * MM + codeH + PAD;
  const rows = Math.max(1, Math.floor((ph - 2 * MARGIN) / cellH));
  const perPage = rows * cols;
  const pages: { width: number; height: number; content: string }[] = [];
  const total = Math.max(1, Math.ceil(items.length / perPage));
  const stamp = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

  for (let p = 0; p < total; p++) {
    let c = textOps(`${o.tenantName} · ${items.length} etiqueta${items.length === 1 ? '' : 's'} · ${stamp} · página ${p + 1} de ${total}`, MARGIN, ph - MARGIN + 3 * MM, 'F1', 6.5, 0.4);
    if (!items.length) c += textOps('No hay productos activos con código para este negocio.', MARGIN, ph - MARGIN - 12, 'F1', 10);
    items.slice(p * perPage, (p + 1) * perPage).forEach((it, i) => {
      const x = MARGIN + (i % cols) * cellW;
      const top = ph - MARGIN - Math.floor(i / cols) * cellH;
      c += cutGuide(x, top - cellH, cellW, cellH);
      const inner = cellW - 2 * PAD;
      // Nombre: hasta dos líneas centradas (una sola línea se centra en el espacio de dos); debajo, el SKU en gris.
      const lines = wrapText(it.name, 'F2', NAME_SIZE, inner, 2);
      let y = top - PAD - NAME_SIZE - (lines.length === 1 ? NAME_LEAD / 2 : 0);
      for (const l of lines) { c += textOps(l, x + (cellW - textWidth(l, 'F2', NAME_SIZE)) / 2, y, 'F2', NAME_SIZE); y -= NAME_LEAD; }
      const sku = `SKU ${it.sku}`;
      c += textOps(sku, x + (cellW - textWidth(sku, 'F1', SKU_SIZE)) / 2, top - PAD - 2 * NAME_LEAD - SKU_SIZE - 1.5, 'F1', SKU_SIZE, 0.35);
      const ean = svgToPdf(gtinSvg(it.gtin, 'ean13'));
      const eanW = ean.width * eanScale;
      const groupW = eanW + (o.qr ? 3 * MM + qrSide : 0);
      const gx = x + (cellW - groupW) / 2;
      const by = top - cellH + PAD;
      c += placeOps(ean, gx, by + (codeH - eanH) / 2, eanScale);
      if (o.qr) {
        const qr = svgToPdf(gtinSvg(it.gtin, 'qr'));
        c += placeOps(qr, gx + eanW + 3 * MM, by + (codeH - qrSide) / 2, qrSide / qr.width);
      }
    });
    pages.push({ width: pw, height: ph, content: c });
  }
  return buildPdf(pages, { title: `Etiquetas · ${o.tenantName}` });
}

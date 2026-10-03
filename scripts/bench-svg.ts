// Mide la generación de SVG EAN-13 y QR sin caché (GTIN distinto en cada iteración).
import bwipjs from 'bwip-js';
import { buildGtin13, toDigitalLink } from '../packages/codes/src/index';

const N = 500;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const run = (kind: 'ean13' | 'qr') => {
  const t: number[] = [];
  for (let i = 0; i < N + 20; i++) {
    const g = buildGtin13('750', '0002', i + 1000);
    const opts: any = kind === 'ean13'
      ? { bcid: 'ean13', text: g.slice(0, 12), includetext: true, scale: 3, height: 12, barcolor: '121316' }
      : { bcid: 'qrcode', text: toDigitalLink(g, 'id.ejemplo.mx'), eclevel: 'M', scale: 4, barcolor: '121316' };
    const s = performance.now(); (bwipjs as any).toSVG(opts); const d = performance.now() - s;
    if (i >= 20) t.push(d); // 20 de calentamiento
  }
  return { kind, n: N, mean_ms: +(t.reduce((a, b) => a + b, 0) / N).toFixed(3), p50_ms: +pct(t, .5).toFixed(3), p95_ms: +pct(t, .95).toFixed(3) };
};
console.table([run('ean13'), run('qr')]);

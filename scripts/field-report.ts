// Informe de campo desde scan_events REALES. Sin datos → "sin datos". Uso: tsx scripts/field-report.ts [salida.md]
import pg from 'pg';
import fs from 'node:fs';

const MATRIX: [string, string][] = [
  ['android-gama-baja-chrome', 'etiqueta-100'], ['android-gama-baja-chrome', 'etiqueta-80'], ['android-gama-baja-chrome', 'pantalla-laptop'],
  ['iphone-safari', 'etiqueta-100'], ['iphone-safari', 'pantalla-otro-telefono'],
  ['laptop-windows-chrome', 'etiqueta-100'],
];
const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/codes' });
await c.connect();
const rows = (await c.query(`
  SELECT device, support, count(*)::int AS n, count(*) FILTER (WHERE result='resolved')::int AS ok,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY decode_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY decode_ms) AS p95,
         string_agg(DISTINCT engine, ',') AS engines
  FROM scan_events WHERE device IS NOT NULL AND support IS NOT NULL AND engine <> 'manual' GROUP BY device, support`)).rows;
const wrong = (await c.query("SELECT device, support, gtin, result, created_at FROM scan_events WHERE device IS NOT NULL AND result <> 'resolved' AND engine <> 'manual' ORDER BY id DESC LIMIT 50")).rows;
const f = (x: number | null) => (x == null ? 'sin datos' : x.toFixed(1));
let md = `# Informe de campo\n\nGenerado ${new Date().toISOString()} a partir de \`scan_events\` (solo lecturas reales; objetivo: 30 por fila).\n\n| Dispositivo | Soporte | Motor | Lecturas | Éxito | decode p50 (ms) | decode p95 (ms) |\n|---|---|---|---|---|---|---|\n`;
const seen = new Set<string>();
for (const [d, s] of MATRIX) {
  const r = rows.find(x => x.device === d && x.support === s); seen.add(`${d}|${s}`);
  md += r ? `| ${d} | ${s} | ${r.engines} | ${r.n}${r.n < 30 ? ' (<30)' : ''} | ${(100 * r.ok / r.n).toFixed(0)} % | ${f(r.p50)} | ${f(r.p95)} |\n` : `| ${d} | ${s} | sin datos | sin datos | sin datos | sin datos | sin datos |\n`;
}
for (const r of rows) if (!seen.has(`${r.device}|${r.support}`)) md += `| ${r.device} | ${r.support} | ${r.engines} | ${r.n} | ${(100 * r.ok / r.n).toFixed(0)} % | ${f(r.p50)} | ${f(r.p95)} |\n`;
md += `\n## Lecturas erróneas o no resueltas (últimas 50)\n\n` + (wrong.length ? wrong.map(w => `- ${w.created_at.toISOString()} ${w.device}/${w.support} ${w.gtin ?? ''} → ${w.result}`).join('\n') : 'Ninguna registrada.') + '\n';
const out = process.argv[2] ?? 'docs/campo/informe.md';
fs.writeFileSync(out, md); console.log(md);
await c.end();

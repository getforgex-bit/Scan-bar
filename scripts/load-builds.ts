// Carga de POST /v1/builds (equivalente a scripts/load/builds.k6.js, sin k6): tasa fija, BOM distintos.
// Uso: tsx scripts/load-builds.ts [rps=20] [segundos=120]   (requiere API en :3000 con la semilla)
const BASE = process.env.BASE ?? 'http://localhost:3000';
const rps = Number(process.argv[2] ?? 20), secs = Number(process.argv[3] ?? 120);
const [email, password] = [process.env.LOAD_EMAIL ?? 'caja2@ejemplo.mx', process.env.LOAD_PASSWORD ?? process.env.SEED_POS_PASSWORD ?? ''];
const H = { 'content-type': 'application/json', 'x-requested-with': 'load' };

const login = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error('login falló: ' + login.status);
const cookie = login.headers.getSetCookie()[0].split(';')[0];
const prods: any[] = await (await fetch(`${BASE}/v1/products`, { headers: { cookie } })).json();
const id = (sku: string) => prods.find(p => p.sku === sku).id;
// LOAD_VARIANT (0-3) cambia CPU y placa para generar BOM que aún no existen en la base
const variant = Number(process.env.LOAD_VARIANT ?? 0);
const base = [variant & 1 ? 'CPU-A5-7600' : 'CPU-A7-7700', variant & 2 ? 'MB-B650-MATX' : 'MB-B650-ATX', 'PSU-850', 'CASE-ATX'].map(id);

let n = 0; const lat: number[] = []; let errors = 0, created = 0;
const one = async (i: number) => {
  // variamos cantidades de RAM/SSD/HDD para obtener BOM distintos (el hash incluye qty)
  const q = (k: number) => 1 + ((i >> k) % 4), lines = [
    ...base.map(productId => ({ productId, qty: 1 })),
    { productId: id('RAM-D5-16'), qty: q(0) }, { productId: id('SSD-1T'), qty: 1 + (i >> 2) % 6 }, { productId: id('HDD-2T'), qty: 1 + (i >> 5) % 6 }, { productId: id('SSD-500'), qty: 1 + (i >> 8) % 6 },
  ];
  const t = performance.now();
  try {
    const r = await fetch(`${BASE}/v1/builds`, { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify({ lines }) });
    await r.text(); lat.push(performance.now() - t);
    if (r.status === 201) created++; else if (r.status !== 200) errors++;
  } catch { errors++; }
};
const pending: Promise<void>[] = []; const start = performance.now();
for (let i = 0; i < rps * secs; i++) {
  const due = start + (i * 1000) / rps; const wait = due - performance.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  pending.push(one(i)); n++;
}
await Promise.all(pending);
const s = [...lat].sort((a, b) => a - b); const p = (x: number) => +s[Math.min(s.length - 1, Math.floor(s.length * x))].toFixed(1);
console.log(JSON.stringify({ requests: n, newBuilds: created, errors, errorRate: +(errors / n).toFixed(4), p50_ms: p(.5), p95_ms: p(.95), p99_ms: p(.99), max_ms: +s[s.length - 1].toFixed(1) }));
export {};

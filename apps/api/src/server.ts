import { buildApp } from './app';
import { startAutoSync } from './sync';

const app = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`API escuchando en http://localhost:${port}`);
// Catálogo de las webs: al arrancar y cada SYNC_INTERVAL_MIN minutos si un repo cambió (SYNC_REPOS=0 lo apaga).
const stopSync = startAutoSync(app.db.adminRw, m => console.log(`[sync] ${m}`));
// El contenedor recibe SIGTERM al dormirse o al desplegar: se cierran conexiones y se vacía la bitácora.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, async () => { stopSync(); await app.close().catch(() => {}); process.exit(0); });

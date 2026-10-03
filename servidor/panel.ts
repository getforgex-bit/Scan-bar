// Panel del servidor de Scan-bar en tu PC (npm run servidor, o doble clic en "Servidor Scan-bar.cmd").
// Un botón enciende y apaga todo; la pestaña Datos muestra el registro, el estado y los números de la base.
// Encender, en orden: PostgreSQL embebido (datos en .servidor/postgres) → la app (scripts/start.ts: migra, crea cuentas,
// sincroniza las webs) → túnel gratuito de Cloudflare hacia la app → avisa al Worker scan-bar.<cuenta>.workers.dev la
// dirección del túnel. Apagar, al revés. Todo gratis: sin servidor en la nube ni tarjeta.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { SOURCES } from '../apps/api/src/sync';
import { adminEmail, cajaEmail } from '../apps/api/src/bootstrap';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// SERVIDOR_DATOS cambia la carpeta de datos (por omisión .servidor/ en el repo, fuera de git).
const DATA = path.resolve(process.env.SERVIDOR_DATOS ?? path.join(ROOT, '.servidor'));
const UI = fileURLToPath(new URL('./ui/', import.meta.url));
const PANEL_PORT = Number(process.env.PANEL_PORT ?? 4100);
const APP_PORT = Number(process.env.SCANBAR_PORT ?? 3100);
const PG_PORT = Number(process.env.SCANBAR_PG_PORT ?? 5434);
const LOCAL_URL = `http://127.0.0.1:${APP_PORT}`;
const WIN = process.platform === 'win32';
fs.mkdirSync(DATA, { recursive: true });

// ---------- configuración (se crea sola la primera vez; vive solo en esta PC, fuera de git) ----------
type Config = { publicUrl: string; proxyKey: string; adminPassword: string; cajaPassword: string; pgPassword: string; dbAppRw: string; dbAdminRo: string; dbAdminRw: string; totpKey: string };
const CONFIG_FILE = path.join(DATA, 'config.json');
const ALFABETO = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Contraseña fácil de teclear: 4 grupos de 4 (≈90 bits), sin caracteres que se confunden. */
const clave = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('')).join('-');
const aleatorio = () => crypto.randomBytes(24).toString('hex');
function leerConfig(): Config {
  const previa = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config> : {};
  const c: Config = {
    publicUrl: previa.publicUrl ?? '', proxyKey: previa.proxyKey ?? aleatorio(),
    adminPassword: previa.adminPassword ?? clave(), cajaPassword: previa.cajaPassword ?? clave(),
    pgPassword: previa.pgPassword ?? aleatorio(), dbAppRw: previa.dbAppRw ?? aleatorio(), dbAdminRo: previa.dbAdminRo ?? aleatorio(),
    dbAdminRw: previa.dbAdminRw ?? aleatorio(), totpKey: previa.totpKey ?? crypto.randomBytes(32).toString('base64'),
  };
  if (JSON.stringify(c) !== JSON.stringify(previa)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  return c;
}
let cfg = leerConfig();
const guardarConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });

// ---------- registro ----------
type Linea = { t: number; src: 'panel' | 'scan-bar' | 'postgres' | 'túnel'; nivel: 'info' | 'aviso' | 'error'; texto: string };
const lineas: Linea[] = [];
const oyentes = new Set<http.ServerResponse>();
const LOG_FILE = path.join(DATA, 'registro.log');
if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.anterior');
const archivoLog = fs.createWriteStream(LOG_FILE, { flags: 'a' }); // en orden (appendFile suelto puede cruzar líneas)
const sinColor = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** Contraseñas y llaves nunca se escriben en el registro. */
const tapar = (s: string) => [cfg.proxyKey, cfg.adminPassword, cfg.cajaPassword, cfg.pgPassword, cfg.dbAppRw, cfg.dbAdminRo, cfg.dbAdminRw, cfg.totpKey]
  .reduce((acc, secreto) => secreto ? acc.split(secreto).join('••••') : acc, s);
function log(src: Linea['src'], texto: string, nivel: Linea['nivel'] = 'info') {
  for (const raw of sinColor(String(texto)).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const l: Linea = { t: Date.now(), src, nivel: nivel === 'info' && /\b(error|fall[óo]|fatal)\b/i.test(raw) ? 'error' : nivel, texto: tapar(raw) };
    lineas.push(l); if (lineas.length > 3000) lineas.shift();
    archivoLog.write(`${new Date(l.t).toISOString()} [${l.src}] ${l.texto}\n`);
    for (const o of oyentes) o.write(`data: ${JSON.stringify(l)}\n\n`);
    const m = /^\[sync\] ([a-z0-9-]+): (.*)$/.exec(l.texto);
    if (src === 'scan-bar' && m) syncs.set(m[1], { at: l.t, texto: m[2], error: /FALL/.test(m[2]) });
  }
}

// ---------- estado ----------
type Estado = 'apagado' | 'encendiendo' | 'encendido' | 'apagando' | 'error';
let estado: Estado = 'apagado';
let paso = '';
let desde = 0;
let error = '';
let tunelUrl = '';
let aviso = '';
let salud = { ok: false, ms: 0, at: 0, detalle: '' };
const syncs = new Map<string, { at: number; texto: string; error: boolean }>();
let pgInst: EmbeddedPostgres | null = null;
let app: ChildProcess | null = null;
let tunel: ChildProcess | null = null;
let deteniendo = false;
let monitor: NodeJS.Timeout | null = null;
const publicHost = () => { try { return cfg.publicUrl ? new URL(cfg.publicUrl).host : ''; } catch { return ''; } };
const dbUrl = () => `postgres://postgres:${encodeURIComponent(cfg.pgPassword)}@127.0.0.1:${PG_PORT}/scanbar`;
const fase = (texto: string) => { paso = texto; log('panel', `${texto}…`); };
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));

async function encender() {
  if (estado !== 'apagado' && estado !== 'error') return;
  estado = 'encendiendo'; error = ''; aviso = ''; deteniendo = false;
  try {
    fase('Revisando lo necesario');
    const [mayor, menor] = process.versions.node.split('.').map(Number);
    if (mayor < 22 || (mayor === 22 && menor < 12)) throw new Error(`Se necesita Node.js 22.12 o superior (tienes ${process.versions.node}).`);
    // Se compila la primera vez y cada vez que cambia su código (al actualizar Scan-bar); si no, se vería la versión anterior.
    const huella = huellaWeb();
    const huellaPrevia = fs.existsSync(HUELLA_WEB) ? fs.readFileSync(HUELLA_WEB, 'utf8') : '';
    if (!fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')) || huella !== huellaPrevia) {
      fase(huellaPrevia ? 'Preparando la versión nueva de la app (~1 minuto)' : 'Preparando la app (solo la primera vez, ~1 minuto)');
      await correr(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', 'apps/web', '--config', 'apps/web/vite.config.ts']);
      fs.writeFileSync(HUELLA_WEB, huella);
    }
    fase('Iniciando la base de datos');
    await iniciarPostgres();
    fase('Iniciando Scan-bar');
    iniciarApp();
    await esperarSalud(`${LOCAL_URL}/health`, 120_000, 'Scan-bar no arrancó a tiempo; revisa el registro.', false, () => app?.exitCode != null ? 'Scan-bar se cerró al arrancar; revisa el registro (pestaña Datos).' : '');
    if (cfg.publicUrl) {
      fase('Abriendo el túnel a internet');
      // SERVIDOR_SIN_TUNEL=1: el Worker llega directo a esta PC (pruebas, o si ya la expones de otra forma).
      tunelUrl = process.env.SERVIDOR_SIN_TUNEL === '1' ? LOCAL_URL : await iniciarTunel();
      fase('Avisando a Cloudflare');
      await registrar(tunelUrl);
      fase('Comprobando desde internet');
      const ok = await esperarSalud(`${cfg.publicUrl}/health`, 90_000, '', true);
      if (!ok) aviso = 'Encendido, pero aún no responde desde internet. Se sigue intentando solo.';
    } else {
      aviso = 'Encendido solo en esta PC. Para que las webs lo encuentren, completa "Conexión con Cloudflare" en Datos.';
    }
    estado = 'encendido'; desde = Date.now(); paso = '';
    log('panel', cfg.publicUrl ? `Encendido: ${cfg.publicUrl}` : `Encendido en ${LOCAL_URL} (solo esta PC)`);
    vigilar();
  } catch (e: any) {
    error = explicar(e?.message ?? String(e));
    log('panel', `No se pudo encender: ${error}`, 'error');
    await apagar(true);
    estado = 'error';
  }
}

/** Huella del código de la PWA (y de las dependencias): cambia cuando se actualiza Scan-bar. */
const HUELLA_WEB = path.join(DATA, 'pwa-huella.txt');
function huellaWeb(): string {
  const h = crypto.createHash('sha256');
  const recorrer = (rel: string) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs).sort()) if (n !== 'dist' && n !== 'node_modules') recorrer(path.join(rel, n)); return; }
    h.update(rel.split(path.sep).join('/')); h.update(fs.readFileSync(abs));
  };
  for (const rel of ['apps/web', 'packages/codes/src', 'package-lock.json']) recorrer(rel);
  return h.digest('hex');
}

/** Errores de Windows con solución conocida, en palabras claras (el detalle técnico queda en el registro). */
function explicar(m: string) {
  // 3221225781 = 0xC0000135 (falta una DLL): PostgreSQL para Windows necesita el runtime de Visual C++.
  if (/\b(3221225781|-1073741515)\b/.test(m))
    return 'A Windows le falta "Microsoft Visual C++ Redistributable", que necesita la base de datos. Instálalo desde https://aka.ms/vs/17/release/vc_redist.x64.exe y vuelve a encender.';
  return m;
}

async function apagar(porError = false) {
  // Mientras enciende no se interrumpe (quedarían piezas a medio abrir); el botón lo indica.
  if (!porError && (estado === 'apagado' || estado === 'apagando' || estado === 'encendiendo')) return;
  deteniendo = true;
  if (!porError) estado = 'apagando';
  paso = 'Apagando';
  if (monitor) { clearInterval(monitor); monitor = null; }
  if (cfg.publicUrl && tunelUrl) { log('panel', 'Avisando a Cloudflare que Scan-bar se apaga…'); await registrar('').catch(() => {}); }
  await detener(tunel, 'túnel'); tunel = null; tunelUrl = '';
  await detener(app, 'Scan-bar'); app = null;
  if (pgInst) { log('panel', 'Deteniendo la base de datos…'); await pgInst.stop().catch(e => log('postgres', String(e), 'error')); pgInst = null; }
  salud = { ok: false, ms: 0, at: 0, detalle: '' }; desde = 0; paso = ''; aviso = '';
  if (!porError) { estado = 'apagado'; log('panel', 'Apagado.'); }
  deteniendo = false;
}

// ---------- piezas ----------
async function iniciarPostgres() {
  const dir = path.join(DATA, 'postgres');
  pgInst = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: cfg.pgPassword, port: PG_PORT, persistent: true,
    onLog: m => log('postgres', String(m)), onError: m => log('postgres', String(m), 'error'),
  });
  try {
    if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) { log('panel', 'Creando la base de datos (primera vez)…'); await vigilado(pgInst.initialise()); }
    await vigilado(pgInst.start());
  } catch (e) {
    // Sin proceso vivo que detener: pgInst.stop() esperaría para siempre un cierre que ya pasó (o que nunca empezó).
    pgInst = null;
    throw e instanceof Error ? e : new Error(`La base de datos se cerró al arrancar (¿otro programa usa el puerto ${PG_PORT}?); revisa el registro.`);
  }
  try { await pgInst.createDatabase('scanbar'); } catch { /* ya existe */ }
}

// embedded-postgres no escucha el 'error' de sus procesos: si no puede abrir initdb o postgres (antivirus, permisos), el
// error llega a uncaughtException (abajo) y su promesa no termina nunca. alFallarAlAbrir corta esa espera.
let alFallarAlAbrir: ((e: Error) => void) | null = null;
const vigilado = <T>(p: Promise<T>) => new Promise<T>((resolve, reject) => { alFallarAlAbrir = reject; p.then(resolve, reject); })
  .finally(() => { alFallarAlAbrir = null; });

/** Variables para la app: las de este proceso sin nada de bases o secretos ajenos (p. ej. un .env de desarrollo). */
function entornoApp(): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_URL|APP_DATABASE_URL|ADMIN_DATABASE_URL|ADMIN_RW_DATABASE_URL|DB_|TOTP_ENC_KEY|ADMIN_|CAJA_|RESOLVER_HOST|PROXY_KEY|SEED_|WEB_URL_|PORT$|HOST$)/.test(k)));
  return {
    ...base, NODE_ENV: 'production', PORT: String(APP_PORT), HOST: '127.0.0.1', DATABASE_URL: dbUrl(),
    DB_APP_RW_PASSWORD: cfg.dbAppRw, DB_ADMIN_RO_PASSWORD: cfg.dbAdminRo, DB_ADMIN_RW_PASSWORD: cfg.dbAdminRw, TOTP_ENC_KEY: cfg.totpKey,
    ADMIN_PASSWORD: cfg.adminPassword, CAJA_PASSWORD: cfg.cajaPassword, SYNC_INTERVAL_MIN: '10',
    RESOLVER_HOST: publicHost() || `localhost:${APP_PORT}`,
    ...(cfg.publicUrl ? { PROXY_KEY: cfg.proxyKey } : {}),
  };
}

function iniciarApp() {
  app = spawn(process.execPath, ['--import', 'tsx', 'scripts/start.ts'], { cwd: ROOT, env: entornoApp(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  app.stdout!.on('data', d => log('scan-bar', String(d)));
  app.stderr!.on('data', d => log('scan-bar', String(d), 'aviso'));
  const este = app;
  app.on('exit', code => {
    log('scan-bar', `El proceso terminó (código ${code ?? '—'}).`, code ? 'error' : 'info');
    if (app === este && !deteniendo && estado === 'encendido') {
      error = 'Scan-bar se detuvo de forma inesperada; revisa el registro y vuelve a encender.';
      app = null; void apagar(true).then(() => { estado = 'error'; });
    }
  });
}

async function esperarSalud(url: string, maxMs: number, mensaje: string, silencioso = false, fallo: () => string = () => ''): Promise<boolean> {
  const fin = Date.now() + maxMs;
  while (Date.now() < fin) {
    const f = fallo(); if (f) throw new Error(f);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) return true; } catch { /* aún no */ }
    await esperar(1500);
  }
  if (silencioso) return false;
  throw new Error(mensaje);
}

/** cloudflared: el del sistema si existe; si no, se descarga una sola vez de GitHub (releases oficiales de Cloudflare). */
async function binCloudflared(): Promise<string> {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  try { await exec('cloudflared', ['--version'], { timeout: 10_000 }); return 'cloudflared'; } catch { /* no está instalado */ }
  const dir = path.join(DATA, 'bin');
  const bin = path.join(dir, WIN ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(bin)) return bin;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  const archivo = WIN ? `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe` : process.platform === 'darwin' ? `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz` : `cloudflared-linux-${arch}`;
  log('panel', `Descargando cloudflared (una sola vez): ${archivo}…`);
  const r = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${archivo}`, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`No se pudo descargar cloudflared (${r.status}). Instálalo a mano: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
  fs.mkdirSync(dir, { recursive: true });
  const datos = Buffer.from(await r.arrayBuffer());
  if (archivo.endsWith('.tgz')) { const tgz = path.join(dir, archivo); fs.writeFileSync(tgz, datos); await exec('tar', ['-xzf', tgz, '-C', dir]); fs.rmSync(tgz); }
  else fs.writeFileSync(bin, datos);
  fs.chmodSync(bin, 0o755);
  return bin;
}

let reintentosTunel = 0;
async function iniciarTunel(): Promise<string> {
  const bin = await binCloudflared();
  return new Promise((resolve, reject) => {
    const t = spawn(bin, ['tunnel', '--no-autoupdate', '--url', LOCAL_URL], { cwd: DATA, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    tunel = t;
    let listo = false;
    const plazo = setTimeout(() => { if (!listo) { reject(new Error('El túnel de Cloudflare no respondió en 90 s; revisa tu conexión a internet.')); t.kill(); } }, 90_000);
    const leer = (d: Buffer) => {
      const s = String(d); log('túnel', s);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(s);
      if (m && !listo) { listo = true; clearTimeout(plazo); resolve(m[0]); }
    };
    t.stdout!.on('data', leer); t.stderr!.on('data', leer);
    t.on('error', (e: any) => { clearTimeout(plazo); if (!listo) reject(new Error(`No se pudo abrir cloudflared (${e.code}). Si tienes antivirus, permite la carpeta de Scan-bar y vuelve a encender.`)); });
    t.on('exit', code => {
      clearTimeout(plazo);
      if (!listo) { reject(new Error(`El túnel se cerró al iniciar (código ${code ?? '—'}).`)); return; }
      if (tunel === t && !deteniendo && estado === 'encendido' && reintentosTunel < 5) {
        reintentosTunel++;
        log('túnel', 'El túnel se cerró; se vuelve a abrir…', 'aviso');
        void iniciarTunel().then(async url => { tunelUrl = url; await registrar(url); log('panel', 'Túnel restablecido.'); })
          .catch(e => { error = `Se perdió la conexión a internet: ${e.message}`; log('panel', error, 'error'); });
      }
    });
  });
}

/** Le dice al Worker de Cloudflare la dirección actual del túnel ("" = apagado). */
async function registrar(origen: string) {
  let r: Response;
  try {
    r = await fetch(new URL('/__scanbar/origen', cfg.publicUrl), {
      method: 'POST', headers: { 'x-scanbar-proxy': cfg.proxyKey, 'content-type': 'application/json' },
      body: JSON.stringify({ origen }), signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) { throw new Error(`No se pudo contactar ${cfg.publicUrl}: ${e?.cause?.code ?? e.message}. Revisa la dirección pública.`); }
  if (r.status === 204) { if (origen) log('panel', `Cloudflare ya envía las visitas a ${origen}`); return; }
  const cuerpo = (await r.text()).slice(0, 200);
  if (r.status === 401) throw new Error('La llave no coincide con el secreto SCANBAR_PROXY_KEY del Worker. Cópiala de nuevo (Datos → Conexión con Cloudflare).');
  if (r.status === 503 && /SCANBAR_PROXY_KEY/.test(cuerpo)) throw new Error('Al Worker le falta el secreto SCANBAR_PROXY_KEY. Agrégalo en Cloudflare (Datos → Conexión con Cloudflare).');
  throw new Error(`El Worker respondió ${r.status}. ¿Está publicada la versión más reciente de Scan-bar en Cloudflare? ${cuerpo}`);
}

/** Cada 30 s: ¿responde Scan-bar desde internet? Si falla seguido, se vuelve a avisar a Cloudflare. */
function vigilar() {
  let fallos = 0;
  const revisar = async () => {
    const url = `${cfg.publicUrl || LOCAL_URL}/health`; const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      salud = { ok: r.ok, ms: Date.now() - t0, at: Date.now(), detalle: r.ok ? '' : `respondió ${r.status}` };
    } catch (e: any) { salud = { ok: false, ms: 0, at: Date.now(), detalle: e?.cause?.code ?? e.message }; }
    if (salud.ok) { fallos = 0; if (aviso.startsWith('Encendido, pero')) aviso = ''; return; }
    if (++fallos === 3 && cfg.publicUrl && tunelUrl) { log('panel', 'No responde desde internet; se avisa de nuevo a Cloudflare…', 'aviso'); await registrar(tunelUrl).catch(e => log('panel', e.message, 'error')); fallos = 0; }
  };
  void revisar();
  monitor = setInterval(revisar, 30_000);
}

function correr(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.on('data', d => log('panel', String(d))); p.stderr.on('data', d => log('panel', String(d), 'aviso'));
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? cmd)} terminó con código ${code}`)));
  });
}

async function detener(p: ChildProcess | null, nombre: string) {
  if (!p || p.exitCode !== null || p.pid === undefined) return;
  log('panel', `Deteniendo ${nombre}…`);
  const salio = new Promise<void>(r => p.once('exit', () => r()));
  if (WIN) await exec('taskkill', ['/pid', String(p.pid), '/T', '/F']).catch(() => p.kill());
  else p.kill('SIGTERM');
  const listo = await Promise.race([salio.then(() => true), esperar(10_000).then(() => false)]);
  if (!listo) { p.kill('SIGKILL'); await salio; }
}

// ---------- datos para la pestaña Datos ----------
async function datosBase() {
  if (!pgInst || estado === 'apagado') return null;
  const c = new pg.Client({ connectionString: dbUrl() });
  try {
    await c.connect();
    const negocios = (await c.query(`SELECT t.slug, t.name, t.product_url_tpl AS web,
        count(p.id) FILTER (WHERE p.active)::int AS activos,
        count(p.id) FILTER (WHERE p.active AND p.origin = 'scanbar')::int AS consola,
        count(k.gtin) FILTER (WHERE k.retired_at IS NULL)::int AS codigos
      FROM tenants t LEFT JOIN products p ON p.tenant_id = t.id LEFT JOIN codes k ON k.product_id = p.id
      WHERE t.company_prefix >= '0010' GROUP BY t.id ORDER BY t.company_prefix`)).rows;
    const n = (await c.query(`SELECT
        (SELECT count(*)::int FROM builds) AS configuraciones,
        (SELECT count(*)::int FROM scan_events WHERE created_at >= date_trunc('day', now())) AS escaneos_hoy,
        (SELECT count(*)::int FROM sales WHERE created_at >= date_trunc('day', now())) AS ventas_hoy,
        (SELECT coalesce(sum(total_cents), 0)::bigint FROM sales WHERE created_at >= date_trunc('day', now())) AS vendido_hoy,
        pg_database_size(current_database())::bigint AS tamano`)).rows[0];
    return { negocios, ...n, vendido_hoy: Number(n.vendido_hoy), tamano: Number(n.tamano) };
  } catch (e: any) { return { error: e.message }; } finally { await c.end().catch(() => {}); }
}

function resumenEstado() {
  return {
    estado, paso, desde, error, aviso, publicUrl: cfg.publicUrl, tunelUrl, localUrl: LOCAL_URL, salud,
    configurado: !!cfg.publicUrl, equipo: `${os.hostname()} · ${os.type()} · Node ${process.versions.node}`,
  };
}

// ---------- servidor del panel (solo en esta PC) ----------
const TIPOS: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const leerCuerpo = (req: http.IncomingMessage) => new Promise<any>((resolve) => { let s = ''; req.on('data', d => { s += d; if (s.length > 10_000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });

const panel = http.createServer(async (req, res) => {
  // Solo esta PC: se rechaza cualquier otro host (protege contra páginas web que intenten usar el panel).
  const hostsOk = [`127.0.0.1:${PANEL_PORT}`, `localhost:${PANEL_PORT}`];
  if (!hostsOk.includes(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'POST') {
    const origen = req.headers.origin;
    if (req.headers['x-panel'] !== '1' || (origen && !hostsOk.map(h => `http://${h}`).includes(origen))) { res.writeHead(403).end(); return; }
    if (url.pathname === '/api/encender') { void encender(); return json(res, 202, resumenEstado()); }
    if (url.pathname === '/api/apagar') {
      if (estado === 'encendiendo') return json(res, 409, { ...resumenEstado(), mensaje: 'Espera a que termine de encender.' });
      void apagar(); return json(res, 202, resumenEstado());
    }
    if (url.pathname === '/api/config') {
      const b = await leerCuerpo(req);
      let pub = String(b.publicUrl ?? '').trim().replace(/\/+$/, '');
      if (pub && !/^https?:\/\//.test(pub)) pub = `https://${pub}`;
      if (pub) { try { const u = new URL(pub); if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw 0; pub = u.origin; } catch { return json(res, 400, { error: 'Escribe una dirección como https://scan-bar.tu-cuenta.workers.dev' }); } }
      if (estado !== 'apagado' && estado !== 'error' && pub !== cfg.publicUrl) return json(res, 409, { error: 'Apaga el servidor antes de cambiar la dirección pública.' });
      cfg.publicUrl = pub; guardarConfig(); log('panel', pub ? `Dirección pública: ${pub}` : 'Sin dirección pública (solo esta PC).');
      return json(res, 200, resumenEstado());
    }
    res.writeHead(404).end(); return;
  }

  if (url.pathname === '/api/estado') return json(res, 200, resumenEstado());
  if (url.pathname === '/api/datos') {
    return json(res, 200, {
      base: await datosBase(),
      sincronizacion: SOURCES.map(s => ({ slug: s.slug, nombre: s.name, ...(syncs.get(s.slug) ?? { at: 0, texto: '', error: false }) })),
      cuentas: { admin: adminEmail({}), adminPassword: cfg.adminPassword, cajas: SOURCES.map(s => cajaEmail(s.slug)), cajaPassword: cfg.cajaPassword },
      llave: cfg.proxyKey, publicUrl: cfg.publicUrl, registro: LOG_FILE, datos: DATA,
    });
  }
  if (url.pathname === '/api/registro') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    for (const l of lineas.slice(-800)) res.write(`data: ${JSON.stringify(l)}\n\n`);
    oyentes.add(res); req.on('close', () => oyentes.delete(res));
    return;
  }
  const archivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const ruta = archivo === 'icon.svg' ? path.join(ROOT, 'apps/web/public/icon.svg') : path.join(UI, archivo);
  if (!/^[a-z0-9.-]+$/i.test(archivo) || !fs.existsSync(ruta)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(ruta)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(ruta).pipe(res);
});

panel.on('error', (e: any) => {
  console.error(e.code === 'EADDRINUSE' ? `El panel ya está abierto (puerto ${PANEL_PORT}). Ábrelo en http://127.0.0.1:${PANEL_PORT}` : e);
  process.exit(1);
});
panel.listen(PANEL_PORT, '127.0.0.1', () => {
  const dir = `http://127.0.0.1:${PANEL_PORT}`;
  console.log(`\n  Panel de Scan-bar: ${dir}\n  Deja esta ventana abierta mientras uses el servidor. Para salir: Ctrl+C (apaga todo).\n`);
  log('panel', `Panel abierto en ${dir}`);
  if (!process.argv.includes('--no-abrir')) {
    const [cmd, args] = WIN ? ['explorer', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  }
  if (process.argv.includes('--encender')) void encender();
});

// Cerrar la ventana o Ctrl+C apaga todo en orden: túnel, app y al final la base de datos. embedded-postgres registra su
// propio cierre al recibir la señal (y cerraría la base antes que la app); se quita para que mande este orden.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.removeAllListeners(sig);
let saliendo = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, async () => {
  if (saliendo) return; saliendo = true;
  console.log('\n  Apagando Scan-bar…');
  await apagar().catch(() => {});
  process.exit(0);
});
process.on('exit', () => { for (const p of [tunel, app]) try { p?.kill(); } catch { /* ya terminó */ } });
// Un error que nadie atrapa (p. ej. embedded-postgres no puede abrir initdb/postgres) no cierra el panel: queda en el
// registro y el paso que lo sufrió falla con su propio mensaje.
process.on('uncaughtException', (e: any) => {
  if (!e?.syscall?.startsWith('spawn')) { log('panel', `Error inesperado: ${e?.stack ?? e}`, 'error'); return; }
  const m = `No se pudo abrir ${path.basename(e.path ?? '')} (${e.code}). Si tienes antivirus, permite la carpeta de Scan-bar y vuelve a encender.`;
  log('panel', m, 'error');
  alFallarAlAbrir?.(new Error(m));
});

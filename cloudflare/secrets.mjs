// Configura los secretos del Worker "scan-bar" en Cloudflare (una vez, después del primer despliegue).
// Uso, en la raíz del repo: npm run cf:secrets   — pregunta lo que falta; también lee DATABASE_URL, ADMIN_PASSWORD y CAJA_PASSWORD del entorno.
// Lo que ya existe en Cloudflare se conserva salvo que escribas un valor nuevo. TOTP_ENC_KEY nunca se regenera:
// si cambiara, los SuperAdmin tendrían que volver a activar su segundo factor.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const wrangler = (args, opts = {}) => execFileSync(npx, ['wrangler', ...args], { encoding: 'utf8', shell: process.platform === 'win32', ...opts });

let existing = new Set();
try { existing = new Set(JSON.parse(wrangler(['secret', 'list', '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] })).map(s => s.name)); }
catch { console.log('Aún no hay secretos (o el Worker no existe: despliega primero; ver docs/DESPLIEGUE.md).'); }

/** Pregunta sin mostrar lo que se escribe (contraseñas y URL con contraseña). */
function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    rl._writeToOutput = () => {}; // la pregunta ya se escribió; lo que se teclea no se muestra
  });
}
const strong = () => crypto.randomBytes(15).toString('base64url'); // 20 caracteres
function problem(pw, email) {
  if (pw.length < 12) return 'debe tener al menos 12 caracteres';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return `no debe contener "${local}"`;
  return null;
}

const out = {};
const generated = [];

// 1) Base de datos (Neon: usa la cadena "Direct connection", sin "-pooler"; la app necesita LISTEN/NOTIFY)
let dbUrl = process.env.DATABASE_URL ?? '';
while (!dbUrl) {
  dbUrl = await ask(existing.has('DATABASE_URL') ? 'DATABASE_URL (Enter = conservar la actual): ' : 'DATABASE_URL de Neon (postgresql://…): ');
  if (!dbUrl && existing.has('DATABASE_URL')) break;
  if (dbUrl && !/^postgres(ql)?:\/\//.test(dbUrl)) { console.log('Debe empezar con postgresql://'); dbUrl = ''; }
}
if (dbUrl) {
  if (/-pooler\./.test(dbUrl)) console.log('Aviso: es la conexión "pooled" de Neon; usa la "Direct connection" (sin -pooler) para que funcione el tiempo real de la consola.');
  out.DATABASE_URL = dbUrl;
}

// 2) Contraseñas de los roles internos de Postgres y clave de cifrado del TOTP: aleatorias, nadie las necesita conocer
for (const name of ['DB_APP_RW_PASSWORD', 'DB_ADMIN_RO_PASSWORD', 'DB_ADMIN_RW_PASSWORD']) if (!existing.has(name)) out[name] = crypto.randomBytes(24).toString('hex');
if (!existing.has('TOTP_ENC_KEY')) out.TOTP_ENC_KEY = crypto.randomBytes(32).toString('base64');

// 3) Cuentas de la consola y de caja
const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@scanbar.mx').toLowerCase();
for (const [name, email, label] of [['ADMIN_PASSWORD', adminEmail, `administrador (${adminEmail})`], ['CAJA_PASSWORD', 'caja.cafe-motz@scanbar.mx', 'las cajas (caja.<negocio>@scanbar.mx)']]) {
  let pw = process.env[name] ?? '';
  for (;;) {
    if (!pw) pw = await ask(`Contraseña de ${label} (Enter = ${existing.has(name) ? 'conservar la actual' : 'generar una'}): `);
    if (!pw && existing.has(name)) break;
    if (!pw) { pw = strong(); generated.push(`${label}: ${pw}`); }
    const p = problem(pw, email);
    if (!p) { out[name] = pw; break; }
    console.log(`No sirve: ${p}.`); pw = '';
  }
}
if (process.env.ADMIN_EMAIL) out.ADMIN_EMAIL = adminEmail;

if (!Object.keys(out).length) { console.log('Nada que cambiar.'); process.exit(0); }
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scanbar-')), 'secrets.json');
try {
  fs.writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
  console.log(`Subiendo ${Object.keys(out).join(', ')}…`);
  wrangler(['secret', 'bulk', file], { stdio: 'inherit' });
} finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }

if (generated.length) {
  console.log('\nContraseñas generadas (guárdalas ahora; no se vuelven a mostrar):');
  for (const g of generated) console.log(`  ${g}`);
}
console.log('\nListo. Si Scan-bar ya estaba en marcha, vuelve a desplegar (Retry deployment en el panel o `npm run cf:deploy`) para reiniciarlo con los secretos nuevos.');
console.log('Al arrancar, las cuentas toman la contraseña de estos secretos (y se cierran sus sesiones si cambió).');

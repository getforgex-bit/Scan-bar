// npm run servidor: revisa Node, instala lo necesario la primera vez (o si la instalación quedó a medias, o si al actualizar
// Scan-bar cambió package-lock.json) y abre el panel. El panel corre en un proceso aparte: cuando se actualiza solo
// (botón "Actualizar Scan-bar") sale con el código 75 (o 76 si estaba encendido) y aquí se vuelve a abrir con el código nuevo.
// JavaScript simple, sin dependencias: corre antes de que exista node_modules.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REINICIAR = 75, REINICIAR_ENCENDIDO = 76;
const [mayor, menor] = process.versions.node.split('.').map(Number);
if (mayor < 22 || (mayor === 22 && menor < 12)) {
  console.error(`Necesitas Node.js 22.12 o superior (tienes ${process.versions.node}). Descarga la versión LTS de https://nodejs.org e instálala.`);
  process.exit(1);
}

// Lo que el panel carga al arrancar; si falta algo, la instalación no está completa.
const NECESARIOS = ['tsx', 'embedded-postgres', 'pg', 'fastify', 'argon2', 'vite'];
const instalado = () => NECESARIOS.every(m => fs.existsSync(path.join(ROOT, 'node_modules', m, 'package.json')));
// Marca con la huella de package-lock.json de la última instalación: si cambia (Scan-bar actualizado), se vuelve a instalar.
const MARCA = path.join(ROOT, 'node_modules', '.scanbar-lock');
const huellaLock = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).digest('hex');
function dependencias() {
  const completo = instalado();
  if (completo && fs.existsSync(MARCA) && fs.readFileSync(MARCA, 'utf8') === huellaLock()) return;
  console.log(completo ? 'Revisando que las dependencias estén al día…' : 'Instalando lo necesario por única vez (tarda unos minutos)…');
  const args = ['install', '--no-audit', '--no-fund'];
  // Con npm run, npm_execpath apunta a npm: se llama con este mismo Node, sin shell (igual en Windows, macOS y Linux).
  const npm = process.env.npm_execpath;
  const r = npm && /\.[cm]?js$/.test(npm)
    ? spawnSync(process.execPath, [npm, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync(`npm ${args.join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status === 0 && instalado()) fs.writeFileSync(MARCA, huellaLock());
  else if (completo && instalado()) console.warn('No se pudieron actualizar las dependencias (¿sin internet?); se sigue con las que ya estaban.');
  else {
    console.error('No se pudo instalar lo necesario. Revisa tu conexión a internet y vuelve a intentarlo (o ejecuta npm install y mira el error).');
    process.exit(1);
  }
}

// Ctrl+C o cerrar la ventana: el panel recibe la misma señal y apaga todo en orden; aquí solo se espera a que termine.
// (En Windows no se reenvía: matar al hijo desde aquí lo cortaría sin apagar la base de datos.)
let hijo = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { if (process.platform !== 'win32') hijo?.kill(sig); });

let args = process.argv.slice(2);
for (;;) {
  dependencias();
  const codigo = await new Promise(resolve => {
    hijo = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'servidor', 'panel.ts'), ...args], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, SCANBAR_SUPERVISADO: '1' },
    });
    hijo.on('error', e => { console.error(e); resolve(1); });
    hijo.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1)));
  });
  if (codigo !== REINICIAR && codigo !== REINICIAR_ENCENDIDO) process.exit(codigo);
  console.log('\n  Scan-bar se actualizó; abriendo el panel con la versión nueva…\n');
  args = [...args.filter(a => a !== '--encender' && a !== '--no-abrir'), '--no-abrir', ...(codigo === REINICIAR_ENCENDIDO ? ['--encender'] : [])];
}

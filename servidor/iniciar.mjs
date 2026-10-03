// npm run servidor: revisa Node, instala lo necesario la primera vez (o si la instalación quedó a medias) y abre el panel.
// JavaScript simple, sin dependencias: corre antes de que exista node_modules.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const [mayor, menor] = process.versions.node.split('.').map(Number);
if (mayor < 22 || (mayor === 22 && menor < 12)) {
  console.error(`Necesitas Node.js 22.12 o superior (tienes ${process.versions.node}). Descarga la versión LTS de https://nodejs.org e instálala.`);
  process.exit(1);
}

// Lo que el panel carga al arrancar; si falta algo, la instalación no está completa.
const NECESARIOS = ['tsx', 'embedded-postgres', 'pg', 'fastify', 'argon2', 'vite'];
const instalado = () => NECESARIOS.every(m => fs.existsSync(path.join(ROOT, 'node_modules', m, 'package.json')));
if (!instalado()) {
  console.log('Instalando lo necesario por única vez (tarda unos minutos)…');
  const args = ['install', '--no-audit', '--no-fund'];
  // Con npm run, npm_execpath apunta a npm: se llama con este mismo Node, sin shell (igual en Windows, macOS y Linux).
  const npm = process.env.npm_execpath;
  const r = npm && /\.[cm]?js$/.test(npm)
    ? spawnSync(process.execPath, [npm, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync(`npm ${args.join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0 || !instalado()) {
    console.error('No se pudo instalar lo necesario. Revisa tu conexión a internet y vuelve a intentarlo (o ejecuta npm install y mira el error).');
    process.exit(1);
  }
}

const { register } = await import('tsx/esm/api');
register();
await import('./panel.ts');

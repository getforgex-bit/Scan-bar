// Botón "Actualizar Scan-bar" del panel: lee el .tar.gz de GitHub y escribe solo lo que cambió, nunca fuera del
// repositorio ni sobre los datos de la PC.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leerTar, rutaValida, cambios, aplicar } from '../servidor/actualizar';

/** Arma un .tar como los de GitHub: encabezado pax global con el commit, carpeta raíz y rutas largas en pax. */
function tar(commit: string, archivos: Record<string, string>, modos: Record<string, number> = {}) {
  const bloques: Buffer[] = [];
  const entrada = (nombre: string, tipo: string, datos: Buffer, modo = 0o644) => {
    const h = Buffer.alloc(512);
    h.write(nombre.slice(0, 99), 0); h.write(modo.toString(8).padStart(7, '0'), 100); h.write('0000000', 108); h.write('0000000', 116);
    h.write(datos.length.toString(8).padStart(11, '0'), 124); h.write('00000000000', 136); h.write('        ', 148); h.write(tipo, 156);
    h.write('ustar\x0000', 257);
    let suma = 0; for (const b of h) suma += b; h.write(suma.toString(8).padStart(6, '0') + '\0 ', 148);
    bloques.push(h, datos, Buffer.alloc((512 - (datos.length % 512)) % 512));
  };
  const pax = (k: string, v: string) => { const r = ` ${k}=${v}\n`; let n = r.length; n += String(n + String(n).length).length; return Buffer.from(`${n}${r}`); };
  entrada('pax_global_header', 'g', pax('comment', commit));
  const raiz = `getforgex-bit-Scan-bar-${commit.slice(0, 7)}/`;
  entrada(raiz, '5', Buffer.alloc(0), 0o755);
  for (const [ruta, texto] of Object.entries(archivos)) {
    const completa = raiz + ruta;
    if (completa.length > 99) entrada('PaxHeader', 'x', pax('path', completa));
    entrada(completa, '0', Buffer.from(texto), modos[ruta] ?? 0o644);
  }
  bloques.push(Buffer.alloc(1024));
  return Buffer.concat(bloques);
}

describe('actualizar Scan-bar desde GitHub', () => {
  const larga = `apps/web/src/${'muy-largo/'.repeat(12)}archivo.ts`;
  const t = tar('0b3d5ccd46dfdc58b254c8e17d582046dade6f30', {
    'package.json': '{"name":"x"}', 'servidor/panel.ts': 'nuevo', 'servidor.sh': '#!/bin/sh', [larga]: 'ruta larga',
    '.servidor/config.json': '{"proxyKey":"de-github"}', 'node_modules/x/index.js': 'x', 'apps/web/dist/index.html': 'x',
    '.env': 'SECRETO=1', 'Servidor Scan-bar.cmd': '@echo off', '../fuera.txt': 'no',
  }, { 'servidor.sh': 0o755 });

  it('lee el commit, las rutas (también las largas) y el permiso de ejecución', () => {
    const p = leerTar(t);
    expect(p.commit).toBe('0b3d5ccd46dfdc58b254c8e17d582046dade6f30');
    expect(p.archivos.map(a => a.ruta)).toContain(larga);
    expect(p.archivos.find(a => a.ruta === 'servidor.sh')!.ejecutable).toBe(true);
    expect(p.archivos.find(a => a.ruta === 'package.json')!.ejecutable).toBe(false);
  });

  it('nunca escribe fuera del repositorio ni sobre datos, dependencias, app compilada, secretos o el lanzador en uso', () => {
    for (const r of ['../x', '/etc/passwd', 'a/../../x', 'C:/x', 'a\\b', '.servidor/config.json', 'node_modules/x', 'apps/web/dist/sw.js', '.env', '.dev-credentials.txt', 'Servidor Scan-bar.cmd', '.git/config'])
      expect(rutaValida(r), r).toBe(false);
    for (const r of ['package.json', 'servidor/panel.ts', 'apps/web/src/App.tsx', '.gitignore', 'servidor/ui/app.js']) expect(rutaValida(r), r).toBe(true);
  });

  it('escribe solo lo que cambió y deja intactos los datos de la PC', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actualizar-'));
    fs.mkdirSync(path.join(root, 'servidor')); fs.mkdirSync(path.join(root, '.servidor'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}'); // igual: no cambia
    fs.writeFileSync(path.join(root, 'servidor/panel.ts'), 'viejo');
    fs.writeFileSync(path.join(root, '.servidor/config.json'), '{"proxyKey":"mia"}');
    const lista = cambios(root, leerTar(t));
    expect(lista.map(a => a.ruta).sort()).toEqual(['servidor.sh', 'servidor/panel.ts', larga].sort());
    aplicar(root, lista);
    expect(fs.readFileSync(path.join(root, 'servidor/panel.ts'), 'utf8')).toBe('nuevo');
    expect(fs.readFileSync(path.join(root, larga), 'utf8')).toBe('ruta larga');
    expect(fs.readFileSync(path.join(root, '.servidor/config.json'), 'utf8')).toBe('{"proxyKey":"mia"}');
    expect(fs.existsSync(path.join(root, '.env')) || fs.existsSync(path.join(root, 'node_modules')) || fs.existsSync(path.join(path.dirname(root), 'fuera.txt'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, 'servidor.sh')).mode & 0o111).not.toBe(0);
    expect(cambios(root, leerTar(t))).toEqual([]); // segunda vez: nada que hacer
    fs.rmSync(root, { recursive: true, force: true });
  });
});

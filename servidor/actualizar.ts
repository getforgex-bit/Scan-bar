// Actualiza el código de Scan-bar desde GitHub sin Git ni ZIP: descarga el .tar.gz público de la rama main y escribe solo
// los archivos que cambiaron. Nunca toca los datos (.servidor/), node_modules, la app compilada ni secretos locales; el panel
// se reinicia después (servidor/iniciar.mjs) y, al encender, reinstala dependencias y recompila la app si hace falta.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const REPO = process.env.SCANBAR_REPO ?? 'getforgex-bit/Scan-bar';
export const RAMA = process.env.SCANBAR_RAMA ?? 'main'; // otra rama solo para probar una versión antes de publicarla
const URL_TAR = (repo: string) => `https://codeload.github.com/${repo}/tar.gz/refs/heads/${RAMA}`;

type Archivo = { ruta: string; datos: Buffer; ejecutable: boolean };
export type Paquete = { commit: string | null; archivos: Archivo[] };

// Lo que es de esta PC: datos, dependencias instaladas, app compilada, secretos. El lanzador de Windows se excluye porque
// cmd.exe lo lee mientras corre (reemplazarlo a media ejecución puede hacerle leer líneas cortadas).
const PROTEGIDO = /^(\.servidor|node_modules|\.git|apps\/web\/dist|\.wrangler)(\/|$)|^(\.env|\.dev-credentials\.txt|Servidor Scan-bar\.cmd)$/;

/** Lee un .tar (formato ustar/pax de GitHub): archivos regulares con su ruta sin la carpeta raíz, y el commit. */
export function leerTar(tar: Buffer): Paquete {
  const archivos: Archivo[] = []; let commit: string | null = null; let rutaPax: string | null = null;
  const texto = (h: Buffer, a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
  const pax = (d: Buffer) => { // registros "<largo> clave=valor\n"
    const r: Record<string, string> = {}; let i = 0;
    while (i < d.length) {
      const esp = d.indexOf(0x20, i); const largo = Number(d.subarray(i, esp).toString());
      if (!largo || esp < 0) break;
      const kv = d.subarray(esp + 1, i + largo - 1).toString('utf8'); const eq = kv.indexOf('=');
      r[kv.slice(0, eq)] = kv.slice(eq + 1); i += largo;
    }
    return r;
  };
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const tam = parseInt(texto(h, 124, 136).trim() || '0', 8);
    const tipo = String.fromCharCode(h[156] || 0x30);
    const datos = tar.subarray(off + 512, off + 512 + tam);
    off += 512 + Math.ceil(tam / 512) * 512;
    if (tipo === 'g') { commit = pax(datos).comment ?? commit; continue; }
    if (tipo === 'x') { rutaPax = pax(datos).path ?? null; continue; }
    if (tipo === 'L') { rutaPax = datos.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const prefijo = texto(h, 345, 500);
    const completa = rutaPax ?? (prefijo ? `${prefijo}/` : '') + texto(h, 0, 100); rutaPax = null;
    if (tipo !== '0') continue; // carpetas, enlaces y demás: no hacen falta
    const ruta = completa.split('/').slice(1).join('/'); // sin "getforgex-bit-Scan-bar-<commit>/"
    archivos.push({ ruta, datos: Buffer.from(datos), ejecutable: (parseInt(texto(h, 100, 108).trim() || '0', 8) & 0o111) !== 0 });
  }
  return { commit, archivos };
}

/** Ruta segura dentro del repositorio (sin "..", absolutas ni unidades de Windows) y fuera de lo protegido. */
export const rutaValida = (r: string) =>
  !!r && !r.startsWith('/') && !r.includes('\\') && !r.includes(':') && !r.split('/').some(p => p === '..' || p === '' || p === '.') && !PROTEGIDO.test(r);

/** Archivos que cambiarían (nuevos o con otro contenido). */
export function cambios(root: string, p: Paquete): Archivo[] {
  return p.archivos.filter(a => rutaValida(a.ruta)).filter(a => {
    const destino = path.join(root, ...a.ruta.split('/'));
    try { return !fs.readFileSync(destino).equals(a.datos); } catch { return true; }
  });
}

/** Escribe los cambios (cada archivo se escribe aparte y se renombra: nunca queda uno a medias). */
export function aplicar(root: string, lista: Archivo[]) {
  for (const a of lista) {
    const destino = path.join(root, ...a.ruta.split('/'));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const tmp = `${destino}.actualizando`;
    fs.writeFileSync(tmp, a.datos, { mode: a.ejecutable ? 0o755 : 0o644 });
    fs.renameSync(tmp, destino);
  }
}

export async function descargar(repo = REPO): Promise<Paquete> {
  const r = await fetch(URL_TAR(repo), { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status} al descargar ${repo}`);
  const p = leerTar(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
  if (!p.archivos.some(a => a.ruta === 'package.json') || !p.archivos.some(a => a.ruta === 'servidor/panel.ts'))
    throw new Error('El archivo descargado no parece ser Scan-bar; no se cambió nada.');
  return p;
}

// Worker de Scan-bar en Cloudflare (plan gratuito): da la dirección fija https://scan-bar.<cuenta>.workers.dev y pasa cada
// petición (PWA, API, resolver /01/…) al servidor que corre en tu PC (panel: npm run servidor). Al encender, el panel abre un
// túnel gratuito de Cloudflare y le dice a este Worker su dirección (POST /__scanbar/origen, firmado con SCANBAR_PROXY_KEY);
// la dirección se guarda en un Durable Object (almacenamiento SQLite, incluido en el plan gratuito).
// Cada petición que se reenvía va firmada con la misma llave: el servidor rechaza lo que no venga de aquí.
import { DurableObject } from 'cloudflare:workers';

interface Env {
  ORIGEN: DurableObjectNamespace<ScanbarOrigin>;
  /** La llave que muestra el panel del servidor (pestaña Datos → Conexión con Cloudflare). */
  SCANBAR_PROXY_KEY?: string;
}

/** Guarda la dirección actual del servidor (la del túnel). Una sola instancia, por nombre. */
export class ScanbarOrigin extends DurableObject<Env> {
  async leer(): Promise<string> { return (await this.ctx.storage.get<string>('origen')) ?? ''; }
  async guardar(origen: string): Promise<void> { await this.ctx.storage.put('origen', origen); }
}

const texto = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const apagado = () => texto('Scan-bar está apagado en este momento: el servidor se enciende desde su panel. Intenta más tarde.', 503, { 'retry-after': '30' });

/** Compara sin filtrar por tiempo cuánto coincide la llave. */
async function mismaLlave(a: string, b: string) {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// La dirección se recuerda unos segundos en la memoria del Worker para no consultar el Durable Object en cada petición.
let cache = { origen: '', hasta: 0 };
const almacen = (env: Env) => env.ORIGEN.get(env.ORIGEN.idFromName('principal'));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const llave = env.SCANBAR_PROXY_KEY;
    if (!llave) return texto('Falta configurar Scan-bar: agrega el secreto SCANBAR_PROXY_KEY a este Worker (la llave aparece en el panel del servidor).', 503);

    // El panel registra (o borra, con "") la dirección del túnel al encender y al apagar.
    if (url.pathname === '/__scanbar/origen') {
      if (!(await mismaLlave(request.headers.get('x-scanbar-proxy') ?? '', llave))) return texto('Llave incorrecta: revisa SCANBAR_PROXY_KEY.', 401);
      if (request.method === 'GET') return Response.json({ origen: await almacen(env).leer() });
      if (request.method !== 'POST') return texto('Método no permitido', 405);
      const { origen } = await request.json<{ origen?: string }>().catch(() => ({ origen: undefined }));
      if (typeof origen !== 'string' || (origen && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origen) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen)))
        return texto('Dirección inválida', 400);
      await almacen(env).guardar(origen);
      cache = { origen, hasta: Date.now() + 15_000 };
      return new Response(null, { status: 204 });
    }

    if (Date.now() > cache.hasta) cache = { origen: await almacen(env).leer(), hasta: Date.now() + 15_000 };
    if (!cache.origen) return apagado();

    const headers = new Headers(request.headers);
    headers.set('x-scanbar-proxy', llave);
    headers.set('x-scanbar-host', url.host);
    headers.set('x-scanbar-ip', request.headers.get('cf-connecting-ip') ?? '');
    try {
      // redirect: 'manual' para que las redirecciones del resolver (302 a la web del negocio) lleguen al navegador tal cual.
      const r = await fetch(cache.origen + url.pathname + url.search, { method: request.method, headers, body: request.body, redirect: 'manual' });
      // El túnel responde 502/530 cuando la PC se apagó sin avisar: se trata como "apagado".
      if (r.status === 530 || r.status === 502) { cache.hasta = 0; return apagado(); }
      return r;
    } catch (e) {
      console.error('El servidor de Scan-bar no respondió', e);
      cache.hasta = 0;
      return apagado();
    }
  },
} satisfies ExportedHandler<Env>;

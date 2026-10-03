// Worker de Scan-bar en Cloudflare: recibe todas las peticiones (PWA, API, resolver /01/…) y las pasa al
// contenedor que ejecuta la app de Node (../Dockerfile). Una sola instancia: las sesiones y los límites de tasa
// son de un solo proceso. Se duerme tras SLEEP_AFTER sin peticiones y despierta en la siguiente (unos segundos).
import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  SCANBAR: DurableObjectNamespace<ScanbarContainer>;
  [name: string]: unknown;
}

/** Variables y secretos que se pasan al proceso de la app (ver README de esta carpeta). */
const PASS = /^(DATABASE_URL|DB_(APP_RW|ADMIN_RO|ADMIN_RW)_PASSWORD|TOTP_ENC_KEY|ADMIN_EMAIL|ADMIN_PASSWORD|CAJA_PASSWORD|RESOLVER_HOST|SYNC_REPOS|SYNC_INTERVAL_MIN|WEB_URL_[A-Z_]+)$/;

export class ScanbarContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '20m';
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = { NODE_ENV: 'production', TRUST_PROXY: '1', PORT: '3000' };
    for (const [k, v] of Object.entries(env)) if (PASS.test(k) && typeof v === 'string' && v) vars[k] = v;
    this.envVars = vars;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // La app confía en estos encabezados (TRUST_PROXY=1): IP real para el límite de tasa y host público para QR y cookies.
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') ?? '');
    try {
      return await getContainer(env.SCANBAR).fetch(new Request(request, { headers }));
    } catch (e) {
      console.error('Scan-bar no respondió', e);
      return new Response('Scan-bar está arrancando; intenta de nuevo en unos segundos.', { status: 503, headers: { 'retry-after': '5', 'content-type': 'text/plain; charset=utf-8' } });
    }
  },
} satisfies ExportedHandler<Env>;

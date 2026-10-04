import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, money, fmtGtin, queueScanEvent, queueSale, flushSales, flushScanEvents, pendingSales, type Me, type Product } from './api';
import { kvGet, kvSet } from './kv';
import { Scanner, type Reading } from './Scanner';
import { Configurator } from './Configurator';
import { MyBuilds } from './MyBuilds';
import { Console } from './Console';
import { Campo } from './Campo';
import { AuthDialog, type AuthMode } from './Auth';
import { CatalogLabels } from './Labels';
import { SHOW_CONFIGURATOR } from './flags';

type Mode = 'nav' | 'caja';
type Tab = 'scan' | 'cfg' | 'mine' | 'cat' | 'con' | 'campo';
type Line = { gtin: string; name: string; priceCents: number; qty: number; kind: string; bom?: { name: string; qty: number; frozenCents: number; currentCents: number }[] };
type Receipt = { id: number; totalCents: number; taxCents: number; items: { gtin: string; name: string; qty: number; unitPriceCents: number }[]; at: string; pending?: boolean };

const isStaff = (me: Me | null) => me?.role === 'superadmin' || me?.role === 'operador_pos';
// Ruta pública del configurador de un negocio: /t/{slug}/configurador
const pathTenant = () => (SHOW_CONFIGURATOR ? /^\/t\/([a-z0-9-]+)\/configurador\/?$/.exec(location.pathname)?.[1] : undefined);

export function App() {
  // La app se usa sin iniciar sesión; undefined = cargando, null = visitante anónimo.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(() => api<Me | { anonymous: true }>('/v1/auth/me').then(r => setMe('anonymous' in r ? null : r)).catch(() => setMe(null)), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { window.addEventListener('admin-locked', refresh); return () => window.removeEventListener('admin-locked', refresh); }, [refresh]);
  if (me === undefined) return <main><p role="status">Cargando…</p></main>;
  return <Shell key={me?.email ?? 'anon'} me={me} refresh={refresh} />;
}

function Shell({ me, refresh }: { me: Me | null; refresh: () => Promise<void> }) {
  const staff = isStaff(me); const admin = me?.role === 'superadmin';
  const [modePref, setModePref] = useState<Mode>('nav');
  const mode: Mode = staff ? modePref : 'nav'; // el modo Caja exige una cuenta de personal
  const [tab, setTab] = useState<Tab>(pathTenant() ? 'cfg' : location.pathname === '/campo' && admin ? 'campo' : 'scan');
  const [auth, setAuth] = useState<{ mode: AuthMode; note?: string } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Line[]>([]);
  const [live, setLive] = useState('');
  const [notice, setNotice] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [external, setExternal] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const cartRef = useRef(cart); cartRef.current = cart;
  const modeRef = useRef(mode); modeRef.current = mode;

  const loadProducts = useCallback(() => (staff ? api<Product[]>('/v1/products').then(setProducts) : Promise.resolve()), [staff]);
  useEffect(() => {
    kvGet<Mode>('mode', 'nav').then(setModePref);
    api<{ domains: string[] }>('/v1/allowed-domains').then(r => setAllowed(r.domains)).catch(() => {});
    if (!staff) return;
    const sync = async () => { await flushSales(); await flushScanEvents(); setPending((await pendingSales()).length); loadProducts().catch(() => {}); };
    sync(); window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [loadProducts, staff]);

  const setMode = async (m: Mode) => {
    if (m === mode) return;
    if (m === 'caja' && !staff) { setAuth({ mode: 'login', note: 'El modo Caja es para el personal del negocio. Entra con una cuenta de operador.' }); return; }
    if (cartRef.current.length > 0) {
      let pin = await kvGet<string>('pin', '');
      if (!pin) { const n = window.prompt('Define un PIN de 4 dígitos para desbloquear el cambio de modo'); if (!n || !/^\d{4}$/.test(n)) return; await kvSet('pin', n); pin = n; }
      else if (window.prompt('PIN para cambiar de modo con un carrito abierto') !== pin) { setNotice('PIN incorrecto'); return; }
    }
    setModePref(m); kvSet('mode', m);
  };

  const addToCart = async (gtin: string) => {
    try {
      const r: any = await api(`/v1/scan/${gtin}`);
      setCart(c => { const i = c.findIndex(l => l.gtin === gtin); return i >= 0 ? c.map((l, k) => k === i ? { ...l, qty: l.qty + 1 } : l) : [...c, { gtin, name: r.name, priceCents: r.priceCents, qty: 1, kind: r.kind, bom: r.bom }]; });
      setLive(`Agregado: ${r.name}, ${money(r.priceCents)}`); setNotice(''); return 'ok';
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setNotice(`⚠ El código ${fmtGtin(gtin)} no pertenece a esta empresa o no existe.`); return 'not_found'; }
      setNotice('⚠ Error al consultar el código'); return 'error';
    }
  };

  const onReading = async (r: Reading) => {
    const m = modeRef.current; const a = r.accepted;
    const log = (e: Record<string, unknown>) => { if (staff) queueScanEvent({ mode: m, engine: r.engine, decodeMs: r.decodeMs, totalMs: r.totalMs, ...e }); };
    if ('external' in a) {
      let host = ''; try { host = new URL(a.external).hostname; } catch { /* no es URL */ }
      log({ result: 'external' });
      if (m === 'nav' && host && allowed.includes(host)) window.location.href = a.external;
      else setExternal(a.external);
      return;
    }
    if (m === 'nav') {
      log({ result: 'resolved', gtin: a.gtin });
      await new Promise(res => setTimeout(res, 50));
      window.location.href = `/01/${a.gtin.padStart(14, '0')}`;
      return;
    }
    log({ result: (await addToCart(a.gtin)) === 'ok' ? 'resolved' : 'not_found', gtin: a.gtin });
  };

  const total = cart.reduce((s, l) => s + l.qty * l.priceCents, 0);
  const tax = Math.round(total * 16 / 116);
  const checkout = async () => {
    const key = crypto.randomUUID(); const items = cart.map(l => ({ gtin: l.gtin, qty: l.qty }));
    try {
      const s = await api<Receipt>('/v1/sales', { method: 'POST', body: { items, paymentMethod: 'efectivo' }, headers: { 'Idempotency-Key': key } });
      setReceipt({ ...s, at: new Date().toLocaleString('es-MX') }); setCart([]); loadProducts();
    } catch (e) {
      if (e instanceof ApiError) { setNotice(e.status === 409 ? `⚠ Sin stock: ${(e.body.detail ?? []).map((d: any) => `${d.name} (hay ${d.stock})`).join(', ')}` : `⚠ ${e.message}`); return; }
      await queueSale({ key, items, paymentMethod: 'efectivo' }); setPending((await pendingSales()).length);
      setReceipt({ id: 0, totalCents: total, taxCents: tax, items: cart.map(l => ({ gtin: l.gtin, name: l.name, qty: l.qty, unitPriceCents: l.priceCents })), at: new Date().toLocaleString('es-MX'), pending: true }); setCart([]);
    }
  };
  const logout = async () => { await api('/v1/auth/logout', { method: 'POST' }); await refresh(); };

  const tabs: [Tab, string, boolean][] = [['scan', 'Escáner', true], ['cfg', 'Configurador', SHOW_CONFIGURATOR], ['mine', 'Mis configuraciones', SHOW_CONFIGURATOR && !!me], ['cat', 'Catálogo y etiquetas', staff], ['con', 'Administración', !!admin], ['campo', 'Campo', !!admin]];

  return (
    <>
      <header className="top">
        <div><span className="label">{me?.tenant?.name ?? 'Sistema universal de códigos'}</span><h1 className="serif">Scan-bar</h1></div>
        {/* Visitantes: solo el escáner. El personal elige modo (Navegación / Caja) y ve sus secciones. */}
        {staff && <div role="radiogroup" aria-label="Modo del lector" className="modes">
          {(['nav', 'caja'] as Mode[]).map(m => <button key={m} role="radio" aria-checked={mode === m} className={'mode' + (mode === m ? ' active' : '')} onClick={() => setMode(m)}>{m === 'nav' ? 'Navegación' : 'Caja'}</button>)}
        </div>}
        {tabs.filter(t => t[2]).length > 1 && <nav className="row gap" aria-label="Secciones">
          {tabs.filter(t => t[2]).map(([k, l]) => <button key={k} className={'link' + (tab === k ? ' active' : '')} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{l}</button>)}
        </nav>}
        <div className="row gap account">
          {me ? <><span className="label" title={me.role}>{me.email}</span><button className="link" onClick={logout}>Salir</button></>
            : <><button className="link" onClick={() => setAuth({ mode: 'login' })}>Entrar</button>{SHOW_CONFIGURATOR && <button className="secondary" onClick={() => setAuth({ mode: 'register' })}>Registrarse</button>}</>}
        </div>
      </header>
      <main>
        <div className="sr" aria-live="polite">{live}</div>
        {pending > 0 && <p className="notice">⏳ {pending} venta(s) pendientes de sincronizar</p>}
        {tab === 'scan' && (
          <div className={'grid ' + (mode === 'caja' ? 'pos' : '')}>
            <div>
              <h2>{mode === 'caja' ? 'Cobrar' : 'Escanea un código'}</h2>
              {mode === 'nav' && <p className="label">Apunta la cámara al código de barras o al QR de un producto para abrir su página. No necesitas cuenta; si la cámara no funciona, escribe los 13 dígitos.</p>}
              <Scanner onReading={onReading} paused={!!external} />
              {external && <div className="notice" role="alertdialog" aria-label="QR externo"><p>QR con dominio no registrado:</p><p className="mono wrap">{external}</p><div className="row gap"><button className="secondary" onClick={() => { window.open(external, '_blank', 'noopener'); setExternal(null); }}>Abrir de todos modos</button><button className="link" onClick={() => setExternal(null)}>Descartar</button></div></div>}
              {notice && <p className="err" role="alert">{notice}</p>}
            </div>
            {mode === 'caja' && (
              <aside className="cart">
                <h2>Compra</h2>
                {cart.length === 0 ? <p className="label">Escanea un producto o un artículo configurado.</p> : (
                  <table><tbody>
                    {cart.map(l => (
                      <tr key={l.gtin}><td>
                        {l.kind === 'build' ? <details><summary>{l.name}</summary><ul className="parts">{l.bom!.map((b, i) => <li key={i}>{b.name} × {b.qty} <span className="mono">{money(b.frozenCents)}</span>{b.currentCents !== b.frozenCents && <span className="label"> (hoy {money(b.currentCents)})</span>}</li>)}</ul></details> : l.name}
                        <div className="row gap"><button className="step" aria-label="Menos" onClick={() => setCart(c => c.flatMap(x => x.gtin === l.gtin ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x]))}>−</button><span className="mono">{l.qty}</span><button className="step" aria-label="Más" onClick={() => setCart(c => c.map(x => x.gtin === l.gtin ? { ...x, qty: x.qty + 1 } : x))}>+</button></div>
                      </td><td className="num mono">{money(l.qty * l.priceCents)}</td></tr>
                    ))}
                  </tbody></table>
                )}
                <p className="mono num">Subtotal {money(total - tax)}<br />IVA 16 % {money(tax)}<br /><b>Total {money(total)}</b></p>
                <button disabled={!cart.length} onClick={checkout}>Cobrar</button>
              </aside>
            )}
          </div>
        )}
        {tab === 'cfg' && SHOW_CONFIGURATOR && <Configurator me={me} initialTenant={pathTenant()} onNeedAccount={() => setAuth({ mode: 'register', note: 'Con una cuenta, tus configuraciones quedan guardadas.' })} />}
        {tab === 'mine' && me && <MyBuilds />}
        {tab === 'con' && admin && me && <Console me={me} refresh={refresh} />}
        {tab === 'campo' && admin && <Campo />}
        {tab === 'cat' && staff && (
          <section className="stack"><h2>Catálogo y etiquetas</h2>
            {me && <CatalogLabels me={me} />}
            {me?.tenant && <h3>Productos de {me.tenant.name}</h3>}
            <table><thead><tr><th className="label">Producto</th><th className="label">Categoría</th><th className="label">GTIN</th><th className="label num">Stock</th><th className="label num">Precio</th></tr></thead>
              <tbody>{products.map(p => <tr key={p.id}><td>{p.name}<small className="label"> {p.sku}</small></td><td className="label">{p.category}</td><td className="mono">{fmtGtin(p.gtin)}</td><td className="num mono">{p.stock}</td><td className="num mono">{money(p.priceCents)}</td></tr>)}</tbody></table>
          </section>
        )}
        <footer className="label version">Versión del {new Date(__BUILD__).toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}</footer>
      </main>
      {auth && <AuthDialog mode={auth.mode} note={auth.note} onClose={() => setAuth(null)} onSwitch={m => setAuth({ mode: m })} onDone={async () => { setAuth(null); await refresh(); }} />}
      {receipt && (
        <dialog open className="receipt-dlg" aria-label="Ticket">
          <article className="ticket">
            <h2 className="mono">{me?.tenant?.name}</h2>
            <p className="mono">{receipt.at}{receipt.pending ? ' · SIN RED (pendiente)' : ` · Venta #${receipt.id}`}</p>
            {receipt.items.map((i, k) => <p className="mono tl" key={k}><span>{i.qty} × {i.name}</span><span>{money(i.qty * i.unitPriceCents)}</span></p>)}
            <hr />
            <p className="mono tl"><span>Subtotal</span><span>{money(receipt.totalCents - receipt.taxCents)}</span></p>
            <p className="mono tl"><span>IVA 16 %</span><span>{money(receipt.taxCents)}</span></p>
            <p className="mono tl"><b>TOTAL</b><b>{money(receipt.totalCents)}</b></p>
          </article>
          <div className="row gap noprint"><button onClick={() => window.print()}>Imprimir ticket</button><button className="secondary" onClick={() => setReceipt(null)}>Cerrar</button></div>
        </dialog>
      )}
    </>
  );
}

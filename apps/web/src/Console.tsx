import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, money, fmtGtin, type Me, type Product } from './api';
import { SHOW_CONFIGURATOR } from './flags';
import { LabelsPdf } from './Labels';

type Section = 'tenants' | 'cfgs' | 'products' | 'acceso' | 'users' | 'keys' | 'db' | 'req' | 'metrics' | 'live';
// Primero lo de todos los días (productos, etiquetas, sincronizar); después lo técnico.
const SECTIONS: [Section, string][] = [['products', 'Productos y etiquetas'], ['acceso', 'Acceso con QR'], ['tenants', 'Negocios'], ['users', 'Usuarios'], ['metrics', 'Métricas'], ['live', 'En vivo'],
  ...(SHOW_CONFIGURATOR ? [['cfgs', 'Configuradores'] as [Section, string]] : []), ['keys', 'Llaves'], ['db', 'Base de datos'], ['req', 'Depurador']];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Error de red');

/** Funciones de administrador: piden la contraseña (15 min de vigencia, se renueva con el uso) y exigen segundo factor. */
export function Console({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const [sec, setSec] = useState<Section>('products');
  if (!me.adminUnlocked) return <Unlock onDone={refresh} />;
  if (!me.totp) return <TotpSetup onDone={refresh} />;
  return (
    <div className="grid console">
      <nav aria-label="Secciones de administración" className="sidenav">
        {SECTIONS.map(([k, l]) => <button key={k} className={'link' + (sec === k ? ' active' : '')} aria-current={sec === k ? 'page' : undefined} onClick={() => setSec(k)}>{l}</button>)}
        <button className="link" onClick={async () => { await api('/v1/auth/admin-lock', { method: 'POST' }); await refresh(); }}>Bloquear ahora</button>
      </nav>
      <section>
        {sec === 'tenants' && <Tenants />}{sec === 'cfgs' && <Configurators />}{sec === 'products' && <Products />}{sec === 'acceso' && <AccessCards />}
        {sec === 'users' && <Users />}{sec === 'keys' && <Keys />}
        {sec === 'db' && <DbViewer />}{sec === 'req' && <Requests />}{sec === 'metrics' && <Metrics />}{sec === 'live' && <Live />}
      </section>
    </div>
  );
}

function Unlock({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/v1/auth/admin-unlock', { method: 'POST', body: { password: pw } }); onDone(); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <form className="notice narrow stack" onSubmit={submit}>
      <h2>Funciones de administrador</h2>
      <p>Confirma tu contraseña para continuar. El acceso se bloquea solo tras 15 minutos sin uso.</p>
      <label className="label" htmlFor="ul">Contraseña de administrador</label>
      <input id="ul" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
      {err && <p className="err" role="alert">⚠ {err}</p>}
      <button type="submit" disabled={busy || !pw}>Desbloquear</button>
    </form>
  );
}

const TEMPLATE = {
  itemLabel: 'Pedido',
  groups: [
    { category: 'base', label: 'Base', min: 1, max: 1 },
    { category: 'extra', label: 'Extras', min: 0, max: 3, maxQty: 2, hint: 'Opcional' },
  ],
  rules: [],
};

function Configurators() {
  const { data, err, reload } = useLoad<any[]>('/v1/admin/configurators'); const tenants = useLoad<any[]>('/v1/admin/tenants');
  const [edit, setEdit] = useState<any>(null); const [json, setJson] = useState(''); const [note, setNote] = useState(''); const [problems, setProblems] = useState<string[]>([]);
  const start = (c: any) => { setEdit(c); setJson(JSON.stringify(c.definition, null, 2)); setNote(''); setProblems([]); };
  const save = async () => {
    setProblems([]); setNote('');
    let definition: unknown;
    try { definition = JSON.parse(json); } catch (e: any) { setProblems(['El JSON no es válido: ' + e.message]); return; }
    try {
      if (edit.id) await api(`/v1/admin/configurators/${edit.id}`, { method: 'PATCH', body: { name: edit.name, description: edit.description, active: edit.active, definition } });
      else await api('/v1/admin/configurators', { method: 'POST', body: { tenantId: Number(edit.tenant_id), slug: edit.slug, name: edit.name, description: edit.description, definition } });
      setEdit(null); setNote('Guardado. Los clientes ya ven el cambio.'); reload();
    } catch (e) {
      const b = e instanceof ApiError ? e.body : null;
      setProblems(Array.isArray(b?.detail) ? b.detail : Array.isArray(b?.issues) ? b.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`) : [msg(e)]);
    }
  };
  return (<>
    <h2>Configuradores</h2>
    <p className="label">Un configurador define qué elige el cliente (grupos = categorías del catálogo) y qué combinaciones son válidas (reglas). Son datos: se cambian aquí, sin desplegar.</p>
    {err && <p className="err">⚠ {err}</p>}{note && <p className="label" role="status">{note}</p>}
    <table><thead><tr><th className="label">Negocio</th><th className="label">Configurador</th><th className="label">Grupos</th><th className="label">Estado</th><th><span className="sr">Acciones</span></th></tr></thead>
      <tbody>{data?.map(c => <tr key={c.id}><td>{c.tenant_name}</td><td>{c.name}<small className="label"> {c.slug}</small></td><td className="label">{c.definition.groups.map((g: any) => g.label).join(', ')}</td><td>{c.active ? 'activo' : 'inactivo'}</td>
        <td><button className="secondary" onClick={() => start(c)}>Editar</button></td></tr>)}</tbody></table>
    {!edit && <button onClick={() => start({ tenant_id: tenants.data?.[0]?.id ?? 1, slug: '', name: '', description: '', active: true, definition: TEMPLATE })}>Nuevo configurador</button>}
    {edit && <div className="notice stack">
      <h3>{edit.id ? `Editar ${edit.name}` : 'Nuevo configurador'}</h3>
      {!edit.id && <>
        <label className="label" htmlFor="cf-t">Negocio</label>
        <select id="cf-t" value={edit.tenant_id} onChange={e => setEdit({ ...edit, tenant_id: e.target.value })}>{tenants.data?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <label className="label" htmlFor="cf-s">Identificador (minúsculas y guiones)</label><input id="cf-s" className="mono" value={edit.slug} onChange={e => setEdit({ ...edit, slug: e.target.value })} /></>}
      <label className="label" htmlFor="cf-n">Nombre</label><input id="cf-n" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} />
      <label className="label" htmlFor="cf-d">Descripción</label><input id="cf-d" value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} />
      {edit.id && <label className="row gap"><input type="checkbox" className="check" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> Activo (visible para los clientes)</label>}
      <label className="label" htmlFor="cf-j">Definición (JSON)</label>
      <textarea id="cf-j" className="mono" rows={18} spellCheck={false} value={json} onChange={e => setJson(e.target.value)} />
      <details><summary>Cómo se escribe</summary>
        <ul className="help">
          <li><b>groups</b>: <span className="mono">category</span> es la categoría de los productos que se ofrecen; <span className="mono">min</span>/<span className="mono">max</span> cuántas opciones distintas; <span className="mono">maxQty</span> cuántas unidades de cada una.</li>
          <li><b>equals</b>: <span className="mono">a</span> y <span className="mono">b</span> deben tener el mismo atributo (socket del CPU = socket de la placa).</li>
          <li><b>in</b>: el atributo de <span className="mono">a</span> debe estar en la lista de <span className="mono">b</span> (tamaño ∈ tamaños de la bebida).</li>
          <li><b>sum_lte</b>: la suma de <span className="mono">attr</span> × <span className="mono">factor</span> no puede pasar del atributo <span className="mono">limit</span> (consumo ≤ potencia).</li>
          <li><b>forbid</b> / <b>require</b>: si alguna opción cumple <span className="mono">when</span>, el grupo queda prohibido u obligatorio (el americano no lleva leche).</li>
        </ul></details>
      {problems.length > 0 && <ul className="err" role="alert">{problems.map(p => <li key={p}>⚠ {p}</li>)}</ul>}
      <div className="row gap"><button onClick={save}>Validar y guardar</button><button className="secondary" onClick={() => setEdit(null)}>Cancelar</button></div>
    </div>}
  </>);
}

type AdminProduct = Product & { tenantId: number; active: boolean; origin: 'repo' | 'scanbar'; description: string; imageUrl: string | null; variantOf: string | null; variant: string | null };
const ORIGIN_LABEL = { repo: 'código de la web', scanbar: 'Scan-bar' } as const;

/** SKU sugerido a partir del nombre: "Vestido rojo de lino" → VESTIDO-ROJO-DE-LINO (se puede cambiar en Opciones avanzadas). */
const skuFrom = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');

/** "CH, M, G" o "Chico=45, Grande=55" (precio en pesos) → variantes. */
function parseVariants(text: string): { label: string; priceCents?: number }[] {
  return text.split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const [label, price] = x.split('=').map(y => y.trim());
    const cents = price ? Math.round(Number(price) * 100) : undefined;
    if (price && !Number.isFinite(cents)) throw new Error(`Precio inválido en la variante "${label}"`);
    return cents === undefined ? { label } : { label, priceCents: cents };
  });
}

/** Productos de cualquier página web: lo que se agrega aquí aparece en la web del negocio y recibe su código al instante. */
function Products() {
  const tenants = useLoad<any[]>('/v1/admin/tenants');
  const [tenantId, setTenantId] = useState(0);
  const tid = tenantId || tenants.data?.[0]?.id || 0;
  const tenant = tenants.data?.find(t => t.id === tid);
  const [data, setData] = useState<AdminProduct[] | null>(null); const [err, setErr] = useState('');
  const reload = useCallback(() => { if (tid) api<AdminProduct[]>(`/v1/admin/products?tenantId=${tid}`).then(setData).catch(e => setErr(msg(e))); }, [tid]);
  useEffect(() => { setData(null); reload(); }, [reload]);
  const empty = { sku: '', skuTouched: false, name: '', category: '', price: '', stock: '10', description: '', imageUrl: '', variants: '', attrs: '{}' };
  const [f, setF] = useState(empty); const [note, setNote] = useState(''); const [edit, setEdit] = useState<AdminProduct | null>(null);
  const cats = [...new Set(data?.map(p => p.category) ?? [])];
  const add = async () => {
    setNote('');
    let attrs: unknown, variants: { label: string; priceCents?: number }[];
    try { attrs = JSON.parse(f.attrs || '{}'); } catch { setNote('⚠ Los atributos deben ser JSON, por ejemplo {"color": "rojo"}'); return; }
    try { variants = parseVariants(f.variants); } catch (e: any) { setNote('⚠ ' + e.message); return; }
    const priceCents = Math.round(Number(f.price) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) { setNote('⚠ Precio inválido'); return; }
    try {
      const r = await api<{ created: { sku: string; gtin: string }[] }>('/v1/admin/products', { method: 'POST', body: { tenantId: tid, sku: f.sku, name: f.name, category: f.category, priceCents, stock: Number(f.stock) || 0, description: f.description, imageUrl: f.imageUrl || null, attrs, variants } });
      setNote(`Agregado a ${tenant?.name}: ${r.created.map(c => `${c.sku} → ${fmtGtin(c.gtin)}`).join(' · ')}`); setF({ ...empty, category: f.category }); reload();
    } catch (e) { setNote('⚠ ' + msg(e)); }
  };
  const patch = async (p: AdminProduct, body: Record<string, unknown>) => {
    try { await api(`/v1/admin/products/${p.id}`, { method: 'PATCH', body }); setEdit(null); setNote(`Guardado: ${p.name}`); reload(); } catch (e) { setNote('⚠ ' + msg(e)); }
  };
  return (<>
    <h2>Productos y etiquetas</h2>
    <div className="formrow">
      <label className="label" htmlFor="pr-t">Página web / negocio</label>
      <select id="pr-t" value={tid} onChange={e => { setTenantId(Number(e.target.value)); setEdit(null); setNote(''); }}>{tenants.data?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
    </div>
    {err && <p className="err">⚠ {err}</p>}
    {tenant && <LabelsPdf url={`/v1/admin/tenants/${tenant.id}/labels.pdf`} slug={tenant.slug} name={tenant.name} categories={cats} />}
    <p className="label">Lo que agregas aquí aparece en la página web del negocio y recibe su código EAN-13/QR al instante. Lo que viene del código de la web llega solo desde su repositorio; aquí solo se ajustan sus existencias.</p>
    <SyncPanel onDone={reload} />
    <h3>Agregar producto a {tenant?.name}</h3>
    <div className="fields">
      <label className="field"><span className="label">Nombre</span><input value={f.name} onChange={e => setF({ ...f, name: e.target.value, sku: f.skuTouched ? f.sku : skuFrom(e.target.value) })} /></label>
      <label className="field"><span className="label">Categoría (sección de la web)</span><input list="cats" value={f.category} onChange={e => setF({ ...f, category: e.target.value })} /></label>
      <datalist id="cats">{cats.map(c => <option key={c} value={c} />)}</datalist>
      <label className="field"><span className="label">Precio en pesos (IVA incluido)</span><input inputMode="decimal" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></label>
      <label className="field"><span className="label">Existencias</span><input inputMode="numeric" value={f.stock} onChange={e => setF({ ...f, stock: e.target.value.replace(/\D/g, '') })} /></label>
      <label className="field"><span className="label">Variantes (opcional)</span><input placeholder="CH, M, G  ·  o  Chico=45, Grande=55" value={f.variants} onChange={e => setF({ ...f, variants: e.target.value })} aria-describedby="pr-var-help" /></label>
      <label className="field"><span className="label">Imagen (opcional)</span><input type="url" placeholder="https://…" className="mono" value={f.imageUrl} onChange={e => setF({ ...f, imageUrl: e.target.value })} /></label>
    </div>
    <p className="label" id="pr-var-help">Cada variante (talla, tamaño, gramaje) recibe su propio código. Con precio (Chico=45) cambia el precio de esa variante.</p>
    <details><summary>Opciones avanzadas</summary>
      <div className="fields">
        <label className="field"><span className="label">SKU (se genera del nombre)</span><input className="mono" value={f.sku} onChange={e => setF({ ...f, sku: e.target.value.toUpperCase(), skuTouched: true })} /></label>
        <label className="field"><span className="label">Descripción corta</span><input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
        <label className="field"><span className="label">Atributos en JSON</span><input className="mono" placeholder='{"color": "rojo"}' value={f.attrs} onChange={e => setF({ ...f, attrs: e.target.value })} /></label>
      </div>
    </details>
    <button onClick={add} disabled={!tid || !f.sku || !f.name || !f.category || f.price === ''}>Agregar y generar código</button>
    {note && <p className={note.startsWith('⚠') ? 'err' : 'label'} role="status">{note}</p>}
    {edit && <div className="notice stack">
      <h3>Editar {edit.sku}</h3>
      {edit.origin === 'scanbar' && <>
        <label className="label" htmlFor="pe-n">Nombre</label><input id="pe-n" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} />
        <label className="label" htmlFor="pe-p">Precio en pesos</label><input id="pe-p" inputMode="decimal" value={edit.priceCents / 100} onChange={e => setEdit({ ...edit, priceCents: Math.round(Number(e.target.value) * 100) })} />
        <label className="label" htmlFor="pe-d">Descripción</label><input id="pe-d" value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} />
        <label className="label" htmlFor="pe-i">Imagen</label><input id="pe-i" className="mono" value={edit.imageUrl ?? ''} onChange={e => setEdit({ ...edit, imageUrl: e.target.value })} /></>}
      <label className="label" htmlFor="pe-s">Existencias</label><input id="pe-s" inputMode="numeric" value={edit.stock} onChange={e => setEdit({ ...edit, stock: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
      <div className="row gap">
        <button onClick={() => patch(edit, edit.origin === 'scanbar' ? { name: edit.name, priceCents: edit.priceCents, description: edit.description, imageUrl: edit.imageUrl || null, stock: edit.stock } : { stock: edit.stock })}>Guardar</button>
        <button className="secondary" onClick={() => setEdit(null)}>Cancelar</button></div>
    </div>}
    <table><thead><tr><th className="label">Producto</th><th className="label">Categoría</th><th className="label">Origen</th><th className="label">Código</th><th className="label num">Stock</th><th className="label num">Precio</th><th><span className="sr">Acciones</span></th></tr></thead>
      <tbody>{data?.map(p => <tr key={p.id} className={p.active ? '' : 'off'}>
        <td>{p.name}<small className="label"> {p.sku}{p.active ? '' : ' · retirado'}</small></td><td className="label">{p.category}</td>
        <td><span className={'pill ' + (p.origin === 'scanbar' ? 'ok' : 'degraded')}>{ORIGIN_LABEL[p.origin]}</span></td>
        <td className="mono">{p.gtin ? fmtGtin(p.gtin) : '—'}</td><td className="num mono">{p.stock}</td><td className="num mono">{money(p.priceCents)}</td>
        <td className="row gap">
          <button className="secondary" onClick={() => setEdit({ ...p })}>{p.origin === 'scanbar' ? 'Editar' : 'Existencias'}</button>
          {p.origin === 'scanbar' && <button className="secondary" onClick={() => patch(p, { active: !p.active })}>{p.active ? 'Retirar' : 'Reactivar'}</button>}
        </td></tr>)}</tbody></table>
    {data && data.length === 0 && <p className="label">Este negocio aún no tiene productos.</p>}
  </>);
}

type AccessRow = { tenantId: number; slug: string; name: string; caja: string | null; card: { createdAt: string; lastUsedAt: string | null; uses: number } | null };
const fecha = (iso: string) => new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

/** Tarjetas de acceso: un QR impreso por negocio para entrar como su caja sin contraseña (escáner de la PWA o cámara). */
function AccessCards() {
  const { data, err, reload } = useLoad<AccessRow[]>('/v1/admin/access-cards');
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const emitir = async (rows: AccessRow[]) => {
    const activas = rows.filter(r => r.card).length;
    if (activas && !confirm(`${activas === 1 ? 'La tarjeta actual dejará' : `Las ${activas} tarjetas actuales dejarán`} de servir. ¿Generar ${rows.length === 1 ? 'una nueva' : 'nuevas'}?`)) return;
    setBusy(true); setNote('');
    try {
      const res = await fetch('/v1/admin/access-cards', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'pwa', 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantIds: rows.map(r => r.tenantId) }) });
      if (!res.ok) { const body = await res.json().catch(() => null); if (res.status === 403 && body?.error === 'admin_locked') window.dispatchEvent(new Event('admin-locked')); throw new ApiError(res.status, body); }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = href; a.download = `tarjetas-acceso${rows.length === 1 ? '-' + rows[0].slug : ''}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      const sin = decodeURIComponent(res.headers.get('X-Sin-Caja') ?? '');
      setNote(`PDF listo: imprime, recorta y entrega cada tarjeta a su negocio.${sin ? ` Sin cuenta de caja (no se generó): ${sin}.` : ''}`); reload();
    } catch (e) { setNote('⚠ ' + msg(e)); } finally { setBusy(false); }
  };
  const desactivar = async (r: AccessRow) => {
    if (!confirm(`¿Desactivar la tarjeta de ${r.name}? Nadie podrá entrar con ella.`)) return;
    try { await api(`/v1/admin/access-cards/${r.tenantId}/revoke`, { method: 'POST' }); setNote(`Tarjeta de ${r.name} desactivada.`); reload(); } catch (e) { setNote('⚠ ' + msg(e)); }
  };
  const conCaja = data?.filter(r => r.caja) ?? [];
  return (<>
    <h2>Acceso con QR</h2>
    <p className="label">Cada negocio recibe una tarjeta impresa con un QR. Al escanearla en Scan-bar (o con la cámara del teléfono) se entra como su caja, sin contraseña. Quien tenga la tarjeta puede cobrar en ese negocio; si se pierde, genera otra y la anterior deja de servir. Nunca da acceso de administrador.</p>
    <button onClick={() => emitir(conCaja)} disabled={busy || !conCaja.length}>{busy ? 'Generando…' : 'Generar tarjetas de todos los negocios (PDF)'}</button>
    {err && <p className="err">⚠ {err}</p>}{note && <p className={note.startsWith('⚠') ? 'err' : 'label'} role="status">{note}</p>}
    <table><thead><tr><th className="label">Negocio</th><th className="label">Entra como</th><th className="label">Tarjeta</th><th><span className="sr">Acciones</span></th></tr></thead>
      <tbody>{data?.map(r => <tr key={r.tenantId}>
        <td>{r.name}</td><td className="mono">{r.caja ?? <span className="label">Sin cuenta de caja</span>}</td>
        <td>{r.card ? <><span className="pill ok">Activa</span> <span className="label">desde {fecha(r.card.createdAt)} · {r.card.uses} uso{r.card.uses === 1 ? '' : 's'}{r.card.lastUsedAt ? ` · último ${fecha(r.card.lastUsedAt)}` : ''}</span></> : <span className="label">Sin tarjeta</span>}</td>
        <td className="row gap">{r.caja && <button className="secondary" disabled={busy} onClick={() => emitir([r])}>{r.card ? 'Generar otra' : 'Generar tarjeta'}</button>}
          {r.card && <button className="secondary" onClick={() => desactivar(r)}>Desactivar</button>}</td>
      </tr>)}</tbody></table>
  </>);
}

type SyncResult = { slug: string; items: number; created: number; updated: number; retired: number; reactivated: number; skipped: number; error?: string };
type SyncState = { running: boolean; last?: { at: string; results: SyncResult[] } };
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'hace un momento' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };

/** Los productos definidos en el código de cada web llegan solos (al arrancar y cada pocos minutos); aquí se ve cuándo y se puede forzar. */
function SyncPanel({ onDone }: { onDone: () => void }) {
  const [st, setSt] = useState<SyncState | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api<SyncState>('/v1/admin/sync').then(setSt).catch(e => setErr(msg(e))); }, []);
  const run = async () => {
    setBusy(true); setErr('');
    try { setSt(await api<SyncState>('/v1/admin/sync', { method: 'POST' })); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const results = st?.last?.results ?? [];
  const failed = results.filter(r => r.error);
  return (
    <div className="notice stack">
      <div className="row between wrapbtns gap">
        <p role="status">{busy || st?.running ? 'Sincronizando los catálogos de las webs…' : st?.last ? `Catálogos de las webs sincronizados ${ago(st.last.at)}: ${results.reduce((n, r) => n + r.items, 0)} productos${failed.length ? `, ${failed.length} con error` : ''}.` : 'Los catálogos de las webs aún no se han sincronizado en este arranque.'}</p>
        <button className="secondary" onClick={run} disabled={busy}>{busy ? 'Sincronizando…' : 'Sincronizar ahora'}</button>
      </div>
      {results.length > 0 && <details><summary>Detalle por web</summary>
        <ul className="help">{results.map(r => <li key={r.slug}><b>{r.slug}</b>: {r.error ? <span className="err">⚠ {r.error}</span> : `${r.items} productos · ${r.created} nuevos · ${r.updated} actualizados · ${r.retired} retirados`}</li>)}</ul>
      </details>}
      {err && <p className="err" role="alert">⚠ {err}</p>}
    </div>
  );
}


function TotpSetup({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [recovery, setRecovery] = useState<string[] | null>(null);
  if (recovery) return (
    <div className="notice"><h2>Códigos de recuperación</h2><p>Guárdalos ahora: no se vuelven a mostrar y cada uno sirve una sola vez.</p>
      <ul className="mono">{recovery.map(c => <li key={c}>{c}</li>)}</ul><button onClick={onDone}>Ya los guardé</button></div>);
  return (
    <div className="notice narrow">
      <h2>Activa el segundo factor</h2>
      <p>Las funciones de administrador exigen un segundo factor (app de autenticación) además de la contraseña.</p>
      {!s ? <button onClick={async () => { try { setS(await api('/v1/auth/totp/setup', { method: 'POST' })); } catch (e) { setErr(msg(e)); } }}>Generar código QR</button> : <>
        <div className="qr" dangerouslySetInnerHTML={{ __html: s.qr }} />
        <p className="label">O ingresa la clave a mano</p><p className="mono wrap">{s.secret}</p>
        <label className="label" htmlFor="tc">Código de 6 dígitos</label>
        <div className="row gap"><input id="tc" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} className="mono" />
          <button disabled={code.length !== 6} onClick={async () => { try { const r = await api<{ recoveryCodes: string[] }>('/v1/auth/totp/verify', { method: 'POST', body: { code } }); setRecovery(r.recoveryCodes); } catch (e) { setErr(msg(e)); } }}>Activar</button></div></>}
      {err && <p className="err" role="alert">⚠ {err}</p>}
    </div>);
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null); const [err, setErr] = useState('');
  const reload = useCallback(() => api<T>(path).then(setData).catch(e => setErr(msg(e))), [path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, err, reload };
}

function Tenants() {
  const { data, err, reload } = useLoad<any[]>('/v1/admin/tenants');
  const [edit, setEdit] = useState<any>(null); const [note, setNote] = useState('');
  const save = async () => {
    try { await api(`/v1/admin/tenants/${edit.id}`, { method: 'PATCH', body: { name: edit.name, productUrlTpl: edit.product_url_tpl, buildUrlTpl: edit.build_url_tpl || null, allowedDomains: edit.allowed_domains } }); setEdit(null); setNote('Guardado'); reload(); }
    catch (e) { setNote('⚠ ' + msg(e)); }
  };
  return (<>
    <h2>Negocios</h2>{err && <p className="err">⚠ {err}</p>}{note && <p className="label" role="status">{note}</p>}
    <table><thead><tr><th className="label">Prefijo</th><th className="label">Nombre</th><th className="label">Plantilla de producto</th><th className="label">Enlace</th><th><span className="sr">Acciones</span></th></tr></thead>
      <tbody>{data?.map(t => (<tr key={t.id}><td className="mono">{t.gs1_prefix}{t.company_prefix}</td><td>{t.name}</td><td className="mono wrap">{t.product_url_tpl}</td>
        <td><span className={'pill ' + t.link_status}>{t.link_status}</span></td>
        <td className="row gap"><button className="secondary" onClick={() => setEdit({ ...t })}>Editar</button>
          <button className="secondary" onClick={async () => { try { const r = await api<any>(`/v1/tenants/${t.id}/check-link`, { method: 'POST' }); setNote(`${t.slug}: ${r.status}`); reload(); } catch (e) { setNote('⚠ ' + msg(e)); } }}>Probar enlace</button></td></tr>))}</tbody></table>
    {edit && <div className="notice"><h3>Editar {edit.slug}</h3>
      <label className="label" htmlFor="tn">Nombre</label><input id="tn" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} />
      <label className="label" htmlFor="tp">Plantilla de producto ({'{sku}'})</label><input id="tp" className="mono" value={edit.product_url_tpl} onChange={e => setEdit({ ...edit, product_url_tpl: e.target.value })} />
      <label className="label" htmlFor="tb">Plantilla de ensamble ({'{gtin}'})</label><input id="tb" className="mono" value={edit.build_url_tpl ?? ''} onChange={e => setEdit({ ...edit, build_url_tpl: e.target.value })} />
      <label className="label" htmlFor="td">Dominios permitidos (coma)</label><input id="td" className="mono" value={edit.allowed_domains.join(',')} onChange={e => setEdit({ ...edit, allowed_domains: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
      <p className="label">Vista previa: <span className="mono">{edit.product_url_tpl.replace('{sku}', 'CPU-A5-7600')}</span></p>
      <div className="row gap"><button onClick={save}>Guardar</button><button className="secondary" onClick={() => setEdit(null)}>Cancelar</button></div></div>}
  </>);
}

function Users() {
  const { data, err, reload } = useLoad<any[]>('/v1/admin/users'); const [f, setF] = useState({ email: '', password: '', tenantId: 1, role: 'operador_pos' }); const [note, setNote] = useState('');
  return (<>
    <h2>Usuarios y membresías</h2>{err && <p className="err">⚠ {err}</p>}
    <table><thead><tr><th className="label">Correo</th><th className="label">Empresa</th><th className="label">Rol</th><th className="label">2FA</th></tr></thead>
      <tbody>{data?.map((u, i) => <tr key={i}><td>{u.email}</td><td className="mono">{u.tenant_id}</td><td>{u.role}</td><td>{u.totp_enabled ? '✓' : '—'}</td></tr>)}</tbody></table>
    <h3>Nuevo usuario o membresía</h3>
    <div className="formrow">
      <input aria-label="Correo" placeholder="correo" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />
      <input aria-label="Contraseña (mínimo 12)" type="password" placeholder="contraseña (≥ 12)" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />
      <input aria-label="ID de empresa" type="number" value={f.tenantId} onChange={e => setF({ ...f, tenantId: Number(e.target.value) })} />
      <select aria-label="Rol" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="operador_pos">operador_pos</option><option value="superadmin">superadmin</option></select>
      <button onClick={async () => { try { await api('/v1/admin/users', { method: 'POST', body: f }); setNote('Creado'); setF({ ...f, email: '', password: '' }); reload(); } catch (e) { setNote('⚠ ' + msg(e)); } }}>Crear</button></div>
    {note && <p className="label" role="status">{note}</p>}
  </>);
}

function Keys() {
  const { data, reload } = useLoad<any[]>('/v1/admin/keys'); const [tenantId, setTenantId] = useState(1); const [shown, setShown] = useState<any>(null); const [note, setNote] = useState('');
  return (<>
    <h2>Llaves de integración</h2>
    <p className="label">Alcance: builds:create y catalog:read. Para rotar: crea una nueva, actualiza la web del equipo y desactiva la anterior.</p>
    <div className="row gap"><input aria-label="ID de empresa" type="number" value={tenantId} onChange={e => setTenantId(Number(e.target.value))} style={{ width: 100 }} />
      <button onClick={async () => { try { setShown(await api('/v1/admin/keys', { method: 'POST', body: { tenantId } })); reload(); } catch (e) { setNote('⚠ ' + msg(e)); } }}>Crear llave</button></div>
    {shown && <div className="notice" role="alert"><p>Copia la llave ahora; no se volverá a mostrar:</p><p className="mono wrap">{shown.key}</p><button className="secondary" onClick={() => setShown(null)}>Listo</button></div>}
    {note && <p className="err">{note}</p>}
    <table><thead><tr><th className="label">Prefijo</th><th className="label">Empresa</th><th className="label">Estado</th><th><span className="sr">Acciones</span></th></tr></thead>
      <tbody>{data?.map(k => <tr key={k.id}><td className="mono">fk_{k.prefix}…</td><td className="mono">{k.tenant_id}</td><td>{k.active ? 'activa' : 'inactiva'}</td>
        <td>{k.active && <button className="secondary" onClick={async () => { await api(`/v1/admin/keys/${k.id}/deactivate`, { method: 'POST' }); reload(); }}>Desactivar</button>}</td></tr>)}</tbody></table>
  </>);
}

const VIEWS = ['v_products', 'v_codes', 'v_builds', 'v_sales', 'v_scan_events'];
function DbViewer() {
  const [view, setView] = useState(VIEWS[0]); const [col, setCol] = useState(''); const [val, setVal] = useState(''); const [page, setPage] = useState(0);
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState('');
  const run = useCallback(async () => {
    setErr('');
    try { setRes(await api(`/v1/admin/db/${view}?page=${page}${col && val ? `&${encodeURIComponent(col)}=${encodeURIComponent(val)}` : ''}`)); } catch (e) { setErr(msg(e)); }
  }, [view, col, val, page]);
  useEffect(() => { run(); }, [view, page]); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <h2>Visor de base de datos</h2><p className="label">Solo lectura · vistas permitidas · máx. 500 filas por página · sin SQL libre</p>
    <div className="formrow">
      <select aria-label="Vista" value={view} onChange={e => { setView(e.target.value); setCol(''); setVal(''); setPage(0); }}>{VIEWS.map(v => <option key={v}>{v}</option>)}</select>
      <select aria-label="Columna" value={col} onChange={e => setCol(e.target.value)}><option value="">(sin filtro)</option>{res?.columns.map((c: string) => <option key={c}>{c}</option>)}</select>
      <input aria-label="Valor" value={val} onChange={e => setVal(e.target.value)} placeholder="valor exacto" />
      <button onClick={() => { setPage(0); run(); }}>Filtrar</button></div>
    {err && <p className="err" role="alert">⚠ {err}</p>}
    {res && <div className="scroll" tabIndex={0} role="region" aria-label="Resultados de la vista"><table><thead><tr>{res.columns.map((c: string) => <th key={c} className="label">{c}</th>)}</tr></thead>
      <tbody>{res.rows.map((r: any, i: number) => <tr key={i}>{res.columns.map((c: string) => <td key={c} className="mono">{String(r[c] ?? '')}</td>)}</tr>)}</tbody></table></div>}
    <div className="row gap"><button className="secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Anterior</button><span className="label">Página {page + 1}</span><button className="secondary" disabled={!res || res.rows.length < 500} onClick={() => setPage(p => p + 1)}>Siguiente</button></div>
  </>);
}

function Requests() {
  const { data, reload } = useLoad<any[]>('/v1/admin/requests'); const [rid, setRid] = useState(''); const [detail, setDetail] = useState<any>(null); const [err, setErr] = useState('');
  const open = async (id: string) => { setErr(''); try { setDetail(await api(`/v1/admin/requests/${id}`)); } catch (e) { setErr(msg(e)); } };
  return (<>
    <h2>Depurador de peticiones</h2>
    <div className="row gap"><input aria-label="request_id" placeholder="request_id" value={rid} onChange={e => setRid(e.target.value)} className="mono" /><button onClick={() => open(rid)} disabled={!rid}>Buscar</button><button className="secondary" onClick={reload}>Actualizar</button></div>
    {err && <p className="err">⚠ {err}</p>}
    {detail && <div className="notice"><p className="mono">{detail.method} {detail.url}{detail.query ? '?' + detail.query : ''} → {detail.status} ({Number(detail.duration_ms).toFixed(1)} ms)</p>
      <pre className="mono wrap">{JSON.stringify(detail.headers, null, 2)}</pre>
      <p className="label">cURL sin credenciales (no hay botón de reenvío)</p><pre className="mono wrap">{detail.curl}</pre>
      <button className="secondary" onClick={() => navigator.clipboard?.writeText(detail.curl)}>Copiar como cURL</button> <button className="link" onClick={() => setDetail(null)}>Cerrar</button></div>}
    <table><thead><tr><th className="label">Hora</th><th className="label">Método</th><th className="label">Ruta</th><th className="label num">Estado</th><th className="label num">ms</th></tr></thead>
      <tbody>{data?.map(r => <tr key={r.id}><td className="mono">{new Date(r.created_at).toLocaleTimeString('es-MX')}</td><td className="mono">{r.method}</td>
        <td><button className="rowbtn mono" onClick={() => open(r.request_id)}>{r.route}</button></td><td className="num mono">{r.status}</td><td className="num mono">{Number(r.duration_ms).toFixed(1)}</td></tr>)}</tbody></table>
  </>);
}

function Metrics() {
  const { data, err, reload } = useLoad<any>('/v1/admin/metrics'); const al = useLoad<any[]>('/v1/admin/alerts');
  const f = (n: any) => (n == null ? '—' : Number(n).toFixed(1));
  return (<>
    <h2>Métricas</h2>{err && <p className="err">⚠ {err}</p>}
    <button className="secondary" onClick={async () => { await api('/v1/admin/alerts/evaluate', { method: 'POST' }); reload(); al.reload(); }}>Evaluar alertas ahora</button>
    <h3>Alertas</h3>
    {al.data?.filter(a => a.active).length === 0 && <p className="label">Sin alertas activas ✓</p>}
    <ul>{al.data?.filter(a => a.active).map(a => <li key={a.id} className="err">⚠ {a.message}</li>)}</ul>
    {data && <>
      <h3>Decodificación por motor y dispositivo (meta p95 &lt; 150 ms; escaneo &lt; 300 ms)</h3>
      <table><thead><tr><th className="label">Motor</th><th className="label">Dispositivo</th><th className="label num">n</th><th className="label num">decode p50</th><th className="label num">decode p95</th><th className="label num">total p95</th></tr></thead>
        <tbody>{data.latency.map((l: any, i: number) => <tr key={i}><td>{l.engine}</td><td>{l.device}</td><td className="num mono">{l.n}</td><td className="num mono">{f(l.decode_p50)}</td><td className="num mono">{f(l.decode_p95)}</td><td className="num mono">{f(l.total_p95)}</td></tr>)}</tbody></table>
      <p>Generación de ensamble p95: <b className="mono">{f(data.buildP95?.p95_ms)} ms</b> (meta &lt; 200) · Error API 15 min: <b className="mono">{data.errors15m?.pct ?? 0} %</b> (alerta &gt; 2 %)</p>
      <h3>Tasa de resolución (alerta &lt; 95 %)</h3>
      <table><tbody>{data.resolution.map((r: any) => <tr key={r.tenant_id}><td>Empresa {r.tenant_id}</td><td className="num mono">{r.resolved}/{r.total}</td><td className="num mono">{r.pct} %</td></tr>)}</tbody></table>
      <h3>Ventas por caja</h3>
      <table><tbody>{data.salesByBox.map((s: any, i: number) => <tr key={i}><td className="mono">{String(s.day).slice(0, 10)}</td><td>Empresa {s.tenant_id}</td><td className="num mono">{s.sales}</td><td className="num mono">{money(Number(s.total_cents))}</td></tr>)}</tbody></table>
    </>}
  </>);
}

function Live() {
  const [events, setEvents] = useState<any[]>([]); const [state, setState] = useState('conectando…'); const live = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const es = new EventSource('/v1/admin/stream'); // el navegador reconecta solo
    es.onopen = () => setState('conectado'); es.onerror = () => setState('reconectando…');
    es.onmessage = m => setEvents(e => [JSON.parse(m.data), ...e].slice(0, 100));
    return () => es.close();
  }, []);
  return (<><h2>En vivo</h2><p className="label" role="status">{state}</p>
    <div ref={live} aria-live="off"><table><tbody>{events.map((e, i) => <tr key={i}><td className="mono">{new Date(e.at).toLocaleTimeString('es-MX')}</td><td><span className={'pill ' + (e.type === 'error' || e.type === 'alert' ? 'down' : 'ok')}>{e.type}</span></td><td className="mono">empresa {e.tenant_id ?? '—'}</td><td className="mono">{e.detail}</td></tr>)}</tbody></table></div></>);
}

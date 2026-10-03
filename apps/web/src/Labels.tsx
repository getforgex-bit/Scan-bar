// Hoja de etiquetas en PDF para recortar y pegar: la usan la consola (cualquier negocio), el SuperAdmin desde Catálogo
// (cualquier negocio o todos juntos) y cada negocio desde su cuenta (solo el suyo).
import { useEffect, useId, useState } from 'react';
import { api, ApiError, type Me } from './api';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Error de red');
type LabelTenant = { slug: string; name: string; products: number; categories: string[] };
const ALL = '*';

/** Arriba de Catálogo: el personal descarga las etiquetas de su negocio; el SuperAdmin elige el negocio o todos. */
export function CatalogLabels({ me }: { me: Me }) {
  const [tenants, setTenants] = useState<LabelTenant[] | null>(null); const [err, setErr] = useState('');
  useEffect(() => { api<LabelTenant[]>('/v1/labels/tenants').then(setTenants).catch(e => setErr(msg(e))); }, []);
  if (err) return <p className="err">⚠ {err}</p>;
  if (!tenants) return <p className="label" role="status">Cargando etiquetas…</p>;
  if (!tenants.length) return null;
  return <LabelsPdf url="/v1/labels.pdf" tenants={tenants} initial={me.tenant?.slug} />;
}

type Props = { url: string } & (
  | { tenants: LabelTenant[]; initial?: string } // con selector de negocio cuando hay más de uno
  | { slug: string; name: string; categories: string[] }
);

/** Descarga la hoja de etiquetas (PDF) para recortar y pegar: nombre encima de cada código. */
export function LabelsPdf(props: Props) {
  const id = useId();
  const list = 'tenants' in props ? props.tenants : null;
  const [tenant, setTenant] = useState(() => (list && (list.find(t => t.slug === (props as any).initial) ?? list[0])?.slug) || '');
  const chosen = list ? (tenant === ALL ? null : list.find(t => t.slug === tenant) ?? list[0]) : null;
  const name = list ? chosen?.name ?? 'Todos los negocios' : (props as { name: string }).name;
  const slug = list ? chosen?.slug ?? 'todos-los-negocios' : (props as { slug: string }).slug;
  const categories = list ? [...new Set((chosen ? [chosen] : list).flatMap(t => t.categories))].sort() : (props as { categories: string[] }).categories;
  const count = list ? (chosen ? chosen.products : list.reduce((n, t) => n + t.products, 0)) : null;
  const [o, setO] = useState({ paper: 'letter', qr: false, copies: 1, scale: 100, category: '' });
  const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  const download = async () => {
    setBusy(true); setNote('');
    const q = new URLSearchParams({ paper: o.paper, qr: o.qr ? '1' : '0', copies: String(o.copies), scale: String(o.scale),
      ...(o.category ? { category: o.category } : {}), ...(list ? { tenant: chosen?.slug ?? ALL } : {}) });
    try {
      const res = await fetch(`${props.url}?${q}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'pwa' } });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (res.status === 403 && body?.error === 'admin_locked') window.dispatchEvent(new Event('admin-locked'));
        throw new ApiError(res.status, body);
      }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = href; a.download = `etiquetas-${slug}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setNote('PDF listo. Imprime al 100 % ("tamaño real"), recorta por las guías y pega cada etiqueta en su producto.');
    } catch (e) { setNote('⚠ ' + msg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="notice stack">
      <h3>Etiquetas en PDF · {name}</h3>
      <p className="label">
        {count === null ? 'Todos los productos activos con su código' : `${count} producto${count === 1 ? '' : 's'} con código`}; el nombre del producto va encima de cada código de barras.
        {list && !chosen && ' Cada negocio empieza en una página nueva.'}
      </p>
      <div className="formrow">
        {list && list.length > 1 && (
          <select aria-label="Negocio" value={chosen?.slug ?? ALL} onChange={e => { setTenant(e.target.value); setO({ ...o, category: '' }); setNote(''); }}>
            {list.map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}
            <option value={ALL}>Todos los negocios</option>
          </select>
        )}
        <select aria-label="Categoría" value={o.category} onChange={e => setO({ ...o, category: e.target.value })}><option value="">Todas las categorías</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <select aria-label="Papel" value={o.paper} onChange={e => setO({ ...o, paper: e.target.value })}><option value="letter">Carta</option><option value="a4">A4</option></select>
        <select aria-label="Tamaño del código" value={o.scale} onChange={e => setO({ ...o, scale: Number(e.target.value) })}><option value={100}>Código al 100 %</option><option value={80}>Código al 80 %</option></select>
        <label className="row gap label" htmlFor={`${id}-c`}>Copias<input id={`${id}-c`} type="number" min={1} max={50} value={o.copies} onChange={e => setO({ ...o, copies: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} /></label>
        <label className="row gap"><input type="checkbox" className="check" checked={o.qr} onChange={e => setO({ ...o, qr: e.target.checked })} /> Incluir QR</label>
        <button onClick={download} disabled={busy || count === 0}>{busy ? 'Generando…' : 'Descargar PDF'}</button>
      </div>
      {note && <p className={note.startsWith('⚠') ? 'err' : 'label'} role="status">{note}</p>}
    </div>
  );
}

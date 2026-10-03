import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, money, fmtGtin, type Me } from './api';
import { kvGet, kvSet } from './kv';
import { evaluate, type Definition, type Group } from '../../../packages/codes/src/rules';

type Option = { id: number; sku: string; name: string; category: string; priceCents: number; attrs: Record<string, any>; inStock: boolean };
type Business = { slug: string; name: string; configurators: { slug: string; name: string; description: string }[] };
type Detail = { tenant: { slug: string; name: string }; configurator: { slug: string; name: string; description: string; definition: Definition }; products: Option[] };
export type BuildResult = { gtin: string; label: string; digitalLink: string; reused: boolean; saved: boolean; totalCents: number; bom: { sku: string; name: string; qty: number; unitPriceCents: number }[]; svg: { ean13: string; qr: string } };
type Selection = Record<number, number>; // productId → cantidad

const price = (c: number) => (c === 0 ? 'Sin costo' : money(c));
const groupHint = (g: Group) => g.hint ?? (g.min === 0 ? 'Opcional' : g.max === 1 ? 'Elige una opción' : `Elige de ${g.min} a ${g.max}`);

/** Tarjeta-espécimen: sirve para el borrador, el resultado guardado y "Mis configuraciones". */
export function Specimen({ label, gtin, lines, totalCents, svg, note }: { label: string; gtin?: string; lines: { name: string; qty: number; cents: number }[]; totalCents: number; svg?: { ean13: string; qr: string }; note?: string }) {
  return (
    <article className="specimen">
      <p className="label">{label} {gtin ? '· guardado' : '· borrador'}</p>
      <h2 className="serif big">{gtin ? fmtGtin(gtin) : 'Sin código aún'}</h2>
      {lines.length === 0 ? <p className="label">Elige opciones para empezar.</p> :
        <ol className="bom">{lines.map((b, i) => <li key={i}><span>{b.name}{b.qty > 1 ? ` × ${b.qty}` : ''}</span><span className="mono num">{price(b.qty * b.cents)}</span></li>)}</ol>}
      <p className="total mono">Total {money(totalCents)}</p>
      {svg && <div className="codes"><div dangerouslySetInnerHTML={{ __html: svg.ean13 }} /><div className="qr" dangerouslySetInnerHTML={{ __html: svg.qr }} /></div>}
      {note && <p className="label">{note}</p>}
    </article>
  );
}

export function Configurator({ me, initialTenant, onNeedAccount }: { me: Me | null; initialTenant?: string; onNeedAccount: () => void }) {
  const staffTenant = me?.tenant?.slug; // el personal configura solo para su negocio
  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  const [tenant, setTenant] = useState<string>(''); const [cfg, setCfg] = useState<string>('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sel, setSel] = useState<Selection>({});
  const [result, setResult] = useState<BuildResult | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Business[]>('/v1/public/tenants').then(async list => {
      setBusinesses(list);
      const wanted = staffTenant ?? initialTenant ?? await kvGet<string>('lastTenant', '');
      const b = list.find(x => x.slug === wanted) ?? (staffTenant ? undefined : list[0]);
      if (b) { setTenant(b.slug); setCfg(b.configurators[0].slug); }
    }).catch(() => setErr('No se pudo cargar la lista de negocios'));
  }, [staffTenant, initialTenant]);

  const draftKey = `draft:${tenant}:${cfg}`;
  useEffect(() => {
    if (!tenant || !cfg) return;
    let alive = true; setDetail(null); setResult(null); setErr('');
    Promise.all([api<Detail>(`/v1/public/t/${tenant}/configurators/${cfg}`), kvGet<Selection>(draftKey, {})]).then(([d, draft]) => {
      if (!alive) return;
      const ids = new Set(d.products.map(p => p.id));
      setDetail(d); setSel(Object.fromEntries(Object.entries(draft).filter(([id]) => ids.has(Number(id))))); // descarta opciones que ya no existen
      if (!staffTenant) kvSet('lastTenant', tenant);
    }).catch(e => alive && setErr(e instanceof ApiError ? e.message : 'Error de red'));
    return () => { alive = false; };
  }, [tenant, cfg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (detail) kvSet(draftKey, sel); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const def = detail?.configurator.definition;
  // Elegidos en el orden de los grupos del configurador (bebida, tamaño, leche…), igual que la respuesta del servidor.
  const chosen = useMemo(() => {
    if (!detail) return [];
    const idx = (c: string) => detail.configurator.definition.groups.findIndex(g => g.category === c);
    return detail.products.filter(p => sel[p.id]).sort((x, y) => idx(x.category) - idx(y.category) || x.name.localeCompare(y.name));
  }, [detail, sel]);
  const violations = useMemo(() => (def ? evaluate(def, chosen.map(p => ({ id: p.id, category: p.category, attrs: p.attrs, name: p.name, qty: sel[p.id] }))) : []), [def, chosen, sel]);
  const missing = violations.filter(v => v.rule === 'grupo_obligatorio');
  const conflicts = violations.filter(v => v.rule !== 'grupo_obligatorio');
  const total = chosen.reduce((s, p) => s + p.priceCents * sel[p.id], 0);

  const toggle = (g: Group, p: Option) => {
    setResult(null);
    setSel(s => {
      if (s[p.id]) { const { [p.id]: _drop, ...rest } = s; return rest; }
      const inGroup = detail!.products.filter(x => x.category === g.category && s[x.id]).map(x => x.id);
      if (g.max === 1) return { ...Object.fromEntries(Object.entries(s).filter(([id]) => !inGroup.includes(Number(id)))), [p.id]: 1 }; // reemplaza
      if (inGroup.length >= g.max) return s;
      return { ...s, [p.id]: 1 };
    });
  };
  const setQty = (p: Option, q: number) => { setResult(null); setSel(s => ({ ...s, [p.id]: q })); };

  const save = async () => {
    setBusy(true); setErr('');
    const body = { configurator: cfg, lines: chosen.map(p => ({ productId: p.id, qty: sel[p.id] })) };
    try {
      setResult(await api<BuildResult>(staffTenant ? '/v1/builds' : `/v1/public/t/${tenant}/builds`, { method: 'POST', body }));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Sin conexión: tu borrador sigue guardado en este dispositivo'); } finally { setBusy(false); }
  };

  const business = businesses?.find(b => b.slug === tenant);
  if (businesses && !business) return <section><h2>Configurador</h2><p className="notice">{staffTenant ? 'Tu negocio aún no tiene un configurador. Créalo en Administración → Configuradores.' : 'Todavía no hay negocios con configurador.'}</p></section>;

  return (
    <div className="grid cfg">
      <section>
        <div className="formrow">
          {!staffTenant && businesses && <>
            <label className="label" htmlFor="biz">Negocio</label>
            <select id="biz" value={tenant} onChange={e => { const b = businesses.find(x => x.slug === e.target.value)!; setTenant(b.slug); setCfg(b.configurators[0].slug); }}>
              {businesses.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
            </select></>}
          {business && business.configurators.length > 1 && <>
            <label className="label" htmlFor="cfgsel">Qué quieres configurar</label>
            <select id="cfgsel" value={cfg} onChange={e => setCfg(e.target.value)}>{business.configurators.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select></>}
        </div>
        {!detail || !def ? <p className="label">{err || 'Cargando…'}</p> : <>
          <h2>{detail.configurator.name}</h2>
          {detail.configurator.description && <p className="label">{detail.tenant.name} · {detail.configurator.description}</p>}
          {def.groups.map(g => {
            const options = detail.products.filter(p => p.category === g.category);
            const count = options.filter(p => sel[p.id]).length;
            const bad = conflicts.some(v => v.group === g.category);
            return (
              <fieldset key={g.category} className={'group' + (bad ? ' bad' : '')}>
                <legend><span className="gname">{g.label}</span> <span className="label">{groupHint(g)}{g.max > 1 ? ` · ${count}/${g.max}` : ''}</span></legend>
                {options.length === 0 && <p className="label">Sin opciones en el catálogo para “{g.category}”.</p>}
                <table><tbody>
                  {options.map(p => {
                    const on = !!sel[p.id]; const full = !on && g.max > 1 && count >= g.max;
                    return (
                      <tr key={p.id} className={on ? 'on' : ''}>
                        <td><button className="rowbtn" aria-pressed={on} disabled={!p.inStock || full} onClick={() => toggle(g, p)}>
                          <span className="mark" aria-hidden>{on ? '●' : '○'}</span> {p.name}{!p.inStock && <small className="label"> · agotado</small>}</button></td>
                        <td className="qtycell">{on && (g.maxQty ?? 1) > 1 && (
                          <span className="row gap"><button className="step" aria-label={`Menos ${p.name}`} disabled={sel[p.id] <= 1} onClick={() => setQty(p, sel[p.id] - 1)}>−</button>
                            <span className="mono" aria-live="polite">{sel[p.id]}</span>
                            <button className="step" aria-label={`Más ${p.name}`} disabled={sel[p.id] >= (g.maxQty ?? 1)} onClick={() => setQty(p, sel[p.id] + 1)}>+</button></span>)}</td>
                        <td className="num mono">{price(p.priceCents)}</td>
                      </tr>);
                  })}
                </tbody></table>
              </fieldset>);
          })}
        </>}
      </section>
      <aside>
        <Specimen label={result?.label ?? def?.itemLabel ?? 'Configuración'} gtin={result?.gtin} totalCents={result ? result.totalCents : total} svg={result?.svg}
          lines={result ? result.bom.map(b => ({ name: b.name, qty: b.qty, cents: b.unitPriceCents })) : chosen.map(p => ({ name: p.name, qty: sel[p.id], cents: p.priceCents }))}
          note={result ? (result.reused ? 'Código reutilizado: misma configuración y mismos precios' : 'Código nuevo emitido') + (result.saved ? ' · guardado en Mis configuraciones' : '') : undefined} />
        <div aria-live="polite">
          {conflicts.map(v => <p className="err" key={v.rule + v.message}>⚠ {v.message}</p>)}
          {missing.length > 0 && chosen.length > 0 && <p className="label">{missing.map(v => v.message).join(' · ')}</p>}
          {err && detail && <p className="err" role="alert">⚠ {err}</p>}
        </div>
        <div className="row gap wrapbtns">
          <button onClick={save} disabled={busy || !detail || chosen.length === 0 || violations.length > 0}>Guardar y generar código</button>
          {result && <button className="secondary" onClick={() => window.print()}>Imprimir etiqueta</button>}
          <button className="link" onClick={() => { setSel({}); setResult(null); }}>Limpiar</button>
        </div>
        {!me && <p className="label">No necesitas cuenta para configurar. <button className="link inline" onClick={onNeedAccount}>Regístrate</button> si quieres conservar tus configuraciones.</p>}
      </aside>
    </div>
  );
}

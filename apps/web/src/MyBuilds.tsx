import { useEffect, useState } from 'react';
import { api, ApiError, money, fmtGtin } from './api';
import { Specimen } from './Configurator';

type Saved = { gtin: string; tenantSlug: string; tenantName: string; label: string; configurator: string; totalCents: number; savedAt: string };
type Detail = { gtin: string; bom: { name: string; qty: number; unitPriceCents: number }[]; svg: { ean13: string; qr: string } };

export function MyBuilds() {
  const [list, setList] = useState<Saved[] | null>(null); const [open, setOpen] = useState<{ s: Saved; d: Detail } | null>(null); const [err, setErr] = useState('');
  useEffect(() => { api<Saved[]>('/v1/me/builds').then(setList).catch(e => setErr(e instanceof ApiError ? e.message : 'Error de red')); }, []);
  const show = async (s: Saved) => { try { setOpen({ s, d: await api<Detail>(`/v1/me/builds/${s.gtin}`) }); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Error de red'); } };
  return (
    <div className="grid cfg">
      <section>
        <h2>Mis configuraciones</h2>
        {err && <p className="err" role="alert">⚠ {err}</p>}
        {list && list.length === 0 && <p className="label">Aún no tienes configuraciones guardadas. Las bebidas, ensambles y pedidos se arman en la página de cada negocio; ahí recibes su código.</p>}
        {list && list.length > 0 && (
          <table><thead><tr><th className="label">Qué</th><th className="label">Negocio</th><th className="label">Código</th><th className="label num">Total</th></tr></thead>
            <tbody>{list.map(s => (
              <tr key={s.gtin} className={open?.s.gtin === s.gtin ? 'on' : ''}>
                <td><button className="rowbtn" onClick={() => show(s)}>{s.configurator || s.label}<small className="label"> {new Date(s.savedAt).toLocaleDateString('es-MX')}</small></button></td>
                <td>{s.tenantName}</td><td className="mono">{fmtGtin(s.gtin)}</td><td className="num mono">{money(s.totalCents)}</td>
              </tr>))}</tbody></table>)}
      </section>
      <aside>
        {open && <>
          <Specimen label={open.s.label} gtin={open.d.gtin} totalCents={open.s.totalCents} svg={open.d.svg} lines={open.d.bom.map(b => ({ name: b.name, qty: b.qty, cents: b.unitPriceCents }))} note={`${open.s.tenantName} · precios congelados al guardar`} />
          <button className="secondary" onClick={() => window.print()}>Imprimir etiqueta</button>
        </>}
      </aside>
    </div>
  );
}

// Hoja de etiquetas en PDF para recortar y pegar: la usan la consola (cualquier negocio) y cada negocio desde su cuenta (el suyo).
import { useId, useState } from 'react';
import { ApiError } from './api';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Error de red');

/** Descarga la hoja de etiquetas (PDF) para recortar y pegar: nombre encima de cada código. */
export function LabelsPdf({ url, slug, name, categories }: { url: string; slug: string; name: string; categories: string[] }) {
  const id = useId();
  const [o, setO] = useState({ paper: 'letter', qr: false, copies: 1, scale: 100, category: '' });
  const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  const download = async () => {
    setBusy(true); setNote('');
    const q = new URLSearchParams({ paper: o.paper, qr: o.qr ? '1' : '0', copies: String(o.copies), scale: String(o.scale), ...(o.category ? { category: o.category } : {}) });
    try {
      const res = await fetch(`${url}?${q}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'pwa' } });
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
      <p className="label">Todos los productos activos con su código; el nombre va encima de cada uno.</p>
      <div className="formrow">
        <select aria-label="Papel" value={o.paper} onChange={e => setO({ ...o, paper: e.target.value })}><option value="letter">Carta</option><option value="a4">A4</option></select>
        <select aria-label="Categoría" value={o.category} onChange={e => setO({ ...o, category: e.target.value })}><option value="">Todas las categorías</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <select aria-label="Tamaño del código" value={o.scale} onChange={e => setO({ ...o, scale: Number(e.target.value) })}><option value={100}>Código al 100 %</option><option value={80}>Código al 80 %</option></select>
        <label className="row gap label" htmlFor={`${id}-c`}>Copias<input id={`${id}-c`} type="number" min={1} max={50} value={o.copies} onChange={e => setO({ ...o, copies: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} /></label>
        <label className="row gap"><input type="checkbox" className="check" checked={o.qr} onChange={e => setO({ ...o, qr: e.target.checked })} /> Incluir QR</label>
        <button onClick={download} disabled={busy}>{busy ? 'Generando…' : 'Descargar PDF'}</button>
      </div>
      {note && <p className={note.startsWith('⚠') ? 'err' : 'label'} role="status">{note}</p>}
    </div>
  );
}

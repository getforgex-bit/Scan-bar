import { useEffect, useState } from 'react';
import { api, fmtGtin, type Product } from './api';
import { kvGet, kvSet } from './kv';

const DEVICES = ['android-gama-baja-chrome', 'iphone-safari', 'laptop-windows-chrome'];
const SUPPORTS = ['etiqueta-100', 'etiqueta-80', 'pantalla-laptop', 'pantalla-otro-telefono'];
// Ancho nominal del EAN-13 SC2: 37.29 mm al 100 %.
const EAN_MM = 37.29;

export function Campo() {
  const [products, setProducts] = useState<Product[]>([]);
  const [device, setDevice] = useState(''); const [support, setSupport] = useState(''); const [scale, setScale] = useState(100);
  useEffect(() => { api<Product[]>('/v1/products').then(p => setProducts(p.slice(0, 30))); kvGet('device', '').then(setDevice); kvGet('support', '').then(setSupport); }, []);
  const set = (k: 'device' | 'support', v: string, f: (s: string) => void) => { f(v); kvSet(k, v); };
  return (
    <section>
      <div className="noprint">
        <h2>Prueba de campo</h2>
        <p>Elige dispositivo y soporte: cada lectura que hagas en la pestaña Escáner se registra con esa etiqueta. Meta: 30 lecturas por combinación.</p>
        <div className="formrow">
          <label className="label" htmlFor="dv">Dispositivo</label>
          <select id="dv" value={device} onChange={e => set('device', e.target.value, setDevice)}><option value="">(elige)</option>{DEVICES.map(d => <option key={d}>{d}</option>)}</select>
          <label className="label" htmlFor="sp">Soporte</label>
          <select id="sp" value={support} onChange={e => set('support', e.target.value, setSupport)}><option value="">(elige)</option>{SUPPORTS.map(d => <option key={d}>{d}</option>)}</select>
          <label className="label" htmlFor="sc">Escala de impresión</label>
          <select id="sc" value={scale} onChange={e => setScale(Number(e.target.value))}><option value={100}>100 %</option><option value={80}>80 %</option></select>
          <button onClick={() => window.print()}>Imprimir 30 etiquetas</button>
        </div>
        <p className="label">Imprime con "Tamaño real" (sin ajustar a la página). Para resultados: <span className="mono">npm run field-report</span>.</p>
      </div>
      <div className="labels">
        {products.map((p, i) => (
          <figure key={p.gtin} className="lbl">
            <figcaption className="label">#{i + 1} · {p.name}</figcaption>
            <img alt={`EAN-13 ${p.gtin}`} src={`/v1/codes/${p.gtin}.svg?kind=ean13`} style={{ width: `${(EAN_MM * scale) / 100}mm` }} />
            <img alt={`QR ${p.gtin}`} src={`/v1/codes/${p.gtin}.svg?kind=qr`} style={{ width: `${(22 * scale) / 100}mm` }} />
            <p className="mono">{fmtGtin(p.gtin)}</p>
          </figure>
        ))}
      </div>
    </section>
  );
}

// Lo que muestra el escáner al leer un QR que no es de un producto: un enlace (con su sitio bien visible antes de abrirlo),
// un correo / teléfono / mensaje / ubicación, o texto para copiar. Nada se abre sin que la persona lo pida.
import { useState } from 'react';
import type { QrContent } from './scan/logic';

const APP = { mailto: ['Correo', 'Escribir correo'], tel: ['Teléfono', 'Llamar'], sms: ['Mensaje', 'Enviar mensaje'], geo: ['Ubicación', 'Abrir mapa'] } as const;

export function QrResult({ content, onClose }: { content: Exclude<QrContent, { kind: 'acceso' }>; onClose: () => void }) {
  const [copiado, setCopiado] = useState(false);
  const valor = content.kind === 'texto' ? content.text : content.url;
  const copiar = async () => { try { await navigator.clipboard.writeText(valor); setCopiado(true); setTimeout(() => setCopiado(false), 1500); } catch { window.prompt('Copia el texto:', valor); } };
  const titulo = content.kind === 'web' ? 'Enlace en el QR' : content.kind === 'app' ? APP[content.scheme][0] : 'Texto en el QR';
  return (
    <div className="notice stack qr-result" role="alertdialog" aria-labelledby="qr-titulo" aria-describedby="qr-valor">
      <h3 id="qr-titulo">{titulo}</h3>
      {content.kind === 'web' && <p className="qr-host">{content.host}</p>}
      <p id="qr-valor" className="mono wrap">{valor}</p>
      {content.kind === 'web' && !content.seguro && <p className="err">⚠ Este enlace no usa conexión segura (http). Ábrelo solo si confías en quien puso el código.</p>}
      <div className="row gap wrapbtns">
        {content.kind === 'web' && <button onClick={() => { window.open(content.url, '_blank', 'noopener,noreferrer'); onClose(); }}>Abrir enlace</button>}
        {content.kind === 'app' && <button onClick={() => { window.location.href = content.url; onClose(); }}>{APP[content.scheme][1]}</button>}
        <button className="secondary" onClick={copiar}>{copiado ? 'Copiado' : 'Copiar'}</button>
        <button className="link" onClick={onClose}>Seguir escaneando</button>
      </div>
    </div>
  );
}

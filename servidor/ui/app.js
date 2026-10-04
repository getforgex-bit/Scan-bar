// Panel del servidor de Scan-bar: un botón para encender/apagar y una pestaña de datos con el registro en vivo.
'use strict';
const $ = (id) => document.getElementById(id);
const post = (ruta, cuerpo) => fetch(ruta, { method: 'POST', headers: { 'x-panel': '1', 'content-type': 'application/json' }, body: JSON.stringify(cuerpo ?? {}) });
const hora = (t) => new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const horaCorta = (t) => new Date(t).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
const dinero = (c) => (c / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const bytes = (n) => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
function hace(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'hace un momento';
  const m = Math.round(s / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.floor(m / 60)} h ${m % 60} min`;
}
function duracion(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? 'menos de un minuto' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------- pestañas ----------
const tabs = [$('t-servidor'), $('t-datos')];
function abrir(tab) {
  for (const t of tabs) {
    const sel = t === tab;
    t.setAttribute('aria-selected', String(sel)); t.tabIndex = sel ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !sel;
  }
  try { localStorage.setItem('pestana', tab.id); } catch { /* sin almacenamiento */ }
  if (tab.id === 't-datos') cargarDatos();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => abrir(t));
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const otro = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    otro.focus(); abrir(otro);
  });
});
try { const p = localStorage.getItem('pestana'); if (p && $(p)) abrir($(p)); } catch { /* sin almacenamiento */ }

// ---------- estado y botón ----------
let ultimo = null;
let arranque = null; // si el panel se reinicia (p. ej. tras actualizarse), esta página se recarga para usar su versión nueva
let reiniciando = false;
const fecha = (t) => new Date(t).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const corto = (c) => (c ? c.slice(0, 7) : '');
const TEXTO = { apagado: 'Apagado', encendiendo: 'Encendiendo…', encendido: 'Encendido', apagando: 'Apagando…', error: 'No se pudo encender' };
function pintar(e) {
  if (arranque === null) arranque = e.arranque;
  else if (e.arranque !== arranque) { location.reload(); return; }
  ultimo = e;
  const b = $('power');
  const ocupado = e.estado === 'encendiendo' || e.estado === 'apagando';
  b.className = 'power' + (e.estado === 'encendido' ? ' on' : '') + (ocupado ? ' ocupado' : '') + (e.estado === 'error' ? ' error' : '');
  b.disabled = ocupado;
  b.setAttribute('aria-pressed', String(e.estado === 'encendido'));
  $('power-label').textContent = e.estado === 'encendido' ? 'Apagar' : ocupado ? (e.estado === 'apagando' ? 'Apagando' : 'Encendiendo') : 'Encender';
  $('estado-texto').textContent = TEXTO[e.estado];
  $('estado-detalle').textContent = e.estado === 'encendido' ? `Desde las ${horaCorta(e.desde)} · ${duracion(e.desde)}`
    : ocupado ? (e.paso ? `${e.paso}…` : '') : e.estado === 'error' ? e.error : (e.configurado ? 'Pulsa el botón para encender Scan-bar.' : 'Pulsa el botón para encender Scan-bar en esta PC.');
  const pub = e.estado === 'encendido' ? (e.publicUrl || e.localUrl) : '';
  $('enlace').hidden = !pub;
  if (pub) { $('enlace-a').href = pub; $('enlace-a').textContent = pub.replace(/^https?:\/\//, ''); }
  const aviso = e.aviso || (!e.configurado && e.estado !== 'encendido' ? 'Para que las webs y los códigos QR lo encuentren desde internet, completa "Conexión con Cloudflare" en la pestaña Datos (una sola vez).' : '');
  $('aviso').hidden = !aviso; $('aviso').textContent = aviso;

  // pestaña Datos → Estado
  $('d-estado').textContent = TEXTO[e.estado] + (e.paso && ocupado ? ` (${e.paso})` : '') + (e.estado === 'error' ? `: ${e.error}` : '');
  $('d-desde').textContent = e.desde ? `${hora(e.desde)} (${duracion(e.desde)})` : '—';
  $('d-publica').textContent = e.publicUrl || 'Sin configurar (solo esta PC)';
  $('d-salud').textContent = e.estado !== 'encendido' ? '—' : !e.salud.at ? 'comprobando…'
    : e.salud.ok ? `Responde (${e.salud.ms} ms, ${hace(e.salud.at)})` : `No responde (${e.salud.detalle || 'sin respuesta'}, ${hace(e.salud.at)})`;
  $('d-tunel').textContent = e.tunelUrl || '—';
  $('d-local').textContent = e.localUrl;
  $('d-equipo').textContent = e.equipo;
  $('abrir-admin').href = `${e.publicUrl || e.localUrl}/admin`;
  if (document.activeElement !== $('pub') && !$('pub').dataset.editado) $('pub').value = e.publicUrl;

  // versión: aviso en Servidor y detalle en Datos
  const v = e.version, d = v.disponible;
  $('v-instalada').textContent = v.instalada?.commit ? `${corto(v.instalada.commit)} · revisada el ${fecha(v.instalada.fecha)}` : 'Sin registrar (se compara con GitHub al abrir el panel)';
  $('v-github').textContent = d.error ? `No se pudo revisar (${d.error})` : !d.at ? 'Revisando…'
    : d.cambios ? `${corto(d.commit)}: ${d.cambios} archivo${d.cambios === 1 ? '' : 's'} distinto${d.cambios === 1 ? '' : 's'} de los tuyos (pulsa Actualizar)` : `${corto(d.commit)}: es la que tienes`;
  $('nueva').hidden = !(d.cambios > 0 || v.actualizando);
  $('nueva-texto').textContent = v.actualizando ? `${v.actualizando}…` : 'Hay una versión nueva de Scan-bar.';
  $('actualizar-1').hidden = !!v.actualizando;
  for (const id of ['actualizar-1', 'actualizar-2', 'revisar']) $(id).disabled = !!v.actualizando || ocupado || reiniciando;
}
async function estado() {
  try { pintar(await (await fetch('/api/estado')).json()); }
  catch {
    $('estado-texto').textContent = reiniciando ? 'Reiniciando con la versión nueva…' : 'El panel se cerró';
    $('estado-detalle').textContent = reiniciando ? 'Esta página se recarga sola en unos segundos.' : 'Vuelve a abrir "Servidor Scan-bar" para controlar el servidor.';
    $('power').disabled = true;
  }
  const rapido = reiniciando || (ultimo && (ultimo.estado === 'encendiendo' || ultimo.estado === 'apagando'));
  setTimeout(estado, rapido ? 800 : 3000);
}
$('power').addEventListener('click', async () => {
  if (!ultimo) return;
  if (ultimo.estado === 'encendido') {
    if (!confirm('¿Apagar Scan-bar? Las webs seguirán funcionando con sus productos, pero no podrán generar códigos y los QR no abrirán hasta que lo vuelvas a encender.')) return;
    await post('/api/apagar');
  } else await post('/api/encender');
  pintar(await (await fetch('/api/estado')).json());
});
estado();

async function actualizar() {
  if (ultimo?.estado === 'encendido' && !confirm('Para actualizar, Scan-bar se apaga un momento y se vuelve a encender solo (1 a 2 minutos). ¿Continuar?')) return;
  $('v-msg').className = 'msg'; $('v-msg').textContent = 'Descargando la versión más reciente…';
  for (const id of ['actualizar-1', 'actualizar-2', 'revisar']) $(id).disabled = true;
  try {
    const r = await post('/api/actualizar'); const j = await r.json();
    reiniciando = !!j.reinicia;
    $('v-msg').className = 'msg' + (r.ok ? '' : ' error'); $('v-msg').textContent = j.mensaje ?? '';
    if (!r.ok || !j.reinicia) alert(j.mensaje);
    pintar(j);
  } catch { $('v-msg').className = 'msg error'; $('v-msg').textContent = 'No se pudo contactar al panel.'; }
}
$('actualizar-1').addEventListener('click', actualizar);
$('actualizar-2').addEventListener('click', actualizar);
$('revisar').addEventListener('click', async () => {
  $('v-msg').className = 'msg'; $('v-msg').textContent = 'Revisando en GitHub…';
  const j = await (await post('/api/revisar-version')).json();
  pintar(j);
  $('v-msg').textContent = j.version.disponible.error ? '' : j.version.disponible.cambios ? 'Hay una versión nueva: pulsa "Actualizar Scan-bar".' : 'Ya tienes la versión más reciente.';
});

// ---------- tarjetas de acceso ----------
$('tarjetas').addEventListener('click', async () => {
  const m = $('tarjetas-msg'); m.className = 'msg'; m.textContent = 'Generando…';
  try {
    const r = await fetch('/api/tarjetas', { method: 'POST', headers: { 'x-panel': '1' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Error ${r.status}`);
    const href = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = href; a.download = 'tarjetas-acceso.pdf'; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
    m.textContent = ultimo?.configurado ? 'Listo: imprime, recorta y entrega cada tarjeta a su negocio.'
      : 'Listo. Sin "Conexión con Cloudflare", las tarjetas solo sirven con el escáner de Scan-bar (no con la cámara del teléfono).';
  } catch (e) { m.className = 'msg error'; m.textContent = e.message; }
});

// ---------- datos ----------
let datos = null;
async function cargarDatos() {
  try { datos = await (await fetch('/api/datos')).json(); } catch { return; }
  for (const id of ['llave', 'c-admin-pw', 'c-caja-pw']) {
    const v = id === 'llave' ? datos.llave : id === 'c-admin-pw' ? datos.cuentas.adminPassword : datos.cuentas.cajaPassword;
    $(id).dataset.valor = v;
    if ($(id).dataset.oculto !== '1') $(id).textContent = v;
  }
  $('c-admin').textContent = datos.cuentas.admin;
  $('c-cajas').textContent = datos.cuentas.cajas.join('\n');
  $('d-logfile').textContent = datos.registro;
  $('c-config').textContent = `${datos.datos}${datos.datos.includes('\\') ? '\\' : '/'}config.json`;

  const base = datos.base;
  const hay = base && !base.error;
  $('neg').hidden = !hay; $('totales').hidden = !hay;
  $('neg-vacio').hidden = hay;
  if (base && base.error) $('neg-vacio').textContent = `No se pudo leer la base: ${base.error}`;
  if (hay) {
    const tb = $('neg').tBodies[0]; tb.replaceChildren();
    for (const n of base.negocios) {
      const tr = tb.insertRow();
      const td = tr.insertCell();
      const fuera = n.web && !n.web.startsWith('https://github.com/');
      if (fuera) { const a = document.createElement('a'); a.href = n.web; a.target = '_blank'; a.rel = 'noopener'; a.textContent = n.name; td.append(a); } else td.textContent = n.name;
      for (const v of [n.activos, n.consola, n.codigos]) { const c = tr.insertCell(); c.className = 'num'; c.textContent = v.toLocaleString('es-MX'); }
    }
    $('d-conf').textContent = base.configuraciones.toLocaleString('es-MX');
    $('d-esc').textContent = base.escaneos_hoy.toLocaleString('es-MX');
    $('d-ventas').textContent = `${base.ventas_hoy} · ${dinero(base.vendido_hoy)}`;
    $('d-tam').textContent = bytes(base.tamano);
  }
  const ul = $('sync'); ul.replaceChildren();
  for (const s of datos.sincronizacion) {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = s.nombre;
    const p = document.createElement('span'); p.textContent = s.at ? `${s.texto} · ${hace(s.at)}` : 'Aún no se sincroniza en esta sesión.';
    if (s.error) p.className = 'mal';
    li.append(b, p); ul.append(li);
  }
}
setInterval(() => { if (!$('p-datos').hidden) cargarDatos(); }, 10000);

$('f-pub').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/config', { publicUrl: $('pub').value });
  const j = await r.json();
  $('pub-msg').className = 'msg' + (r.ok ? '' : ' error');
  $('pub-msg').textContent = r.ok ? (j.publicUrl ? 'Guardado. Se usará la próxima vez que enciendas.' : 'Guardado: sin dirección pública, solo en esta PC.') : j.error;
  delete $('pub').dataset.editado;
  if (r.ok) pintar(j);
});
$('pub').addEventListener('input', () => { $('pub').dataset.editado = '1'; });

// Mostrar / copiar secretos y enlaces
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mostrar) {
    const el = $(b.dataset.mostrar);
    const oculto = el.dataset.oculto === '1';
    el.dataset.oculto = oculto ? '0' : '1';
    el.textContent = oculto ? (el.dataset.valor ?? '') : '••••••••••••';
    b.textContent = oculto ? 'Ocultar' : 'Mostrar';
  }
  if (b.dataset.copiar) {
    const el = $(b.dataset.copiar);
    const valor = el.dataset.valor ?? el.href ?? el.textContent;
    try { await navigator.clipboard.writeText(valor); const t = b.textContent; b.textContent = 'Copiado'; setTimeout(() => { b.textContent = t; }, 1500); }
    catch { window.prompt('Copia el texto:', valor); }
  }
});

// ---------- registro en vivo ----------
const log = $('log');
let pausado = false;
const pendientes = [];
function visible(l) {
  const f = $('filtro').value;
  return !f || (f === '!' ? l.nivel !== 'info' : l.src === f);
}
function agregar(l) {
  const li = document.createElement('li');
  li.className = `${l.nivel}-l`;
  li.dataset.src = l.src; li.dataset.nivel = l.nivel;
  const t = document.createElement('span'); t.className = 't'; t.textContent = hora(l.t);
  const s = document.createElement('span'); s.className = 'src'; s.textContent = l.src;
  const x = document.createElement('span'); x.className = 'x'; x.textContent = l.texto;
  li.append(t, s, x);
  li.hidden = !visible(l);
  const abajo = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(li);
  while (log.childElementCount > 2000) log.firstElementChild.remove();
  if (abajo) log.scrollTop = log.scrollHeight;
}
const fuente = new EventSource('/api/registro');
fuente.onmessage = (ev) => { const l = JSON.parse(ev.data); if (pausado) pendientes.push(l); else agregar(l); };
$('filtro').addEventListener('change', () => {
  for (const li of log.children) li.hidden = !visible({ src: li.dataset.src, nivel: li.dataset.nivel });
  log.scrollTop = log.scrollHeight;
});
$('pausar').addEventListener('click', () => {
  pausado = !pausado;
  $('pausar').setAttribute('aria-pressed', String(pausado));
  $('pausar').textContent = pausado ? `Seguir` : 'Pausar';
  if (!pausado) { pendientes.splice(0).forEach(agregar); }
});
$('copiar-log').addEventListener('click', async () => {
  const texto = [...log.children].filter(li => !li.hidden).map(li => [...li.children].map(c => c.textContent).join('  ')).join('\n');
  try { await navigator.clipboard.writeText(texto); $('copiar-log').textContent = 'Copiado'; setTimeout(() => { $('copiar-log').textContent = 'Copiar'; }, 1500); } catch { /* sin portapapeles */ }
});

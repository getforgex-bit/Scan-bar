import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { SHOW_CONFIGURATOR } from './flags';

export type AuthMode = 'login' | 'register';

/** Diálogo modal nativo: foco atrapado, Esc para cerrar y fondo inerte sin librerías. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('input, select, textarea')?.focus(); // showModal enfoca el botón de cerrar; el primer campo es más útil
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); onClose(); }}>
      <div className="row between"><h2 id="modal-title" className="serif">{title}</h2><button className="link" aria-label="Cerrar" onClick={onClose}>✕</button></div>
      {children}
    </dialog>
  );
}

export function AuthDialog({ mode, note, onClose, onDone, onSwitch }: { mode: AuthMode; note?: string; onClose: () => void; onDone: () => void; onSwitch: (m: AuthMode) => void }) {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [code, setCode] = useState(''); const [needTotp, setNeedTotp] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const register = mode === 'register';
  const mismatch = register && pw2.length > 0 && pw !== pw2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (register && pw !== pw2) { setErr('Las contraseñas no coinciden'); return; }
    setBusy(true);
    try {
      if (register) await api('/v1/auth/register', { method: 'POST', body: { email, password: pw } });
      else await api('/v1/auth/login', { method: 'POST', body: { email, password: pw, ...(code ? (code.length > 6 ? { recoveryCode: code } : { totp: code }) : {}) } });
      onDone();
    } catch (x) {
      if (x instanceof ApiError && x.body?.error === 'totp_required') setNeedTotp(true);
      else setErr(x instanceof ApiError ? x.message : 'Error de red');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={register ? 'Crear cuenta' : 'Entrar'} onClose={onClose}>
      {note && <p className="label">{note}</p>}
      <form onSubmit={submit} className="stack">
        <label className="label" htmlFor="au-e">Correo</label>
        <input id="au-e" type="email" required autoFocus autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <label className="label" htmlFor="au-p">Contraseña{register ? ' (mínimo 12 caracteres)' : ''}</label>
        <input id="au-p" type="password" required minLength={register ? 12 : 1} autoComplete={register ? 'new-password' : 'current-password'} value={pw} onChange={e => setPw(e.target.value)} />
        {register && <>
          <label className="label" htmlFor="au-p2">Repite la contraseña</label>
          <input id="au-p2" type="password" required autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} aria-invalid={mismatch} />
          {mismatch && <p className="err">✗ No coinciden</p>}
        </>}
        {needTotp && <>
          <label className="label" htmlFor="au-t">Código de segundo factor (o código de recuperación)</label>
          <input id="au-t" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value.trim())} className="mono" autoFocus />
        </>}
        {err && <p className="err" role="alert">⚠ {err}</p>}
        <button type="submit" disabled={busy || mismatch}>{register ? 'Registrarme' : 'Entrar'}</button>
      </form>
      {SHOW_CONFIGURATOR ? <p className="label">
        {register ? '¿Ya tienes cuenta? ' : '¿No tienes cuenta? '}
        <button className="link inline" onClick={() => { setErr(''); onSwitch(register ? 'login' : 'register'); }}>{register ? 'Entrar' : 'Regístrate'}</button>
      </p> : <p className="label">Solo para el personal: administrador y cajas de cada negocio. Para escanear no hace falta cuenta.</p>}
      {register && <p className="label">La cuenta es de cliente: guarda tus configuraciones. El personal de cada negocio recibe su acceso del administrador.</p>}
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import { createDetector, type Engine } from './scan/detector';
import { createConsensus, isManualGtinOk, type Accepted } from './scan/logic';
import { fmtGtin } from './api';

export type Reading = { accepted: Accepted; engine: string; decodeMs: number; totalMs: number };

export function Scanner({ onReading, paused }: { onReading: (r: Reading) => void; paused?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [engine, setEngine] = useState<string>('…');
  const [error, setError] = useState<string>('');
  const [flash, setFlash] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualVal, setManualVal] = useState('');
  const [caps, setCaps] = useState<{ torch?: boolean; zoom?: { min: number; max: number } }>({});
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const cb = useRef(onReading); cb.current = onReading;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const lastHit = useRef(Date.now());

  useEffect(() => {
    let stop = false; let stream: MediaStream | null = null;
    const consensus = createConsensus(1500);
    (async () => {
      try {
        const eng: Engine = await createDetector();
        setEngine(eng.engine);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (stop) { stream.getTracks().forEach(t => t.stop()); return; }
        const track = stream.getVideoTracks()[0]; trackRef.current = track;
        const c: any = track.getCapabilities?.() ?? {};
        setCaps({ torch: !!c.torch, zoom: c.zoom ? { min: c.zoom.min, max: c.zoom.max } : undefined });
        const v = video.current!; v.srcObject = stream; await v.play();
        const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        let inFlight = false;
        const loop = async (_now: number, meta?: any) => {
          if (stop) return;
          const frameAt = performance.now();
          if (!inFlight && !pausedRef.current && v.videoWidth) {
            inFlight = true;
            try {
              const w = Math.round(v.videoWidth * 0.6), h = Math.round(v.videoHeight * 0.6);
              canvas.width = w; canvas.height = h;
              ctx.drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, w, h);
              const t0 = performance.now();
              const found = await eng.detect(canvas);
              const decodeMs = performance.now() - t0;
              for (const f of found) {
                const acc = consensus.feed({ format: f.format, rawValue: f.rawValue }, Date.now());
                if (acc) {
                  lastHit.current = Date.now();
                  const totalMs = performance.now() - frameAt + (meta?.processingDuration ? 0 : 0);
                  setFlash(true); setTimeout(() => setFlash(false), 400);
                  try { navigator.vibrate?.(30); } catch { /* sin vibración */ }
                  beep();
                  cb.current({ accepted: acc, engine: eng.engine, decodeMs, totalMs });
                }
              }
            } catch { /* cuadro descartado */ } finally { inFlight = false; }
          }
          (v as any).requestVideoFrameCallback ? (v as any).requestVideoFrameCallback(loop) : setTimeout(() => loop(0), 60);
        };
        loop(0);
      } catch (e: any) { setError(e?.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Usa la captura manual.' : 'No se pudo abrir la cámara (¿HTTPS?). Usa la captura manual.'); setManual(true); }
    })();
    const idle = setInterval(() => { if (Date.now() - lastHit.current > 8000) setManual(true); }, 1000);
    return () => { stop = true; clearInterval(idle); stream?.getTracks().forEach(t => t.stop()); };
  }, []);

  const submitManual = () => {
    if (!isManualGtinOk(manualVal)) return;
    cb.current({ accepted: { gtin: manualVal }, engine: 'manual', decodeMs: 0, totalMs: 0 });
    setManualVal('');
  };
  const valid = manualVal.length === 13 ? isManualGtinOk(manualVal) : null;

  return (
    <section aria-label="Lector">
      <div className={'viewer' + (flash ? ' hit' : '')}>
        <video ref={video} playsInline muted aria-label="Vista de la cámara" />
        <i className="cross" aria-hidden />
        <b className="c tl" /><b className="c tr" /><b className="c bl" /><b className="c br" />
      </div>
      <div className="row between meta">
        <span className="label">Motor: {engine}</span>
        <span className="row gap">
          {caps.torch && <button className="link" onClick={() => (trackRef.current as any)?.applyConstraints({ advanced: [{ torch: true }] })}>Linterna</button>}
          {caps.zoom && <input aria-label="Zoom" type="range" min={caps.zoom.min} max={caps.zoom.max} step="0.1" onChange={e => (trackRef.current as any)?.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] })} />}
          <button className="link" onClick={() => setManual(m => !m)}>Captura manual</button>
        </span>
      </div>
      {error && <p className="err" role="alert">⚠ {error}</p>}
      {manual && (
        <div className="manual">
          <label className="label" htmlFor="man">GTIN de 13 dígitos</label>
          <div className="row gap">
            <input id="man" inputMode="numeric" maxLength={13} value={manualVal} onChange={e => setManualVal(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && submitManual()} className="mono" />
            <button onClick={submitManual} disabled={!valid}>Usar</button>
          </div>
          <p className="label" aria-live="polite">{valid === null ? `${manualVal.length}/13` : valid ? `✓ Verificador correcto (${fmtGtin(manualVal)})` : '✗ Dígito verificador incorrecto'}</p>
        </div>
      )}
    </section>
  );
}

let audio: AudioContext | null = null;
function beep() {
  try {
    audio ??= new AudioContext(); const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 1200; g.gain.value = 0.05; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.08);
  } catch { /* sin audio */ }
}

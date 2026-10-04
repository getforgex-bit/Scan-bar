// Escáner: QR que no son de productos (tarjeta de acceso, enlaces y otros).
import { describe, it, expect } from 'vitest';
import { classifyQr, accessToken, toGtin } from '../apps/web/src/scan/logic';
import { buildGtin13 } from '../packages/codes/src/index';

const T = 'a'.repeat(21) + '-_' + 'Z9'.repeat(10);
describe('QR que no son de productos', () => {
  it('reconoce la tarjeta de acceso de cualquier dirección de Scan-bar y nada más', () => {
    expect(T).toHaveLength(43);
    expect(accessToken(`https://scan-bar.forgex.workers.dev/acceso#k=${T}`)).toBe(T);
    expect(accessToken(`http://127.0.0.1:3100/acceso/#k=${T}`)).toBe(T);
    expect(classifyQr(`  https://scan-bar.forgex.workers.dev/acceso#k=${T}\n`)).toEqual({ kind: 'acceso', token: T });
    for (const no of [`https://x.mx/acceso?k=${T}`, `https://x.mx/acceso#k=${T}x`, `https://x.mx/otra#k=${T}`, `javascript:alert(1)//acceso#k=${T}`, 'https://x.mx/acceso#k=corto'])
      expect(accessToken(no), no).toBeNull();
  });

  it('los enlaces web se ofrecen para abrir; otros esquemas peligrosos quedan como texto', () => {
    expect(classifyQr('https://www.ejemplo.mx/promo?x=1')).toEqual({ kind: 'web', url: 'https://www.ejemplo.mx/promo?x=1', host: 'www.ejemplo.mx', seguro: true });
    expect(classifyQr('http://menu.cafe.mx')).toMatchObject({ kind: 'web', host: 'menu.cafe.mx', seguro: false });
    expect(classifyQr('www.instagram.com/motzcafe')).toMatchObject({ kind: 'web', url: 'https://www.instagram.com/motzcafe' });
    expect(classifyQr('tel:+529621234567')).toEqual({ kind: 'app', url: 'tel:+529621234567', scheme: 'tel' });
    expect(classifyQr('mailto:hola@ejemplo.mx')).toMatchObject({ kind: 'app', scheme: 'mailto' });
    expect(classifyQr('SMSTO:5512345678:Hola')).toMatchObject({ kind: 'app', scheme: 'sms' });
    for (const t of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'intent://x#Intent;end', 'WIFI:S:Cafe;T:WPA;P:clave;;', 'Hola mundo'])
      expect(classifyQr(t).kind, t).toBe('texto');
  });

  it('un QR de producto (GS1 Digital Link) sigue yendo al resolver, no a enlaces', () => {
    const g = buildGtin13('750', '0003', 1);
    expect(toGtin({ format: 'qr_code', rawValue: `https://scan-bar.forgex.workers.dev/01/0${g}` })).toEqual({ gtin: g });
    expect(toGtin({ format: 'qr_code', rawValue: 'https://www.ejemplo.mx' })).toEqual({ external: 'https://www.ejemplo.mx' });
  });
});

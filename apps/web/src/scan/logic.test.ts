import { describe, it, expect } from 'vitest';
import { createConsensus, toGtin, isManualGtinOk } from './logic';

const ean = (v: string) => ({ format: 'ean_13', rawValue: v });
describe('consenso y antirrebote', () => {
  it('EAN-13 exige dos lecturas idénticas', () => {
    const c = createConsensus();
    expect(c.feed(ean('7500002000891'), 0)).toBeNull();
    expect(c.feed(ean('7500002000891'), 50)).toEqual({ gtin: '7500002000891' });
  });
  it('lecturas distintas no logran consenso', () => {
    const c = createConsensus();
    expect(c.feed(ean('7500002000891'), 0)).toBeNull();
    expect(c.feed(ean('4006381333931'), 50)).toBeNull();
  });
  it('GTIN inválido se ignora', () => {
    const c = createConsensus();
    expect(c.feed(ean('7500002000894'), 0)).toBeNull();
    expect(c.feed(ean('7500002000894'), 50)).toBeNull();
  });
  it('antirrebote de 1.5 s', () => {
    const c = createConsensus();
    c.feed(ean('7500002000891'), 0);
    expect(c.feed(ean('7500002000891'), 50)).not.toBeNull();
    c.feed(ean('7500002000891'), 100);
    expect(c.feed(ean('7500002000891'), 150)).toBeNull();
    expect(c.feed(ean('7500002000891'), 1000)).toBeNull();
    // tras retirar el código >1.5 s, vuelve a aceptarse
    expect(c.feed(ean('7500002000891'), 3000)).not.toBeNull();
  });
  it('QR Digital Link → GTIN-13; QR ajeno → external', () => {
    expect(toGtin({ format: 'qr_code', rawValue: 'https://id.ejemplo.mx/01/07500002000891' })).toEqual({ gtin: '7500002000891' });
    expect(toGtin({ format: 'qr_code', rawValue: 'https://otro.com/x' })).toEqual({ external: 'https://otro.com/x' });
    const c = createConsensus();
    expect(c.feed({ format: 'qr_code', rawValue: 'http://localhost:3000/01/07500002000891' }, 0)).toEqual({ gtin: '7500002000891' });
  });
  it('captura manual valida el verificador', () => {
    expect(isManualGtinOk('7500002000891')).toBe(true);
    expect(isManualGtinOk('7500002000894')).toBe(false);
    expect(isManualGtinOk('123')).toBe(false);
  });
});

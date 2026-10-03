import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkDigit, isValidGtin13, buildGtin13, toDigitalLink, parseDigitalLink } from './index';

describe('GTIN', () => {
  it('casos conocidos', () => {
    expect(isValidGtin13('7500002000891')).toBe(true);
    expect(isValidGtin13('7500002000894')).toBe(false);
    expect(isValidGtin13('4006381333931')).toBe(true);
  });
  it('todo GTIN generado es válido y de 13 dígitos', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 0, max: 99999 }), (c, i) => {
      const g = buildGtin13('750', String(c).padStart(4, '0'), i);
      return g.length === 13 && isValidGtin13(g);
    }));
  });
  it('mutar un dígito siempre se rechaza', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 99999 }), fc.integer({ min: 0, max: 12 }), fc.integer({ min: 1, max: 9 }), (i, pos, delta) => {
      const g = buildGtin13('750', '0002', i);
      const d = (Number(g[pos]) + delta) % 10;
      return !isValidGtin13(g.slice(0, pos) + d + g.slice(pos + 1));
    }));
  });
  it('rango agotado y prefijo largo fallan', () => {
    expect(() => buildGtin13('750', '0002', 100000)).toThrow();
    expect(() => buildGtin13('750', '000200000', 1)).toThrow();
    expect(() => checkDigit('123')).toThrow();
  });
  it('digital link ida y vuelta', () => {
    const g = '7500002000891';
    expect(toDigitalLink(g, 'id.ejemplo.mx')).toBe('https://id.ejemplo.mx/01/07500002000891');
    expect(parseDigitalLink(toDigitalLink(g, 'id.ejemplo.mx'))).toBe(g);
    expect(parseDigitalLink('https://x.mx/01/17500002000891')).toBeNull();
    expect(parseDigitalLink('https://x.mx/01/07500002000894')).toBeNull();
    expect(parseDigitalLink('https://x.mx/otra')).toBeNull();
    expect(parseDigitalLink('basura')).toBeNull();
  });
});

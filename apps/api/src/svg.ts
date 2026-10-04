import bwipjs from 'bwip-js';
import { toDigitalLink } from '../../../packages/codes/src/index';

export const resolverHost = () => process.env.RESOLVER_HOST ?? 'localhost:3000';
const cache = new Map<string, string>();

export function gtinSvg(gtin: string, kind: 'ean13' | 'qr'): string {
  const key = `${kind}:${gtin}:${resolverHost()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const opts: any = kind === 'ean13'
    ? { bcid: 'ean13', text: gtin.slice(0, 12), includetext: true, scale: 3, height: 12, barcolor: '121316', backgroundcolor: 'FFFFFF', paddingwidth: 11, paddingheight: 4 }
    : { bcid: 'qrcode', text: toDigitalLink(gtin, resolverHost()).replace('https://', resolverHost().startsWith('localhost') ? 'http://' : 'https://'), eclevel: 'M', scale: 4, barcolor: '121316', backgroundcolor: 'FFFFFF', paddingwidth: 4, paddingheight: 4 };
  const raw = (bwipjs as any).toSVG(opts) as string;
  // bwip-js dibuja los dígitos como trazos: añadimos título accesible con los 13 dígitos
  const svg = raw.replace("<svg ", `<svg role="img" aria-label="${kind === 'qr' ? 'QR' : 'EAN-13'} ${gtin}" `).replace(/(<svg[^>]*>)/, `$1<title>${gtin}</title>`);
  if (cache.size > 5000) cache.clear();
  cache.set(key, svg);
  return svg;
}

export const digitalLink = (gtin: string) =>
  toDigitalLink(gtin, resolverHost()).replace('https://', resolverHost().startsWith('localhost') ? 'http://' : 'https://');

/** QR de un texto cualquiera (p. ej. el enlace de una tarjeta de acceso); sin caché: cada tarjeta es única. */
export const textQrSvg = (text: string) =>
  (bwipjs as any).toSVG({ bcid: 'qrcode', text, eclevel: 'M', scale: 4, barcolor: '121316', backgroundcolor: 'FFFFFF', paddingwidth: 4, paddingheight: 4 }) as string;

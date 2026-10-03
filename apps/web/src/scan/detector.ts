// Detector por capacidad (nunca por user agent): BarcodeDetector nativo o ponyfill Wasm autoalojado.
import { BarcodeDetector as WasmDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export type Detected = { format: string; rawValue: string };
export type Engine = { engine: 'native' | 'wasm'; detect(src: ImageBitmap | HTMLCanvasElement | HTMLVideoElement): Promise<Detected[]> };

let prepared = false;
function prepareWasm() {
  if (prepared) return;
  prepared = true;
  // El binario .wasm se sirve desde nuestro dominio, no desde un CDN.
  prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) }, fireImmediately: true });
}

export async function createDetector(): Promise<Engine> {
  const formats = ['ean_13', 'qr_code'];
  const Native = (globalThis as any).BarcodeDetector;
  if (Native) {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      if (formats.every(f => supported.includes(f))) {
        const d = new Native({ formats });
        return { engine: 'native', detect: s => d.detect(s) };
      }
    } catch { /* cae a Wasm */ }
  }
  prepareWasm();
  const d = new WasmDetector({ formats: formats as any });
  return { engine: 'wasm', detect: s => d.detect(s as any) as Promise<Detected[]> };
}

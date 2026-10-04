/// <reference types="vite/client" />
declare module "*.wasm?url" { const u: string; export default u; }
/** Fecha de compilación de la app (vite.config.ts → define). */
declare const __BUILD__: string;

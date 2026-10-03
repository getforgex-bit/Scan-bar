/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />
declare module "*.wasm?url" { const u: string; export default u; }

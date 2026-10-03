import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: { name: 'Sistema Universal de Códigos', short_name: 'Códigos', start_url: '/', display: 'standalone', background_color: '#F8F9FA', theme_color: '#F8F9FA', icons: [] },
      workbox: { globPatterns: ['**/*.{js,css,html,wasm,woff2,svg}'], maximumFileSizeToCacheInBytes: 8_000_000, navigateFallbackDenylist: [/^\/v1\//, /^\/01\//] },
    }),
  ],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 }, // sin data: URIs: la CSP solo admite recursos del propio origen
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000', '/01': 'http://localhost:3000' } },
});

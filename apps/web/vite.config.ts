import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Scan-bar · Sistema Universal de Códigos', short_name: 'Scan-bar', lang: 'es-MX', start_url: '/', display: 'standalone', background_color: '#F8F9FA', theme_color: '#F8F9FA',
        description: 'Escanea el código de barras o el QR de un producto para abrir su página; cobra en caja e imprime etiquetas.',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,wasm,woff2,svg}'], maximumFileSizeToCacheInBytes: 8_000_000, navigateFallbackDenylist: [/^\/v1\//, /^\/01\//] },
    }),
  ],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 }, // sin data: URIs: la CSP solo admite recursos del propio origen
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000', '/01': 'http://localhost:3000' } },
});

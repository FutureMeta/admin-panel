// Build del frontend. §3.7
//
// Il minifier di Vite 8 e' Oxc: `build.minify: 'esbuild'` FALLISCE, e non e'
// una svista da correggere piu' avanti — e' il default nuovo. Qui si lascia il
// valore predefinito e non si tocca.
//
// L'output va in `dist/`: nginx serve `dist/assets/*` con l'hash nel nome e
// `Cache-Control: immutable`, mentre `dist/index.html` lo legge il processo
// Node all'avvio e lo serve con il nonce CSP (§2, §5.1).

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // L'hash nel nome e' cio' che rende sicuro `immutable` su nginx.
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // In sviluppo il frontend gira su Vite e l'API sul processo Node: il proxy
    // tiene tutto sulla stessa origine, altrimenti i cookie `__Host-` e
    // `SameSite=Strict` non partirebbero e il login non funzionerebbe in
    // locale per un motivo che non c'entra col codice.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/accept': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/internal': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});

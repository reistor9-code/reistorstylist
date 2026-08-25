import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],

  /*
   * The app is served from /dashboard, not from the root.
   *
   * Without this, index.html asks for /assets/index-*.js. Nginx has no such
   * location, the SPA fallback answers with index.html instead, and the
   * browser reports "Unexpected token '<'" — the build is fine, the paths
   * are not.
   */
  base: '/dashboard/',

  resolve: { alias: { '@': path.resolve(__dirname, './src') } },

  server: {
    // The API lives on the Linode. Proxying in dev means the same relative
    // URL works locally and in production, with no build-time switch.
    proxy: {
      '/dashboard/api': { target: 'https://stylist.reistor.life', changeOrigin: true },
      '/dashboard/auth': { target: 'https://stylist.reistor.life', changeOrigin: true },
    },
  },
});

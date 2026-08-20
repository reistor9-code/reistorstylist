import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    // The Worker owns the data. Proxying in dev means the same relative URL
    // works locally and in production, with no build-time switch.
    proxy: {
      '/dashboard': {
        target: 'https://reistor-ai-stylist.reistorlife.workers.dev',
        changeOrigin: true,
      },
    },
  },
});

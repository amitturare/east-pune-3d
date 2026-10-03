import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 3003, strictPort: true },
  preview: { port: 3003, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});

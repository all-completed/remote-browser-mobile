import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Capacitor loads the built app from a local origin; absolute "/assets/..." breaks there.
  base: './',
  build: {
    outDir: 'www',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});

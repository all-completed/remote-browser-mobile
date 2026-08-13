import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // The app version comes from package.json at build time; a literal in the source would
  // silently drift from the released version (see src/lib/device.ts).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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

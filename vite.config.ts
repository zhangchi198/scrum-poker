import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    // Preact through its compat layer instead of React + ReactDOM: the bundle drops from 84 KB to 23 KB gzip. The app uses
    // only hooks and plain elements. Types still come from @types/react, and the runtime tests cover the swap (see README).
    alias: {
      react: 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-runtime',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: { root: '.', include: ['test/**/*.test.ts'] },
});

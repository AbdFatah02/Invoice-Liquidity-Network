import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  build: {
    lib: {
      entry: 'src/index.browser.ts',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist/browser',
    target: 'es2022',
    rollupOptions: {
      external: ['@stellar/freighter-api'],
    },
  },
  resolve: {
    conditions: ['browser'],
  },
});

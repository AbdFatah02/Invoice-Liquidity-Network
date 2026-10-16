import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: process.env.SKIP_DTS !== 'true',
    minify: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    external: ['react', 'react-native', '@stellar/stellar-sdk'],
    outExtension({ format }) {
      return {
        js: format === 'esm' ? '.mjs' : '.cjs',
      };
    },
  },
  {
    // The `./legacy` subpath export (issue #1219) resolves dist/legacy-imports.*.
    // Built as its own config so index.mjs stays a single bundle and the
    // bundle-size budget in scripts/check-bundle-size.js keeps measuring it.
    entry: ['src/legacy-imports.ts'],
    format: ['esm', 'cjs'],
    dts: process.env.SKIP_DTS !== 'true',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    external: ['react', 'react-native', '@stellar/stellar-sdk'],
    outExtension({ format }) {
      return {
        js: format === 'esm' ? '.mjs' : '.cjs',
      };
    },
  },
  {
    entry: ['src/react-native/index.ts'],
    format: ['esm'],
    dts: process.env.SKIP_DTS !== 'true',
    minify: true,
    sourcemap: true,
    clean: true,
    target: 'esnext',
    outDir: 'dist/react-native',
    external: ['react', 'react-native', '@stellar/stellar-sdk'],
    platform: 'browser',
    outExtension() {
      return { js: '.js' };
    },
  },
]);

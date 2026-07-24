/**
 * electron.preload.config.ts — builds the sandboxed preload to CommonJS
 * (`dist/preload/index.cjs`). Only `electron` is external; the shared IPC
 * contract (types only) is erased.
 */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  build: {
    outDir: resolve(root, 'dist/preload'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(root, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});

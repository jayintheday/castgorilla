/**
 * electron.main.config.ts — builds the Electron MAIN process to CommonJS
 * (`dist/main/index.cjs`).
 *
 * The canned MockEngine (imported by relative path in `engine-host.ts`) is
 * bundled in — it pulls in only a pure emitter + the pure device-profile table,
 * no native modules. Electron, Node builtins, and the real `@castgorilla/engine`
 * dynamic-import target are kept EXTERNAL so nothing native is bundled and the
 * WS6b real-engine swap resolves from node_modules at runtime.
 */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

const root = import.meta.dirname;

const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
  build: {
    outDir: resolve(root, 'dist/main'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(root, 'src/main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: [
        'electron',
        ...nodeExternals,
        // The real engine is loaded via dynamic import only on the CASTGORILLA_REAL
        // path; keep it external + its (potentially native) deps.
        '@castgorilla/engine',
        'bonjour-service',
        'castv2',
        'zod',
      ],
    },
  },
});

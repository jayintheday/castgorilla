/**
 * dev.mjs — the dev loop orchestrator.
 *
 * 1. Bundles the Electron main + preload (Vite lib builds).
 * 2. Starts the Vite dev server for the renderer (HMR).
 * 3. Launches Electron pointed at the dev-server URL via VITE_DEV_SERVER_URL.
 *
 * GUI launch is best-effort — a headless/sandboxed environment may not open a
 * window. See README.md for the macOS local-network (TCC) caveat.
 */

import { spawn } from 'node:child_process';
import { build, createServer } from 'vite';
import electronPath from 'electron';

async function main() {
  await build({ configFile: 'electron.main.config.ts' });
  await build({ configFile: 'electron.preload.config.ts' });

  const server = await createServer({ configFile: 'vite.config.ts' });
  await server.listen();

  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('Vite dev server did not report a URL');
  server.printUrls();

  const child = spawn(electronPath, ['dist/main/index.cjs'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  child.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

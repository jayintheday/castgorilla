/**
 * index.ts — the Electron main-process entry point.
 *
 * Creates the window, points it at the Vite dev server (dev) or the built
 * renderer bundle (packaged), hosts the engine behind `engine-host.ts`, and
 * wires IPC. Built by Vite to CommonJS (`dist/main/index.cjs`).
 */

// MUST BE FIRST. Points the engine at the ffmpeg/ffprobe bundled in
// Contents/Resources (a Finder-launched app has no /opt/homebrew/bin on its
// PATH). Imported for its side effect, ahead of every other module, so the env
// is in place before anything can reach the engine. See ffmpeg-paths.ts.
import './ffmpeg-paths.js';

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngineForApp } from './engine-host.js';
import { attachEngine } from './ipc.js';
import type { EngineService } from './engine-service.js';

// Emitted as CJS, so a normal __dirname is available at runtime; this keeps the
// source valid under both ESM typecheck and the CJS bundle.
const dirname =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

/** Set by the dev orchestrator (scripts/dev.mjs); absent in a packaged app. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let service: EngineService | undefined;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0e0f12',
    // The renderer draws its own top bar (with an `-webkit-app-region: drag`
    // strip), so the native title bar is hidden but the traffic lights stay,
    // inset. macOS-only styling; ignored elsewhere.
    titleBarStyle: 'hiddenInset',
    title: 'Cast Gorilla',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The same "this window only ever shows our UI" rule as the deny above, for
  // navigations rather than new windows — and the backstop for drag-and-drop.
  // If a file drop lands anywhere OUTSIDE the drop zone, Chromium's default is
  // to navigate the window to that file: the app blanks out and there is no way
  // back without restarting it. The renderer also preventDefaults its own
  // dragover/drop, but a single missed handler would be unrecoverable, so the
  // guard lives here too.
  //
  // The same-URL carve-out is NOT a weakening — it is what keeps the dev loop
  // alive. Measured on Electron 43.2.0:
  //   - `loadURL()` (dev) and `loadFile()` (packaged) do NOT emit this event,
  //     so the initial load is never at risk on either path.
  //   - `webContents.reload()` (the Cmd+R / menu path) does NOT emit it either.
  //   - but `location.reload()` DOES, and that is exactly how Vite performs a
  //     full page reload. This renderer registers no `import.meta.hot` accept
  //     handlers, so a full reload — not an HMR patch — is what every renderer
  //     edit triggers. A blanket preventDefault would silently pin the dev
  //     window to stale code, which is the one failure mode worse than no
  //     reload at all.
  // A reload targets the URL we are already on; a dropped file always resolves
  // to a different one (`file:///…/movie.mkv`), so this admits reloads only.
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return; // reload — allow
    e.preventDefault();
  });

  const handle = await createEngineForApp();
  // Log the engine-gate outcome (real vs mock, and the fallback reason if any)
  // once at startup — invaluable when diagnosing which engine a launch resolved.
  console.log('[engine-gate]', JSON.stringify(handle.mode));
  service = attachEngine(win, handle);

  if (DEV_SERVER_URL) {
    await win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('Failed to start castgorilla:', err);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quit is the last exit route from playback: shutdown() tears down the session,
// which releases the idle-sleep assertion (`power.ts`). The OS reclaims the
// assertion with the process anyway, but leaving it to that would mask a leak in
// every other path.
app.on('before-quit', () => {
  void service?.shutdown();
});

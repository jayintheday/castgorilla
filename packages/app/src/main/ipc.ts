/**
 * ipc.ts — thin Electron adapter binding the pure service/handlers to the
 * Electron IPC + window transport. Not unit-tested (all logic lives in
 * `engine-service.ts` / `handlers.ts`); this file only shuttles bytes.
 */

import { BrowserWindow, dialog, ipcMain, powerSaveBlocker } from 'electron';
import { EngineService } from './engine-service.js';
import { createRequestHandlers } from './handlers.js';
import { createThumbnailProvider } from './thumbnails.js';
import { SleepBlocker } from './power.js';
import { VIDEO_EXTENSIONS } from '../shared/video-extensions.js';
import type { EngineHandle } from './engine-host.js';
import type { EventChannel } from '../shared/ipc.js';

/**
 * Native video-file picker. Resolves the chosen absolute path, or null.
 *
 * The filter comes from the shared `VIDEO_EXTENSIONS` so the picker and the
 * drag-and-drop validator can never accept different sets of files.
 */
async function openVideoDialog(win: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: [...VIDEO_EXTENSIONS] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/**
 * Wire the engine to a window: build the service (pushing events to the
 * renderer), register every request handler, and start discovery.
 * Returns the service so the caller can `shutdown()` on quit.
 */
export function attachEngine(win: BrowserWindow, handle: EngineHandle): EngineService {
  const push = (channel: EventChannel, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // This is the app's Electron boundary, so it is where the real
  // `powerSaveBlocker` is injected — `engine-service.ts` and `power.ts` stay
  // Electron-free and unit-testable.
  const service = new EngineService(
    handle.engine,
    handle.mode,
    push,
    new SleepBlocker(powerSaveBlocker),
  );

  const handlers = createRequestHandlers(service, {
    openVideoDialog: () => openVideoDialog(win),
    getThumbnail: createThumbnailProvider(handle.mode),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload));
  }

  // Losing the window is an exit route from playback too: there is no longer
  // any UI that can stop the session, and (on macOS) the process lives on — so
  // an assertion held past this point would keep the Mac awake indefinitely
  // with nothing on screen to explain why. Tear the session down, which
  // releases it. The engine itself stays up for a re-activated window.
  win.once('closed', () => {
    void service.stop();
  });

  service.init();
  return service;
}

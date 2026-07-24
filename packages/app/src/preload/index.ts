/**
 * preload/index.ts — the contextBridge. Runs in an isolated, sandboxed world and
 * exposes exactly the typed `CastgorillaApi` on `window.castgorilla`. Built by Vite
 * to CommonJS (`dist/preload/index.cjs`).
 *
 * Command methods wrap `ipcRenderer.invoke`; `on*` methods subscribe to EVENT
 * channels and return an unsubscribe function. No Node or engine internals are
 * ever exposed to the renderer.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { EVT, REQ } from '../shared/ipc.js';
import type {
  DiscoveredDevice,
  SessionState,
  SessionStatus,
} from '../shared/engine-types.js';
import type {
  EngineMode,
  EventChannel,
  PlanRequest,
  CastgorillaApi,
  StartSessionRequest,
  ThumbnailRequest,
} from '../shared/ipc.js';

/** Subscribe to an EVENT channel; returns an unsubscribe fn. */
function subscribe<T>(channel: EventChannel, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener as (e: IpcRendererEvent, ...a: unknown[]) => void);
  return () =>
    ipcRenderer.removeListener(
      channel,
      listener as (e: IpcRendererEvent, ...a: unknown[]) => void,
    );
}

const api: CastgorillaApi = {
  getMode: () => ipcRenderer.invoke(REQ.getMode),
  listDevices: () => ipcRenderer.invoke(REQ.listDevices),
  rescanDevices: () => ipcRenderer.invoke(REQ.rescanDevices),
  openVideoDialog: () => ipcRenderer.invoke(REQ.openVideoDialog),
  probe: (file: string) => ipcRenderer.invoke(REQ.probe, { file }),
  getThumbnail: (req: ThumbnailRequest) => ipcRenderer.invoke(REQ.getThumbnail, req),
  plan: (req: PlanRequest) => ipcRenderer.invoke(REQ.plan, req),
  startSession: (req: StartSessionRequest) => ipcRenderer.invoke(REQ.startSession, req),
  pause: () => ipcRenderer.invoke(REQ.pause),
  resume: () => ipcRenderer.invoke(REQ.resume),
  seek: (positionSec: number) => ipcRenderer.invoke(REQ.seek, { positionSec }),
  stop: () => ipcRenderer.invoke(REQ.stop),
  setVolume: (volume: number) => ipcRenderer.invoke(REQ.setVolume, { volume }),
  setMuted: (muted: boolean) => ipcRenderer.invoke(REQ.setMuted, { muted }),
  selectAudio: (index: number) => ipcRenderer.invoke(REQ.selectAudio, { index }),
  selectSubtitle: (trackId: number | null) =>
    ipcRenderer.invoke(REQ.selectSubtitle, { trackId }),
  getStatus: () => ipcRenderer.invoke(REQ.getStatus),

  // Preload-local, not an IPC round trip: a `File` cannot be structured-cloned
  // to main, and `File.path` was removed in Electron 32. `webUtils` is
  // available in a sandboxed preload. Never throws — a non-File argument makes
  // `getPathForFile` throw, and a JS-constructed File not backed by disk makes
  // it return ''; both mean "no path", i.e. null.
  pathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  onDevices: (cb: (devices: DiscoveredDevice[]) => void) => subscribe(EVT.devices, cb),
  onStatus: (cb: (status: SessionStatus) => void) => subscribe(EVT.status, cb),
  onState: (cb: (state: SessionState) => void) => subscribe(EVT.state, cb),
  onPosition: (cb: (positionSec: number) => void) => subscribe(EVT.position, cb),
  onWarning: (cb: (warning: string) => void) => subscribe(EVT.warning, cb),
  onEnded: (cb: () => void) => subscribe<void>(EVT.ended, () => cb()),
  onError: (cb: (message: string) => void) =>
    subscribe<{ message: string }>(EVT.error, (p) => cb(p.message)),
  onMode: (cb: (mode: EngineMode) => void) => subscribe(EVT.mode, cb),
};

contextBridge.exposeInMainWorld('castgorilla', api);

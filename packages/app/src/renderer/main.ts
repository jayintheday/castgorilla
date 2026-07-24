/**
 * main.ts — the renderer entry point: boot, wiring, and nothing else.
 *
 * The division of labour:
 *  - `store.ts`  holds state and interpolates the playback position. Pure.
 *  - `views/*`   own the DOM. They receive an `AppState` and a bag of callbacks
 *                and never see `window.castgorilla`.
 *  - this file   is the only place the two meet: it creates the store, mounts
 *                the views, subscribes engine events into the store, and
 *                implements the actions the views dispatch.
 *
 * Everything that talks to the engine lives here on purpose. `cleanErr`, the
 * `CommandResult` contract and the keyed banners are all part of one decision —
 * how a failure reaches the user — and splitting that decision across six view
 * modules is how a `void api.pause()` gets reintroduced.
 *
 * The rendering model is unchanged and deliberately unfashionable: the store
 * notifies, `render()` reads `store.get()` and updates the DOM. No framework, no
 * virtual DOM, no reactivity. A separate requestAnimationFrame loop calls only
 * `renderPosition`, so the seek bar moves smoothly between the engine's ~1Hz
 * updates without re-rendering the whole window sixty times a second.
 */

import { Store } from './store.js';
import { createDevicePreference, defaultStorage } from './device-preference.js';
import { createPrefsPreference } from './prefs-preference.js';
import { createRecents } from './recents.js';
import type { RecentEntry } from './recents.js';
import { createThumbnailCache } from './thumbnails.js';
import { formatFileName } from './media-format.js';
import type {
  CommandResult,
  EngineMode,
  PlanRequest,
  StartSessionRequest,
} from '../shared/ipc.js';
import type { AppActions, View } from './views/contracts.js';
import { el } from './views/dom.js';
import { cleanErr, mountFeedback } from './views/feedback.js';
import { mountDropZone } from './views/drop-zone.js';
import { mountActivity } from './views/activity.js';
import { mountTray } from './views/tray.js';
import { mountNav } from './views/nav.js';
import { mountDevicePicker } from './views/device-picker.js';
import { mountLaunch } from './views/launch.js';
import { mountTracks } from './views/tracks.js';
import { mountAdvanced } from './views/advanced.js';
import { mountPlayerBar } from './views/player-bar.js';
import { mountCasting } from './views/casting.js';
import { mountRecents } from './views/recents.js';

const api = window.castgorilla;
const store = new Store();
const feedback = mountFeedback();
/** Remembers the last device cast to, so the next launch defaults to it. */
const devicePreference = createDevicePreference(defaultStorage());
/** Persists the two Advanced prefs (surround, HDR policy) across launches. */
const prefsPreference = createPrefsPreference(defaultStorage());
/** The recently-played list — "pick up where you left off". */
const recents = createRecents(defaultStorage());
/** De-duplicating cache in front of the engine's thumbnail generator. */
const getThumbnail = createThumbnailCache((query) => api.getThumbnail(query));

/**
 * Monotonic tokens that make a late async result identifiable as stale.
 *
 * Dropping file B while A is still probing (or changing device while a plan is
 * in flight) means two results race, and the loser can arrive last. Without
 * this, A's `MediaInfo` would overwrite B's and the card would describe a file
 * nobody chose. Cheap insurance for a state the drop zone makes very easy to
 * reach — you can drop a second file the instant after the first.
 */
let probeToken = 0;
let planToken = 0;

// --- engine calls -----------------------------------------------------------

/**
 * Re-plan for the current file + device + prefs.
 *
 * Runs on device change, on either preference change, and after every successful
 * probe. A failure is a PlanRefusedError (or any planner fault) and means this
 * file cannot be played on this device as things stand: drop the stale plan so
 * Play stays disabled, and put the engine's own reason in a persistent banner
 * rather than a toast that outlives it by six seconds.
 */
async function replan(): Promise<void> {
  const state = store.get();
  if (!state.media || !state.selectedDeviceId) return;

  const request: PlanRequest = {
    deviceId: state.selectedDeviceId,
    media: state.media,
    prefs: state.prefs,
  };
  const token = ++planToken;

  try {
    const plan = await api.plan(request);
    if (token !== planToken) return;
    store.setPlan(plan);
    feedback.clearBanner('plan');
  } catch (err) {
    if (token !== planToken) return;
    store.setPlan(null);
    feedback.setBanner(
      'plan',
      `Can't play this file on this device — ${cleanErr(err)}`,
      'error',
    );
  }
}

/**
 * Filled after `mountNav`. An intentional file load (drop / choose / recent)
 * must hop to Clip even when a previous clip is still loaded — otherwise Home's
 * empty face stays up and DnD looks broken. See `NavView.goTo`.
 */
let goToClip: () => void = () => undefined;

/**
 * Probe a path and plan for it.
 *
 * `store.setFile()` sets `probing`, which the drop zone reflects as `.is-probing`
 * — the app's only loading feedback, and the reason a 7.9 GB MKV no longer looks
 * like a frozen window while its keyframe index is built.
 */
async function loadPath(path: string): Promise<void> {
  store.setFile(path);
  // Force Clip: edge auto-advance only fires the first time a file appears, so
  // stop → Home → drop-another would otherwise leave the empty Home face up.
  goToClip();
  feedback.clearBanner('plan');
  feedback.clearBanner('probe');
  const token = ++probeToken;

  try {
    const media = await api.probe(path);
    if (token !== probeToken) return;
    store.setMedia(media);
    feedback.clearBanner('probe');
    await replan();
  } catch (err) {
    if (token !== probeToken) return;
    // Probe is where a missing/too-old ffmpeg first bites (ffprobe resolution
    // runs here). The engine throws a clear, actionable message ("…brew install
    // ffmpeg"); show it persistently rather than as a 6s toast.
    store.setMedia(null);
    feedback.setBanner('probe', `Couldn't read this file — ${cleanErr(err)}`, 'error');
  }
}

/**
 * How a command should behave when it fails. Transport commands (pause / resume
 * / seek / stop, track selection) take the defaults; the high-frequency VOLUME
 * path opts out of both — see the call sites.
 */
interface CommandOptions {
  /**
   * On a `sessionGone` result, clear the session and banner it. TRUE for
   * transport: a receiver that discarded the media session cannot be paused or
   * sought, so the honest thing is to tear the UI down and offer a restart.
   * FALSE for volume: a volume command must never be what removes a healthy
   * playing session from the screen (it routes through the RECEIVER channel and
   * cannot legitimately mean the media session is gone). A genuine drop is
   * reported independently by the engine's own connection-loss path.
   */
  recoverSessionGone?: boolean;
  /**
   * Suppress the failure toast. TRUE for volume: a glitched command mid-drag is
   * self-correcting (the next throttled send, or the reconcile once idle, fixes
   * the slider), so a burst of "Volume failed" toasts is pure noise.
   */
  silent?: boolean;
}

/**
 * Fire a command and surface a failure instead of swallowing it.
 *
 * These resolve to a `CommandResult` rather than throwing (the main process
 * contains the rejection — see `main/handlers.ts`), so a bare `void api.pause()`
 * would silently discard every failure. `sessionGone` means the receiver threw
 * the media session away: for transport that is not transient, so clear the
 * session and say so persistently.
 */
async function command(
  label: string,
  run: () => Promise<CommandResult>,
  opts: CommandOptions = {},
): Promise<void> {
  const { recoverSessionGone = true, silent = false } = opts;
  let result: CommandResult;
  try {
    result = await run();
  } catch (err) {
    // The handler is not supposed to reject any more; if one ever does, still
    // tell the user rather than leaving a dead button.
    if (!silent) feedback.toast(`${label} failed — ${cleanErr(err)}`, true);
    return;
  }
  if (result.ok) return;

  if (result.sessionGone && recoverSessionGone) {
    store.clearSession(Date.now());
    feedback.setBanner(
      'session',
      'The device dropped this session — playback is gone. Press Play to start it again.',
      'error',
    );
    return;
  }
  if (!silent) {
    feedback.toast(
      `${label} failed — ${cleanErr(result.error?.message ?? 'unknown error')}`,
      true,
    );
  }
}

async function startSession(): Promise<void> {
  const state = store.get();
  if (!state.media || !state.plan || !state.selectedDeviceId) return;

  const request: StartSessionRequest = {
    deviceId: state.selectedDeviceId,
    media: state.media,
    plan: state.plan,
    prefs: state.prefs,
  };
  feedback.clearBanner('session');
  try {
    const status = await api.startSession(request);
    store.applyStatus(status, Date.now());
  } catch (err) {
    feedback.setBanner('session', `Couldn't start playback — ${cleanErr(err)}`, 'error');
  }
}

// --- recents recording ------------------------------------------------------

/**
 * Persist how far into the current file the viewer has got, so the empty state
 * can offer to resume it. Recorded from the last OBSERVED position (never the
 * interpolated one — resuming at an interpolated position would add the whole
 * time the app spent between engine ticks), throttled during playback and forced
 * at the natural end-of-session moments (stop, ended).
 */
const RECENTS_STEP_SEC = 15;
let lastRecordedPath: string | null = null;
let lastRecordedPos = Number.NEGATIVE_INFINITY;

function recordRecent(force = false): void {
  const state = store.get();
  const path = state.media?.path ?? state.file;
  // Nothing to record until a file is actually playing (a status exists).
  if (!path || !state.status) return;

  const positionSec = state.status.positionSec;
  const pathChanged = path !== lastRecordedPath;
  if (
    !force &&
    !pathChanged &&
    Math.abs(positionSec - lastRecordedPos) < RECENTS_STEP_SEC
  ) {
    return;
  }

  const entry: RecentEntry = {
    path,
    name: formatFileName(path),
    lastPlayedAt: Date.now(),
    positionSec,
    durationSec: state.status.durationSec || state.media?.durationSec || 0,
  };
  lastRecordedPath = path;
  lastRecordedPos = positionSec;
  store.setRecents(recents.record(entry));
}

// --- actions (views → engine) ----------------------------------------------

const actions: AppActions = {
  openFileDialog(): void {
    void (async (): Promise<void> => {
      const file = await api.openVideoDialog();
      // The picker's own filter already restricts to VIDEO_EXTENSIONS, so unlike
      // the drop path there is nothing left to validate here.
      if (file) await loadPath(file);
    })();
  },
  loadPath(path: string): void {
    void loadPath(path);
  },
  clearFile(): void {
    // setFile(null) also clears media, plan and the probing flag.
    store.setFile(null);
    feedback.clearBanner('probe');
    feedback.clearBanner('plan');
  },

  selectDevice(id: string | null): void {
    store.selectDevice(id);
    // Written on SELECTION, not on a successful cast. A device the user picked
    // and then could not reach is still the device they meant, and making them
    // pick it again on the next launch would punish them for a network problem.
    devicePreference.write(id);
    void replan();
  },
  refreshDevices(): void {
    // Discovery is a subscription, but a device in screensaver state can miss its
    // announcement; `rescanDevices` RE-QUERIES the network (not just re-reads the
    // cache like `listDevices` did — the actual bug), so a device that was asleep
    // at launch can now turn up. The re-query's async arrivals still flow in via
    // the `onDevices` push; this just seeds whatever is known synchronously.
    void (async (): Promise<void> => {
      try {
        store.setDevices(await api.rescanDevices());
      } catch (err) {
        feedback.toast(`Couldn't refresh devices — ${cleanErr(err)}`, true);
      }
    })();
  },
  setSurround(on: boolean): void {
    store.setPrefs({ surround: on });
    prefsPreference.write(store.get().prefs);
    void replan();
  },
  setHdrPolicy(policy: 'warn' | 'block'): void {
    store.setPrefs({ hdrPolicy: policy });
    prefsPreference.write(store.get().prefs);
    void replan();
  },

  clearRecents(): void {
    recents.clear();
    store.setRecents([]);
  },
  removeRecent(path: string): void {
    store.setRecents(recents.remove(path));
  },

  start(): void {
    void startSession();
  },
  resume(): void {
    void command('Resume', () => api.resume());
  },
  pause(): void {
    void command('Pause', () => api.pause());
  },
  stop(): void {
    void command('Stop', () => api.stop());
  },
  seek(positionSec: number): void {
    void command('Seek', () => api.seek(positionSec));
  },
  setVolume(volume: number): void {
    // The high-frequency path: never tear down the session, never toast. A bad
    // volume command is self-correcting and must not blank the casting view.
    void command('Volume', () => api.setVolume(volume), {
      recoverSessionGone: false,
      silent: true,
    });
  },
  setMuted(muted: boolean): void {
    // Mute shares the RECEIVER channel with volume, so it likewise must not be
    // the command that clears a healthy session — but it is a deliberate,
    // low-frequency press, so a failure is worth a single toast.
    void command('Mute', () => api.setMuted(muted), { recoverSessionGone: false });
  },
  selectAudio(streamIndex: number): void {
    void command('Audio track', () => api.selectAudio(streamIndex));
  },
  selectSubtitle(trackId: number | null): void {
    void command('Subtitle track', () => api.selectSubtitle(trackId));
  },
};

// --- views ------------------------------------------------------------------

// The stepper drives `body[data-page]`, the view-switch source of truth.
// `requestRender` covers state changes with no store event — a step click or
// `goTo` from loadPath — the same pattern the device picker uses for its grace
// timer.
const nav = mountNav({ requestRender: () => render() });
goToClip = () => nav.goTo('clip');

const views: View[] = [
  feedback,
  mountActivity(),
  mountTray(),
  nav,
  mountDropZone({
    actions,
    feedback,
    resolvePath: (file) => api.pathForFile(file),
    getThumbnail,
  }),
  mountDevicePicker({ actions, requestRender: () => render() }),
  mountLaunch({ actions }),
  mountTracks({ actions, feedback }),
  mountAdvanced({ actions }),
  mountPlayerBar({ actions }),
  mountCasting({ getThumbnail }),
  mountRecents({ actions, getThumbnail }),
];

function render(): void {
  const state = store.get();
  for (const view of views) view.render(state);
  renderPosition();
}

function renderPosition(): void {
  const state = store.get();
  const position = store.getPosition(Date.now());
  for (const view of views) view.renderPosition?.(state, position);
}

// --- engine events (engine → store) ----------------------------------------

function wireEngineEvents(): void {
  api.onMode((mode: EngineMode) => {
    store.setMode(mode);
    feedback.applyMode(mode);
  });
  api.onDevices((devices) => {
    // Discovery can finish AFTER a file was probed. mDNS is slow on real
    // hardware, so a file dropped in the first seconds has already run its
    // replan — and bailed, because no device was selected yet. When the device
    // then turns up here the store auto-selects it, but nothing re-plans for it:
    // the file sits with media + device but no plan, Play stays disabled, and
    // there is no error to explain why (a plan FAILURE would at least banner).
    // So: if this push changed the selected device, plan for it. Guarded on an
    // actual change so a steady stream of identical mDNS pushes does not replan
    // on every one. (`replan()` itself no-ops when there is no media yet.)
    const before = store.get().selectedDeviceId;
    store.setDevices(devices);
    if (store.get().selectedDeviceId !== before && store.get().selectedDeviceId !== null) {
      void replan();
    }
  });
  api.onStatus((status) => {
    store.applyStatus(status, Date.now());
    // Throttled: keep the resume point roughly current while the file plays.
    recordRecent();
  });
  api.onState((state) => {
    store.applyState(state, Date.now());
    // The natural "you left it here" moments — pin the resume point exactly.
    if (state === 'stopped' || state === 'error') recordRecent(true);
  });
  api.onPosition((position) => store.applyPosition(position, Date.now()));
  api.onWarning((warning) => {
    store.addWarning(warning);
    feedback.toast(warning);
  });
  api.onError((message) => {
    feedback.clearBanner('session');
    feedback.toast(cleanErr(message), true);
  });
  api.onEnded(() => {
    // Record BEFORE clearing — clearSession drops the status this reads from.
    recordRecent(true);
    store.clearSession(Date.now());
    feedback.clearBanner('session');
    feedback.toast('Playback ended');
  });
}

// --- boot -------------------------------------------------------------------

function frame(): void {
  renderPosition();
  requestAnimationFrame(frame);
}

async function boot(): Promise<void> {
  // The sidebar's version string. Deliberately NOT a view: a view exists to turn
  // AppState into DOM on every notification, and this is a build-time constant
  // that is written once and never again. `__APP_VERSION__` is substituted by
  // Vite from packages/app/package.json (see vite.config.ts), the same field
  // electron-builder stamps into the bundle — so what the sidebar shows and what
  // Get Info shows cannot drift. The " · your Mac" suffix stays in the markup.
  el('app-version').textContent = `v${__APP_VERSION__}`;

  store.subscribe(render);
  wireEngineEvents();

  // Before any device list arrives, so the first `setDevices()` — whether it
  // comes from `listDevices()` below or from an mDNS push that beats it — can
  // already honour the remembered device instead of grabbing devices[0].
  store.setPreferredDeviceId(devicePreference.read());

  // Restore persisted state before the first paint so the empty-state recents
  // grid and the Advanced prefs are correct on launch, not one frame late.
  store.setRecents(recents.list());
  const storedPrefs = prefsPreference.read();
  if (storedPrefs) store.setPrefs(storedPrefs);

  try {
    const mode = await api.getMode();
    store.setMode(mode);
    feedback.applyMode(mode);
    store.setDevices(await api.listDevices());
    const status = await api.getStatus();
    if (status) store.applyStatus(status, Date.now());
  } catch (err) {
    feedback.toast(`Startup error: ${cleanErr(err)}`, true);
  }

  render();
  requestAnimationFrame(frame);
}

void boot();

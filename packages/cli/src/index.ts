/**
 * @castgorilla/cli — the `castgorilla` command surface.
 *
 * Commands:
 *   castgorilla devices [--json] [--timeout 5]
 *   castgorilla probe <file> [--device <name>] [--surround] [--hdr warn|block] [--json]
 *   castgorilla play  <file> --device <name|host> [--surround] [--hdr warn|block]
 *                                                [--audio <idx>] [--start mm:ss|sec] [--volume 0..1]
 *
 * Exit codes: 0 clean, 1 error, 2 plan refused (PlanRefusedError).
 *
 * Everything comes from @castgorilla/engine — the CLI reaches into no subpaths.
 */

import { parseArgs } from 'node:util';
import { emitKeypressEvents, createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

import {
  createEngine,
  CastDiscovery,
  PROFILES,
  buildPlaybackPlan,
  probe as probeFile,
  PlanRefusedError,
  discoverSidecars,
  MediaServer,
  resolveFfmpeg,
  PlaybackSessionImpl,
  type DiscoveredDevice,
  type MediaInfo,
  type PlaybackPlan,
  type PlaybackPrefs,
  type PlaybackSession,
  type SidecarSub,
  type Track,
} from '@castgorilla/engine';

import { parseTimecode, parseVolume, parseHdrPolicy, formatTimecode, formatPercent } from './parse.js';
import { renderDeviceTable, renderMediaSummary, renderPlan, buildProbeJson } from './render.js';

const USAGE = `castgorilla — cast local video to a Chromecast

Usage:
  castgorilla devices [--json] [--timeout <sec>]
  castgorilla probe <file> [--device <name>] [--surround] [--hdr warn|block] [--json]
  castgorilla play  <file> --device <name|host> [--surround] [--hdr warn|block]
                          [--audio <idx>] [--start <mm:ss|sec>] [--volume <0..1>]
                          [--sub <auto|none|trackId|path>]

Play keys:  space pause/resume  ←/→ ±10s  ↑/↓ vol ±5%  m mute
            g seek (mm:ss)  s subtitle  a audio  q quit`;

const out = (s = ''): void => void process.stdout.write(s + '\n');
const err = (s = ''): void => void process.stderr.write(s + '\n');
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// --- Discovery --------------------------------------------------------------

async function discover(timeoutMs: number): Promise<DiscoveredDevice[]> {
  const disc = new CastDiscovery();
  const byId = new Map<string, DiscoveredDevice>();
  disc.on('device', (d) => byId.set(d.id, d));
  disc.on('error', () => {
    /* surfaced to the user via an empty list */
  });
  disc.start();
  await delay(timeoutMs);
  disc.stop();
  return [...byId.values()];
}

/** Match a device by exact friendlyName/id/host, then case-insensitive substring. */
function pickDevice(devices: DiscoveredDevice[], query: string): DiscoveredDevice | undefined {
  const q = query.toLowerCase();
  return (
    devices.find((d) => d.friendlyName.toLowerCase() === q || d.id.toLowerCase() === q || d.host === query) ??
    devices.find((d) => d.friendlyName.toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
  );
}

/** A bare IP that was not discovered: cast to it directly with the conservative profile. */
function synthDevice(hostOrName: string): DiscoveredDevice | undefined {
  if (!IPV4.test(hostOrName)) return undefined;
  return {
    id: hostOrName,
    friendlyName: hostOrName,
    model: '',
    host: hostOrName,
    port: 8009,
    profile: PROFILES.unknown,
  };
}

function prefsFrom(values: { surround?: boolean; hdr?: string }): PlaybackPrefs | null {
  const hdr = parseHdrPolicy(values.hdr);
  if (hdr === null) {
    err(`error: --hdr must be 'warn' or 'block'`);
    return null;
  }
  return { surround: values.surround ?? false, hdrPolicy: hdr };
}

// --- subtitles --------------------------------------------------------------

/** The resolved `--sub` request. */
type SubMode =
  | { kind: 'auto' }
  | { kind: 'none' }
  | { kind: 'track'; id: number }
  | { kind: 'path'; path: string };

/** Interpret `--sub <auto|none|trackId|path>`. Returns an error string on garbage. */
function parseSubArg(input: string | undefined): { mode: SubMode } | { error: string } {
  if (input === undefined || input === 'auto') return { mode: { kind: 'auto' } };
  if (input === 'none') return { mode: { kind: 'none' } };
  if (/^\d+$/.test(input)) return { mode: { kind: 'track', id: Number(input) } };
  if (existsSync(input)) return { mode: { kind: 'path', path: input } };
  return {
    error: `--sub must be auto|none|<trackId>|<path> (got "${input}"; not a keyword, integer, or existing file)`,
  };
}

/** Read the session's live TEXT (subtitle) tracks via its diagnostics snapshot. */
type Diagnosable = { diagnostics?: () => { load?: { tracks?: Track[] } } };
function textTracksOf(session: PlaybackSession): Track[] {
  const tracks = (session as unknown as Diagnosable).diagnostics?.().load?.tracks ?? [];
  return tracks.filter((t) => t.type === 'TEXT');
}

// --- devices ----------------------------------------------------------------

async function runDevices(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });
  const timeoutSec = values.timeout ? Number(values.timeout) : 5;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    err('error: --timeout must be a positive number of seconds');
    return 1;
  }
  const devices = await discover(timeoutSec * 1000);
  if (values.json) {
    out(
      JSON.stringify(
        devices.map((d) => ({
          id: d.id,
          friendlyName: d.friendlyName,
          model: d.model,
          profile: d.profile.key,
          host: d.host,
          port: d.port,
        })),
        null,
        2,
      ),
    );
  } else {
    out(renderDeviceTable(devices));
  }
  return 0;
}

// --- probe ------------------------------------------------------------------

async function resolveDeviceProfile(
  deviceQuery: string | undefined,
): Promise<{ device?: DiscoveredDevice; profile: DiscoveredDevice['profile'] }> {
  if (!deviceQuery) return { profile: PROFILES.unknown };
  const devices = await discover(5000);
  const device = pickDevice(devices, deviceQuery) ?? synthDevice(deviceQuery);
  if (!device) {
    err(`warning: device "${deviceQuery}" not found — planning against the 'unknown' profile`);
    return { profile: PROFILES.unknown };
  }
  return { device, profile: device.profile };
}

async function runProbe(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      device: { type: 'string' },
      surround: { type: 'boolean', default: false },
      hdr: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    err('error: probe requires a <file> argument\n');
    err(USAGE);
    return 1;
  }
  if (!existsSync(file)) {
    err(`error: file not found: ${file}`);
    return 1;
  }
  const prefs = prefsFrom(values);
  if (!prefs) return 1;

  let media: MediaInfo;
  try {
    media = await probeFile(file);
  } catch (e) {
    err(`error: probe failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const { device, profile } = await resolveDeviceProfile(values.device);

  let plan: PlaybackPlan | undefined;
  let refused: string | undefined;
  try {
    plan = buildPlaybackPlan(media, profile, prefs);
  } catch (e) {
    if (e instanceof PlanRefusedError) refused = e.reason;
    else throw e;
  }

  const sidecars = await discoverSidecars(file).catch(() => [] as SidecarSub[]);

  if (values.json) {
    if (plan) out(JSON.stringify(buildProbeJson(media, plan, device), null, 2));
    else out(JSON.stringify({ file: media.path, refused }, null, 2));
    return refused ? 2 : 0;
  }

  out(renderMediaSummary(media, sidecars));
  out('');
  if (plan) {
    out(renderPlan(plan));
    return 0;
  }
  out(`Plan:  REFUSED — ${refused}`);
  return 2;
}

// --- play -------------------------------------------------------------------

async function runPlay(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      device: { type: 'string' },
      surround: { type: 'boolean', default: false },
      hdr: { type: 'string' },
      audio: { type: 'string' },
      start: { type: 'string' },
      volume: { type: 'string' },
      sub: { type: 'string' },
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    err('error: play requires a <file> argument\n');
    err(USAGE);
    return 1;
  }
  if (!existsSync(file)) {
    err(`error: file not found: ${file}`);
    return 1;
  }
  if (!values.device) {
    err('error: play requires --device <name|host>');
    return 1;
  }
  const prefs = prefsFrom(values);
  if (!prefs) return 1;

  let startSec = 0;
  if (values.start !== undefined) {
    const parsed = parseTimecode(values.start);
    if (parsed === null) {
      err(`error: --start must be seconds or mm:ss (got "${values.start}")`);
      return 1;
    }
    startSec = parsed;
  }
  let volume: number | undefined;
  if (values.volume !== undefined) {
    const v = parseVolume(values.volume);
    if (v === null) {
      err(`error: --volume must be a number 0..1 (got "${values.volume}")`);
      return 1;
    }
    volume = v;
  }
  let audioIdx: number | undefined;
  if (values.audio !== undefined) {
    const n = Number(values.audio);
    if (!Number.isInteger(n)) {
      err(`error: --audio must be an integer stream index (got "${values.audio}")`);
      return 1;
    }
    audioIdx = n;
  }
  const subParsed = parseSubArg(values.sub);
  if ('error' in subParsed) {
    err(`error: ${subParsed.error}`);
    return 1;
  }
  const subMode = subParsed.mode;

  // Resolve the target device.
  err(`Discovering devices…`);
  const devices = await discover(5000);
  const device = pickDevice(devices, values.device) ?? synthDevice(values.device);
  if (!device) {
    err(`error: device "${values.device}" not found. Try: castgorilla devices`);
    return 1;
  }

  const engine = createEngine();
  let media: MediaInfo;
  try {
    media = await engine.probe(file);
  } catch (e) {
    err(`error: probe failed: ${e instanceof Error ? e.message : String(e)}`);
    await engine.shutdown();
    return 1;
  }

  // Plan first so a refusal exits 2 before we ever touch the device.
  let plan: PlaybackPlan;
  try {
    plan = engine.plan(media, device.profile, prefs);
  } catch (e) {
    await engine.shutdown();
    if (e instanceof PlanRefusedError) {
      err(`Refused: ${e.reason}`);
      return 2;
    }
    err(`error: planning failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  err(`Casting "${file}" to ${device.friendlyName} (${device.host})  tier=${plan.tier}`);

  // A `--sub <path>` external track must be resolved into the session at start,
  // which the frozen Engine.play() surface can't carry — so for that one case we
  // drive PlaybackSession directly over a CLI-owned media server. Every other
  // case goes through the engine unchanged.
  let session: PlaybackSession;
  let extraServer: MediaServer | undefined;
  try {
    if (subMode.kind === 'path') {
      extraServer = new MediaServer();
      await extraServer.listen();
      const ff = await resolveFfmpeg();
      session = await PlaybackSessionImpl.start({
        device,
        media,
        plan,
        prefs,
        server: extraServer,
        ff,
        extraSubtitlePaths: [subMode.path],
      });
    } else {
      session = await engine.play({ device, media, plan, prefs });
    }
  } catch (e) {
    if (extraServer) await extraServer.close();
    await engine.shutdown();
    if (e instanceof PlanRefusedError) {
      err(`Refused: ${e.reason}`);
      return 2;
    }
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const code = await drivePlayback(session, media, device, { startSec, volume, audioIdx, sub: subMode });
  await session.stop().catch(() => undefined);
  if (extraServer) await extraServer.close();
  await engine.shutdown();
  return code;
}

interface PlayInit {
  startSec: number;
  volume: number | undefined;
  audioIdx: number | undefined;
  sub: SubMode;
}

/** Attach listeners, apply initial flags, run the 1Hz status line + key loop. */
function drivePlayback(
  session: PlaybackSession,
  media: MediaInfo,
  device: DiscoveredDevice,
  init: PlayInit,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
    let exitCode = 0;
    let finished = false;
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    let detachKeys: () => void = () => {};

    // Label map for the active-subtitle readout + the `s`-key cycle.
    const subLabels = new Map<number, string>(
      textTracksOf(session).map((t) => [t.trackId, t.name ?? `Track ${t.trackId}`]),
    );

    const clearLine = (): void => {
      if (isTty) process.stdout.write('\r\x1b[2K');
    };
    const printStatus = (): void => {
      const s = session.status();
      const subPart =
        subLabels.size > 0
          ? `  sub=${s.activeSubtitleTrackId === null ? 'off' : subLabels.get(s.activeSubtitleTrackId) ?? `#${s.activeSubtitleTrackId}`}`
          : '';
      const line =
        `[${s.state}] ${formatTimecode(s.positionSec)}/${formatTimecode(s.durationSec)}  ` +
        `tier=${s.tier}  dev=${device.friendlyName}  vol=${formatPercent(s.volume)}${s.muted ? ' (muted)' : ''}${subPart}`;
      if (isTty) {
        clearLine();
        process.stdout.write(line);
      } else {
        out(line);
      }
    };

    const finish = (c: number): void => {
      if (finished) return;
      finished = true;
      exitCode = c;
      if (statusTimer) clearInterval(statusTimer);
      detachKeys();
      clearLine();
      resolve(exitCode);
    };

    session.on('warning', (w) => {
      clearLine();
      err(`⚠ ${w}`);
    });
    session.on('ended', () => {
      clearLine();
      err('Playback finished.');
      finish(0);
    });
    session.on('error', (e) => {
      clearLine();
      err(`Playback error: ${e.message}`);
      finish(1);
    });

    // Apply initial flags once we're underway (best-effort; failures are non-fatal).
    void (async () => {
      try {
        if (init.volume !== undefined) await session.setVolume(init.volume);
        if (init.audioIdx !== undefined && init.audioIdx !== session.status().activeAudioStreamIndex) {
          await session.selectAudioStream(init.audioIdx);
        }
        // Subtitle selection: auto keeps the session default; none/track/path override.
        if (init.sub.kind === 'none') {
          await session.selectSubtitleTrack(null);
        } else if (init.sub.kind === 'track') {
          await session.selectSubtitleTrack(init.sub.id);
        } else if (init.sub.kind === 'path') {
          // The external file was appended as the last TEXT track — select it.
          const last = textTracksOf(session).at(-1);
          if (last) await session.selectSubtitleTrack(last.trackId);
        }
        if (init.startSec > 0) await session.seek(init.startSec);
      } catch {
        /* ignore — the user can drive manually */
      }
    })();

    statusTimer = setInterval(printStatus, 1000);
    statusTimer.unref?.();
    printStatus();

    const quit = (): void => {
      err('');
      err('Stopping…');
      finish(exitCode);
    };

    // SIGINT always means quit (clean stop).
    process.on('SIGINT', quit);

    if (isTty) {
      const detach = attachKeys(session, media, {
        onQuit: quit,
        redraw: printStatus,
        pauseStatus: () => {
          if (statusTimer) clearInterval(statusTimer);
        },
        resumeStatus: () => {
          statusTimer = setInterval(printStatus, 1000);
          statusTimer.unref?.();
        },
      });
      detachKeys = () => {
        detach();
        process.off('SIGINT', quit);
      };
    } else {
      // Non-interactive: just stream status lines until ended/error/SIGINT.
      detachKeys = () => process.off('SIGINT', quit);
    }
  });
}

interface KeyHooks {
  onQuit: () => void;
  redraw: () => void;
  pauseStatus: () => void;
  resumeStatus: () => void;
}

function attachKeys(session: PlaybackSession, media: MediaInfo, hooks: KeyHooks): () => void {
  emitKeypressEvents(process.stdin);
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* not all TTYs support raw mode */
  }
  process.stdin.resume();

  // Subtitle cycle order: off → each resolved TEXT track → off. Track ids are the
  // session's sequential subtitle trackIds (embedded + sidecar), not ffprobe indices.
  const subIds: (number | null)[] = [null, ...textTracksOf(session).map((t) => t.trackId)];
  const audioIds: number[] = media.audio.map((a) => a.index);

  const adjustVolume = async (delta: number): Promise<void> => {
    const v = Math.max(0, Math.min(1, session.status().volume + delta));
    await session.setVolume(v).catch(() => undefined);
  };

  const promptSeek = async (): Promise<void> => {
    hooks.pauseStatus();
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => rl.question('\rseek to (mm:ss): ', res));
    rl.close();
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    const t = parseTimecode(answer);
    if (t !== null) await session.seek(t).catch(() => undefined);
    hooks.resumeStatus();
    hooks.redraw();
  };

  const cycleSub = async (): Promise<void> => {
    const cur = session.status().activeSubtitleTrackId;
    const idx = subIds.findIndex((x) => x === cur);
    const next = subIds[(idx + 1) % subIds.length] ?? null;
    await session.selectSubtitleTrack(next).catch(() => undefined);
  };

  const cycleAudio = async (): Promise<void> => {
    if (audioIds.length <= 1) return;
    const cur = session.status().activeAudioStreamIndex;
    const idx = audioIds.findIndex((x) => x === cur);
    const next = audioIds[(idx + 1) % audioIds.length];
    if (next !== undefined) await session.selectAudioStream(next).catch(() => undefined);
  };

  const onKey = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
    if (!key) return;
    const name = key.name;
    if (name === 'q' || (key.ctrl && name === 'c')) return void hooks.onQuit();
    if (name === 'space') {
      const st = session.status().state;
      void (st === 'playing' ? session.pause() : session.resume()).catch(() => undefined);
    } else if (name === 'right') {
      void session.seek(session.status().positionSec + 10).catch(() => undefined);
    } else if (name === 'left') {
      void session.seek(session.status().positionSec - 10).catch(() => undefined);
    } else if (name === 'up') {
      void adjustVolume(0.05);
    } else if (name === 'down') {
      void adjustVolume(-0.05);
    } else if (name === 'm') {
      void session.setMuted(!session.status().muted).catch(() => undefined);
    } else if (name === 'g') {
      void promptSeek();
    } else if (name === 's') {
      void cycleSub();
    } else if (name === 'a') {
      void cycleAudio();
    }
  };

  process.stdin.on('keypress', onKey);
  return () => {
    process.stdin.off('keypress', onKey);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    process.stdin.pause();
  };
}

// --- dispatch ---------------------------------------------------------------

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'devices':
      return runDevices(rest);
    case 'probe':
      return runProbe(rest);
    case 'play':
      return runPlay(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      out(USAGE);
      return command === undefined ? 1 : 0;
    default:
      err(`error: unknown command "${command}"\n`);
      err(USAGE);
      return 1;
  }
}

export { parseTimecode, formatTimecode, parseVolume, parseHdrPolicy } from './parse.js';
export { buildProbeJson, renderDeviceTable, renderMediaSummary, renderPlan } from './render.js';

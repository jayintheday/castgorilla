#!/usr/bin/env node
/**
 * spike-hls-selftest.mjs — device-free HLS pipeline self-test.
 *
 * Every other spike needs a Chromecast in the room, which confounds two
 * variables at once: "is our HLS output valid?" and "does this receiver accept
 * it?". This tool answers the FIRST one on its own.
 *
 * It stands up the REAL engine pipeline for a file — probe → buildPlaybackPlan
 * against a named device profile → MediaServer + HlsSession, wired exactly the
 * way PlaybackSessionImpl.prepare() wires them — then acts as the HLS client
 * itself over plain HTTP on 127.0.0.1 and validates what comes back:
 *
 *   - the synthesized playlist, printed verbatim;
 *   - init.mp4 + seg0..segN with status / content-type / bytes / latency
 *     (seg0 latency is the number that says whether a device would starve);
 *   - ffprobe of the FETCHED bytes (init, and init+seg0 joined) so we see the
 *     actual codec/stream shape a receiver would be handed;
 *   - an ffmpeg decode pass over the served playlist URL (`-f null -`), the
 *     single strongest signal that the stream is well-formed;
 *   - an INIT STABILITY check: ffmpeg does NOT write init.mp4 atomically and
 *     HlsSession.fileReady() only guards `size > 0`, so a partially-written init
 *     can be served with a valid Content-Length. We stat the on-disk init twice,
 *     a beat apart, at first-fetch time and report whether it grew;
 *   - a BOUNDARY DRIFT check: our #EXTINF values come from the keyframe index
 *     (computeBoundaries) while ffmpeg cuts on `-hls_time`. If those disagree on
 *     a video-copy tier, the advertised timeline desyncs from the media.
 *
 * The HlsSession is always disposed (kills ffmpeg + removes its work dir), on
 * success, failure and SIGINT alike.
 *
 * Usage:
 *   npx tsc -b     # the engine must be built — this drives packages/engine/dist
 *   node scripts/spikes/spike-hls-selftest.mjs --file fixtures/mp4-h264-aac51.mp4
 *   node scripts/spikes/spike-hls-selftest.mjs --file f.mkv --profile ultra --segments 5
 *   node scripts/spikes/spike-hls-selftest.mjs --help
 *
 * Flags:
 *   --file <path>       (required) media file to run through the pipeline
 *   --profile <key>     device profile to plan against (default "unknown" —
 *                       what an NVIDIA Shield's mDNS md resolves to)
 *   --segments <n>      how many segments to fetch (default 3)
 *   --keep              leave the fetch dir on disk for inspection
 *   --no-validate       skip the ffmpeg decode pass
 *   --help
 *
 * Exit code: 0 = PASS, 1 = FAIL (bad fetch / failed validation / drift flagged),
 * 2 = bad usage or a direct-play plan (nothing to test).
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './_shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../packages/engine/dist');

/** Segment target the engine uses everywhere (session/playback-session.ts TARGET_SEC). */
const TARGET_SEC = 6;
/** Advertised-vs-actual segment duration delta we consider real drift. */
const DRIFT_TOLERANCE_SEC = 0.1;
/** Gap between the two init.mp4 stats. */
const INIT_STABILITY_GAP_MS = 400;
/** Give up waiting for init.mp4 to appear on disk (HlsSession's own limit is 30s). */
const INIT_WATCH_TIMEOUT_MS = 35_000;

const HELP = `spike-hls-selftest.mjs — device-free HLS pipeline self-test

  --file <path>       (required) media file to run through the real pipeline
  --profile <key>     device profile to plan against (default "unknown")
  --segments <n>      segments to fetch (default 3)
  --keep              leave the fetch dir on disk for inspection
  --no-validate       skip the ffmpeg decode pass over the playlist
  --help

Answers "is OUR HLS output valid?" with no Cast device involved: stands up the
real MediaServer + HlsSession, acts as the HLS client over 127.0.0.1, and
ffprobes/decodes what it gets back. Build the engine first: npx tsc -b`;

// --- tiny output helpers ----------------------------------------------------

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(...a) {
  console.log(ts(), ...a);
}
function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}
function ms(n) {
  return `${n.toFixed(1)}ms`;
}

/** Lazily import the built engine's public entry (so --help works before a build). */
async function loadEngine() {
  const entry = path.join(DIST, 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      `engine build not found at ${DIST}. Run \`npx tsc -b\` from the repo root first.`,
    );
  }
  return import(entry);
}

function execFileAsync(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout ?? '', stderr: stderr ?? '', code: err?.code ?? 0 });
    });
  });
}

// --- HTTP client ------------------------------------------------------------

/** GET a URL, timing the FULL body read (that's what starves a device). */
async function timedGet(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '-',
      bytes: buf.length,
      elapsedMs: performance.now() - t0,
      buf,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      contentType: '-',
      bytes: 0,
      elapsedMs: performance.now() - t0,
      buf: Buffer.alloc(0),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function reportFetch(label, r) {
  const err = r.error ? `  ERROR: ${r.error}` : '';
  log(
    `  ${label.padEnd(14)} ${String(r.status).padEnd(4)} ${String(r.contentType).padEnd(28)} ` +
      `${String(r.bytes).padStart(9)} B  ${ms(r.elapsedMs).padStart(10)}${err}`,
  );
}

// --- init.mp4 stability -----------------------------------------------------

/**
 * Watch the on-disk init file: the instant it is non-empty (which is exactly
 * when HlsSession.fileReady() lets the server serve it), record its size, wait
 * a beat, record it again. A growing file means we serve a truncated init.
 */
function watchInitStability(initPath, gapMs = INIT_STABILITY_GAP_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sizeOf = () => {
      try {
        return statSync(initPath).size;
      } catch {
        return -1;
      }
    };
    const iv = setInterval(() => {
      const first = sizeOf();
      if (first > 0) {
        clearInterval(iv);
        const firstAtMs = Date.now() - started;
        const t = setTimeout(() => {
          resolve({ observed: true, first, second: sizeOf(), gapMs, firstAtMs });
        }, gapMs);
        t.unref?.();
      } else if (Date.now() - started > INIT_WATCH_TIMEOUT_MS) {
        clearInterval(iv);
        resolve({ observed: false });
      }
    }, 10);
    iv.unref?.();
  });
}

// --- ffprobe ----------------------------------------------------------------

const PROBE_ENTRIES =
  'stream=index,codec_type,codec_name,profile,width,height,r_frame_rate,channels,channel_layout,sample_rate,duration' +
  ':format=format_name,duration,nb_streams';

async function ffprobeSummary(ffprobe, file) {
  const r = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-show_entries', PROBE_ENTRIES,
    '-of', 'json',
    file,
  ]);
  if (r.err) return { ok: false, stderr: r.stderr.trim() || String(r.err) };
  try {
    return { ok: true, json: JSON.parse(r.stdout), stderr: r.stderr.trim() };
  } catch (e) {
    return { ok: false, stderr: `unparsable ffprobe output: ${e instanceof Error ? e.message : e}` };
  }
}

function renderProbe(res) {
  if (!res.ok) return `    FAILED: ${res.stderr}`;
  const lines = [];
  const f = res.json.format ?? {};
  lines.push(`    format=${f.format_name ?? '?'} nb_streams=${f.nb_streams ?? '?'} duration=${f.duration ?? '-'}`);
  for (const s of res.json.streams ?? []) {
    if (s.codec_type === 'video') {
      lines.push(
        `    #${s.index} video  ${s.codec_name}${s.profile ? ` (${s.profile})` : ''} ` +
          `${s.width}x${s.height} fps=${s.r_frame_rate} dur=${s.duration ?? '-'}`,
      );
    } else if (s.codec_type === 'audio') {
      lines.push(
        `    #${s.index} audio  ${s.codec_name}${s.profile ? ` (${s.profile})` : ''} ` +
          `${s.channels}ch ${s.channel_layout ?? ''} ${s.sample_rate}Hz dur=${s.duration ?? '-'}`,
      );
    } else {
      lines.push(`    #${s.index} ${s.codec_type}  ${s.codec_name}`);
    }
  }
  if (lines.length === 1) lines.push('    (no streams reported)');
  return lines.join('\n');
}

/**
 * Real playable duration of a fetched segment. Per-stream `duration` is often
 * absent in a bare fMP4 fragment, so sum the video packet durations; fall back
 * to the container duration.
 */
async function segmentDurationOf(ffprobe, file) {
  const pk = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=duration_time',
    '-of', 'csv=p=0',
    file,
  ]);
  if (!pk.err) {
    let sum = 0;
    let n = 0;
    for (const line of pk.stdout.split('\n')) {
      const v = Number(line.trim().replace(/,$/, ''));
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        n++;
      }
    }
    if (n > 0) return { sec: sum, source: `${n} video packets` };
  }
  const fm = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const v = Number(fm.stdout.trim());
  if (!fm.err && Number.isFinite(v) && v > 0) return { sec: v, source: 'container duration' };
  return { sec: NaN, source: 'unavailable' };
}

// --- playlist ---------------------------------------------------------------

function parseExtinf(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const m = /^#EXTINF:([0-9.]+)/.exec(raw.trim());
    if (m) out.push(Number(m[1]));
  }
  return out;
}

// --- plan helpers (mirroring PlaybackSessionImpl) ---------------------------

function needsKeyframes(plan) {
  return (
    plan.method === 'hls' &&
    plan.video.kind === 'copy' &&
    plan.segmentation?.mode === 'keyframe' &&
    !plan.segmentation.boundaries
  );
}

function resolveBoundaries(plan, media, keyframePts, engine) {
  const dur = plan.durationSec || media.durationSec;
  if (plan.segmentation?.mode === 'keyframe') {
    if (plan.segmentation.boundaries && plan.segmentation.boundaries.length > 0) {
      return plan.segmentation.boundaries;
    }
    if (keyframePts && keyframePts.length > 0) {
      return engine.computeBoundaries(keyframePts, dur, TARGET_SEC);
    }
  }
  return engine.fixedBoundaries(dur, TARGET_SEC);
}

function describeVideo(v) {
  if (v.kind === 'copy') return `copy${v.tag ? ` (tag ${v.tag})` : ''}`;
  const scale = v.scale ? ` → ${v.scale.w}x${v.scale.h}` : '';
  return `transcode ${v.encoder} q=${v.quality}${scale}${v.maxFps ? ` @${v.maxFps}fps` : ''}`;
}
function describeAudio(a) {
  if (a.kind === 'copy') return 'copy';
  return `transcode ${a.encoder} ${a.bitrate} ${a.channels}ch${a.filters?.length ? ` [${a.filters.join(',')}]` : ''}`;
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2), ['keep', 'no-validate', 'help']);
  if (args.help || process.argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (!args.file) {
    console.error('error: --file is required\n');
    console.error(HELP);
    return 2;
  }
  const file = path.resolve(args.file);
  if (!existsSync(file)) {
    console.error(`error: file not found: ${file}`);
    return 2;
  }
  const profileKey = args.profile ?? 'unknown';
  const wantSegments = args.segments ? Number(args.segments) : 3;
  if (!Number.isInteger(wantSegments) || wantSegments < 1) {
    console.error(`error: --segments must be a positive integer (got "${args.segments}")`);
    return 2;
  }
  const doValidate = !args['no-validate'];

  const engine = await loadEngine();
  const profile = engine.PROFILES[profileKey];
  if (!profile) {
    console.error(
      `error: unknown --profile "${profileKey}". Known: ${Object.keys(engine.PROFILES).join(', ')}`,
    );
    return 2;
  }

  console.log(`spike-hls-selftest — device-free HLS pipeline check`);
  console.log(`  file:    ${file}`);
  console.log(`  profile: ${profile.key}`);

  const ff = await engine.resolveFfmpeg();
  log(`ffmpeg: ${ff.version}`);

  // 1 — probe + plan (exactly as the session does).
  section('PLAN');
  const media = await engine.probe(file);
  const prefs = { surround: false, hdrPolicy: 'warn' };
  let keyframePts;
  let plan;
  try {
    plan = engine.buildPlaybackPlan(media, profile, prefs);
    if (needsKeyframes(plan)) {
      keyframePts = await engine.extractKeyframeIndex(media.path, plan.videoStreamIndex);
      plan = engine.buildPlaybackPlan(media, profile, prefs, { keyframePts });
    }
  } catch (e) {
    if (e instanceof engine.PlanRefusedError) {
      console.error(`\nPLAN REFUSED — ${e.reason ?? e.message}`);
      console.error('Nothing to self-test: the planner will not play this file on this profile.');
      return 2;
    }
    throw e;
  }

  console.log(`  method:        ${plan.method}`);
  console.log(`  tier:          ${plan.tier}`);
  console.log(`  video:         ${describeVideo(plan.video)}`);
  console.log(`  audio:         ${describeAudio(plan.audio)}`);
  console.log(`  segmentFormat: ${plan.segmentFormat ?? '(n/a)'}`);
  console.log(
    `  segmentation:  ${plan.segmentation ? `${plan.segmentation.mode} target=${plan.segmentation.targetSec}s` : '(n/a)'}`,
  );
  console.log(`  contentType:   ${plan.contentType}`);
  console.log(`  durationSec:   ${plan.durationSec}`);
  console.log(`  hdrOutcome:    ${plan.hdrOutcome}`);
  for (const r of plan.reasons) console.log(`  reason:        ${r}`);

  if (plan.method !== 'hls') {
    console.log('');
    console.log(
      `BAIL: this file plans to DIRECT play (tier=${plan.tier}) on profile "${profile.key}" — ` +
        'there is no HLS pipeline to self-test.',
    );
    console.log('Pick a file that plans to hls, or a more conservative --profile.');
    return 2;
  }

  const segFmt = plan.segmentFormat ?? 'fmp4';
  const segExt = segFmt === 'ts' ? 'ts' : 'm4s';

  // 2 — stand up the real server + HlsSession, as PlaybackSessionImpl.prepare() does.
  section('PIPELINE');
  const boundaries = resolveBoundaries(plan, media, keyframePts, engine);
  const workDir = await mkdtemp(path.join(tmpdir(), 'ss-selftest-work-'));
  const fetchDir = await mkdtemp(path.join(tmpdir(), 'ss-selftest-fetch-'));

  const logger = engine.createLogger('selftest');
  const server = new engine.MediaServer(logger.child('server'));
  const port = await server.listen();
  const hls = new engine.HlsSession({
    media,
    plan,
    boundaries,
    input: media.path,
    workDir,
    ff,
    logger: logger.child('hls'),
  });
  const routeId = 'selftest';
  const localPath = server.registerHls(routeId, hls);
  const base = `http://127.0.0.1:${port}${localPath.replace(/playlist\.m3u8$/, '')}`;
  const playlistUrl = `http://127.0.0.1:${port}${localPath}`;

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      server.unregister(routeId);
    } catch { /* ignore */ }
    // dispose() kills ffmpeg AND removes the work dir — must always run.
    await hls.dispose().catch(() => {});
    await server.close().catch(() => {});
    if (args.keep) {
      console.log(`\n(--keep) fetched bytes left in: ${fetchDir}`);
    } else {
      await rm(fetchDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const onSignal = () => {
    console.log('\ninterrupted — disposing HLS session ...');
    dispose().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const failures = [];
  const flags = [];

  try {
    console.log(`  work dir:   ${workDir}`);
    console.log(`  fetch dir:  ${fetchDir}`);
    console.log(`  server:     127.0.0.1:${port}`);
    console.log(`  playlist:   ${playlistUrl}`);
    console.log(`  boundaries: ${boundaries.length} segments, first: [${boundaries.slice(0, 8).map((b) => b.toFixed(3)).join(', ')}${boundaries.length > 8 ? ', …' : ''}]`);

    // warmup() is what the session calls so seg0 is ready ASAP.
    const warmAt = performance.now();
    hls.warmup();
    log('ffmpeg warmup() issued');

    // 3 — act as the HLS client.
    section('PLAYLIST');
    const pl = await timedGet(playlistUrl);
    reportFetch('playlist', pl);
    if (!pl.ok) failures.push(`playlist fetch returned HTTP ${pl.status}`);
    console.log('');
    console.log(pl.buf.toString('utf8').replace(/^/gm, '  | '));

    const extinf = parseExtinf(pl.buf.toString('utf8'));
    console.log(`  (#EXTINF count: ${extinf.length}; playlist declares segFmt=${segFmt})`);

    section('SEGMENT FETCHES');
    log('  resource       code type                         bytes     latency');

    let initBuf;
    let initFetchedBytes = 0;
    // The stability watcher runs on its own timer; do NOT await it here or its
    // settle gap would be charged to the seg0 latency we are trying to measure.
    let stabilityP;
    if (segFmt === 'fmp4') {
      stabilityP = watchInitStability(path.join(workDir, 'init.mp4'));
      const initRes = await timedGet(`${base}init.mp4`);
      reportFetch('init.mp4', initRes);
      if (!initRes.ok || initRes.bytes === 0) {
        failures.push(`init.mp4 fetch returned HTTP ${initRes.status} / ${initRes.bytes} bytes`);
      }
      initBuf = initRes.buf;
      initFetchedBytes = initRes.bytes;
      await writeFile(path.join(fetchDir, 'init.mp4'), initBuf);
    }

    const n = Math.min(wantSegments, boundaries.length);
    const fetched = [];
    for (let i = 0; i < n; i++) {
      const name = `seg${i}.${segExt}`;
      const r = await timedGet(`${base}${name}`);
      reportFetch(name, r);
      if (!r.ok || r.bytes === 0) {
        failures.push(`${name} fetch returned HTTP ${r.status} / ${r.bytes} bytes`);
        continue;
      }
      const raw = path.join(fetchDir, name);
      await writeFile(raw, r.buf);
      // A bare fMP4 fragment is not parsable alone — join it onto the init.
      const probeFile = path.join(fetchDir, `probe-seg${i}.mp4`);
      if (segFmt === 'fmp4' && initBuf) await writeFile(probeFile, Buffer.concat([initBuf, r.buf]));
      else await writeFile(probeFile, r.buf);
      fetched.push({ i, name, raw, probeFile, bytes: r.bytes, elapsedMs: r.elapsedMs });
    }
    if (fetched.length > 0) {
      log(`  seg0 first-byte-to-last-byte latency: ${ms(fetched[0].elapsedMs)} ` +
        `(${ms(performance.now() - warmAt)} after warmup) — this is what starves a device`);
    }

    const initStability = stabilityP
      ? { ...(await stabilityP), fetchedBytes: initFetchedBytes }
      : { observed: false, skipped: true };

    // 4a — ffprobe the fetched bytes.
    section('FFPROBE (fetched bytes)');
    if (segFmt === 'fmp4') {
      console.log('  init.mp4:');
      console.log(renderProbe(await ffprobeSummary(ff.ffprobe, path.join(fetchDir, 'init.mp4'))));
    }
    if (fetched.length > 0) {
      console.log(`  seg0.${segExt}${segFmt === 'fmp4' ? ' (joined onto init.mp4)' : ''}:`);
      const r = await ffprobeSummary(ff.ffprobe, fetched[0].probeFile);
      console.log(renderProbe(r));
      if (!r.ok) failures.push('ffprobe could not parse the fetched seg0');
      else if ((r.json.streams ?? []).length === 0) failures.push('fetched seg0 reports zero streams');
    } else {
      failures.push('no segments were fetched — nothing to ffprobe');
    }

    // 4b — init stability.
    section('INIT STABILITY (init.mp4 is not written atomically)');
    if (initStability.skipped) {
      console.log('  n/a — TS segments have no init.mp4');
    } else if (!initStability.observed) {
      console.log('  could not observe init.mp4 on disk (never became non-empty?)');
      failures.push('init.mp4 never appeared on disk');
    } else {
      const grew = initStability.second !== initStability.first;
      console.log(`  first non-empty at +${initStability.firstAtMs}ms: ${initStability.first} B`);
      console.log(`  again ${initStability.gapMs}ms later:        ${initStability.second} B`);
      console.log(`  bytes actually served:        ${initStability.fetchedBytes} B`);
      if (grew) {
        console.log(
          `  *** UNSTABLE: init.mp4 grew by ${initStability.second - initStability.first} B after ` +
            'fileReady() said it was servable — a truncated init may have been served.',
        );
        flags.push('init.mp4 was still being written when it became servable');
      } else if (initStability.fetchedBytes !== initStability.second) {
        console.log(
          `  *** MISMATCH: served ${initStability.fetchedBytes} B but the final file is ${initStability.second} B.`,
        );
        flags.push('init.mp4 served a different byte count than the final on-disk file');
      } else {
        console.log('  stable — the size did not change and we served the whole file.');
      }
    }

    // 4c — boundary drift.
    section('BOUNDARY DRIFT (advertised #EXTINF vs. what ffmpeg actually cut)');
    let drifted = 0;
    if (fetched.length === 0) {
      console.log('  n/a — no segments fetched');
    } else {
      console.log('  seg   advertised   actual      delta     source');
      for (const f of fetched) {
        const adv = extinf[f.i];
        const act = await segmentDurationOf(ff.ffprobe, f.probeFile);
        const delta = Number.isFinite(act.sec) && adv !== undefined ? act.sec - adv : NaN;
        const bad = Number.isFinite(delta) && Math.abs(delta) > DRIFT_TOLERANCE_SEC;
        if (bad) drifted++;
        console.log(
          `  ${String(f.i).padEnd(5)} ${(adv ?? NaN).toFixed(3).padStart(9)}s ` +
            `${(Number.isFinite(act.sec) ? act.sec.toFixed(3) : '   n/a').padStart(9)}s ` +
            `${(Number.isFinite(delta) ? (delta >= 0 ? '+' : '') + delta.toFixed(3) : 'n/a').padStart(8)}s` +
            `${bad ? '  <<< DRIFT' : '          '}  ${act.source}`,
        );
      }
      if (drifted > 0) {
        flags.push(
          `${drifted}/${fetched.length} segment(s) drift more than ${DRIFT_TOLERANCE_SEC}s from the advertised #EXTINF`,
        );
      } else {
        console.log(`  all within ±${DRIFT_TOLERANCE_SEC}s — the advertised timeline matches the media.`);
      }
    }

    // 4d — the decode pass.
    section('DECODE PASS (ffmpeg -i <playlist> -t 20 -f null -)');
    if (!doValidate) {
      console.log('  skipped (--no-validate)');
    } else {
      const t0 = performance.now();
      const r = await execFileAsync(
        ff.ffmpeg,
        ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-i', playlistUrl, '-t', '20', '-f', 'null', '-'],
        { timeout: 180_000 },
      );
      const took = performance.now() - t0;
      if (r.err) {
        console.log(`  FAILED after ${ms(took)} (exit ${r.err.code ?? r.err.signal ?? '?'})`);
        console.log('  ffmpeg stderr (verbatim):');
        console.log((r.stderr || '(empty)').replace(/^/gm, '  | '));
        failures.push('ffmpeg could not decode the served playlist');
      } else if (r.stderr.trim().length > 0) {
        console.log(`  decoded 20s in ${ms(took)}, but ffmpeg emitted warnings:`);
        console.log(r.stderr.trim().replace(/^/gm, '  | '));
        flags.push('ffmpeg decoded the playlist but emitted warnings');
      } else {
        console.log(`  clean — decoded 20s of the served playlist in ${ms(took)} with no diagnostics.`);
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    const alive = hls.aliveFfmpegCount;
    await dispose();
    section('TEARDOWN');
    console.log(`  ffmpeg children alive before dispose: ${alive}; after dispose: ${hls.aliveFfmpegCount}`);
    console.log(`  work dir removed: ${!existsSync(workDir)}`);
  }

  section('SUMMARY');
  console.log(`  file:    ${path.basename(file)}`);
  console.log(`  profile: ${profile.key}   method=${plan.method} tier=${plan.tier} segFmt=${segFmt}`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  for (const f of flags) console.log(`  FLAG  ${f}`);
  const bad = failures.length + flags.length;
  console.log('');
  console.log(
    bad === 0
      ? '  PASS — our HLS output is well-formed and served correctly (no device involved).'
      : `  FAIL — ${failures.length} failure(s), ${flags.length} flag(s). See above.`,
  );
  return bad === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('spike-hls-selftest failed:', err?.stack ?? err);
    process.exit(1);
  });

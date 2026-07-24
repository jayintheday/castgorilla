#!/usr/bin/env node
/**
 * spike-load.mjs — the G1 hardware-gate tool.
 *
 * LOADs an arbitrary URL with a caller-specified content type and HLS segment
 * formats onto a real device, then prints the full MEDIA_STATUS (and any error
 * payload) VERBATIM. This is how we answer the hardware-gate questions:
 *   R1: does HEVC-in-HLS play on Ultra / Chromecast-with-Google-TV?
 *   R2: fMP4 vs TS segments on gen2 / gen3?
 *
 * Point --url at an HLS master.m3u8 served by static-server.mjs (or any reachable
 * URL). A LOAD_FAILED / ERROR payload is printed in full so the exact
 * detailedErrorCode / reason is captured for the gate decision.
 *
 * Usage:
 *   npm run build
 *   node scripts/spikes/spike-load.mjs --device Ultra \
 *     --url http://<lan-ip>:8010/master.m3u8 \
 *     --content-type application/vnd.apple.mpegurl \
 *     --hls-segment-format FMP4 --hls-video-segment-format FMP4
 *
 *   node scripts/spikes/spike-load.mjs --help
 *
 * Flags:
 *   --device <name|id>              (required) device to load on
 *   --url <url>                     (required) media URL
 *   --content-type <ct>            MIME (default application/vnd.apple.mpegurl)
 *   --stream-type <BUFFERED|LIVE>  default BUFFERED
 *   --duration <sec>               optional media duration hint
 *   --hls-segment-format <FMP4|TS_AAC|...>        LoadRequest.media.hlsSegmentFormat
 *   --hls-video-segment-format <FMP4|MPEG2_TS>    LoadRequest.media.hlsVideoSegmentFormat
 *   --watch <ms>                   keep printing status pushes for <ms> (default 15000)
 *   --no-stop                      leave the item playing (don't STOP at the end)
 *   --timeout <ms>                 discovery window (default 4000)
 *   --help
 */

import { parseArgs, discoverDevices, pickDevice, describeDevice, loadEngine, pretty } from './_shared.mjs';

const HELP = `spike-load.mjs — LOAD arbitrary media + print full MEDIA_STATUS (G1 gate tool)

  --device <name|id>                  (required) device to load on
  --url <url>                         (required) media URL
  --content-type <ct>                 MIME (default application/vnd.apple.mpegurl)
  --stream-type <BUFFERED|LIVE|NONE>  default BUFFERED
  --duration <sec>                    optional duration hint
  --hls-segment-format <fmt>          FMP4 | TS | TS_AAC | MPEG2_TS | AAC | AC3 | MP3 | E_AC3
  --hls-video-segment-format <fmt>    FMP4 | MPEG2_TS
  --watch <ms>                        print status pushes for <ms> (default 15000)
  --no-stop                           leave the item playing
  --timeout <ms>                      discovery window ms (default 4000)
  --help`;

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(...a) {
  console.log(ts(), ...a);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['no-stop', 'help']);
  if (args.help || process.argv.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }
  if (!args.url) {
    console.error('error: --url is required\n');
    console.error(HELP);
    process.exit(2);
  }

  const timeoutMs = args.timeout ? Number(args.timeout) : 4000;
  log(`discovering Chromecasts for ${timeoutMs}ms ...`);
  const devices = await discoverDevices({ timeoutMs, onFound: (d) => log('found:', describeDevice(d)) });
  if (devices.length === 0) {
    log('no devices found.');
    process.exit(1);
  }

  const device = pickDevice(devices, args.device);
  if (!device) {
    log(`no device matched --device "${args.device ?? '(none given)'}". Devices:`);
    for (const d of devices) console.log('  -', describeDevice(d));
    process.exit(1);
  }

  // Build the LoadMediaInformation exactly as specified.
  const media = {
    contentId: args.url,
    contentType: args['content-type'] ?? 'application/vnd.apple.mpegurl',
    streamType: args['stream-type'] ?? 'BUFFERED',
  };
  if (args.duration !== undefined) media.duration = Number(args.duration);
  if (args['hls-segment-format']) media.hlsSegmentFormat = args['hls-segment-format'];
  if (args['hls-video-segment-format']) media.hlsVideoSegmentFormat = args['hls-video-segment-format'];

  log('LoadMediaInformation:');
  console.log(pretty(media));

  const { CastClient } = await loadEngine();
  log(`connecting to ${describeDevice(device)}`);
  const client = await CastClient.connect(device.host, { port: device.port });
  client.on('reconnecting', () => log('! reconnecting ...'));
  client.on('reconnected', () => log('! reconnected'));
  client.on('session-lost', () => log('! session lost'));
  client.on('error', (err) => log('client error:', err.message));

  const controller = await client.launchDefaultMediaReceiver();
  controller.on('status', (s) => {
    log(`status push: playerState=${s.playerState} t=${s.currentTime} idleReason=${s.idleReason ?? '-'}`);
  });

  let loadOk = false;
  try {
    log('LOAD ...');
    const status = await controller.load(media, { autoplay: true });
    loadOk = true;
    log('LOAD succeeded. Full MEDIA_STATUS:');
    console.log(pretty(status));
  } catch (err) {
    log('LOAD FAILED. Error (verbatim):');
    // CastCommandError carries the raw device payload; print everything useful.
    console.log(
      pretty({
        name: err?.name,
        code: err?.code,
        message: err?.message,
        responseType: err?.responseType,
        detailedErrorCode: err?.detailedErrorCode,
        reason: err?.reason,
        payload: err?.payload,
      }),
    );
  }

  const watchMs = args.watch ? Number(args.watch) : 15_000;
  log(`watching status for ${watchMs}ms ...`);
  await sleep(watchMs);

  log('final lastStatus:');
  console.log(pretty(controller.lastStatus ?? null));

  if (loadOk && !args['no-stop']) {
    log('STOP');
    await controller.stop().catch((e) => log('stop error:', e.message));
  }
  client.close();
  log('done.');
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('spike-load failed:', err?.stack ?? err);
  process.exit(1);
});

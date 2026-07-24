#!/usr/bin/env node
/**
 * spike-basic.mjs — end-to-end smoke test against a REAL Chromecast.
 *
 * Discovers devices (printing model + resolved profile), and — with --device —
 * connects, launches the Default Media Receiver, LOADs a URL (or a default
 * sample), reports every playerState transition, optionally SEEKs after 10s,
 * then STOPs and disconnects.
 *
 * Usage:
 *   npm run build
 *   node scripts/spikes/spike-basic.mjs                       # list devices only
 *   node scripts/spikes/spike-basic.mjs --device "Living Room"
 *   node scripts/spikes/spike-basic.mjs --device Ultra --url http://<lan-ip>:8010/movie.mp4 \
 *        --content-type video/mp4 --seek 120
 *   node scripts/spikes/spike-basic.mjs --help
 *
 * Flags:
 *   --device <name|id>   friendly name / id (substring ok). Omit to just list.
 *   --url <url>          media URL to LOAD (default: Big Buck Bunny MP4)
 *   --content-type <ct>  MIME type for the URL (default: video/mp4)
 *   --seek <sec>         after 10s of playback, seek to <sec>
 *   --timeout <ms>       discovery window (default 4000)
 *   --help
 */

import { parseArgs, discoverDevices, pickDevice, describeDevice } from './_shared.mjs';

const HELP = `spike-basic.mjs — discover + connect + launch + load + seek + stop

  --device <name|id>   device to drive (substring match). Omit to only list.
  --url <url>          media URL to LOAD (default: sample Big Buck Bunny MP4)
  --content-type <ct>  MIME type (default: video/mp4)
  --seek <sec>         seek to <sec> after ~10s of playback
  --timeout <ms>       discovery window in ms (default 4000)
  --help`;

const DEFAULT_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(...a) {
  console.log(ts(), ...a);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help !== undefined || process.argv.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }

  const timeoutMs = args.timeout ? Number(args.timeout) : 4000;
  log(`discovering Chromecasts for ${timeoutMs}ms ...`);
  const devices = await discoverDevices({
    timeoutMs,
    onFound: (d) => log('found:', describeDevice(d)),
  });

  if (devices.length === 0) {
    log('no devices found. Is this Mac on the same LAN/VLAN as the Chromecast?');
    process.exit(1);
  }
  log(`${devices.length} device(s):`);
  for (const d of devices) console.log('  -', describeDevice(d));

  if (!args.device) {
    log('no --device given; listing only. Re-run with --device <name> to drive one.');
    process.exit(0);
  }

  const device = pickDevice(devices, args.device);
  if (!device) {
    log(`no device matched --device "${args.device}". See the list above.`);
    process.exit(1);
  }

  const url = args.url ?? DEFAULT_URL;
  const contentType = args['content-type'] ?? 'video/mp4';
  const { loadEngine } = await import('./_shared.mjs');
  const { CastClient } = await loadEngine();

  log(`connecting to ${describeDevice(device)}`);
  const client = await CastClient.connect(device.host, { port: device.port });
  client.on('reconnecting', () => log('! reconnecting ...'));
  client.on('reconnected', () => log('! reconnected'));
  client.on('session-lost', () => log('! session lost'));
  client.on('error', (err) => log('client error:', err.message));

  log('launching Default Media Receiver ...');
  const media = await client.launchDefaultMediaReceiver();

  let last;
  media.on('status', (s) => {
    if (s.playerState !== last) {
      last = s.playerState;
      log(`playerState -> ${s.playerState}  (t=${s.currentTime?.toFixed?.(1) ?? s.currentTime}s)`);
    }
  });

  log(`LOAD ${url}  (${contentType})`);
  const status = await media.load(
    { contentId: url, contentType, streamType: 'BUFFERED' },
    { autoplay: true },
  );
  log(`LOAD ok: mediaSessionId=${status.mediaSessionId} playerState=${status.playerState}`);

  await sleep(10_000);

  if (args.seek !== undefined) {
    const sec = Number(args.seek);
    log(`seeking to ${sec}s ...`);
    const seeked = await media.seek(sec);
    log(`after seek: t=${seeked.currentTime}s playerState=${seeked.playerState}`);
    await sleep(4000);
  }

  log('STOP');
  await media.stop().catch((e) => log('stop error:', e.message));
  client.close();
  log('done.');
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('spike-basic failed:', err?.stack ?? err);
  process.exit(1);
});

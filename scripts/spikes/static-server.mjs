#!/usr/bin/env node
/**
 * static-server.mjs — THROWAWAY local file server for hardware spikes ONLY.
 *
 * This is NOT the engine's streaming server. It exists so a spike can hand a
 * Chromecast a URL it can fetch off this Mac: it serves a file or directory with
 * HTTP Range support (seeking) and permissive CORS, and answers preflight
 * OPTIONS. Do not use it for anything real.
 *
 * Usage:
 *   node scripts/spikes/static-server.mjs --file /path/to/movie.mp4 [--port 8010]
 *   node scripts/spikes/static-server.mjs --dir  /path/to/hls-output [--port 8010]
 *   node scripts/spikes/static-server.mjs --help
 *
 * Prints the LAN URL(s) to feed to spike-basic / spike-load.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HELP = `static-server.mjs — throwaway Range+CORS file server for cast spikes

  --file <path>   serve a single file (URL path is ignored, always returns it)
  --dir  <path>   serve a directory tree (URL path maps to a file under it)
  --port <n>      listen port (default 8010)
  --host <ip>     bind address (default 0.0.0.0)
  --help          show this help

Exactly one of --file / --dir is required (unless --help).`;

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.json': 'application/json',
};

function parseArgs(argv) {
  const args = { port: 8010, host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
  }
  return args;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Encoding, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function resolveTarget(args, reqUrl) {
  if (args.file) return path.resolve(args.file);
  const rel = decodeURIComponent(new URL(reqUrl, 'http://x').pathname).replace(/^\/+/, '');
  const base = path.resolve(args.dir);
  const resolved = path.resolve(base, rel);
  // Prevent path traversal outside the served directory.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function serve(req, res, args) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, corsHeaders());
    res.end('Method Not Allowed');
    return;
  }

  const target = resolveTarget(args, req.url);
  if (!target) {
    res.writeHead(403, corsHeaders());
    res.end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    res.writeHead(404, corsHeaders());
    res.end('Not Found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, corsHeaders());
    res.end('Not Found');
    return;
  }

  const total = stat.size;
  const headers = {
    ...corsHeaders(),
    'Content-Type': contentTypeFor(target),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    let start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
    let end = m[2] === '' ? total - 1 : Number(m[2]);
    start = Math.max(0, start);
    end = Math.min(end, total - 1);
    if (start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(total) });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!args.file && !args.dir) {
    console.error('error: one of --file or --dir is required\n');
    console.error(HELP);
    process.exit(2);
  }
  if (args.file && !fs.existsSync(args.file)) {
    console.error(`error: file not found: ${args.file}`);
    process.exit(2);
  }
  if (args.dir && !fs.existsSync(args.dir)) {
    console.error(`error: directory not found: ${args.dir}`);
    process.exit(2);
  }

  const server = http.createServer((req, res) => {
    // Per-request log: proves WHAT the device fetched and from WHERE. Mirrors the
    // engine MediaServer's one-line-per-request format so spike output and engine
    // output can be compared directly.
    const t0 = Date.now();
    const remote = `${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? 0}`;
    res.once('close', () => {
      const aborted = res.writableFinished ? '' : ' ABORTED';
      console.log(
        `${new Date().toISOString().slice(11, 23)} ${req.method} ${req.url} ` +
          `range=${req.headers.range ?? '-'} -> ${res.statusCode} ${Date.now() - t0}ms ` +
          `remote=${remote}${aborted}`,
      );
    });
    try {
      serve(req, res, args);
    } catch (err) {
      res.writeHead(500, corsHeaders());
      res.end(String(err));
    }
  });

  server.listen(args.port, args.host, () => {
    const what = args.file ? `file ${path.resolve(args.file)}` : `dir ${path.resolve(args.dir)}`;
    console.log(`static-server: serving ${what} on port ${args.port}`);
    for (const ip of lanIps()) {
      const suffix = args.file ? `/${path.basename(args.file)}` : '/<path-under-dir>';
      console.log(`  http://${ip}:${args.port}${suffix}`);
    }
    console.log('Ctrl-C to stop.');
  });
}

main();

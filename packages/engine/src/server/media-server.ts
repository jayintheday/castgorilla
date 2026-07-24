/**
 * server/media-server.ts — the LAN HTTP server the Cast device pulls from.
 *
 * One server per engine. It exposes three kinds of resource, each registered by
 * a caller-chosen id and torn down with unregister():
 *  - direct:  a source file streamed with Range support   (registerDirect)
 *  - hls:     an HlsSession's playlist + init + segments   (registerHls)
 *  - file:    an arbitrary file (e.g. a sidecar .vtt)      (registerFile)
 *
 * Binds 0.0.0.0:0 (report the actual port). urlFor() turns a local path into the
 * absolute URL to advertise to a specific device, using the LAN interface on the
 * device's subnet (pickLanIp).
 *
 * OBSERVABILITY (this is the diagnostic backbone for "the app hangs on
 * loading"): every request is logged on ONE line at debug (and at warn when the
 * response is not 2xx) with method, path, Range, status, body bytes, elapsed ms
 * and the REMOTE ADDRESS — the remote address is what proves the device (and not
 * localhost) actually reached us, i.e. that pickLanIp chose an interface on the
 * device's subnet. Per-registration counters (statsFor) record what the device
 * did fetch, so a stalled PlaybackSession can name the stage that failed:
 * nothing fetched at all / playlist but no segments / segments but no playback.
 *
 * ONE exception to "not 2xx ⇒ warn/error": a segment the HlsSession abandoned
 * because the user seeked (SupersededError) is routine scrub control flow. It
 * still answers 500 on the wire — unchanged, deliberately, since we have no
 * hardware evidence for how a receiver reacts to each status mid-scrub — but it
 * logs at debug and does not count towards RouteStats.errors. A single scrub can
 * abandon two dozen in-flight segments; logging those as errors buried genuine
 * faults and made a healthy session read as broken.
 *
 * DISCONNECT IS ALSO A SIGNAL, not just an outcome: every request carries an
 * AbortController that fires when the socket closes before the response
 * finished, and that signal is threaded into HlsSession. A receiver scanning
 * during a scrub opens a connection per segment and abandons most of them in
 * ~53ms; without the signal each of those still armed an ffmpeg restart for a
 * position the user never landed on. Those requests reject with
 * RequestAbandonedError and are answered with nothing at all — the client is
 * already gone.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pickLanIp } from '../util/net.js';
import { createLogger, type Logger } from '../util/logger.js';
import { applyCors, handleOptions, contentTypeFor } from './cors.js';
import { serveFile } from './range.js';
import { SupersededError, RequestAbandonedError, type HlsSession } from '../hls/session.js';

interface FileReg {
  /** Registration id this path belongs to (so requests can be attributed). */
  id: string;
  filePath: string;
  contentType: string;
}

/** What a single registration id has actually served. See statsFor(). */
export interface RouteStats {
  /** GET /hls/<id>/playlist.m3u8 */
  playlist: number;
  /** GET /hls/<id>/init.mp4 */
  init: number;
  /** GET /hls/<id>/seg<N>.(m4s|ts) */
  segments: number;
  /** Anything else attributed to this id (direct file, sidecar .vtt, odd sub-path). */
  other: number;
  /**
   * Responses that finished with a non-2xx status AND represent a genuine fault.
   *
   * Deliberately NOT incremented for a segment superseded by a seek-restart:
   * that is routine scrub control flow (see SupersededError), and this counter
   * is quoted verbatim to the user by PlaybackSessionImpl.diagnoseStall() as
   * "N error response(s)". Inflating it with scrub churn would make that
   * diagnosis actively misleading. The wire status is unaffected.
   */
  errors: number;
  /** Total response body bytes written for this id. */
  bytes: number;
  /** Path of the most recent request. */
  lastPath: string | undefined;
  /** Date.now() of the most recent request. */
  lastAt: number | undefined;
  /** Date.now() of the first request. */
  firstAt: number | undefined;
  /** '<ip>:<port>' of the most recent requester — proves WHO is fetching. */
  lastRemote: string | undefined;
}

interface IdEntry {
  filePaths?: string[];
  hls?: string;
  stats: RouteStats;
}

type RouteKind = 'playlist' | 'init' | 'segments' | 'other';

const SEG_RE = /^seg(\d+)\.(m4s|ts)$/;

function newStats(): RouteStats {
  return {
    playlist: 0,
    init: 0,
    segments: 0,
    other: 0,
    errors: 0,
    bytes: 0,
    lastPath: undefined,
    lastAt: undefined,
    firstAt: undefined,
    lastRemote: undefined,
  };
}

/**
 * Wrap res.write/res.end so we can report the BODY bytes actually written.
 * Content-Length only says what we promised; a device that walks away mid-segment
 * shows up as a short write, which is exactly the kind of thing we are hunting.
 */
function countBody(res: ServerResponse): () => number {
  let bytes = 0;
  const add = (chunk: unknown, encoding: unknown): void => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    if (typeof chunk === 'string') {
      const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
      bytes += Buffer.byteLength(chunk, enc);
    } else if (ArrayBuffer.isView(chunk)) {
      bytes += chunk.byteLength;
    }
  };
  const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  res.write = function (this: ServerResponse, ...args: unknown[]): boolean {
    add(args[0], args[1]);
    return origWrite(...args);
  } as unknown as ServerResponse['write'];
  res.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    add(args[0], args[1]);
    return origEnd(...args);
  } as unknown as ServerResponse['end'];
  return () => bytes;
}

export class MediaServer {
  private readonly server: Server;
  private readonly log: Logger;

  /** Exact-path → file registration (direct + sidecar files). */
  private readonly files = new Map<string, FileReg>();
  /** id → HlsSession (prefix routes under /hls/<id>/). */
  private readonly hls = new Map<string, HlsSession>();
  /** id → what it registered + what it has served, for unregister() / statsFor(). */
  private readonly idIndex = new Map<string, IdEntry>();
  /**
   * Responses whose non-2xx status is EXPECTED control flow rather than a fault
   * (today: a segment superseded by a seek-restart). Membership demotes the
   * one-line request log to debug and keeps the response out of
   * RouteStats.errors — without touching the status that goes on the wire.
   *
   * A WeakSet keyed on the response object is what fits this code shape: the
   * decision is made deep inside serveHls()/hlsError() while the accounting
   * happens in the onRequest() 'close' handler, and threading a flag back up
   * through three call frames (two of which are `void`-returning) would be far
   * more invasive than a mark the finaliser can read. Entries evict themselves
   * with the response.
   */
  private readonly expectedNonError = new WeakSet<ServerResponse>();

  private _port = 0;

  constructor(logger?: Logger) {
    this.log = logger ?? createLogger('server');
    this.server = createServer((req, res) => {
      this.onRequest(req, res).catch((e) => {
        this.log.error('request handler error', e instanceof Error ? e : new Error(String(e)));
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('internal error');
        } else {
          res.destroy();
        }
      });
    });
  }

  /** Start listening on 0.0.0.0:0; resolves with the chosen port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '0.0.0.0', () => {
        this.server.off('error', reject);
        const addr = this.server.address() as AddressInfo;
        this._port = addr.port;
        this.log.info(`media server listening on 0.0.0.0:${this._port}`);
        resolve(this._port);
      });
    });
  }

  get port(): number {
    return this._port;
  }

  // --- registration -------------------------------------------------------

  registerDirect(id: string, filePath: string, contentType: string): string {
    const p = `/direct/${encodeURIComponent(id)}`;
    this.files.set(p, { id, filePath, contentType });
    this.idIndex.set(id, { filePaths: [p], stats: newStats() });
    return p;
  }

  registerFile(id: string, filePath: string, contentType: string): string {
    const p = `/file/${encodeURIComponent(id)}`;
    this.files.set(p, { id, filePath, contentType });
    this.idIndex.set(id, { filePaths: [p], stats: newStats() });
    return p;
  }

  registerHls(id: string, session: HlsSession): string {
    this.hls.set(id, session);
    this.idIndex.set(id, { hls: id, stats: newStats() });
    return `/hls/${encodeURIComponent(id)}/playlist.m3u8`;
  }

  unregister(id: string): void {
    const entry = this.idIndex.get(id);
    if (!entry) return;
    if (entry.filePaths) for (const p of entry.filePaths) this.files.delete(p);
    if (entry.hls) this.hls.delete(entry.hls);
    this.idIndex.delete(id);
  }

  /**
   * What the device has actually fetched for a registration id, or undefined if
   * the id is not (or no longer) registered. A snapshot — safe to keep.
   */
  statsFor(id: string): RouteStats | undefined {
    const entry = this.idIndex.get(id);
    return entry ? { ...entry.stats } : undefined;
  }

  /** Absolute URL to advertise to a device for a local path. */
  urlFor(localPath: string, deviceHost: string): string {
    const ip = pickLanIp(deviceHost);
    return `http://${ip}:${this._port}${localPath}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      // Don't wait on lingering keep-alive sockets.
      this.server.closeAllConnections?.();
    });
  }

  // --- routing ------------------------------------------------------------

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = Date.now();
    const method = req.method ?? 'GET';
    const rangeHeader = req.headers['range'];
    // Capture the peer NOW: the socket may be gone by the time we log.
    const remote = `${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? 0}`;
    const bodyBytes = countBody(res);

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      pathname = req.url ?? '/';
    }

    const hit = this.attribute(pathname);
    if (hit) this.noteRequest(hit.id, hit.kind, pathname, remote);

    // ONE line per request, emitted once the response is done (so we know the
    // final status + how many bytes actually made it to the device).
    let logged = false;
    const finish = (): void => {
      if (logged) return;
      logged = true;
      const status = res.statusCode;
      const bytes = bodyBytes();
      const expected = this.expectedNonError.has(res);
      if (hit) this.noteResponse(hit.id, status, bytes, expected);
      const aborted = !res.writableFinished ? ' ABORTED' : '';
      const line =
        `${method} ${pathname} range=${rangeHeader ?? '-'} -> ${status} ` +
        `${bytes}B ${Date.now() - t0}ms remote=${remote}${aborted}`;
      // A superseded segment is a normal scrub outcome; warning on it would just
      // move the noise from ERROR to WARN, so it stays on the debug line.
      if (!expected && (status < 200 || status >= 300)) this.log.warn(line);
      else this.log.debug(line);
    };
    res.once('close', finish);

    // Client-disconnect signal, threaded into HlsSession. Without it a receiver
    // that walks away mid-scrub (measured: it holds a scan probe ~53ms) still
    // leaves a waiter parked here AND a debounced ffmpeg restart armed for a
    // segment nobody wants — 38 of 60 launches in the run-2 hardware trace had
    // no live request at launch time. Registered AFTER finish() so the request
    // has already been logged/accounted as `200 0B … ABORTED`; 200 is 2xx, so
    // this path cannot inflate RouteStats.errors and needs no expectedNonError
    // marking.
    const ac = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    applyCors(res); // on EVERY response

    if (method === 'OPTIONS') {
      handleOptions(res);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }

    // direct / sidecar files (exact path).
    const fileReg = this.files.get(pathname);
    if (fileReg) {
      await serveFile(req, res, fileReg.filePath, fileReg.contentType);
      return;
    }

    // hls: /hls/<id>/<rest>
    const m = /^\/hls\/([^/]+)\/(.+)$/.exec(pathname);
    if (m) {
      const id = decodeURIComponent(m[1] ?? '');
      const rest = m[2] ?? '';
      const session = this.hls.get(id);
      if (session) {
        await this.serveHls(req, res, session, rest, ac.signal);
        return;
      }
    }

    res.writeHead(404);
    res.end('not found');
  }

  // --- per-route accounting -----------------------------------------------

  /** Map a request path onto the registration id it belongs to, if any. */
  private attribute(pathname: string): { id: string; kind: RouteKind } | undefined {
    const fileReg = this.files.get(pathname);
    if (fileReg) return { id: fileReg.id, kind: 'other' };

    const m = /^\/hls\/([^/]+)\/(.+)$/.exec(pathname);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1] ?? '');
    if (!this.idIndex.has(id)) return undefined;
    const rest = m[2] ?? '';
    if (rest === 'playlist.m3u8') return { id, kind: 'playlist' };
    if (rest === 'init.mp4') return { id, kind: 'init' };
    if (SEG_RE.test(rest)) return { id, kind: 'segments' };
    return { id, kind: 'other' };
  }

  private noteRequest(id: string, kind: RouteKind, pathname: string, remote: string): void {
    const entry = this.idIndex.get(id);
    if (!entry) return;
    const s = entry.stats;
    s[kind] += 1;
    s.lastPath = pathname;
    s.lastAt = Date.now();
    if (s.firstAt === undefined) s.firstAt = s.lastAt;
    s.lastRemote = remote;
  }

  /**
   * `expectedNonError` marks a non-2xx that is routine control flow, so the
   * status still goes on the wire unchanged but the fault counter ignores it.
   */
  private noteResponse(id: string, status: number, bytes: number, expectedNonError = false): void {
    const entry = this.idIndex.get(id);
    if (!entry) return;
    entry.stats.bytes += bytes;
    if (!expectedNonError && (status < 200 || status >= 300)) entry.stats.errors += 1;
  }

  // --- HLS ----------------------------------------------------------------

  private async serveHls(
    req: IncomingMessage,
    res: ServerResponse,
    session: HlsSession,
    rest: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (rest === 'playlist.m3u8') {
      const body = session.playlistText();
      const buf = Buffer.from(body, 'utf8');
      res.setHeader('Content-Type', contentTypeFor('m3u8'));
      res.setHeader('Content-Length', String(buf.length));
      res.writeHead(200);
      if (req.method === 'HEAD') res.end();
      else res.end(buf);
      return;
    }

    if (rest === 'init.mp4') {
      try {
        const initPath = await session.getInitSegment(signal);
        await serveFile(req, res, initPath, contentTypeFor('mp4'));
      } catch (e) {
        if (e instanceof RequestAbandonedError) {
          this.log.debug('hls init dropped (client disconnected mid-wait)');
        } else {
          this.hlsError(res, session, e, 'init');
        }
      }
      return;
    }

    const seg = SEG_RE.exec(rest);
    if (seg) {
      const i = Number(seg[1]);
      try {
        const segPath = await session.getSegment(i, signal);
        await serveFile(req, res, segPath, contentTypeFor(seg[2] ?? 'm4s'));
      } catch (e) {
        // Checked FIRST: the client is already gone, so there is nothing to
        // write and no status to choose. finish() has logged it as ABORTED with
        // whatever status the socket died on, and noteResponse() has recorded
        // it — writing here would only throw. Debug, never error: this is the
        // receiver's own scrub behaviour, not a fault of ours.
        if (e instanceof RequestAbandonedError) {
          this.log.debug(`hls segment ${i} dropped (client disconnected mid-wait)`);
        } else if (e instanceof RangeError) {
          res.writeHead(404);
          res.end('segment out of range');
        } else {
          this.hlsError(res, session, e, `segment ${i}`);
        }
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }

  private hlsError(res: ServerResponse, _session: HlsSession, e: unknown, what: string): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err instanceof SupersededError) {
      // Expected during a scrub: the device had this segment in flight when the
      // user seeked, and HlsSession abandoned it in favour of the new target.
      // Debug, not error — and NOT counted in RouteStats.errors (see the
      // expectedNonError WeakSet). The status on the wire is unchanged.
      this.expectedNonError.add(res);
      this.log.debug(`hls ${what} abandoned (expected during seek): ${err.message}`);
    } else {
      this.log.error(`hls ${what} failed: ${err.message}`);
    }
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('streaming error');
    } else {
      res.destroy();
    }
  }
}

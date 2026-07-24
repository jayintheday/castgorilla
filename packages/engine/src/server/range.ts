/**
 * server/range.ts — RFC 7233 single-range file serving.
 *
 * Direct playback streams the source file to the device, which issues Range
 * requests to seek. We support a single byte range (the only form Cast uses):
 *  - no Range              → 200, full body
 *  - bytes=a-b / a- / -n   → 206 + Content-Range/Content-Length
 *  - unsatisfiable         → 416 + Content-Range: bytes * /size
 *  - HEAD                  → headers only, no body
 * Bodies stream via fs.createReadStream — never buffered whole.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

type ParsedRange = { start: number; end: number } | 'invalid' | 'unsatisfiable' | null;

/**
 * Parse a single-range `Range` header against a known size.
 * Returns inclusive {start,end}, or 'unsatisfiable' (→416), or 'invalid'/null
 * (treat as no range → 200).
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(.*)$/.exec(header.trim());
  if (!m) return 'invalid';
  // Only honor the first range in a (possibly multi-range) request.
  const first = (m[1] ?? '').split(',')[0]?.trim() ?? '';
  const dash = first.indexOf('-');
  if (dash < 0) return 'invalid';

  const startStr = first.slice(0, dash).trim();
  const endStr = first.slice(dash + 1).trim();

  if (startStr === '') {
    // Suffix range: bytes=-N → last N bytes.
    if (endStr === '') return 'invalid';
    const n = Number(endStr);
    if (!Number.isInteger(n) || n < 0) return 'invalid';
    if (n === 0) return 'unsatisfiable';
    if (size === 0) return 'unsatisfiable';
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isInteger(start) || start < 0) return 'invalid';
  if (start >= size) return 'unsatisfiable';

  let end: number;
  if (endStr === '') {
    end = size - 1;
  } else {
    const e = Number(endStr);
    if (!Number.isInteger(e) || e < start) return 'invalid';
    end = Math.min(e, size - 1);
  }
  return { start, end };
}

/**
 * Serve a file with range support + the given content type. Applies no CORS
 * itself — the server applies CORS to every response before dispatching here.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  let size: number;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    size = st.size;
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const isHead = req.method === 'HEAD';
  const parsed = parseRange(req.headers['range'], size);

  if (parsed === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.writeHead(416);
    res.end();
    return;
  }

  if (parsed === null || parsed === 'invalid') {
    // No / unparseable range → full 200.
    res.setHeader('Content-Length', String(size));
    res.writeHead(200);
    if (isHead) {
      res.end();
      return;
    }
    streamFile(res, filePath);
    return;
  }

  const { start, end } = parsed;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.writeHead(206);
  if (isHead) {
    res.end();
    return;
  }
  streamFile(res, filePath, start, end);
}

function streamFile(res: ServerResponse, filePath: string, start?: number, end?: number): void {
  const stream =
    start !== undefined && end !== undefined
      ? createReadStream(filePath, { start, end })
      : createReadStream(filePath);
  stream.on('error', () => {
    // Header may already be sent; just tear the socket down.
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

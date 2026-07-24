/**
 * server/cors.ts — permissive CORS + content-type helpers.
 *
 * Chromecast's media player fetches from a null/opaque origin, so every response
 * (playlist, segment, direct file, VTT) carries wide-open CORS headers, and we
 * expose the range headers the player relies on.
 */

import type { ServerResponse } from 'node:http';

/** Applied to EVERY response (including error responses and OPTIONS). */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept-Encoding, Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

export function applyCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

/** Answer a CORS preflight: 204 with the CORS headers already applied. */
export function handleOptions(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** Content-Type for a path/extension. Falls back to application/octet-stream. */
export function contentTypeFor(pathOrExt: string): string {
  const ext = pathOrExt.includes('.') ? pathOrExt.slice(pathOrExt.lastIndexOf('.') + 1).toLowerCase() : pathOrExt.toLowerCase();
  switch (ext) {
    case 'm3u8':
      return 'application/vnd.apple.mpegurl';
    case 'm4s':
      return 'video/iso.segment';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'ts':
      return 'video/mp2t';
    case 'vtt':
      return 'text/vtt';
    default:
      return 'application/octet-stream';
  }
}

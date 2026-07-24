/**
 * server-range: in-process MediaServer + real fetch — RFC 7233 range serving
 * and CORS on every response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaServer } from '../src/server/media-server.js';

const SIZE = 1000;
let server: MediaServer;
let dir: string;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ss-range-'));
  const file = path.join(dir, 'movie.bin');
  // Deterministic pattern: byte i === i % 256.
  const buf = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) buf[i] = i % 256;
  await writeFile(file, buf);

  server = new MediaServer();
  const port = await server.listen();
  const localPath = server.registerDirect('movie', file, 'video/mp4');
  base = `http://127.0.0.1:${port}${localPath}`;
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function expectCors(res: Response): void {
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
  expect(res.headers.get('access-control-expose-headers')).toContain('Content-Range');
}

describe('MediaServer range serving', () => {
  it('full GET → 200, whole body, Accept-Ranges', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expectCors(res);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(SIZE);
    expect(body[0]).toBe(0);
    expect(body[255]).toBe(255);
  });

  it('HEAD → 200, headers only, no body', async () => {
    const res = await fetch(base, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(0);
    expectCors(res);
  });

  it('mid-range bytes=100-199 → 206 with Content-Range + sliced body', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${SIZE}`);
    expect(res.headers.get('content-length')).toBe('100');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(100 % 256);
    expect(body[99]).toBe(199 % 256);
  });

  it('suffix range bytes=-50 → last 50 bytes', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=-50' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 950-999/${SIZE}`);
    expect(res.headers.get('content-length')).toBe('50');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(50);
    expect(body[49]).toBe(999 % 256);
  });

  it('open-ended bytes=500- → to EOF', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=500-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 500-999/${SIZE}`);
    expect(res.headers.get('content-length')).toBe('500');
  });

  it('first byte bytes=0-0 and last byte bytes=999-999', async () => {
    const first = await fetch(base, { headers: { Range: 'bytes=0-0' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-0/${SIZE}`);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([0]));

    const last = await fetch(base, { headers: { Range: 'bytes=999-999' } });
    expect(last.status).toBe(206);
    expect(last.headers.get('content-range')).toBe(`bytes 999-999/${SIZE}`);
    expect(new Uint8Array(await last.arrayBuffer())).toEqual(new Uint8Array([999 % 256]));
  });

  it('out-of-range → 416 with Content-Range: bytes */size', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=2000-3000' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`);
    expectCors(res);
  });

  it('OPTIONS → 204 with all CORS headers', async () => {
    const res = await fetch(base, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expectCors(res);
    expect(res.headers.get('access-control-allow-headers')).toContain('Range');
  });

  it('unknown path → 404 (still CORS)', async () => {
    const res = await fetch(base.replace('/direct/movie', '/nope'));
    expect(res.status).toBe(404);
    expectCors(res);
  });

  it('unregister removes the route', async () => {
    const s = new MediaServer();
    const port = await s.listen();
    const p = s.registerDirect('gone', path.join(dir, 'movie.bin'), 'video/mp4');
    const url = `http://127.0.0.1:${port}${p}`;
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
    s.unregister('gone');
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(404);
    await s.close();
  });
});

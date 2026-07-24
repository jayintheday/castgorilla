/**
 * server-cors: content-type mapping + CORS header set (pure).
 */
import { describe, it, expect } from 'vitest';
import { contentTypeFor, CORS_HEADERS } from '../src/server/cors.js';

describe('contentTypeFor', () => {
  it('maps the HLS + direct media extensions', () => {
    expect(contentTypeFor('playlist.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeFor('seg7.m4s')).toBe('video/iso.segment');
    expect(contentTypeFor('init.mp4')).toBe('video/mp4');
    expect(contentTypeFor('seg7.ts')).toBe('video/mp2t');
    expect(contentTypeFor('subs.vtt')).toBe('text/vtt');
  });
  it('accepts a bare extension and falls back to octet-stream', () => {
    expect(contentTypeFor('m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeFor('bin')).toBe('application/octet-stream');
  });
});

describe('CORS_HEADERS', () => {
  it('is wide-open GET/HEAD/OPTIONS and exposes range headers', () => {
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toBe('GET, HEAD, OPTIONS');
    expect(CORS_HEADERS['Access-Control-Allow-Headers']).toContain('Range');
    expect(CORS_HEADERS['Access-Control-Expose-Headers']).toContain('Content-Range');
    expect(CORS_HEADERS['Access-Control-Expose-Headers']).toContain('Accept-Ranges');
  });
});

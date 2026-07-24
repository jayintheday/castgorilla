/**
 * file-drop.test.ts — the drag-and-drop path validator.
 *
 * `isSupportedVideoPath` is the ONLY gate a dropped file passes through before
 * the app tries to probe it (a folder cannot be stat'd from the renderer), so
 * its edge cases are the app's edge cases: a dropped directory, a dotfile, a
 * directory whose NAME contains a dot.
 */

import { describe, expect, it } from 'vitest';
import {
  VIDEO_EXTENSIONS,
  isSupportedVideoPath,
} from '../src/shared/video-extensions.js';

describe('isSupportedVideoPath — accepted extensions', () => {
  it('accepts every extension the native picker offers', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isSupportedVideoPath(`/Users/x/Movies/clip.${ext}`)).toBe(true);
    }
  });

  it('lists the expected extensions (picker filter and drop validator share it)', () => {
    expect([...VIDEO_EXTENSIONS]).toEqual([
      'mp4',
      'm4v',
      'mov',
      'mkv',
      'webm',
      'avi',
      'ts',
      'm2ts',
      'wmv',
      'flv',
    ]);
  });

  it('is case-insensitive', () => {
    expect(isSupportedVideoPath('/x/CLIP.MKV')).toBe(true);
    expect(isSupportedVideoPath('/x/clip.Mp4')).toBe(true);
    expect(isSupportedVideoPath('/x/clip.M2TS')).toBe(true);
  });

  it('accepts a bare filename with no directory part', () => {
    expect(isSupportedVideoPath('clip.mkv')).toBe(true);
  });

  it('accepts a name with several dots — only the last one counts', () => {
    expect(isSupportedVideoPath('/x/Show.S01E01.1080p.mkv')).toBe(true);
  });

  it('accepts a hidden file that still carries a real extension', () => {
    expect(isSupportedVideoPath('/x/.hidden.mkv')).toBe(true);
  });

  it('accepts a Windows-style path', () => {
    expect(isSupportedVideoPath('C:\\Users\\x\\Movies\\clip.mkv')).toBe(true);
  });
});

describe('isSupportedVideoPath — rejected paths', () => {
  it('rejects a path with no extension at all (this is how a dropped FOLDER is rejected)', () => {
    expect(isSupportedVideoPath('/Users/x/Movies')).toBe(false);
    expect(isSupportedVideoPath('/Users/x/Movies/')).toBe(false);
  });

  it('rejects a file whose DIRECTORY contains a dot but whose name does not', () => {
    // The trap a naive `split('.').pop()` falls into: it would read "folder/movie".
    expect(isSupportedVideoPath('/x/my.folder/movie')).toBe(false);
  });

  it('...while still accepting the same file once it has an extension', () => {
    expect(isSupportedVideoPath('/x/my.folder/movie.mkv')).toBe(true);
  });

  it('rejects a dotfile with no real extension', () => {
    expect(isSupportedVideoPath('/x/.DS_Store')).toBe(false);
    expect(isSupportedVideoPath('/x/.mkv')).toBe(false);
    expect(isSupportedVideoPath('.mkv')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isSupportedVideoPath('')).toBe(false);
  });

  it('rejects non-video extensions', () => {
    expect(isSupportedVideoPath('/x/notes.txt')).toBe(false);
    expect(isSupportedVideoPath('/x/manual.pdf')).toBe(false);
    expect(isSupportedVideoPath('/x/cover.jpg')).toBe(false);
    expect(isSupportedVideoPath('/x/audio.mp3')).toBe(false);
    expect(isSupportedVideoPath('/x/subs.srt')).toBe(false);
  });

  it('rejects a trailing dot (no extension characters)', () => {
    expect(isSupportedVideoPath('/x/clip.')).toBe(false);
  });

  it('does not match an extension embedded mid-name', () => {
    expect(isSupportedVideoPath('/x/clip.mkv.bak')).toBe(false);
  });
});

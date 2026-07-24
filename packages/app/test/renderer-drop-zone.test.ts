/**
 * renderer-drop-zone.test.ts — the drag counter and the drop-payload decision.
 *
 * Both exist because of specific, reproducible DOM behaviour rather than taste:
 *
 *  - `dragenter`/`dragleave` fire once per nested descendant crossed. `#file-zone`
 *    contains an icon, a title, a hint, a button and an overlay, so a pointer
 *    moving across it generates a stream of leave events with no matching exit.
 *    A boolean flag flickers; only a depth counter does not.
 *  - A drop's `File` objects have no usable path (Electron 32 removed
 *    `File.path`), so by the time the app can decide anything it is holding
 *    `(string | null)[]` from `pathForFile`. Every interesting case — a folder, a
 *    PDF, a drag from a web page, five files at once — is a shape of that array.
 */

import { describe, expect, it } from 'vitest';
import {
  createDragCounter,
  dragCarriesFiles,
  selectDropPath,
} from '../src/renderer/views/drop-zone.js';

describe('createDragCounter', () => {
  it('stays active while nested children fire spurious leave events', () => {
    const counter = createDragCounter();
    // Pointer enters the zone, then the film icon, then the title.
    expect(counter.enter()).toBe(true);
    expect(counter.enter()).toBe(true);
    expect(counter.enter()).toBe(true);
    // Leaving the title and the icon must NOT drop the highlight — the pointer
    // is still inside the zone.
    expect(counter.leave()).toBe(true);
    expect(counter.leave()).toBe(true);
    // Only leaving the zone itself does.
    expect(counter.leave()).toBe(false);
  });

  it('reports inactive on the final leave and no earlier', () => {
    const counter = createDragCounter();
    counter.enter();
    counter.enter();
    expect(counter.depth).toBe(2);
    counter.leave();
    expect(counter.depth).toBe(1);
    counter.leave();
    expect(counter.depth).toBe(0);
  });

  it('clamps at zero so an unmatched leave cannot strand the class on', () => {
    const counter = createDragCounter();
    // A drag we declined (no files) still delivers dragleave.
    expect(counter.leave()).toBe(false);
    expect(counter.leave()).toBe(false);
    expect(counter.depth).toBe(0);
    // Without the clamp the depth would now be -2, and the next real drag would
    // need three enters before the highlight appeared.
    expect(counter.enter()).toBe(true);
    expect(counter.depth).toBe(1);
  });

  it('reset() forgets an in-progress drag entirely (this is the drop path)', () => {
    const counter = createDragCounter();
    counter.enter();
    counter.enter();
    counter.enter();
    expect(counter.reset()).toBe(false);
    expect(counter.depth).toBe(0);
  });
});

describe('dragCarriesFiles', () => {
  it('accepts a drag carrying files', () => {
    expect(dragCarriesFiles(['Files'])).toBe(true);
    expect(dragCarriesFiles(['text/plain', 'Files'])).toBe(true);
  });

  it('declines a text or link drag', () => {
    expect(dragCarriesFiles(['text/plain'])).toBe(false);
    expect(dragCarriesFiles(['text/uri-list', 'text/html'])).toBe(false);
    expect(dragCarriesFiles([])).toBe(false);
  });

  it('declines when there is no dataTransfer at all', () => {
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe('selectDropPath', () => {
  it('takes a single supported file with nothing to say about it', () => {
    expect(selectDropPath(['/Volumes/media/Show/episode.mkv'])).toEqual({
      path: '/Volumes/media/Show/episode.mkv',
      notice: null,
      isError: false,
    });
  });

  it('takes the first supported file and says so when several are dropped', () => {
    const result = selectDropPath(['/x/one.mkv', '/x/two.mp4', '/x/three.mov']);
    expect(result.path).toBe('/x/one.mkv');
    expect(result.isError).toBe(false);
    expect(result.notice).toContain('3 files');
    expect(result.notice).toContain('one.mkv');
  });

  it('skips unsupported files to reach the first playable one', () => {
    const result = selectDropPath(['/x/cover.jpg', '/x/episode.mkv']);
    expect(result.path).toBe('/x/episode.mkv');
    expect(result.isError).toBe(false);
  });

  it('rejects a dropped FOLDER with folder-specific wording', () => {
    // A folder has no video extension, which is the only signal available — the
    // renderer cannot stat anything.
    const result = selectDropPath(['/Volumes/media/Season 1']);
    expect(result.path).toBeNull();
    expect(result.isError).toBe(true);
    expect(result.notice).toContain('Season 1');
    expect(result.notice).toContain('folder');
  });

  it('rejects a non-video file by naming it and the formats that do work', () => {
    const result = selectDropPath(['/x/manual.pdf']);
    expect(result.path).toBeNull();
    expect(result.isError).toBe(true);
    expect(result.notice).toContain('manual.pdf');
    expect(result.notice).toContain('MKV');
  });

  it('complains about the rejected files rather than announcing a pick', () => {
    const result = selectDropPath(['/x/a.pdf', '/x/b.txt', '/x/c.jpg']);
    expect(result.path).toBeNull();
    expect(result.isError).toBe(true);
    expect(result.notice).toContain('a.pdf');
  });

  it('rejects a drag that resolved to no path (not backed by a file on disk)', () => {
    const result = selectDropPath([null]);
    expect(result.path).toBeNull();
    expect(result.isError).toBe(true);
    expect(result.notice).toContain('Finder');
  });

  it('treats an empty-string path as unresolved (getPathForFile returns "")', () => {
    const result = selectDropPath(['']);
    expect(result.path).toBeNull();
    expect(result.isError).toBe(true);
  });

  it('handles an entirely empty drop', () => {
    const result = selectDropPath([]);
    expect(result.path).toBeNull();
    expect(result.isError).toBe(true);
    expect(result.notice).toContain('Nothing was dropped');
  });

  it('ignores unresolvable entries alongside a good one', () => {
    const result = selectDropPath([null, '/x/episode.mkv']);
    expect(result.path).toBe('/x/episode.mkv');
    // Only one path RESOLVED, so there is nothing to announce.
    expect(result.notice).toBeNull();
  });

  it('accepts every extension the shared validator does', () => {
    for (const ext of ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm2ts']) {
      expect(selectDropPath([`/x/clip.${ext}`]).path).toBe(`/x/clip.${ext}`);
    }
  });
});

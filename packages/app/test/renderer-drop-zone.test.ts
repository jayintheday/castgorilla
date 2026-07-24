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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDragCounter,
  dragCarriesFiles,
  mountDropZone,
  selectDropPath,
} from '../src/renderer/views/drop-zone.js';
import type { AppActions, Feedback } from '../src/renderer/views/contracts.js';

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

/**
 * mountDropZone — proves drag-and-drop is wired to the WINDOW, not to `#file-zone`.
 *
 * The bug: the drag/drop listeners lived on the hero element, so a file dropped on
 * a recent-file card, the sidebar, or any gap did nothing — even though the Home UI
 * says "Drop a video anywhere in this window" and section B of the element contract
 * defines `.is-dragging` as a drag over THE WINDOW. The fix moves the wiring to
 * `window` while keeping the `.is-dragging` accent on `#file-zone`.
 *
 * These tests run under the `node` environment (jsdom is NOT a dependency of this
 * package and cannot be installed here), so they hand-roll a minimal fake DOM: a
 * `window` that records every listener registered on it and a `document` whose
 * elements are stubs. The view's `window` handlers are then invoked directly.
 *
 * What this CANNOT simulate, and is deliberately not claimed:
 *  - a real `DataTransfer`/`File` (Electron strips `File.path`; `resolvePath` is the
 *    injected stand-in for the preload's `getPathForFile`, exactly as in production);
 *  - real capture → target → bubble event propagation and ordering;
 *  - the OS drag cursor produced by `dataTransfer.dropEffect`.
 * The pure `selectDropPath` cases above cover the payload decision; these cover that
 * the payload reaches `actions.loadPath` from a WINDOW-level drop, exactly once.
 */

type FakeListener = (event: unknown) => void;

interface CapturedListener {
  type: string;
  fn: FakeListener;
  capture: boolean;
}

interface FakeElement {
  readonly classes: Set<string>;
  /** Every event type this element had a listener bound to — for asserting the hero has NONE. */
  readonly eventTypes: string[];
  addEventListener(type: string, fn?: FakeListener): void;
  querySelector(selector?: string): null;
  removeAttribute(name: string): void;
  textContent: string;
  title: string;
  classList: { toggle(name: string, force?: boolean): boolean };
}

function makeElement(): FakeElement {
  const classes = new Set<string>();
  const eventTypes: string[] = [];
  return {
    classes,
    eventTypes,
    addEventListener(type: string): void {
      eventTypes.push(type);
    },
    querySelector: (): null => null,
    removeAttribute(): void {},
    textContent: '',
    title: '',
    classList: {
      toggle(name: string, force?: boolean): boolean {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
  };
}

interface Harness {
  readonly captured: CapturedListener[];
  readonly fileZone: FakeElement;
  readonly loadPath: ReturnType<typeof vi.fn>;
  readonly toast: ReturnType<typeof vi.fn>;
  /** The single window listener of a given (type, phase); throws if not exactly one. */
  listener(type: string, capture: boolean): CapturedListener;
  restore(): void;
}

function mountInFakeDom(): Harness {
  const captured: CapturedListener[] = [];
  const fileZone = makeElement();
  const elements: Record<string, FakeElement> = {
    'file-zone': fileZone,
    'open-file': makeElement(),
    'clear-file': makeElement(),
    'file-name': makeElement(),
    'file-meta': makeElement(),
  };

  const fakeWindow = {
    addEventListener(
      type: string,
      fn: FakeListener,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const capture = typeof options === 'object' ? Boolean(options.capture) : Boolean(options);
      captured.push({ type, fn, capture });
    },
  };
  const fakeDocument = {
    getElementById(id: string): FakeElement | null {
      return elements[id] ?? null;
    },
  };

  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = g.window;
  const prevDocument = g.document;
  g.window = fakeWindow;
  g.document = fakeDocument;

  const loadPath = vi.fn();
  const toast = vi.fn();
  mountDropZone({
    actions: { loadPath } as unknown as AppActions,
    feedback: { toast } as unknown as Feedback,
    // Stands in for the preload's getPathForFile: a dropped File resolves to a path.
    resolvePath: (file) => `/resolved/${(file as unknown as { name: string }).name}`,
    getThumbnail: () => Promise.resolve(null),
  });

  return {
    captured,
    fileZone,
    loadPath,
    toast,
    listener(type: string, capture: boolean): CapturedListener {
      const match = captured.filter((l) => l.type === type && l.capture === capture);
      if (match.length !== 1) {
        throw new Error(
          `expected exactly one ${capture ? 'capture' : 'bubble'}-phase "${type}" window ` +
            `listener, found ${match.length}`,
        );
      }
      const [only] = match;
      if (!only) throw new Error('unreachable');
      return only;
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
    },
  };
}

describe('mountDropZone — window-wide drag and drop', () => {
  let harness: Harness | null = null;
  afterEach(() => {
    harness?.restore();
    harness = null;
  });

  it('loads a file dropped ANYWHERE in the window via a single window-level handler', () => {
    harness = mountInFakeDom();
    // `listener('drop', false)` throws unless there is EXACTLY ONE bubble-phase
    // window "drop" handler — this is the "loads exactly once" invariant.
    const drop = harness.listener('drop', false);
    drop.fn({
      preventDefault() {},
      dataTransfer: { types: ['Files'], files: [{ name: 'episode.mkv' }] },
    });
    expect(harness.loadPath).toHaveBeenCalledTimes(1);
    expect(harness.loadPath).toHaveBeenCalledWith('/resolved/episode.mkv');
  });

  it('binds NO drag/drop listeners to #file-zone — the hero has no drop of its own', () => {
    // If the hero still had its own `drop` listener a drop on it would fire twice.
    harness = mountInFakeDom();
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      expect(harness.fileZone.eventTypes).not.toContain(type);
    }
  });

  it('toggles .is-dragging on #file-zone from a window-level dragenter (not the hero)', () => {
    harness = mountInFakeDom();
    harness.listener('dragenter', false).fn({
      preventDefault() {},
      dataTransfer: { types: ['Files'] },
    });
    expect(harness.fileZone.classes.has('is-dragging')).toBe(true);
  });

  it('sets dropEffect=copy on a file-carrying dragover anywhere in the window', () => {
    harness = mountInFakeDom();
    const dataTransfer = { types: ['Files'], dropEffect: 'none' };
    harness.listener('dragover', false).fn({ preventDefault() {}, dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
  });

  it('ignores a window drag that carries no files (a text selection) — no accent', () => {
    harness = mountInFakeDom();
    harness.listener('dragenter', false).fn({
      preventDefault() {},
      dataTransfer: { types: ['text/plain'] },
    });
    expect(harness.fileZone.classes.has('is-dragging')).toBe(false);
  });

  it('ignores a window drop that carried no files — no loadPath, no spurious toast', () => {
    // Now that `drop` is window-wide, the capture-phase swallow prevents the
    // default of a NON-file drag too, so `drop` fires for it. Without the gate the
    // handler would run `selectDropPath([])` and toast "Nothing was dropped". A
    // genuine Finder drop of a folder/PDF DOES carry 'Files' and is unaffected.
    harness = mountInFakeDom();
    harness.listener('drop', false).fn({
      preventDefault() {},
      dataTransfer: { types: ['text/plain'], files: [] },
    });
    expect(harness.loadPath).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('keeps the capture-phase navigate guard on window for dragover AND drop', () => {
    // Invariant 1: navigate-to-file must be prevented for a drop on ANY pixel,
    // which is what the capture-phase swallow on window does regardless of target.
    harness = mountInFakeDom();
    const dropGuard = vi.fn();
    harness.listener('drop', true).fn({ preventDefault: dropGuard });
    expect(dropGuard).toHaveBeenCalled();

    const dragoverGuard = vi.fn();
    harness.listener('dragover', true).fn({ preventDefault: dragoverGuard });
    expect(dragoverGuard).toHaveBeenCalled();
  });
});

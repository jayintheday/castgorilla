/**
 * drop-zone.ts — `#file-zone`: the hero drop target that collapses into the
 * compact file card, plus everything about getting a path into the app.
 *
 * Three things here are less obvious than they look.
 *
 * 1. THE WINDOW-LEVEL GUARD IS THE REAL DEFENCE. Chromium's default action for a
 *    file dropped anywhere on a page is to NAVIGATE to it. In an Electron
 *    renderer that replaces the whole app with a video the window cannot come
 *    back from — no history entry, no error, just a blank app. So a capture-phase
 *    `preventDefault()` on `dragover` and `drop` is registered on `window`, not
 *    on the zone: it covers the 95% of the window that is not the drop target.
 *    (`main/index.ts` also has a `will-navigate` guard, but that is a backstop
 *    for a bug here, not the mechanism.)
 *
 * 2. THE DRAG COUNTER. `dragenter`/`dragleave` fire for every nested child the
 *    pointer crosses, so a naive add-on-enter/remove-on-leave flickers the accent
 *    border every time the cursor passes over the icon or the button inside the
 *    zone. Counting depth is the standard fix and the only one that survives
 *    nested markup.
 *
 * 3. VALIDATION HAPPENS BEFORE THE PROBE. `isSupportedVideoPath` is shared with
 *    the native picker's filter, so the two can never disagree, and it is what
 *    turns a dropped folder or PDF into an immediate specific sentence instead
 *    of an opaque ffprobe failure thirty lines deep.
 */

import { formatFileMeta, formatFileName } from '../media-format.js';
import type { AppState } from '../store.js';
import { isSupportedVideoPath } from '../../shared/video-extensions.js';
import type { AppActions, Feedback, ThumbnailFetcher, View } from './contracts.js';
import { el } from './dom.js';

// --- pure logic (unit-tested; no DOM) ---------------------------------------

/**
 * Depth counter for `dragenter`/`dragleave`.
 *
 * Every method returns whether the drag is currently OVER the zone, so the
 * caller is a one-liner (`zone.classList.toggle('is-dragging', counter.enter())`)
 * and there is no second copy of the "is it active" rule.
 *
 * The floor at zero is deliberate: a `dragleave` can arrive without a matching
 * `dragenter` (a drag that began outside, a drag we declined because it carried
 * no files), and without the clamp the counter goes negative and the class then
 * sticks on for the rest of the session.
 */
export interface DragCounter {
  /** A `dragenter` we accepted. */
  enter(): boolean;
  /** A `dragleave`. */
  leave(): boolean;
  /** A `drop`, or any other reason to forget the drag entirely. */
  reset(): boolean;
  /** Current nesting depth — exposed for tests, not for callers. */
  readonly depth: number;
}

export function createDragCounter(): DragCounter {
  let depth = 0;
  return {
    enter(): boolean {
      depth += 1;
      return true;
    },
    leave(): boolean {
      depth = Math.max(0, depth - 1);
      return depth > 0;
    },
    reset(): boolean {
      depth = 0;
      return false;
    },
    get depth(): number {
      return depth;
    },
  };
}

/**
 * Whether a drag carries files at all.
 *
 * `DataTransfer.types` is the ONLY thing readable during a drag — the file names
 * and paths are withheld until the drop, by design. So this is as far as the
 * `.is-dragging` accept-check can go, and dragging a text selection over the
 * window correctly lights nothing up.
 */
export function dragCarriesFiles(types: readonly string[] | undefined): boolean {
  return types !== undefined && Array.from(types).includes('Files');
}

/** What a drop resolved to, and what (if anything) to tell the user about it. */
export interface DropSelection {
  /** The path to load, or null when nothing usable was dropped. */
  path: string | null;
  /** A message to toast, or null when the drop needs no comment. */
  notice: string | null;
  isError: boolean;
}

/** True when the final path segment carries no extension at all — a folder's shape. */
function looksLikeFolder(path: string): boolean {
  const segment = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  return segment.lastIndexOf('.') <= 0;
}

/**
 * Choose what to do with a drop, given the paths its files resolved to.
 *
 * The input is the output of `pathForFile` over `DataTransfer.files` — that
 * resolution has to happen in the preload (see `CastgorillaApi.pathForFile`), so
 * by the time the decision is made a "file" is just a `string | null`. `null`
 * entries are drops that are not backed by disk at all (a drag from a web page,
 * a browser-constructed File).
 *
 * Order matters: unresolvable first, then unsupported, then the multi-file
 * notice. A drop of five PDFs should complain about the PDFs, not announce that
 * it picked one of them.
 */
export function selectDropPath(resolved: readonly (string | null)[]): DropSelection {
  const paths = resolved.filter((p): p is string => typeof p === 'string' && p.length > 0);

  const [firstPath] = paths;
  if (firstPath === undefined) {
    return {
      path: null,
      notice:
        resolved.length === 0
          ? 'Nothing was dropped — drag a video file in from Finder.'
          : "That isn't a file on this Mac — drag a video file in from Finder.",
      isError: true,
    };
  }

  const playable = paths.filter(isSupportedVideoPath);
  const [chosen] = playable;
  if (chosen === undefined) {
    const name = formatFileName(firstPath);
    return {
      path: null,
      notice: looksLikeFolder(firstPath)
        ? `"${name}" looks like a folder — drop a single video file instead.`
        : `"${name}" isn't a video castgorilla can play — try MP4, MKV, MOV, WebM or AVI.`,
      isError: true,
    };
  }

  if (paths.length > 1) {
    return {
      path: chosen,
      notice: `${paths.length} files dropped — using "${formatFileName(chosen)}".`,
      isError: false,
    };
  }

  return { path: chosen, notice: null, isError: false };
}

// --- the view ---------------------------------------------------------------

export interface DropZoneDeps {
  actions: AppActions;
  feedback: Feedback;
  /**
   * `window.castgorilla.pathForFile`. Injected rather than reached for so this
   * view has no opinion about how the app talks to Electron — and so the whole
   * engine surface stays in `main.ts`.
   */
  resolvePath(file: File): string | null;
  /** Fetch a poster still for the loaded file card (cached, null-safe). */
  getThumbnail: ThumbnailFetcher;
}

export function mountDropZone(deps: DropZoneDeps): View {
  const { actions, feedback, resolvePath, getThumbnail } = deps;

  const zone = el<HTMLElement>('file-zone');
  const openButton = el<HTMLButtonElement>('open-file');
  const clearButton = el<HTMLButtonElement>('clear-file');
  const nameLabel = el<HTMLHeadingElement>('file-name');
  const metaLabel = el<HTMLParagraphElement>('file-meta');
  // Class-scoped (the contract gives the thumb a class, not an id) — it lives
  // inside #file-zone and the film-icon behind it is the CSS fallback when unset.
  const thumb = zone.querySelector<HTMLImageElement>('.file-card__thumb');

  const counter = createDragCounter();
  /** The file the card thumbnail currently reflects, so it is fetched once per file. */
  let thumbFor: string | null = null;

  // See note 1 in the module header. Capture phase so it runs before anything
  // else can accept the drag, and on `window` so it covers the whole app. This
  // is the navigate-to-file defence and stays exactly as it was — it must fire
  // for a drop on ANY pixel of the window, not just the hero.
  const swallow = (event: DragEvent): void => event.preventDefault();
  window.addEventListener('dragover', swallow, { capture: true });
  window.addEventListener('drop', swallow, { capture: true });

  // Drag affordance AND drop handling are bound to `window`, not to `#file-zone`.
  // The Home UI says "Drop a video anywhere in this window," and section B of the
  // element contract defines `.is-dragging` as "a drag … over THE WINDOW" — so a
  // drop on a recent-file card, the sidebar, or any gap must work, not just one on
  // the hero. The accent still LIVES on #file-zone (its visual home per the
  // contract: border + tint + overlay), so the class is toggled on `zone` while
  // the events that drive it are observed window-wide. There is exactly ONE `drop`
  // handler that calls `actions.loadPath` — the hero no longer has its own, so a
  // drop on the hero loads once, not twice.
  //
  // The drag counter's depth approach still applies at window level: dragenter /
  // dragleave fire once per nested child the pointer crosses the window over too.
  window.addEventListener('dragenter', (event) => {
    if (!dragCarriesFiles(event.dataTransfer?.types)) return;
    event.preventDefault();
    zone.classList.toggle('is-dragging', counter.enter());
  });

  window.addEventListener('dragover', (event) => {
    if (!dragCarriesFiles(event.dataTransfer?.types)) return;
    // Required on EVERY dragover, not just the first: without it the drop event
    // never fires at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', () => {
    zone.classList.toggle('is-dragging', counter.leave());
  });

  window.addEventListener('drop', (event) => {
    // Gate the bubble handler the same way `dragenter`/`dragover` are gated. Now
    // that drop is window-wide, a non-file drag (a text selection, a dragged
    // image) still fires `drop` here — the capture-phase `swallow` prevented its
    // default, so the browser delivers it — and without this it would run
    // `selectDropPath([])` and toast "Nothing was dropped". Finder drops of
    // folders / PDFs / unsupported files DO carry 'Files', so they pass this gate
    // and keep their specific error toasts; only genuine non-file drags are
    // dropped. The capture-phase `swallow` above stays unconditional regardless —
    // it is the navigate-to-file defence for every pixel.
    if (!dragCarriesFiles(event.dataTransfer?.types)) return;

    event.preventDefault();
    zone.classList.toggle('is-dragging', counter.reset());

    const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
    const choice = selectDropPath(files.map((file) => resolvePath(file)));
    if (choice.notice) feedback.toast(choice.notice, choice.isError);
    if (choice.path) actions.loadPath(choice.path);
  });

  openButton.addEventListener('click', () => actions.openFileDialog());
  clearButton.addEventListener('click', () => actions.clearFile());

  function render(state: Readonly<AppState>): void {
    // ONE class drives both the collapse and (via a sibling selector) revealing
    // #setup — see section B of the element contract.
    zone.classList.toggle('has-file', state.file !== null);
    zone.classList.toggle('is-probing', state.probing);

    nameLabel.textContent = state.file ? formatFileName(state.file) : 'No file selected';
    // The full path is worth keeping reachable, but not at the cost of the card's
    // largest line being an unreadable 90-character string.
    nameLabel.title = state.file ?? '';

    metaLabel.textContent = state.media ? formatFileMeta(state.media, state.plan) : '';
    // The tier is no longer shown on the card: the "Converting video" pill was a
    // static plan label that read like a live status. What the plan does is now
    // conveyed by the top activity bar while the session prepares (coloured by
    // tier — see views/activity.ts), and the technical tier stays in the Advanced
    // plan summary for anyone who wants the exact word.

    // Poster still, once the probe has confirmed the file is readable. Fetched
    // once per file; cleared on unload so the film-icon fallback returns and a
    // stale frame never rides along under the next file's name.
    updateThumb(state.media?.path ?? null);
  }

  /** Set/clear the file card's poster still, guarded against races and re-fetches. */
  function updateThumb(path: string | null): void {
    if (!thumb) return;
    if (path === thumbFor) return;
    thumbFor = path;
    thumb.removeAttribute('src');
    if (!path) return;
    const target = path;
    void getThumbnail({ file: target, variant: 'thumb' }).then((src) => {
      if (src && thumbFor === target) thumb.src = src;
    });
  }

  return { render };
}

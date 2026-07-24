/**
 * video-extensions.ts — the ONE list of file extensions the app accepts, plus
 * the predicate that tests a path against it.
 *
 * Shared deliberately: the native file picker's filter (`main/ipc.ts`) and the
 * drag-and-drop validator (renderer) must never drift apart, or a file the
 * picker offers would be rejected on drop (or worse, the reverse).
 *
 * Lives in `shared/` because it is pure data + a pure function — no Electron,
 * no Node, no DOM — so it is importable from main, preload and renderer alike.
 */

/** Extensions (lowercase, no leading dot) the app will attempt to play. */
export const VIDEO_EXTENSIONS: readonly string[] = [
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
];

/**
 * Whether `filePath` names a file whose extension we accept. Case-insensitive.
 *
 * Returns false for anything without a real final extension, which is how a
 * dropped FOLDER is rejected: a directory path carries no video extension, and
 * we cannot stat it from the renderer.
 *
 * The extension is taken from the last path SEGMENT, not from the whole string
 * — `/x/my.folder/movie` has a dot in it but no file extension, and must be
 * false, while `/x/my.folder/movie.mkv` must be true. A leading dot with no
 * further dot (`.mkv`, `.DS_Store`) is a dotfile, not an extension.
 */
export function isSupportedVideoPath(filePath: string): boolean {
  const segment = filePath.split(/[/\\]/).pop() ?? '';
  const dot = segment.lastIndexOf('.');
  // dot === -1: no extension.  dot === 0: dotfile, the "extension" is the name.
  if (dot <= 0) return false;
  const ext = segment.slice(dot + 1).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

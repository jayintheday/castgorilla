/**
 * subtitles/discover.ts — sidecar subtitle discovery.
 *
 * Given a media file, find subtitle files that live next to it on disk:
 *   <base>.srt / <base>.ass / <base>.vtt            → a bare sidecar
 *   <base>.<lang>.srt / <base>.<lang>.ass / …       → a language-tagged sidecar
 * where <lang> is a 2–3 letter ISO 639 code (e.g. `.en.srt`, `.eng.ass`).
 * Extensions are matched case-insensitively (`.SRT` counts).
 *
 * Labels come from the language code ("English" via a small ISO 639-1/2 map for
 * common codes, else the code verbatim), or "External" for a bare sidecar.
 */

import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/** Text subtitle container formats we can turn into WebVTT. */
export type SubtitleFormat = 'srt' | 'ass' | 'vtt';

export interface SidecarSub {
  /** Absolute path to the sidecar file. */
  path: string;
  format: SubtitleFormat;
  /** ISO 639 code when the filename carries one (`.en.srt`). */
  language?: string;
  /** Human label: language name, the raw code, or "External". */
  label: string;
}

const SUB_EXTS: Record<string, SubtitleFormat> = {
  srt: 'srt',
  ass: 'ass',
  ssa: 'ass',
  vtt: 'vtt',
};

/** A small ISO 639-1 (2-letter) + 639-2 (3-letter) map for common languages. */
const ISO_639: Record<string, string> = {
  en: 'English', eng: 'English',
  es: 'Spanish', spa: 'Spanish',
  fr: 'French', fra: 'French', fre: 'French',
  de: 'German', deu: 'German', ger: 'German',
  it: 'Italian', ita: 'Italian',
  pt: 'Portuguese', por: 'Portuguese',
  nl: 'Dutch', nld: 'Dutch', dut: 'Dutch',
  ru: 'Russian', rus: 'Russian',
  ja: 'Japanese', jpn: 'Japanese',
  ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', zho: 'Chinese', chi: 'Chinese',
  ar: 'Arabic', ara: 'Arabic',
  hi: 'Hindi', hin: 'Hindi',
  pl: 'Polish', pol: 'Polish',
  sv: 'Swedish', swe: 'Swedish',
  no: 'Norwegian', nor: 'Norwegian',
  da: 'Danish', dan: 'Danish',
  fi: 'Finnish', fin: 'Finnish',
  tr: 'Turkish', tur: 'Turkish',
  cs: 'Czech', ces: 'Czech', cze: 'Czech',
  el: 'Greek', ell: 'Greek', gre: 'Greek',
  he: 'Hebrew', heb: 'Hebrew',
  th: 'Thai', tha: 'Thai',
  uk: 'Ukrainian', ukr: 'Ukrainian',
  hu: 'Hungarian', hun: 'Hungarian',
  ro: 'Romanian', ron: 'Romanian', rum: 'Romanian',
  vi: 'Vietnamese', vie: 'Vietnamese',
  id: 'Indonesian', ind: 'Indonesian',
};

/** Resolve a language code to a human name, or undefined for an unknown code. */
export function languageName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return ISO_639[code.toLowerCase()];
}

/** True when two language codes refer to the same language (2- vs 3-letter aware). */
export function languageMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  const na = languageName(la);
  const nb = languageName(lb);
  return na !== undefined && na === nb;
}

/** Looks like a 2–3 letter ISO language code. */
function isLangCode(s: string): boolean {
  return /^[a-z]{2,3}$/i.test(s);
}

/**
 * Classify a single subtitle file path on its own (no base-name constraint):
 * detect the format from the extension and a trailing `.<lang>` segment.
 * Returns null when the extension is not a supported subtitle format.
 */
export function classifyExternalSidecar(filePath: string): SidecarSub | null {
  const ext = extname(filePath).slice(1).toLowerCase();
  const format = SUB_EXTS[ext];
  if (!format) return null;
  const stem = basename(filePath).slice(0, -(ext.length + 1)); // strip ".<ext>"
  const dot = stem.lastIndexOf('.');
  if (dot > 0) {
    const maybeLang = stem.slice(dot + 1);
    if (isLangCode(maybeLang)) {
      const language = maybeLang.toLowerCase();
      return { path: filePath, format, language, label: languageName(language) ?? language };
    }
  }
  return { path: filePath, format, label: 'External' };
}

/**
 * Scan the media file's directory for sidecar subtitle files.
 * Returns them sorted by filename for a deterministic order.
 */
export async function discoverSidecars(mediaPath: string): Promise<SidecarSub[]> {
  const dir = dirname(mediaPath);
  const mediaBase = basename(mediaPath);
  const mediaExt = extname(mediaBase);
  const base = mediaBase.slice(0, mediaBase.length - mediaExt.length);
  const baseLower = base.toLowerCase();

  let entries: string[];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }

  const found: SidecarSub[] = [];
  for (const name of entries) {
    const ext = extname(name).slice(1).toLowerCase();
    const format = SUB_EXTS[ext];
    if (!format) continue;
    const stem = name.slice(0, name.length - (ext.length + 1)); // drop ".<ext>"
    const stemLower = stem.toLowerCase();

    if (stemLower === baseLower) {
      // Bare sidecar: <base>.<ext>
      found.push({ path: join(dir, name), format, label: 'External' });
      continue;
    }
    if (stemLower.startsWith(baseLower + '.')) {
      const rest = stem.slice(base.length + 1);
      if (isLangCode(rest)) {
        const language = rest.toLowerCase();
        found.push({ path: join(dir, name), format, language, label: languageName(language) ?? language });
      }
    }
  }

  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

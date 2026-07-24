/**
 * subtitles/style.ts — the default Cast TextTrackStyle for castgorilla subtitles.
 *
 * White text on a semi-transparent black box with a hard drop shadow: legible
 * against arbitrary video without a heavy window. Colors are #RRGGBBAA strings
 * per the Cast contract (see types/cast.ts).
 */

import type { TextTrackStyle } from '../types/cast.js';

export const SUBTITLE_STYLE: TextTrackStyle = {
  backgroundColor: '#00000080',
  foregroundColor: '#FFFFFFFF',
  edgeType: 'DROP_SHADOW',
  edgeColor: '#000000FF',
  fontScale: 1.0,
  fontFamily: 'SANS_SERIF',
};

/**
 * Deterministic colour assignment. The same person, company or series always
 * gets the same swatch in every screen of the product and across reloads,
 * because the colour is a pure function of the identifier — never a counter.
 */

/** FNV-1a, 32-bit. Stable across runtimes; good spread on short strings. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const AVATAR_TONE_COUNT = 8;

/** 1-based tone index used by `--avatar-N-bg` / `--avatar-N-fg`. */
export function toneOf(seed: string, count = AVATAR_TONE_COUNT): number {
  if (!seed) return 1;
  return (hashString(seed.trim().toLowerCase()) % count) + 1;
}

export interface ToneStyle {
  background: string;
  color: string;
  borderColor: string;
}

export function toneStyle(seed: string): ToneStyle {
  const n = toneOf(seed);
  return {
    background: `var(--avatar-${n}-bg)`,
    color: `var(--avatar-${n}-fg)`,
    borderColor: `var(--avatar-${n}-fg)`,
  };
}

/** The categorical data-viz ramp, in the order series should consume it. */
export const VIZ_COUNT = 8;
export const vizColor = (index: number): string => `var(--viz-${(index % VIZ_COUNT) + 1})`;

/** A stable series colour when order is not meaningful (e.g. per-plan MRR). */
export const vizColorFor = (seed: string): string => `var(--viz-${toneOf(seed, VIZ_COUNT)})`;

export type Tone =
  | 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'teal' | 'pink';

/** Maps a domain status word onto the semantic tone the whole product uses. */
const STATUS_TONES: Record<string, Tone> = {
  active: 'success', paid: 'success', succeeded: 'success', completed: 'success', won: 'success',
  connected: 'success', healthy: 'success', delivered: 'success', open: 'info', sent: 'info',
  live: 'success', enabled: 'success', subscribed: 'success', resolved: 'success', approved: 'success',
  trialing: 'info', scheduled: 'info', pending: 'info', processing: 'info', running: 'info',
  queued: 'info', in_progress: 'info', new: 'info', draft: 'neutral', paused: 'warning',
  past_due: 'warning', at_risk: 'warning', overdue: 'warning', warning: 'warning', retrying: 'warning',
  unpaid: 'danger', failed: 'danger', canceled: 'danger', cancelled: 'danger', churned: 'danger',
  lost: 'danger', error: 'danger', bounced: 'danger', disabled: 'neutral', archived: 'neutral',
  void: 'neutral', inactive: 'neutral', closed: 'neutral', uncollectible: 'danger',
};

export function toneForStatus(status: string): Tone {
  return STATUS_TONES[status.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? 'neutral';
}

/* ========================================================================== *
 * Contrast. Used by the style guide to measure its own promise at runtime and
 * by tests/design.test.ts to hold tokens.css to it.
 * ========================================================================== */

export interface Rgb { r: number; g: number; b: number }

/** Parses `#abc`, `#aabbcc`, `rgb(…)` and `rgba(…)`. Returns null otherwise. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    if (h.length < 6) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2] };
  }
  return null;
}

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance. */
export const relativeLuminance = ({ r, g, b }: Rgb): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2.1 contrast ratio, 1–21. Returns null when either colour is opaque-unknown. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastGrade = 'AAA' | 'AA' | 'AA Large' | 'Fail';

export function contrastGrade(ratio: number): ContrastGrade {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

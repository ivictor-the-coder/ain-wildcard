/**
 * What the workspace form refuses before the server sees it, and why.
 *
 * Three of these are not cosmetic. `name` is `v.string({ min: 1 })` behind
 * `v.optional`, and `optional` maps `''` to `undefined` before the minimum is
 * ever checked — so an empty name is not refused, it is *dropped*: the server
 * answers 200 with the old name, and a form that trusted its own patch would
 * report a save that never happened. `domain` is `v.string({ max: 200 })`
 * with no shape at all, so `PATCH /v1/org` stores "not a domain!!" and the
 * shell header reads it back under the workspace name on every screen.
 *
 * And `timezone` is `v.string({ max: 60 })`, `locale` `v.string({ max: 20 })`,
 * which is how one PATCH bricks the entire product. Every date on every screen
 * is rendered through `Intl.DateTimeFormat(locale, { timeZone })`, and Intl
 * answers an unknown zone or a malformed tag with a `RangeError` rather than a
 * fallback: `{"timezone":"Mars/Phobos"}` is accepted, `/v1/me` serves it back,
 * the shell's own clock chip throws while drawing, React unmounts the tree and
 * every screen — including this one, the only screen that could undo it — goes
 * white. The server must refuse both; until it does, the form does, and the
 * screen renders through `previewSettings` so it survives a value that is
 * already stored.
 */

export interface WorkspaceDraft {
  name: string;
  domain: string;
  brand_color: string;
  default_currency: string;
  timezone: string;
  locale: string;
}

export const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A hostname as RFC 1123 spells one: labels of letters, digits and hyphens,
 * none starting or ending with a hyphen, joined by dots, with at least one dot
 * and an alphabetic top-level label — `northwind.io`, `billing.northwind.co.uk`.
 * No scheme, no path, no port, no spaces: it is printed on invoices as the
 * company's address on the web, not fetched.
 */
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isHostname(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 253) return false;
  const labels = trimmed.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return false;
  return /^[a-z]{2,63}$/i.test(labels[labels.length - 1]);
}

/**
 * Whether this runtime can actually render dates in a zone, asked of the one
 * thing that decides it. An IANA name Intl does not know — `Mars/Phobos`, or
 * `Europe/Berlin ` with a stray space — throws rather than falling back.
 */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this runtime can render numbers and dates in a locale.
 *
 * A well-formed tag the runtime has no data for (`xx-YY`) resolves to its
 * fallback and renders, so it is not refused here — it is not what breaks. A
 * *malformed* tag (`en_US`, `english`, `de--DE`) throws out of both
 * `Intl.NumberFormat` and `Intl.DateTimeFormat`, and that is what takes the
 * product down, so both are asked.
 */
export function isLocale(value: string): boolean {
  try {
    new Intl.DateTimeFormat(value).format(0);
    new Intl.NumberFormat(value).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Why a field cannot be sent, in the words the operator needs — or nothing. */
export function problemWith(key: keyof WorkspaceDraft, value: string): string | undefined {
  if (key === 'name' && value.trim().length === 0) return 'A workspace must have a name.';
  if (key === 'brand_color' && !HEX.test(value)) return 'Six hex digits after a #, e.g. #5B4BE1.';
  if (key === 'domain' && value.trim() !== '' && !isHostname(value)) {
    return 'A hostname, e.g. northwind.io — letters, digits, hyphens and dots, without a scheme, a path or spaces.';
  }
  if (key === 'timezone' && !isTimeZone(value)) {
    return `An IANA timezone this browser can format in, e.g. Europe/Berlin. ${value.trim() === '' ? 'An empty zone' : `“${value}”`} `
      + 'is not one, and every date in the product is rendered through it.';
  }
  if (key === 'locale' && !isLocale(value)) {
    return `A BCP 47 language tag, e.g. en-GB. ${value.trim() === '' ? 'An empty tag' : `“${value}”`} is not one, and every `
      + 'number, date and amount in the product is formatted through it.';
  }
  return undefined;
}

/** The formatter settings a screen can safely be built from, and what was dropped. */
export interface PreviewSettings {
  locale: string;
  timeZone: string;
  /** The fields this runtime cannot format with, in the order the form shows them. */
  unusable: ('timezone' | 'locale')[];
}

export const FALLBACK_ZONE = 'UTC';
export const FALLBACK_LOCALE = 'en-US';

/**
 * The workspace's own locale and zone where they work, and the platform's
 * defaults where they do not.
 *
 * This is the screen an operator opens *because* those settings are wrong, so
 * it is the one screen that may not be rendered through them unchecked. What
 * was substituted is reported rather than swallowed — a preview quietly
 * showing UTC while the workspace is set to something unformattable would be
 * its own lie.
 */
export function previewSettings(draft: { timezone: string; locale: string }): PreviewSettings {
  const unusable: ('timezone' | 'locale')[] = [];
  if (!isTimeZone(draft.timezone)) unusable.push('timezone');
  if (!isLocale(draft.locale)) unusable.push('locale');
  return {
    timeZone: unusable.includes('timezone') ? FALLBACK_ZONE : draft.timezone,
    locale: unusable.includes('locale') ? FALLBACK_LOCALE : draft.locale,
    unusable,
  };
}

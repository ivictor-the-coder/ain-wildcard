/**
 * What the workspace form refuses before the server sees it, and why.
 *
 * Two of these are not cosmetic. `name` is `v.string({ min: 1 })` behind
 * `v.optional`, and `optional` maps `''` to `undefined` before the minimum is
 * ever checked — so an empty name is not refused, it is *dropped*: the server
 * answers 200 with the old name, and a form that trusted its own patch would
 * report a save that never happened. And `domain` is `v.string({ max: 200 })`
 * with no shape at all, so `PATCH /v1/org` stores "not a domain!!" and the
 * shell header reads it back under the workspace name on every screen. The
 * server should refuse both; until it does, the form does.
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

/** Why a field cannot be sent, in the words the operator needs — or nothing. */
export function problemWith(key: keyof WorkspaceDraft, value: string): string | undefined {
  if (key === 'name' && value.trim().length === 0) return 'A workspace must have a name.';
  if (key === 'brand_color' && !HEX.test(value)) return 'Six hex digits after a #, e.g. #5B4BE1.';
  if (key === 'domain' && value.trim() !== '' && !isHostname(value)) {
    return 'A hostname, e.g. northwind.io — letters, digits, hyphens and dots, without a scheme, a path or spaces.';
  }
  return undefined;
}

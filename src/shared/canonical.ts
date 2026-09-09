/**
 * The canonical form of a property value — one definition, both sides.
 *
 * The server has always canonicalised on write: `Domain` is stored as
 * `andina.cl`, a phone as digits, an email lowercased, and uniqueness is
 * decided on that form. The CSV importer's "Check" step promises to tell you
 * what the import will do *before* it runs, and it was answering from the raw
 * cells — so two rows that the server would collapse into one refusal were
 * reported as two clean creates, and the count on the confirm button did not
 * match the count in the result. A preview that cannot see the canonical form
 * is not a preview. This module is that form, shared, so the two answers are
 * the same answer.
 */

/** How a property's text is canonicalised on write, before uniqueness. */
export type CanonicalNormaliser = 'none' | 'lower' | 'upper' | 'domain' | 'digits';

export const NORMALISERS: CanonicalNormaliser[] = ['none', 'lower', 'upper', 'domain', 'digits'];

/**
 * The canonical form of a web domain: no scheme, no `www.`, no path, no port,
 * no trailing dot, lowercased and trimmed. `https://WWW.Andinaenvases.CL/about`
 * and `andinaenvases.cl ` are the same company, and a dedupe key that cannot
 * see that is not a dedupe key.
 */
export function canonicalDomain(raw: unknown): string {
  let value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/^[^@/]*@/, '');
  value = value.split(/[/?#]/)[0];
  value = value.replace(/:\d+$/, '');
  value = value.replace(/^www\./, '');
  return value.replace(/\.+$/, '');
}

export const canonicalDigits = (raw: unknown): string => String(raw ?? '').replace(/\D/g, '');

/** Apply a property's declared canonical form. Runs before uniqueness. */
export function normaliseText(value: string, normalize: CanonicalNormaliser): string {
  switch (normalize) {
    case 'lower': return value.trim().toLowerCase();
    case 'upper': return value.trim().toUpperCase();
    case 'domain': return canonicalDomain(value);
    case 'digits': return canonicalDigits(value);
    case 'none': default: return value;
  }
}

/** All `canonicalLookupValue` needs of a property definition. */
export interface CanonicalProperty {
  type: string;
  normalize: CanonicalNormaliser;
}

/**
 * The form a value takes once stored, used when looking a record up by one of
 * its properties. `findBy('domain', 'WWW.Andina.CL')` has to find the record
 * stored as `andina.cl`, or keyed imports create a duplicate every run.
 */
export function canonicalLookupValue(prop: CanonicalProperty | null, value: string | number): string | number {
  if (typeof value !== 'string' || !prop) return value;
  if (prop.type === 'email') return value.trim().toLowerCase();
  if (prop.normalize !== 'none') return normaliseText(value, prop.normalize);
  return value;
}

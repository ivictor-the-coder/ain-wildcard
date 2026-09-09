/**
 * Internal names the data model derives so nobody has to type them.
 */

export const slug = (input: string): string =>
  input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * An association type's internal name, from its label. `company_to_company`
 * was the old derivation, and the second company↔company type a workspace
 * defined collided with the first every time. The label is what makes the
 * type distinct, so it is what the name is built from — and if that is taken
 * too, the name steps aside rather than the person.
 */
export function associationTypeName(fromObject: string, toObject: string, label: string, taken: string[]): string {
  const base = slug(label) ? `${slug(fromObject)}_${slug(label)}`.slice(0, 56) : `${slug(fromObject)}_to_${slug(toObject)}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

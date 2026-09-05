/**
 * A trace step's summary, in the words a person reads.
 *
 * The engine writes each step's result as a wire line — `metric=mrr
 * label=Monthly recurring revenue unit=money value=1527917
 * formatted=€15,279.17` — which is right for the expanded Result and wrong
 * for the row itself, where a reader scanning four steps wants "Monthly
 * recurring revenue · €15,279.17". The raw line is kept under the row;
 * this is only what the row says.
 */
import { keyValues } from './api';

export interface DigestWords {
  /** A timestamp as the workspace writes a day and time. */
  when: (ts: number) => string;
  /** `n` of `word`, pluralised. */
  plural: (count: number, word: string) => string;
}

const titleCase = (value: string): string => value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The words the engine's field names read as, where the name itself would not. */
const OBJECT_WORDS: Record<string, string> = {
  delinquent_customers: 'past-due customer',
  metered_usage: 'metered reading',
};

/**
 * One line for one step. Prose stays prose; a wire line becomes a sentence
 * made of the fields a reader would pick out of it.
 */
export function spanDigest(summary: string, words: DigestWords): string {
  const fields = keyValues(summary);
  if (!fields) return summary;

  if (fields.scheduled === 'true') {
    const due = Number(fields.due);
    const day = Number.isFinite(due) && due > 0 ? words.when(due) : 'the due day';
    return fields.note ? `Follow-up booked for ${day} — “${fields.note.trim()}”` : `Follow-up booked for ${day}`;
  }
  if (fields.formatted) {
    const label = fields.label ?? (fields.metric ? titleCase(fields.metric) : fields.measure ? titleCase(fields.measure) : null);
    const scope = fields.scope && fields.scope !== 'workspace' ? ` for ${fields.scope}` : '';
    return label ? `${label}${scope} · ${fields.formatted}` : fields.formatted;
  }
  if (fields.display_name) {
    const kind = fields.object_type ? fields.object_type.replace(/_/g, ' ') : 'record';
    return `${titleCase(kind)} “${fields.display_name}”`;
  }
  if (fields.total !== undefined) {
    const count = Number(fields.total);
    const noun = fields.object_type
      ? fields.object_type.replace(/_/g, ' ')
      : fields.invoices !== undefined ? 'invoice' : fields.customers !== undefined ? (OBJECT_WORDS[fields.object ?? ''] ?? 'customer') : 'row';
    const parts = [Number.isFinite(count) ? `${words.plural(count, noun)} matched` : `${fields.total} matched`];
    if (fields.records !== undefined && Number(fields.records) !== count) parts.push(`${fields.records} read`);
    if (fields.outstanding_display) parts.push(`${fields.outstanding_display} outstanding`);
    return parts.join(' · ');
  }
  // Nothing this recognises: every field, named for a person, no equals signs.
  return Object.entries(fields)
    .filter(([key]) => !/^(object|id|idempotency_key)$/.test(key))
    .map(([key, value]) => `${titleCase(key)} ${value}`)
    .join(' · ') || summary;
}

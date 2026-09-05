/**
 * Where a record the copilot cited lives in this product.
 *
 * Pure, and in its own file, so the routing every citation chip depends on can
 * be tested without a browser: a chip that resolves to nothing is drawn as a
 * dead end, and that used to happen to records with perfectly good screens.
 */

export interface Citation { id: string; label: string; type: string }

/**
 * Every CRM object type the generic record screen can open.
 *
 * Activities are records like any other — `GET /v1/records/call/call_nw_0442`
 * answers, and `/records/call/call_nw_0442` renders it with its timeline and
 * associations. The copilot cites them constantly ("Escalation call after the
 * outage") and every one of those chips used to be drawn disabled, with the
 * reason in a `title` a keyboard never reaches, over a screen that exists.
 */
const RECORD_TYPES = new Set(['note', 'call', 'email', 'meeting', 'task', 'ticket', 'deal', 'company', 'contact']);

/**
 * The cited records, each named once.
 *
 * The engine cites the row it read, and a run that reads one row twice — once
 * to count the open tickets and again to name the oldest — cites it twice.
 * "Dashboard loads slowly with 900 assets selected" appearing twice under
 * SOURCES reads as two tickets, which is a claim about the workspace.
 */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.id)) return false;
    seen.add(citation.id);
    return true;
  });
}

/** Where a cited record lives in this product, or null when nothing shows it. */
export function citationHref(citation: Citation): string | null {
  switch (citation.type) {
    case 'deal': return `/deals/${encodeURIComponent(citation.id)}`;
    case 'company':
    case 'customer_company': return `/companies/${encodeURIComponent(citation.id)}`;
    case 'contact': return `/contacts/${encodeURIComponent(citation.id)}`;
    case 'ticket': return `/records/ticket/${encodeURIComponent(citation.id)}`;
    case 'customer': return `/customers/${encodeURIComponent(citation.id)}`;
    case 'invoice': return `/invoices/${encodeURIComponent(citation.id)}`;
    case 'subscription': return `/subscriptions/${encodeURIComponent(citation.id)}`;
    case 'meter': return `/revenue/usage/${encodeURIComponent(citation.id)}`;
    default:
      if (RECORD_TYPES.has(citation.type)) return `/records/${citation.type}/${encodeURIComponent(citation.id)}`;
      return citation.id.startsWith('cmp_') ? `/companies/${encodeURIComponent(citation.id)}` : null;
  }
}

export const CITATION_ICON: Record<string, string> = {
  deal: 'deals',
  company: 'building',
  contact: 'user',
  ticket: 'tickets',
  customer: 'wallet',
  invoice: 'invoice',
  subscription: 'repeat',
  meter: 'gauge',
  price: 'tag',
  product: 'tag',
};


const ID_PREFIX: Record<string, string> = { cmp: 'company', con: 'contact', deal: 'deal', tkt: 'ticket' };

/** The records a queued write names, so the conversation can link to them. */
export function writeTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => { if (typeof value === 'string' && value) out.push(value); };
  for (const key of ['record_id', 'id', 'contact_id', 'company_id']) push(args[key]);
  for (const key of ['record_ids', 'associate_to']) {
    const value = args[key];
    if (Array.isArray(value)) for (const entry of value) push(entry);
  }
  return [...new Set(out)].filter((id) => ID_PREFIX[id.split('_')[0]]);
}

/**
 * The record a queued write would land on, as the approval card names it.
 *
 * The card's first preview line is the engine's own sentence for the target —
 * `Deal Sakamoto Seiki — multi-site rollout`, `Note on Ferro Norte
 * Siderurgia`, `Follow-up on Aldergate Logistics` — and the name inside it is
 * the only thing on that card a person can check against the sentence they
 * typed. It is read off the preview rather than the arguments because the
 * arguments carry `deal_nw_59` and nothing else.
 *
 * `null` when the shape is one this cannot read, or when the engine itself
 * could not name the target: a card that says "a record I can no longer name"
 * has already said the loudest true thing about it.
 */
export function writeTargetLabel(
  tool: string,
  args: Record<string, unknown>,
  preview: string[],
): string | null {
  const first = preview[0]?.trim();
  if (!first || first.includes('a record I can no longer name')) return null;
  const lead = /^(?:note on|follow-up on|linked to)\s+(.+)$/i.exec(first);
  if (lead) {
    const one = lead[1].split(',')[0].trim();
    return one && one !== 'no record' ? one : null;
  }
  if (tool !== 'update_record') return null;
  // `${humanise(object_type)} ${name}` — the type is dropped so what is left is
  // the record's own display name and nothing else.
  const type = typeof args.object_type === 'string' ? args.object_type.replace(/_/g, ' ') : '';
  if (!type) return first || null;
  const stripped = new RegExp(`^${type.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+`, 'i');
  const name = stripped.test(first) ? first.replace(stripped, '').trim() : first;
  return name || null;
}

export function recordLink(id: string): { type: string; href: string } | null {
  const type = ID_PREFIX[id.split('_')[0]];
  if (!type) return null;
  return { type, href: citationHref({ id, label: id, type }) ?? `/records/${type}/${encodeURIComponent(id)}` };
}


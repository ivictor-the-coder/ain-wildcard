/**
 * One label and one tone for every lifecycle status the product shows — a
 * subscription, an invoice, a credit note, a dunning campaign, a grant, a
 * meter, a settlement, a payment instruction. Pure, so the map can be held to
 * account in a test without a DOM.
 *
 * Two rules it keeps. Casing is uniform, so a credit note never reads a
 * lowercase "void" beside an invoice's title-cased "Void". And the record's
 * word is the operator's word: the menu item says "Write it off", so the
 * badge says "Written off" rather than the wire value `uncollectible`.
 */
import { toneForStatus, type Tone } from './color';
import { humanize } from './format';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const STATUS_COPY: Readonly<Record<string, string>> = {
  trialing: 'Trialing', active: 'Active', past_due: 'Past due', paused: 'Paused',
  canceled: 'Canceled', unpaid: 'Unpaid', incomplete: 'Incomplete', incomplete_expired: 'Expired',
  draft: 'Draft', open: 'Open', paid: 'Paid', void: 'Voided', voided: 'Voided', uncollectible: 'Written off',
  issued: 'Issued', recovering: 'Recovering', recovered: 'Recovered', exhausted: 'Given up',
  succeeded: 'Succeeded', failed: 'Failed', skipped: 'Skipped', pending: 'Pending',
  scheduled: 'Scheduled', expired: 'Expired', settled: 'Settled', invoiced: 'Invoiced',
  inactive: 'Inactive', archived: 'Archived',
  // Deferred work: a job is pending, running, done or cancelled. Both spellings
  // of the last one render the workspace's word, so the queue never shows
  // "Cancelled" beside a subscription's "Canceled".
  running: 'Running', done: 'Done', cancelled: 'Canceled',
  // A subscription schedule's phases: it has not started, it is active, it ran
  // out, or it let go of the subscription. `active` is deliberately the same
  // word here as everywhere else — the schedule badge said "Running" beside a
  // subscription pill reading "Active", for the same fact.
  not_started: 'Not started', completed: 'Completed', released: 'Released',
  credited: 'Credited', ignored: 'Ignored', rebilled: 'Rebilled', withdrawn: 'Withdrawn',
  // A payment instruction's own states. `requires_payment_method` is where a
  // declined intent goes — "Declined" is what happened, and calling it
  // "Requires payment method" hides that money was refused.
  requires_payment_method: 'Declined', requires_confirmation: 'Ready to present',
  requires_action: 'Needs the cardholder', processing: 'With the bank',
};

/**
 * The words the shared status ramp in `color.ts` does not already carry, or
 * reads differently. `pending` is deliberately *not* here: the ramp calls it
 * info, and a queue of 67 pending jobs painted amber says something is wrong
 * when nothing is. One word, one tone, and the ramp already had it.
 */
const STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  active: 'success', paid: 'success', succeeded: 'success', recovered: 'success', settled: 'success',
  credited: 'success', rebilled: 'success',
  trialing: 'info', open: 'info', issued: 'info', processing: 'info', scheduled: 'info', invoiced: 'info',
  not_started: 'info', released: 'neutral',
  past_due: 'warning', paused: 'warning', incomplete: 'warning', requires_action: 'warning',
  recovering: 'warning',
  unpaid: 'danger', canceled: 'danger', uncollectible: 'danger', requires_payment_method: 'danger',
  failed: 'danger', exhausted: 'danger', expired: 'danger', voided: 'danger',
  // Work that finished is a success, whatever word the queue uses for it.
  done: 'success',
};

const STATUS_TONES = new Set<Tone>(['neutral', 'success', 'warning', 'danger', 'info']);

export const statusLabel = (status: string): string => STATUS_COPY[status] ?? humanize(status);

/**
 * The billing words first, then the product-wide ramp for everything else —
 * `won`, `churned`, `running` — so a pill never falls to neutral for a status
 * the rest of the product already colours.
 */
export function statusTone(status: string): StatusTone {
  const own = STATUS_TONE[status];
  if (own) return own;
  const shared = toneForStatus(status);
  return STATUS_TONES.has(shared) ? (shared as StatusTone) : 'neutral';
}

/* ------------------------------ tax registers ----------------------------- */

/**
 * What a register said about a customer's tax number — a different vocabulary
 * from a record's lifecycle, and read by the account page and Settings › Tax
 * alike, so the same number never reads "Unverified" on one and "Register said
 * no" on the other. It lived in the billing module, which is why Settings
 * imported a component out of Billing to draw one badge.
 */
export const TAX_ID_STATUS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Not checked', tone: 'neutral' },
  unverified: { label: 'Register said no', tone: 'warning' },
  unavailable: { label: 'Register silent', tone: 'neutral' },
};

export const taxIdStatusLabel = (status: string): string => TAX_ID_STATUS[status]?.label ?? humanize(status);
export const taxIdStatusTone = (status: string): StatusTone => TAX_ID_STATUS[status]?.tone ?? 'neutral';

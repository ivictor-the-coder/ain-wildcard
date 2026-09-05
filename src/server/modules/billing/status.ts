/**
 * The subscription status machine, in one place.
 *
 * Every status change in the module goes through `assertTransition`, so there
 * is exactly one answer to "can this subscription go from here to there?" and
 * an illegal move is a 409 with the legal moves listed, not a silent write.
 */
import { conflict } from '../../../shared/errors';
import type { SubscriptionStatus } from './types';

/** Statuses a subscription can never leave. */
export const TERMINAL_STATUSES: readonly SubscriptionStatus[] = ['canceled', 'incomplete_expired'];

/** Statuses that keep cycling: the renewal job advances the period. */
export const CYCLING_STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'unpaid', 'paused'];

/** Statuses that count towards recurring revenue. */
export const REVENUE_STATUSES: readonly SubscriptionStatus[] = ['active', 'past_due', 'unpaid'];

const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  // Created but not yet paid for. The first invoice decides which way it goes.
  incomplete: ['active', 'trialing', 'incomplete_expired', 'canceled'],
  incomplete_expired: [],
  // A trial converts, is cut short, or is abandoned.
  trialing: ['active', 'past_due', 'paused', 'unpaid', 'canceled'],
  active: ['past_due', 'paused', 'unpaid', 'canceled', 'trialing'],
  // Collection failed; dunning owns the retries, we own the resting state.
  past_due: ['active', 'unpaid', 'paused', 'canceled'],
  unpaid: ['active', 'past_due', 'paused', 'canceled'],
  // Collection is paused but the cycle keeps running.
  paused: ['active', 'trialing', 'past_due', 'unpaid', 'canceled'],
  canceled: [],
};

export const canTransition = (from: SubscriptionStatus, to: SubscriptionStatus): boolean =>
  from === to || TRANSITIONS[from].includes(to);

export const legalTransitions = (from: SubscriptionStatus): readonly SubscriptionStatus[] => TRANSITIONS[from];

export function assertTransition(id: string, from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (canTransition(from, to)) return;
  const legal = TRANSITIONS[from];
  throw conflict(
    'subscription_status_invalid',
    legal.length
      ? `Subscription ${id} is ${from} and cannot become ${to}. From ${from} it can only become ${legal.join(', ')}.`
      : `Subscription ${id} is ${from}, which is final. Create a new subscription instead.`,
    { from, to, legal },
  );
}

export const isTerminal = (status: SubscriptionStatus): boolean => TERMINAL_STATUSES.includes(status);
export const isCycling = (status: SubscriptionStatus): boolean => CYCLING_STATUSES.includes(status);
export const countsAsRevenue = (status: SubscriptionStatus): boolean => REVENUE_STATUSES.includes(status);

/** The event emitted alongside `subscription.updated` for a given move. */
export function transitionEvent(to: SubscriptionStatus): string {
  switch (to) {
    case 'active': return 'subscription.activated';
    case 'trialing': return 'subscription.trial_started';
    case 'past_due': return 'subscription.past_due';
    case 'unpaid': return 'subscription.unpaid';
    case 'paused': return 'subscription.paused';
    case 'canceled': return 'subscription.canceled';
    case 'incomplete': return 'subscription.incomplete';
    case 'incomplete_expired': return 'subscription.incomplete_expired';
  }
}

/** One line of plain English for a status, used in summaries and by the copilot. */
export function describeStatus(status: SubscriptionStatus): string {
  switch (status) {
    case 'trialing': return 'In trial — nothing has been charged yet.';
    case 'incomplete': return 'Waiting on the first payment. It expires if nothing is paid within 23 hours.';
    case 'incomplete_expired': return 'The first payment never arrived, so this subscription never started.';
    case 'active': return 'Billing normally on its cycle.';
    case 'past_due': return 'The latest invoice failed. Dunning is retrying it.';
    case 'paused': return 'Collection is paused. The cycle still advances.';
    case 'canceled': return 'Ended. It will not bill again.';
    case 'unpaid': return 'Dunning gave up. Invoices are still being raised but nothing is being collected.';
  }
}

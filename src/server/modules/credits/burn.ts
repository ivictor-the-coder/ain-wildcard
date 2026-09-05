/**
 * Which credit is spent first.
 *
 * This is the part of a credit system customers actually notice, so the order
 * is fixed, documented and returned with every settlement rather than being an
 * emergent property of a query plan.
 */
import type { Applicability, ChargeTarget, CreditGrant } from './types';

/** The burn-down order, in the words the API returns. */
export const BURN_ORDER: string[] = [
  'Eligible first: the grant must be in the charge’s currency, effective now, not expired, not voided, paid for, still carrying a balance, and applicable to this charge.',
  '1. Soonest expiry first — a grant about to lapse is spent before one that is not. Grants that never expire go last.',
  '2. Then the grant’s explicit priority, lowest number first.',
  '3. Then promotional before paid, so the customer keeps the credit they paid for.',
  '4. Then the oldest grant first, and finally by id, so two identical grants always draw down in the same order.',
];

export interface Candidate {
  grant: CreditGrant;
  balanceMicro: bigint;
}

/** Does this grant cover this charge? */
export function applicableTo(grant: CreditGrant, target: ChargeTarget): boolean {
  if (grant.currency !== target.currency) return false;
  // Units are not fungible: a pack of telemetry events cannot pay for exported GB.
  if (grant.kind === 'unit' && grant.meter && grant.meter !== target.meter) return false;
  const a = grant.applicability;
  if (a.scope === 'all') return true;
  if (target.price && a.prices.includes(target.price)) return true;
  if (target.meter && a.meters.includes(target.meter)) return true;
  if (target.product && a.products.includes(target.product)) return true;
  return false;
}

export function isLive(grant: CreditGrant, now: number): boolean {
  if (grant.status === 'voided' || grant.status === 'expired') return false;
  // Bought but not yet charged for. The promise is on the books; the money is
  // not, and credit nobody has been billed for is not credit yet.
  if (grant.awaiting_payment) return false;
  if (now < grant.effective_at) return false;
  if (grant.expires_at !== null && now >= grant.expires_at) return false;
  return true;
}

/** Sorts a copy of `candidates` into the order they will be drawn down. */
export function orderCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const expiryA = a.grant.expires_at ?? Number.POSITIVE_INFINITY;
    const expiryB = b.grant.expires_at ?? Number.POSITIVE_INFINITY;
    if (expiryA !== expiryB) return expiryA - expiryB;
    if (a.grant.priority !== b.grant.priority) return a.grant.priority - b.grant.priority;
    const categoryA = a.grant.category === 'promotional' ? 0 : 1;
    const categoryB = b.grant.category === 'promotional' ? 0 : 1;
    if (categoryA !== categoryB) return categoryA - categoryB;
    if (a.grant.created !== b.grant.created) return a.grant.created - b.grant.created;
    return a.grant.id < b.grant.id ? -1 : a.grant.id > b.grant.id ? 1 : 0;
  });
}

/**
 * How many units to actually draw from unit-denominated credits.
 *
 * Naively this is `min(available, quantity)`, but that burns credits against
 * units the price would not have charged for anyway — the free tier of a
 * graduated price, for instance. So we take the largest reduction the customer
 * can get and then find the *smallest* number of units that still achieves it:
 * we never spend a credit that does not move the bill.
 *
 * `cost(q)` must be non-increasing as `q` falls, which is true of every metered
 * price shape. The answer is verified against that assumption and falls back to
 * the naive cap if a price violates it, so a pathological price book cannot
 * silently under-credit a customer.
 */
export function unitsWorthBurning(cost: (quantity: number) => number, quantity: number, available: number): number {
  const cap = Math.min(Math.max(Math.floor(available), 0), quantity);
  if (cap <= 0) return 0;
  const target = cost(quantity - cap);
  if (target >= cost(quantity)) return 0; // spending these units buys nothing

  let lo = 1, hi = cap;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cost(quantity - mid) <= target) hi = mid; else lo = mid + 1;
  }
  const found = lo;
  const achievesTarget = cost(quantity - found) === target;
  const isMinimal = found === 1 || cost(quantity - (found - 1)) > target;
  return achievesTarget && isMinimal ? found : cap;
}

/** A human sentence for what a grant may be spent on. */
export function describeApplicability(a: Applicability, labels: Record<string, string> = {}): string {
  if (a.scope === 'all') return 'any charge in this currency';
  const parts: string[] = [];
  const name = (id: string) => labels[id] ?? id;
  if (a.meters.length) parts.push(`usage on ${a.meters.map(name).join(', ')}`);
  if (a.prices.length) parts.push(`the ${a.prices.map(name).join(', ')} price${a.prices.length > 1 ? 's' : ''}`);
  if (a.products.length) parts.push(a.products.map(name).join(', '));
  return parts.length ? parts.join(' and ') : 'nothing — this grant has a targeted applicability with no targets';
}

/** A stable grouping key for a balance pot. */
export const applicabilityKey = (a: Applicability): string =>
  a.scope === 'all'
    ? 'all'
    : ['meters', 'prices', 'products']
        .map((field) => {
          const values = [...(a[field as 'meters' | 'prices' | 'products'] ?? [])].sort();
          return values.length ? `${field}:${values.join('+')}` : '';
        })
        .filter(Boolean)
        .join('|') || 'targeted:none';

/**
 * What a pot of unit credit is worth in money.
 *
 * `GET /v1/credits/overview` states outstanding monetary credit per currency
 * and counts the unit pots beside it, because a unit is not a currency amount.
 * But a pot that was *sold* has a price: the top-up line that raised it says
 * what the customer paid for how many units, and the refund dialog already
 * prices the unused remainder from that line. The tile does the same sum here,
 * so "$0.00 outstanding" is never printed over a customer holding four million
 * prepaid events.
 *
 * Pure: no React, no design system.
 */
import type { CreditBillableItem, CreditGrant } from './types';

export interface UnitPotValue {
  /** Active unit pots in this currency. */
  pots: number;
  /** Pots whose purchase line was found, in the pot's own currency. */
  priced: number;
  /** Promotional or otherwise unpriced pots — units with no purchase behind them. */
  unpriced: number;
  /** Minor units: the remaining balance at what it was bought for, summed over the priced pots. */
  value: number;
}

/**
 * The unused balance of each sold pot, valued pro rata at its purchase price
 * and rounded once — the same division `POST /v1/credit-grants/:id/refund`
 * settles at, so the tile and the refund dialog cannot name different money
 * for the same pot.
 */
export function unitPotValue(grants: CreditGrant[], purchases: CreditBillableItem[], currency: string): UnitPotValue {
  const code = currency.toLowerCase();
  const byLine = new Map(purchases.map((line) => [line.id, line]));
  const out: UnitPotValue = { pots: 0, priced: 0, unpriced: 0, value: 0 };
  for (const grant of grants) {
    if (grant.kind !== 'unit' || grant.status !== 'active' || grant.currency.toLowerCase() !== code) continue;
    out.pots += 1;
    const line = grant.source === 'topup' && grant.source_ref ? byLine.get(grant.source_ref) : undefined;
    if (!line || line.currency.toLowerCase() !== code || grant.amount <= 0) { out.unpriced += 1; continue; }
    out.priced += 1;
    out.value += Math.round((line.amount * grant.balance) / grant.amount);
  }
  return out;
}

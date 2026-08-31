/**
 * The dashboard's decisions, with no DOM attached.
 *
 * A tile that renders one number out of a multi-currency answer is making a
 * choice, and the choice has to be defensible. `outstanding[0]` was not one:
 * the credits overview sorts its pots alphabetically by currency, so a
 * workspace holding $1,250.00 of prepaid credit and an empty GBP pot read
 * "Prepaid credit outstanding — £0.00" on a screen where every other figure was
 * in USD. The rule that replaces it lives here so it can be tested against the
 * payload shape the API actually returns.
 */
import { exponentOf } from '../../../shared/money';

/** One currency's pot in `GET /v1/credits/overview`. */
export interface CreditPot {
  currency: string;
  monetary_outstanding: number;
  unit_pots: number;
  monetary_outstanding_display: string;
}

export interface CreditOutstanding {
  /** The pot the tile shows. Null when no currency holds money at all. */
  pot: CreditPot | null;
  /** Whether `pot` is denominated in the workspace's own currency. */
  isDefaultCurrency: boolean;
  /** Every other currency still holding money, largest first. */
  others: CreditPot[];
  /** Active grants holding units rather than money, across every currency. */
  unitGrants: number;
  /**
   * What the single number leaves out, as caption clauses joined by ` · `, or
   * null when it leaves out nothing. Lower case: these are appended to the
   * tile's own clauses, not read on their own.
   */
  note: string | null;
}

const code = (currency: string): string => currency.trim().toLowerCase();
const label = (currency: string): string => code(currency).toUpperCase();

/**
 * Pick the pot the "Prepaid credit outstanding" tile should show.
 *
 * The workspace currency wins whenever it holds anything, because that is the
 * currency every other tile on the screen is denominated in. When it holds
 * nothing, showing its $0.00 while another pot holds real money would be true
 * and useless, so the largest pot is shown instead and the note says so. Money
 * cannot be compared across currencies without an FX rate the workspace does
 * not have, so "largest" means largest in major units — near enough to rank
 * pots by, and the note names the others with their own amounts so the reading
 * never rests on that approximation.
 */
export function creditOutstanding(
  pots: readonly CreditPot[] | undefined,
  defaultCurrency: string | undefined,
): CreditOutstanding {
  const all = pots ?? [];
  const def = code(defaultCurrency ?? '');
  const unitGrants = all.reduce((n, pot) => n + (pot.unit_pots || 0), 0);

  const holding = all
    .filter((pot) => pot.monetary_outstanding > 0)
    .sort((a, b) => major(b) - major(a) || code(a.currency).localeCompare(code(b.currency)));

  const pot = holding.find((row) => code(row.currency) === def)
    // Nothing in the workspace currency: show where the money actually is.
    ?? holding[0]
    // Nothing anywhere: the workspace's own empty pot is the honest zero.
    ?? all.find((row) => code(row.currency) === def)
    ?? null;

  const isDefaultCurrency = !def || !pot || code(pot.currency) === def;
  const others = holding.filter((row) => row !== pot);

  const clauses: string[] = [];
  if (pot && !isDefaultCurrency) {
    clauses.push(`shown in ${label(pot.currency)} — no ${label(def)} credit is outstanding`);
  }
  if (others.length) clauses.push(plus(others));

  return { pot, isDefaultCurrency, others, unitGrants, note: clauses.length ? clauses.join(' · ') : null };
}

/** Major units, so ¥1,000 is not ranked as 1,000 dollars' worth of anything. */
const major = (pot: CreditPot): number => pot.monetary_outstanding / 10 ** exponentOf(code(pot.currency));

/** "plus £412.00 in GBP and €90.00 in EUR" — never more than two by name. */
function plus(others: readonly CreditPot[]): string {
  const named = others.slice(0, 2).map((pot) => `${pot.monetary_outstanding_display} in ${label(pot.currency)}`);
  const rest = others.length - named.length;
  if (rest > 0) return `plus ${named.join(', ')} and ${rest} more ${rest === 1 ? 'currency' : 'currencies'}`;
  return `plus ${named.join(' and ')}`;
}

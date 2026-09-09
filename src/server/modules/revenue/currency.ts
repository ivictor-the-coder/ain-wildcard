/**
 * The one rule this module will not bend: **a money figure is stated in a
 * currency, or it is not stated.**
 *
 * There is no exchange-rate table in this platform, and inventing one would be
 * the most dishonest thing a revenue report could do. What this module used to
 * do instead was worse in a quieter way: it added minor units across currencies
 * and labelled the result with the workspace's own currency, so a book of
 * $38,873.66 + €15,279.17 + £2,285.00 was published as `mrr: 5643783,
 * currency: "usd"` and rendered "$56,437.83" — a figure that is true in no
 * currency on earth. With a 3-decimal currency (BHD) or a 0-decimal one (JPY)
 * in the book it is not even the same order of magnitude: BHD 100.000 and
 * ¥100,000 both arrive as 100,000 minor units and both get read as $1,000.00.
 *
 * So: when more than one currency is in scope, every money **scalar** in the
 * response is `null`, and the `by_currency` block — one entry per currency,
 * each internally exact and internally reconciled — is the answer. Narrow the
 * request with `?currency=eur` and the scalars come back, because then they
 * mean something. Nothing is converted, nothing is summed across currencies,
 * and nothing is labelled with a currency it is not in.
 *
 * This is the one place that decides which of those two worlds a request is in.
 */

/** A money figure: a number when one currency is in scope, `null` otherwise. */
export type Scalar = number | null;

export interface CurrencyScope {
  mode: 'single' | 'mixed';
  /**
   * The currency every money field outside `by_currency` is stated in. `null`
   * in mixed mode, which is exactly when those fields are `null` too.
   */
  single: string | null;
  /** The workspace's own currency. A label for the empty book, never a conversion. */
  reporting: string;
  /** Every currency the request touches, sorted. */
  currencies: string[];
  note: string;
}

export const RULE =
  'A money figure is stated in a currency or it is not stated. When more than one currency is in scope every money ' +
  'scalar is null and by_currency is the answer; there is no exchange-rate table here, so nothing is converted and ' +
  'nothing is summed across currencies. Pass ?currency=<iso> to get scalars back.';

export function currencyScope(
  requested: string | undefined, reporting: string, present: string[],
): CurrencyScope {
  const currencies = [...new Set(present.map((c) => c.toLowerCase()))].sort();

  if (requested) {
    const single = requested.toLowerCase();
    return {
      mode: 'single',
      single,
      reporting,
      currencies: [single],
      note:
        `Only ${single.toUpperCase()} subscriptions and invoices are in scope, so every figure in this response is a ` +
        `real ${single.toUpperCase()} amount.`,
    };
  }

  if (currencies.length <= 1) {
    const single = currencies[0] ?? reporting;
    return {
      mode: 'single',
      single,
      reporting,
      currencies: [single],
      note: `The whole book bills in ${single.toUpperCase()}, so no conversion arises and every figure is a real ${single.toUpperCase()} amount.`,
    };
  }

  const names = currencies.map((c) => c.toUpperCase());
  return {
    mode: 'mixed',
    single: null,
    reporting,
    currencies,
    note:
      `This workspace bills in ${names.join(', ')}. There is no exchange-rate table in this platform, so nothing is ` +
      'converted and nothing is added across currencies: every money scalar in this response is null and the ' +
      'by_currency block is the answer. Pass ?currency=' + currencies[0] + ' for a figure that needs no caveat.',
  };
}

/** Publish a money figure only where it is true in one currency. */
export const only = (scope: CurrencyScope, value: number): Scalar =>
  (scope.single === null ? null : value);

/** The same for anything derived from money — a rate, a DSO, a reconciliation. */
export const onlyIn = <T>(scope: CurrencyScope, value: T): T | null =>
  (scope.single === null ? null : value);

/**
 * The sentence a response carries when its scalars are missing, so a reader who
 * only sees `mrr: null` knows why and what to read instead.
 */
export const mixedWarning = (scope: CurrencyScope, what: string): string[] =>
  scope.single !== null
    ? []
    : [
      `${what} is billed in ${scope.currencies.map((c) => c.toUpperCase()).join(', ')} and this platform holds no ` +
      'exchange rates, so no single money figure exists for it: every money scalar here is null and by_currency ' +
      `carries the real amounts. Pass ?currency=${scope.currencies[0]} for a report with scalars in it.`,
    ];

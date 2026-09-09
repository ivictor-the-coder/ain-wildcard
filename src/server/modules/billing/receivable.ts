/**
 * One definition of "still owed", "overdue" and "delinquent" — in SQL, for the
 * ledger that owns the rows.
 *
 * Billing held three of them and they disagreed on the demo book at one
 * instant. `status=open_like` was `status IN ('draft','open')`, so it counted
 * bills that had never been sent alongside bills that had, while
 * `/v1/revenue/collections` — the page a finance team actually works from —
 * ages only what was finalised. `due_before` was `due_date IS NOT NULL AND
 * due_date <= ?`, which is not a filter but a blindfold: a bill with no terms
 * is due on receipt, and the demo book's due-on-receipt bills simply never
 * appeared in the one query the tool descriptions send you to for "what is
 * overdue?". And `billing_customers.delinquent` was subscription status under
 * another name, so an account two months late on its bills whose subscription
 * was collecting fine was in good standing on the overview tile.
 *
 * The definition kept here is the collections report's — `dueAt`, `settledAt`
 * and `outstandingAt` in `src/server/modules/revenue/collections.ts`, which is
 * also the one `src/server/ai/receivables.ts` gives the copilot:
 *
 *  - A receivable is a **finalised** bill that has not been settled. Settled is
 *    paid, voided or written off; an uncollectible bill is a loss, not an asset.
 *    On this ledger that set is exactly `status = 'open'`, because finalising
 *    is the only way in and each of the three exits writes its own status.
 *  - It is worth **what is still due**, never the face value, and a bill a
 *    credit note or an account balance has taken to nothing is off the book
 *    even though nobody paid it — which is why `amount_due > 0` is part of the
 *    predicate rather than a presentation detail.
 *  - It is **overdue** once the day it falls due has passed, and a bill with no
 *    due date is due on receipt: it ages from the day it was finalised.
 */

/** The day a bill falls due, with the due-on-receipt fallbacks the ageing uses. */
export const dueAtSql = (alias: string): string =>
  `COALESCE(${alias}.due_date, ${alias}.finalized_at, ${alias}.created)`;

/**
 * A bill that has been sent, has not been settled, and still asks for money.
 * Parenthesised, so a caller that ORs it cannot silently get a different set.
 */
export const outstandingSql = (alias: string): string =>
  `(${alias}.status = 'open' AND ${alias}.amount_due > 0)`;

/**
 * An account the business is chasing: a bill of theirs has fallen due and not
 * been collected, or a subscription of theirs has stopped collecting.
 *
 * Takes exactly one parameter — the instant to judge at — bound where the `?`
 * appears, because "overdue" is a fact about a moment and a flag written when a
 * subscription last changed status cannot know that the clock has moved.
 */
export const delinquentSql = (alias: string): string => `(
  EXISTS (
    SELECT 1 FROM billing_subscriptions ds
     WHERE ds.org_id = ${alias}.org_id AND ds.customer_id = ${alias}.id
       AND ds.status IN ('past_due','unpaid')
  )
  OR EXISTS (
    SELECT 1 FROM billing_invoices di
     WHERE di.org_id = ${alias}.org_id AND di.customer_id = ${alias}.id
       AND ${outstandingSql('di')} AND ${dueAtSql('di')} <= ?
  )
)`;

/**
 * Revenue reporting.
 *
 * This module owns no table and is the source of truth for nothing. It reads
 * billing's subscriptions and invoices, payments' dunning history, credits'
 * settlement ledger and metering's meters, and its whole job is to say what
 * they add up to without ever disagreeing with them.
 *
 * Two things every endpoint here carries that a revenue report usually does
 * not, and both exist for the same reason — so a sceptic can check the number
 * rather than believe it:
 *
 *  - **`basis`** states, in the response, exactly how the figure was computed:
 *    what counts as revenue, how an interval was normalised, what was excluded
 *    and what is inferred rather than read.
 *  - **`sources`** names the row counts it came from, so "MRR is $412,300"
 *    becomes "MRR is $412,300, from 74 subscriptions and 2 contract changes",
 *    which is an auditable claim.
 *
 * And where a number can be wrong, it says so instead of drawing it: monthly
 * movement carries a reconciliation that re-derives the closing figure from the
 * movements and reports the difference, and `balanced: false` is a first-class
 * answer — reached by checks that can actually fail, never by an identity
 * dressed up as proof.
 *
 * The rule underneath all of it is in `currency.ts`: **a money figure is stated
 * in a currency or it is not stated.** A workspace billing in three currencies
 * has no single MRR, so every money scalar comes back `null` and the
 * `by_currency` block — exact and separately reconciled in each currency — is
 * the answer. `?currency=eur` brings the scalars back, because then they mean
 * something.
 */
import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { list, type Req } from '../../kernel/http';
import { notFound } from '../../../shared/errors';
import { formatMoney, money } from '../../../shared/money';
import v from '../../../shared/validate';
import { Revenue, type RevenueQuery } from './store';

/* --------------------------------- service -------------------------------- */

/**
 * What the rest of the platform needs from revenue. Every method takes the
 * same range query, so a widget, the copilot and a scheduled digest all read
 * one implementation of "the last twelve months".
 */
export interface RevenueService {
  mrr(orgId: string, query?: RevenueQuery): ReturnType<Revenue['mrr']>;
  movement(orgId: string, query?: RevenueQuery): ReturnType<Revenue['movement']>;
  churn(orgId: string, query?: RevenueQuery): ReturnType<Revenue['churn']>;
  cohorts(orgId: string, query?: RevenueQuery): ReturnType<Revenue['cohorts']>;
  deferred(orgId: string, query?: Parameters<Revenue['deferred']>[1]): ReturnType<Revenue['deferred']>;
  collections(orgId: string, query?: RevenueQuery): ReturnType<Revenue['collections']>;
  usage(orgId: string, query?: RevenueQuery): ReturnType<Revenue['usage']>;
  summary(orgId: string, query?: RevenueQuery): ReturnType<Revenue['summary']>;
  /** The same arithmetic narrowed to one account. */
  account(orgId: string, customerId: string, query?: RevenueQuery): ReturnType<Revenue['account']>;
  /** MRR by account, grouped by currency because size only compares inside one. */
  accounts(orgId: string, query?: Parameters<Revenue['accounts']>[1]): ReturnType<Revenue['accounts']>;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { revenue: RevenueService }
}

const stores = new WeakMap<Ctx, Revenue>();
export function revenueStore(ctx: Ctx): Revenue {
  let found = stores.get(ctx);
  if (!found) { found = new Revenue(ctx); stores.set(ctx, found); }
  return found;
}

/* ------------------------------- validators ------------------------------- */

/**
 * A timestamp that survives a query string.
 *
 * `v.timestamp()` reads a number or an ISO-8601 string, but everything in a
 * URL arrives as a string, so `?from=1773100800000` would be refused on a
 * reporting endpoint whose whole job is to take a range. Trying the integer
 * form first accepts both spellings and refuses anything that is neither.
 */
const instant = () => v.transform(
  v.union(v.int({ min: 0, max: 32_503_680_000_000 }), v.timestamp()),
  (value: number) => value,
  { description: 'Unix epoch milliseconds, or an ISO-8601 date such as 2026-03-10.' },
);

const RANGE = {
  from: v.optional(instant()),
  to: v.optional(instant()),
  months: v.optional(v.int({ min: 1, max: 60, description: 'Length of the default window when `from` is omitted.' })),
  currency: v.optional(v.currency()),
};

const rangeQuery = v.object(RANGE);

const movementQuery = v.object({
  ...RANGE,
  top_movers: v.optional(v.int({ min: 0, max: 50, description: 'Accounts to name per month, largest movement first.' })),
});

const deferredQuery = v.object({
  ...RANGE,
  as_of: v.optional(instant()),
  customer: v.optional(v.id('cus')),
  subscription: v.optional(v.id('sub')),
  invoice: v.optional(v.id('in')),
  schedule: v.optional(v.boolean()),
  limit: v.optional(v.int({ min: 1, max: 500 })),
});

const query = (req: Req): RevenueQuery => req.query as unknown as RevenueQuery;

const localeOf = (ctx: Ctx, orgId: string): string => {
  try { return ctx.svc.core.org(orgId).locale || 'en-US'; }
  catch { return 'en-US'; }
};

/* ---------------------------------- module -------------------------------- */

export default defineModule({
  name: 'revenue',
  title: 'Revenue reporting',
  description:
    'MRR and ARR normalised exactly across every billing interval, monthly movement that reconciles opening to closing or says why it does not, logo and revenue churn with gross and net retention, a cohort retention matrix, daily revenue recognition against every invoice line, receivables ageing with DSO and dunning exposure, and the usage economics of a metered book — every figure carrying the basis it was computed on, the row counts it came from, and the currency it is actually in, because a book billing in three currencies has no single total and this module will not invent one.',
  dependsOn: ['core', 'billing', 'payments', 'metering', 'credits'],

  boot(ctx) {
    const revenue = revenueStore(ctx);
    const service: RevenueService = {
      mrr: (orgId, q) => revenue.mrr(orgId, q ?? {}),
      movement: (orgId, q) => revenue.movement(orgId, q ?? {}),
      churn: (orgId, q) => revenue.churn(orgId, q ?? {}),
      cohorts: (orgId, q) => revenue.cohorts(orgId, q ?? {}),
      deferred: (orgId, q) => revenue.deferred(orgId, q ?? {}),
      collections: (orgId, q) => revenue.collections(orgId, q ?? {}),
      usage: (orgId, q) => revenue.usage(orgId, q ?? {}),
      summary: (orgId, q) => revenue.summary(orgId, q ?? {}),
      account: (orgId, customerId, q) => revenue.account(orgId, customerId, q ?? {}),
      accounts: (orgId, q) => revenue.accounts(orgId, q ?? {}),
    };
    ctx.provide('revenue', service);
  },

  routes(router, _ctx) {
    router.get('/v1/revenue/mrr', (req: Req, c: Ctx) => revenueStore(c).mrr(req.auth.orgId, query(req)), {
      summary: 'MRR and ARR, with the monthly series behind them',
      tags: ['revenue'],
      query: rangeQuery,
      description:
        'Contracted monthly recurring revenue: every interval normalised to a month with exact rationals, metered items ' +
        'excluded and reported separately on their own stated basis, trials and paused subscriptions shown as contracted ' +
        'but not recognised. Today\'s figure is billing\'s own subscriptionMrr(), so it cannot disagree with ' +
        '/v1/subscriptions/overview. History is reconstructed from the dated contract changes in the proration ledger and ' +
        'from the pause and resume events, so a closed month never moves. A book in more than one currency reports every ' +
        'money figure in by_currency and nulls the scalars; ?currency=eur brings them back.',
    });

    router.get('/v1/revenue/movement', (req: Req, c: Ctx) => revenueStore(c).movement(req.auth.orgId, query(req) as RevenueQuery & { top_movers?: number }), {
      summary: 'MRR movement by month, reconciled',
      tags: ['revenue'],
      query: movementQuery,
      description:
        'New, expansion, contraction, churn and reactivation for every month in the range, classified per customer. ' +
        'Each row carries a reconciliation proving opening + movements == closing, computed two ways; a month that does ' +
        'not reconcile is named in unbalanced_months and the response sets balanced to false rather than drawing a wrong bar.',
    });

    router.get('/v1/revenue/churn', (req: Req, c: Ctx) => revenueStore(c).churn(req.auth.orgId, query(req)), {
      summary: 'Logo and revenue churn, gross and net retention',
      tags: ['revenue'],
      query: rangeQuery,
      description:
        'Monthly logo churn, gross revenue churn, gross revenue retention and net revenue retention, plus the same ' +
        'measures per signup cohort. Every rate carries the numerator and denominator it was divided from.',
    });

    router.get('/v1/revenue/cohorts', (req: Req, c: Ctx) => revenueStore(c).cohorts(req.auth.orgId, query(req)), {
      summary: 'Retention matrix by signup month',
      tags: ['revenue'],
      query: rangeQuery,
      description:
        'Accounts and MRR retained n months after the month each account first carried recurring revenue, with logo ' +
        'retention and net revenue retention per cell and weighted totals per offset.',
    });

    router.get('/v1/revenue/deferred', (req: Req, c: Ctx) => revenueStore(c).deferred(req.auth.orgId, req.query as never), {
      summary: 'Deferred revenue and the recognition schedule',
      tags: ['revenue'],
      query: deferredQuery,
      description:
        'Every finalised invoice line spread across the days of the period it covers, giving recognised-to-date and the ' +
        'deferred balance at any date. Pass invoice=in_… or schedule=true for the day-by-day schedule, customer=cus_… or ' +
        'subscription=sub_… to narrow it. invoiced = recognised + deferred is checked and reported.',
    });

    router.get('/v1/revenue/collections', (req: Req, c: Ctx) => revenueStore(c).collections(req.auth.orgId, query(req)), {
      summary: 'Receivables ageing, DSO and recovery',
      tags: ['revenue'],
      query: rangeQuery,
      description:
        'AR ageing buckets reconstructed at the close of every month in the range, days sales outstanding, ' +
        'failed-payment exposure and the recovery rate dunning is actually achieving.',
    });

    router.get('/v1/revenue/usage', (req: Req, c: Ctx) => revenueStore(c).usage(req.auth.orgId, query(req)), {
      summary: 'Usage economics: meters, credit and overage',
      tags: ['revenue'],
      query: rangeQuery,
      description:
        'Revenue per meter split into metered value, the part prepaid credit absorbed and the part charged as overage; ' +
        'credit purchased against credit burned; and the share of everything invoiced that is metered rather than recurring.',
    });

    router.get('/v1/revenue/summary', (req: Req, c: Ctx) => revenueStore(c).summary(req.auth.orgId, query(req)), {
      summary: 'The revenue half of the business on one screen',
      tags: ['revenue'],
      query: rangeQuery,
      description:
        'MRR, ARR, net and gross retention, receivables, DSO, deferred balance and overage share, each computed by the ' +
        'same call the dedicated endpoint makes. `balanced` is false whenever any reconciliation in it failed.',
    });

    router.get('/v1/revenue/accounts', (req: Req, c: Ctx) => {
      const q = query(req) as RevenueQuery & { limit?: number };
      const { rows, groups, scope } = revenueStore(c).accounts(req.auth.orgId, q);
      const limit = Math.min(q.limit ?? 100, 500);
      return {
        ...list(rows.slice(0, limit), {
          hasMore: rows.length > limit,
          totalCount: rows.length,
          url: '/v1/revenue/accounts',
        }),
        currency: scope.single,
        groups,
        basis: {
          currency: scope,
          rules: [
            'Every row carries its own currency and its own real MRR; nothing here is converted.',
            scope.single
              ? 'One currency is in scope, so the list is a straight ranking by size.'
              : 'More than one currency is in scope, so the list is grouped by currency and ranked inside each group. '
                + 'Ranking across currencies would put a ¥100,000 account level with a $1,000.00 one. Pass ?currency='
                + `${scope.currencies[0]} for a single ranked list.`,
          ],
        },
        warnings: scope.single
          ? []
          : [`This workspace bills in ${scope.currencies.map((currency) => currency.toUpperCase()).join(', ')}, so these `
            + 'accounts are grouped by currency rather than ranked against each other. `groups` gives the size of each book.'],
      };
    }, {
      summary: 'MRR by account, grouped by currency and largest first inside each',
      tags: ['revenue'],
      query: v.object({ ...RANGE, limit: v.optional(v.int({ min: 1, max: 500 })) }),
      description:
        'Every account carrying recurring revenue now or last month, with the month-on-month change beside it. A mixed '
        + 'book is grouped by currency and ranked inside each group, never ranked across them; ?currency=eur gives one '
        + 'ranked list.',
    });

    router.get('/v1/revenue/accounts/:id', (req: Req, c: Ctx) => {
      const store = revenueStore(c);
      const book = store.book(req.auth.orgId, query(req), { fullHistory: true });
      if (!book.customers.has(req.params.id)) throw notFound('customer', req.params.id);
      return store.account(req.auth.orgId, req.params.id, query(req), book);
    }, {
      summary: 'One account\'s revenue history',
      tags: ['revenue'],
      query: rangeQuery,
      description: 'The MRR series, the subscription timelines behind it, lifetime billed and the account\'s own receivable.',
    });
  },

  tools(ctx) {
    const display = (amount: number, currency: string, orgId: string) =>
      formatMoney(money(amount, currency), { locale: localeOf(ctx, orgId) });

    /**
     * A formatted amount, or nothing at all.
     *
     * The copilot's job here is to state a figure a person can act on, and the
     * fastest way to lose that person's trust is to hand them "$56,437.83" for a
     * book that is part euros and part pounds. So a `*_display` string exists
     * only where one currency is in scope; where several are, the tool returns
     * the per-currency breakdown and the note that says why, and the model has
     * nothing to round up into a single wrong sentence.
     */
    const scalar = (amount: number | null, currency: string | null, orgId: string, key: string) =>
      (amount !== null && currency !== null ? { [key]: display(amount, currency, orgId) } : {});

    return [
      {
        name: 'revenue_summary',
        description:
          'The revenue half of the business: MRR, ARR, net and gross revenue retention, receivables, DSO, deferred ' +
          'balance and overage share, with the basis each was computed on. Use this before answering anything about ' +
          'how the business is doing. When the workspace bills in more than one currency there is no single MRR ' +
          'figure and the money fields come back null — report the by_currency rows, one amount per currency, and ' +
          'never add them together.',
        input: v.object({ months: v.optional(v.int({ min: 1, max: 60 })), currency: v.optional(v.currency()) }),
        readOnly: true,
        tags: ['revenue', 'reporting'],
        run(args: { months?: number; currency?: string }, c: Ctx, meta) {
          const report = revenueStore(c).summary(meta.orgId, args);
          const scope = report.basis.currency;
          return {
            ...report.headline,
            currency: report.currency,
            currency_mode: scope.mode,
            ...scalar(report.headline.mrr, scope.single, meta.orgId, 'mrr_display'),
            ...scalar(report.headline.arr, scope.single, meta.orgId, 'arr_display'),
            ...scalar(report.headline.receivables, scope.single, meta.orgId, 'receivables_display'),
            by_currency: report.by_currency.map((row) => ({
              currency: row.currency,
              mrr: row.mrr,
              arr: row.arr,
              accounts: row.accounts,
              mrr_display: display(row.mrr, row.currency, meta.orgId),
              arr_display: display(row.arr, row.currency, meta.orgId),
              receivables_display: display(row.receivables, row.currency, meta.orgId),
              net_revenue_retention: row.net_revenue_retention.percent,
              gross_revenue_retention: row.gross_revenue_retention.percent,
            })),
            balanced: report.balanced,
            basis: report.basis.summary,
            currency_note: scope.note,
            warnings: report.warnings,
          };
        },
      },
      {
        name: 'revenue_movement',
        description:
          'Month-by-month MRR movement — new, expansion, contraction, churn and reactivation — with the accounts that ' +
          'moved each month and a reconciliation proving opening plus movements equals closing. In a multi-currency ' +
          'workspace the monthly figures come back per currency and each mover names its own.',
        input: v.object({ months: v.optional(v.int({ min: 1, max: 60 })), currency: v.optional(v.currency()) }),
        readOnly: true,
        tags: ['revenue', 'reporting'],
        run(args: { months?: number; currency?: string }, c: Ctx, meta) {
          const report = revenueStore(c).movement(meta.orgId, args);
          const scope = report.basis.currency;
          return {
            currency: report.currency,
            currency_mode: scope.mode,
            balanced: report.balanced,
            warning: report.warning,
            totals: report.totals,
            by_currency: report.by_currency.map((row) => ({
              currency: row.currency,
              opening: display(row.totals.opening, row.currency, meta.orgId),
              net: display(row.totals.net, row.currency, meta.orgId),
              closing: display(row.totals.closing, row.currency, meta.orgId),
              balanced: row.balanced,
            })),
            months: report.series.map((row) => ({
              month: row.month,
              opening: row.opening,
              new_business: row.new_business,
              expansion: row.expansion,
              reactivation: row.reactivation,
              contraction: row.contraction,
              churn: row.churn,
              closing: row.closing,
              by_currency: row.by_currency,
              reconciled: row.reconciliation.balanced,
              movers: row.top_movers.map((mover) => `${mover.name}: ${mover.kind} ${
                mover.currency ? display(mover.amount, mover.currency, meta.orgId) : mover.amount
              }`),
            })),
            currency_note: scope.note,
            warnings: report.warnings,
          };
        },
      },
      {
        name: 'revenue_collections',
        description:
          'What is owed and how old it is: receivables ageing, days sales outstanding, failed-payment exposure and the ' +
          'rate dunning is recovering at. A multi-currency book has no single outstanding figure and no single DSO; ' +
          'both come back per currency.',
        input: v.object({ months: v.optional(v.int({ min: 1, max: 60 })), currency: v.optional(v.currency()) }),
        readOnly: true,
        tags: ['revenue', 'payments'],
        run(args: { months?: number; currency?: string }, c: Ctx, meta) {
          const report = revenueStore(c).collections(meta.orgId, args);
          const scope = report.basis.currency;
          return {
            currency: report.currency,
            currency_mode: scope.mode,
            outstanding: report.totals.outstanding,
            ...scalar(report.totals.outstanding, scope.single, meta.orgId, 'outstanding_display'),
            past_due: report.totals.past_due,
            dso_days: report.totals.dso?.display ?? null,
            ageing: report.ageing.buckets.map((bucket) => ({
              bucket: bucket.label,
              invoices: bucket.invoices,
              amount: bucket.amount,
              share: bucket.share?.percent ?? null,
            })),
            by_currency: report.by_currency.map((row) => ({
              currency: row.currency,
              outstanding: row.totals.outstanding,
              outstanding_display: display(row.totals.outstanding, row.currency, meta.orgId),
              past_due: row.totals.past_due,
              past_due_display: display(row.totals.past_due, row.currency, meta.orgId),
              dso_days: row.totals.dso.display,
              failed_payment_exposure: row.exposure.failed_payments,
              recovery_rate: row.recovery.recovery_rate.percent,
              ageing: row.ageing.buckets.map((bucket) => ({
                bucket: bucket.label, invoices: bucket.invoices, amount: bucket.amount,
              })),
            })),
            failed_payment_exposure: report.exposure.failed_payments,
            recovery_rate: report.recovery.recovery_rate?.percent ?? null,
            note: report.exposure.note,
            currency_note: scope.note,
            warnings: report.warnings,
          };
        },
      },
    ];
  },
});

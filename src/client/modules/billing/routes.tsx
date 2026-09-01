/**
 * The revenue product surface: customers, subscriptions, invoices, and the
 * overview that ties them together.
 *
 * Every figure on these screens is read from the API at render time. Nothing is
 * derived from a constant, and a read that fails renders as a failure with the
 * request id support can grep for — never as a zero.
 */
import { useMemo } from 'react';
import type { CommandDef, NavItem, RouteDef, SettingsPage, WidgetDef } from '../../kernel/registry-types';
import { useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import {
  Badge, Banner, Button, Card, EmptyState, Icons, Inline, Page, Section, Skeleton, Stack, Stat,
  humanize,
} from '../../design';
import {
  Loading, RecordLink, SectionError, StatusPill, calendarDay, customerHref, daysOverdue, invoiceHref,
  invoiceStatusDetail, statusLabel, totalsByCurrency, useBillingFormat,
} from './common';
import { CustomersPage, CustomerDetailPage } from './customers';
import { SubscriptionsPage, SubscriptionDetailPage } from './subscriptions';
import { InvoicesPage, InvoiceDetailPage } from './invoices';
import { TaxRatesPage } from './taxes';
import type { BillingOverview, Invoice, RevenueAccount, Subscription } from './types';

interface RevenueGroup { currency: string; accounts: number; mrr: number; arr: number; largest: string | null }

/**
 * How late a bill is, in the unit an AR team ages a ledger in. `formatRelative`
 * says "2 months ago", which reads as a past event rather than a running debt.
 */
const daysLate = (invoice: Invoice, now: number, timeZone: string): number => (
  invoice.due_date !== null
    // A due date is a UTC calendar boundary; "now" is an instant in the
    // workspace's zone. Dividing the gap by 86,400,000 counts elapsed time
    // rather than dates, and reads a day high all evening in New York.
    ? daysOverdue(invoice.due_date, now, timeZone)
    : Math.max(0, calendarDay(now, timeZone) - calendarDay(invoice.created, timeZone))
);

/* ================================ overview ================================ */

function BillingOverviewPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const overview = useQuery<BillingOverview>('/v1/subscriptions/overview');
  // The card is about what to chase first, so it needs the whole open book to
  // order — `/v1/invoices` answers created-descending, and taking eight off the
  // top of that then calling them "oldest due date first" put the one
  // two-month-overdue invoice at the bottom of the card that exists to find it.
  const receivables = useQuery<ListEnvelope<Invoice>>('/v1/invoices', { status: 'open_like', limit: 200 });
  // The whole book, not the first eight rows of it. The rows come back ordered
  // by currency and then by size, so taking eight off the top handed the card
  // every euro account down to €74.17 and hid sixteen dollar accounts above it.
  const accounts = useQuery<ListEnvelope<RevenueAccount> & { groups?: RevenueGroup[] }>(
    '/v1/revenue/accounts', { limit: 500 },
  );

  const data = overview.data;
  // `status=open_like` is drafts *and* open bills, and a draft the customer has
  // never seen is not a receivable. The card that exists to size what is owed
  // therefore lists only what has been sent; the drafts are counted under it,
  // where they are a queue to finalise rather than money to chase.
  const owed = useMemo(() => {
    const rows = (receivables.data?.data ?? []).filter((invoice) => invoice.status === 'open');
    // "Payable on receipt" has no due date; its issue date is when it became
    // owed, which is what slots it chronologically instead of floating it up.
    const dueAt = (invoice: Invoice) => invoice.due_date ?? invoice.created;
    return [...rows].sort((a, b) => dueAt(a) - dueAt(b));
  }, [receivables.data]);
  const drafts = useMemo(
    () => (receivables.data?.data ?? []).filter((invoice) => invoice.status === 'draft'),
    [receivables.data],
  );
  const draftTotals = useMemo(
    () => totalsByCurrency(drafts, (row) => row.amount_due, (row) => row.currency),
    [drafts],
  );
  const overdue = useMemo(
    () => owed.filter((invoice) => invoice.due_date !== null && invoice.due_date < f.now()),
    [owed, f],
  );
  const statuses = useMemo(
    () => Object.entries(data?.by_status ?? {}).sort((a, b) => b[1] - a[1]),
    [data],
  );
  const paused = data?.by_status?.paused ?? 0;

  // One ranked column per currency. The API already sends the rows grouped and
  // sorted; this only splits them, so the card never ranks across books.
  const books = useMemo(() => {
    const grouped = new Map<string, RevenueAccount[]>();
    for (const row of accounts.data?.data ?? []) {
      const bucket = grouped.get(row.currency) ?? [];
      bucket.push(row);
      grouped.set(row.currency, bucket);
    }
    return [...grouped.entries()]
      .map(([currency, rows]) => ({
        currency,
        rows: [...rows].sort((a, b) => b.mrr - a.mrr),
        mrr: rows.reduce((sum, row) => sum + row.mrr, 0),
      }))
      .sort((a, b) => b.rows.length - a.rows.length || a.currency.localeCompare(b.currency));
  }, [accounts.data]);

  return (
    <Page
      title="Billing"
      eyebrow="Revenue"
      subtitle="What the subscription book is worth today, what is owed, and what happens next."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.wallet size={15} />} onClick={() => navigate('/billing/customers')}>Customers</Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => navigate('/billing/subscriptions?new=1')}>
            New subscription
          </Button>
        </Inline>
      }
    >
      <Stack gap={6}>
        {overview.error && (
          <Card><SectionError error={overview.error} path="GET /v1/subscriptions/overview" onRetry={overview.refetch} /></Card>
        )}
        {!overview.error && !data && (
          <div className="bl-tiles">
            {[0, 1, 2, 3, 4].map((i) => <Card key={i} padding="tight"><Skeleton height={72} /></Card>)}
          </div>
        )}
        {data && (
          <>
            <div className="bl-tiles">
              {data.mixed_currency
                ? data.by_currency.map((book) => (
                  <Card padding="tight" key={book.currency}>
                    <Stat
                      label={`MRR · ${book.currency.toUpperCase()}`}
                      value={book.mrr_display}
                      caption={`${book.arr_display} a year · ${f.plural(book.live, 'live subscription')}`}
                    />
                  </Card>
                ))
                : (
                  <Card padding="tight">
                    <Stat
                      label="Monthly recurring revenue"
                      value={data.mrr_display ?? '—'}
                      caption={`${f.money(data.arr, { currency: data.currency })} a year`}
                    />
                  </Card>
                )}
              <Card padding="tight">
                {/* MRR excludes a paused agreement and this count includes one,
                    so whenever the workspace holds a paused subscription the
                    caption says which part of the count the money covers. */}
                <Stat
                  label="Live subscriptions"
                  value={f.number(data.live)}
                  caption={paused > 0
                    ? `${f.number(data.live - paused)} billing, ${f.number(paused)} paused and outside MRR`
                    : `${f.number(data.subscriptions)} ever created`}
                />
              </Card>
              <Card padding="tight">
                <Stat label="Customers" value={f.number(data.customers)} caption={`${f.number(data.delinquent_customers)} delinquent`} />
              </Card>
              <Card padding="tight">
                <Stat label="Renewing in 30 days" value={f.number(data.renewing_next_30_days)} caption={`${f.number(data.scheduled_to_cancel)} set to cancel`} />
              </Card>
            </div>

            {data.mixed_currency && (
              <Banner tone="info" compact title="Three books, three currencies">
                {`This workspace bills in ${f.list(data.currencies.map((c) => c.toUpperCase()))}. There is no exchange-rate `
                  + 'table in this platform, so nothing is converted and no single MRR figure is offered — each '
                  + 'currency’s book is its own number, and every account below is ranked inside its own.'}
              </Banner>
            )}

            <Card title="The book by status" description="Every subscription ever created, by the state it is in now.">
              <div className="bl-statusgrid">
                {statuses.map(([status, count]) => (
                  <button
                    key={status}
                    type="button"
                    className="bl-statuschip"
                    onClick={() => navigate(`/billing/subscriptions?status=${status}`)}
                  >
                    <StatusPill status={status} />
                    <span className="bl-statuschip__n">{f.number(count)}</span>
                  </button>
                ))}
                {statuses.length === 0 && (
                  <EmptyState size="sm" inline illustration={null} title="No subscription has been created yet" body="The book fills as accounts sign up." />
                )}
              </div>
              {data.uninvoiced_prorations !== 0 && !data.mixed_currency && (
                <div style={{ marginTop: 'var(--space-5)' }}>
                  <Banner tone="info" compact>
                    {`${f.money(data.uninvoiced_prorations, { currency: data.currency })} of proration is priced and waiting for the next invoice.`}
                  </Banner>
                </div>
              )}
            </Card>
          </>
        )}

        <div className="bl-cols">
          <Card
            title="Owed right now"
            description={receivables.error
              // "Nothing is past its date" is a claim about receivables this
              // request never established. The neutral line makes none.
              ? 'Everything still open, the soonest due first.'
              : overdue.length
                ? `${f.plural(overdue.length, 'invoice')} past ${overdue.length === 1 ? 'its' : 'their'} due date, then the rest by how soon they fall due.`
                : 'Everything still open, the soonest due first. Nothing is past its date.'}
            actions={<Button size="sm" variant="secondary" onClick={() => navigate('/billing/invoices?status=open_like')}>All open invoices</Button>}
          >
            {receivables.error && <SectionError error={receivables.error} path="GET /v1/invoices" onRetry={receivables.refetch} />}
            {!receivables.error && receivables.loading && <Loading label="Reading the receivables…" />}
            {!receivables.error && !receivables.loading && owed.length === 0 && (
              <EmptyState
                size="sm"
                inline
                illustration={null}
                title="Nothing is outstanding"
                body={drafts.length
                  ? `Every invoice that has been sent is settled. ${f.plural(drafts.length, 'draft')} still to finalise.`
                  : 'Every invoice this workspace has raised has been settled, written off or withdrawn.'}
                action={drafts.length
                  ? <Button size="sm" variant="secondary" onClick={() => navigate('/billing/invoices?status=draft')}>See the drafts</Button>
                  : undefined}
              />
            )}
            {owed.slice(0, 8).map((invoice) => {
              const late = invoice.due_date !== null && invoice.due_date < f.now();
              return (
                <div key={invoice.id} className={late ? 'bl-row bl-row--late' : 'bl-row'}>
                  <div className="bl-row__main">
                    <div className="bl-row__title">
                      <RecordLink to={invoiceHref(invoice.id)}>{invoice.number}</RecordLink>
                      {' · '}
                      <RecordLink to={customerHref(invoice.customer)}>{invoice.customer_name ?? invoice.customer}</RecordLink>
                    </div>
                    <div className="bl-row__sub">{invoiceStatusDetail(invoice, f)}</div>
                  </div>
                  <div className="bl-row__aside">
                    <div>{invoice.amount_due_display}</div>
                    <div className="bl-sub">
                      {/* An invoice two months late and one raised yesterday are
                          both "Open" on the wire. Only one of them is a problem. */}
                      {late
                        ? <Badge tone="danger" dot pill>{`${f.plural(daysLate(invoice, f.now(), f.timeZone), 'day')} overdue`}</Badge>
                        : <StatusPill status={invoice.status} />}
                    </div>
                  </div>
                </div>
              );
            })}
            {owed.length > 8 && (
              <div className="bl-rank__rest">
                {`${f.plural(owed.length - 8, 'more open invoice')} behind these.`}
              </div>
            )}
            {drafts.length > 0 && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <Banner tone="info" compact title="Not counted above">
                  {`${f.plural(drafts.length, 'invoice')} worth `}
                  {f.list(draftTotals.map((total) => f.money(total.amount, { currency: total.currency })))}
                  {' is held as a draft — collection is paused on those subscriptions, so nothing has been sent '
                    + 'and nothing is owed yet. '}
                  <RecordLink to="/billing/invoices?status=draft">Finalise them</RecordLink>
                  {' to make them collectable.'}
                </Banner>
              </div>
            )}
          </Card>

          <Card
            title="Largest accounts"
            description="Ranked inside each currency — nothing is converted, so each book is its own list."
            actions={<Button size="sm" variant="secondary" onClick={() => navigate('/billing/customers?sort=mrr:desc')}>Every account</Button>}
          >
            {accounts.error && <SectionError error={accounts.error} path="GET /v1/revenue/accounts" onRetry={accounts.refetch} />}
            {!accounts.error && accounts.loading && <Loading label="Reading the account book…" />}
            {!accounts.error && !accounts.loading && (accounts.data?.data.length ?? 0) === 0 && (
              <EmptyState size="sm" inline illustration={null} title="No account carries recurring revenue yet" body="An account appears here as soon as a subscription bills for it." />
            )}
            {!accounts.error && !accounts.loading && (accounts.data?.data.length ?? 0) > 0 && (
              <div className="bl-ranks">
                {books.map((book) => (
                  <div key={book.currency}>
                    <div className="bl-rank__head">
                      <span className="bl-rank__ccy">{book.currency.toUpperCase()}</span>
                      <span className="bl-rank__meta">{f.plural(book.rows.length, 'account')}</span>
                    </div>
                    {book.rows.slice(0, 4).map((account) => (
                      <div key={account.customer} className="bl-rank__row">
                        <span className="bl-rank__name">
                          <RecordLink to={customerHref(account.customer)}>{account.name}</RecordLink>
                        </span>
                        <span className="bl-rank__value">{f.money(account.mrr, { currency: account.currency })}</span>
                      </div>
                    ))}
                    {book.rows.length > 4 && (
                      <div className="bl-rank__rest">
                        {`${f.plural(book.rows.length - 4, 'more account')} worth `}
                        {f.money(book.rows.slice(4).reduce((sum, row) => sum + row.mrr, 0), { currency: book.currency })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Section title="Start something" description="The three things a revenue operator does most.">
          <Inline gap={4} wrap>
            <Button variant="secondary" iconLeft={<Icons.wallet size={15} />} onClick={() => navigate('/billing/customers?new=1')}>New customer</Button>
            <Button variant="secondary" iconLeft={<Icons.repeat size={15} />} onClick={() => navigate('/billing/subscriptions?new=1')}>New subscription</Button>
            <Button variant="secondary" iconLeft={<Icons.invoice size={15} />} onClick={() => navigate('/billing/invoices?new=1')}>Bill an account</Button>
          </Inline>
        </Section>
      </Stack>
    </Page>
  );
}

/* ================================= widgets ================================ */

function RenewalsWidget() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const { data, error, loading, refetch } = useQuery<ListEnvelope<Subscription>>('/v1/subscriptions', {
    status: 'active_like', expand: 'customer', limit: 100,
  });
  const rows = useMemo(
    () => [...(data?.data ?? [])].sort((a, b) => a.current_period_end - b.current_period_end).slice(0, 5),
    [data],
  );
  return (
    <Card
      title="Renewing next"
      description="The subscriptions the clock reaches first"
      actions={<Button size="sm" variant="ghost" onClick={() => navigate('/billing/subscriptions')}>Open</Button>}
    >
      {error && <SectionError error={error} path="GET /v1/subscriptions" onRetry={refetch} />}
      {!error && loading && <Skeleton height={90} />}
      {!error && !loading && rows.length === 0 && (
        <EmptyState size="sm" inline illustration={null} title="Nothing is due to renew" body="No subscription in this workspace is running." />
      )}
      {!error && rows.length > 0 && (
        <div className="bl-rows">
          {rows.map((sub) => (
            <div key={sub.id} className="bl-row">
              <div className="bl-row__main">
                <div className="bl-row__title">
                  <RecordLink to={`/billing/subscriptions/${sub.id}`}>{sub.customer_detail?.name ?? sub.customer}</RecordLink>
                </div>
                <div className="bl-row__sub">
                  {sub.cancel_at_period_end ? 'Ends' : 'Renews'} {f.day(sub.current_period_end)} · {statusLabel(sub.status)}
                </div>
              </div>
              <div className="bl-row__aside">{f.money(sub.mrr, { currency: sub.currency })}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ReceivablesWidget() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const { data, error, loading, refetch } = useQuery<ListEnvelope<Invoice>>('/v1/invoices', { status: 'open_like', limit: 200 });
  // Same ordering as the billing card: what is owed longest, first.
  const rows = useMemo(() => {
    const dueAt = (invoice: Invoice) => invoice.due_date ?? invoice.created;
    return [...(data?.data ?? [])].sort((a, b) => dueAt(a) - dueAt(b)).slice(0, 5);
  }, [data]);
  const currencies = new Set(rows.map((row) => row.currency));
  const total = rows.reduce((sum, row) => sum + row.amount_due, 0);
  return (
    <Card
      title="Owed right now"
      description="Invoices still open, oldest first"
      actions={<Button size="sm" variant="ghost" onClick={() => navigate('/billing/invoices?status=open_like')}>Open</Button>}
    >
      {error && <SectionError error={error} path="GET /v1/invoices" onRetry={refetch} />}
      {!error && loading && <Skeleton height={90} />}
      {!error && !loading && rows.length === 0 && (
        <EmptyState size="sm" inline illustration={null} title="Nothing is outstanding" body="Every bill raised has been settled." />
      )}
      {!error && rows.length > 0 && (
        <Stack gap={4}>
          <Stat
            label={`Open on ${f.plural(data?.total_count ?? rows.length, 'invoice')}`}
            value={currencies.size === 1 ? f.money(total, { currency: rows[0].currency }) : `${rows.length} shown`}
            caption={currencies.size === 1 ? 'Across the five oldest shown below' : 'Mixed currencies — nothing is added across them'}
          />
          <div className="bl-rows">
            {rows.map((invoice) => (
              <div key={invoice.id} className="bl-row">
                <div className="bl-row__main">
                  <div className="bl-row__title"><RecordLink to={invoiceHref(invoice.id)}>{invoice.number}</RecordLink></div>
                  <div className="bl-row__sub">
                    {invoice.customer_name ?? invoice.customer}
                    {invoice.due_date !== null && invoice.due_date < f.now()
                      ? ` · ${f.plural(daysLate(invoice, f.now(), f.timeZone), 'day')} overdue`
                      : invoice.due_date !== null ? ` · due ${f.day(invoice.due_date)}` : ' · payable on receipt'}
                  </div>
                </div>
                <div className="bl-row__aside">{invoice.amount_due_display}</div>
              </div>
            ))}
          </div>
        </Stack>
      )}
    </Card>
  );
}

/* =============================== registration ============================= */

export const routes: RouteDef[] = [
  { path: '/billing', element: BillingOverviewPage, title: 'Billing' },
  { path: '/billing/customers', element: CustomersPage, title: 'Customers' },
  { path: '/billing/customers/:id', element: CustomerDetailPage, title: 'Customer' },
  { path: '/billing/subscriptions', element: SubscriptionsPage, title: 'Subscriptions' },
  { path: '/billing/subscriptions/:id', element: SubscriptionDetailPage, title: 'Subscription' },
  { path: '/billing/invoices', element: InvoicesPage, title: 'Invoices' },
  { path: '/billing/invoices/:id', element: InvoiceDetailPage, title: 'Invoice' },
  { path: '/billing/taxes', element: TaxRatesPage, title: 'Tax' },
];

export const nav: NavItem[] = [
  { id: 'billing', label: 'Billing', to: '/billing', group: 'revenue', order: 10, icon: 'gauge' },
  { id: 'billing.customers.nav', label: 'Customers', to: '/billing/customers', group: 'revenue', order: 12, icon: 'wallet' },
  { id: 'billing.subscriptions.nav', label: 'Subscriptions', to: '/billing/subscriptions', group: 'revenue', order: 14, icon: 'repeat' },
  { id: 'billing.invoices.nav', label: 'Invoices', to: '/billing/invoices', group: 'revenue', order: 16, icon: 'invoice' },
  { id: 'billing.taxes.nav', label: 'Tax', to: '/billing/taxes', group: 'revenue', order: 18, icon: 'percent' },
];

export const commands: CommandDef[] = [
  {
    id: 'billing.overview',
    title: 'Billing overview',
    subtitle: 'MRR, what is owed and what renews next',
    group: 'Go to',
    keywords: ['billing', 'revenue', 'mrr', 'arr'],
    icon: 'gauge',
    run: (nav) => nav('/billing'),
  },
  {
    id: 'billing.customers.open',
    title: 'Billing customers',
    subtitle: 'Every account this workspace bills',
    group: 'Go to',
    keywords: ['customer', 'account', 'billing'],
    icon: 'wallet',
    run: (nav) => nav('/billing/customers'),
  },
  {
    id: 'billing.subscriptions.open',
    title: 'Subscriptions',
    subtitle: 'The recurring book, by status',
    group: 'Go to',
    keywords: ['subscription', 'plan', 'renewal', 'mrr'],
    icon: 'repeat',
    run: (nav) => nav('/billing/subscriptions'),
  },
  {
    id: 'billing.invoices.open',
    title: 'Invoices',
    subtitle: 'Every bill raised, and what is still owed',
    group: 'Go to',
    keywords: ['invoice', 'bill', 'receivable', 'owed'],
    icon: 'invoice',
    run: (nav) => nav('/billing/invoices'),
  },
  {
    id: 'billing.customer.new',
    title: 'New billing customer',
    subtitle: 'Create the account that carries a currency, a balance and invoices',
    group: 'Create',
    keywords: ['new customer', 'create account'],
    icon: 'plus',
    run: (nav) => nav('/billing/customers?new=1'),
  },
  {
    id: 'billing.subscription.new',
    title: 'New subscription',
    subtitle: 'Put an account on a plan; the first period opens immediately',
    group: 'Create',
    keywords: ['new subscription', 'subscribe', 'plan'],
    icon: 'repeat',
    run: (nav) => nav('/billing/subscriptions?new=1'),
  },
  {
    id: 'billing.invoice.new',
    title: 'Bill an account now',
    subtitle: 'Sweep every proration and settled usage onto one invoice',
    group: 'Create',
    keywords: ['invoice now', 'bill', 'charge'],
    icon: 'invoice',
    run: (nav) => nav('/billing/invoices?new=1'),
  },
  {
    id: 'billing.open.receivables',
    title: 'What is owed right now',
    subtitle: 'Every invoice still open',
    group: 'Revenue',
    keywords: ['outstanding', 'receivable', 'overdue', 'unpaid'],
    icon: 'coins',
    run: (nav) => nav('/billing/invoices?status=open_like'),
  },
  {
    id: 'billing.taxes.open',
    title: 'Tax registrations',
    subtitle: 'Where this workspace collects, and what happens to a bill it cannot place',
    group: 'Go to',
    keywords: ['tax', 'vat', 'gst', 'sales tax', 'rate', 'jurisdiction'],
    icon: 'percent',
    run: (nav) => nav('/billing/taxes'),
  },
  {
    id: 'billing.tax.missing',
    title: 'Bills with no tax location',
    subtitle: 'Invoices raised for an account whose country nothing could match',
    group: 'Revenue',
    keywords: ['tax missing', 'no country', 'untaxed', 'held'],
    icon: 'alert-triangle',
    run: (nav) => nav('/billing/invoices?tax=missing'),
  },
  {
    id: 'billing.open.past_due',
    title: 'Past-due subscriptions',
    subtitle: 'Accounts in arrears',
    group: 'Revenue',
    keywords: ['past due', 'dunning', 'arrears', 'delinquent'],
    icon: 'alert-triangle',
    run: (nav) => nav('/billing/subscriptions?status=past_due'),
  },
];

export const widgets: WidgetDef[] = [
  {
    id: 'billing.renewals',
    title: 'Renewing next',
    description: 'The subscriptions the clock reaches first',
    span: 4,
    component: RenewalsWidget,
    group: 'revenue',
  },
  {
    id: 'billing.receivables',
    title: 'Owed right now',
    description: 'Open invoices, oldest first',
    span: 4,
    component: ReceivablesWidget,
    group: 'revenue',
  },
];

export { humanize as billingHumanize, statusLabel };

export const settings: SettingsPage[] = [
  {
    id: 'billing.taxes',
    label: 'Tax registrations',
    group: 'Revenue',
    order: 20,
    path: '/billing/taxes',
    element: TaxRatesPage,
    description: 'The rates every invoice is taxed from, and the hold on bills with no location',
  },
];

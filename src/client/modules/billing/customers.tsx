/**
 * Customers: who is billed, and everything true about their account.
 *
 * The list joins two reads that answer different questions — `/v1/customers`
 * for the record and `/v1/revenue/accounts` for what each one is worth — and
 * says so when the second is not installed rather than printing a zero. The
 * detail screen is `GET /v1/customers/:id/summary`, which is one request that
 * already knows the subscriptions, the balance and its ledger, lifetime value,
 * the next invoice and what needs attention.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useParams, useSearchParam } from '../../kernel/router';
import { usePlatform } from '../../kernel/platform';
import {
  Badge, Banner, Button, Card, DataTable, EmptyState, Field, Grid, GridItem, Icons, Inline, Input,
  Modal, Page, Section, Select, Stack, Tabs, Textarea, Tooltip, humanize, useToast,
  type DataTableColumn, type MenuSection,
} from '../../design';
import { ArrowUpRightIcon } from '../../design';
import {
  BookFooter, DialogFields, EmptyList, FieldRow, InlineEdit, ListFailure, LoadFailedEmpty, Loading,
  balanceWords, csvAmount, csvDay, ExportCsvButton, invoiceClockNote, useBookTotal,
  MoneyRangeFilter, MoneyTotals, RecordLink, RecordMissing, SectionError, StatusPill, TableSearch, customerHref,
  decodeRange, encodeRange, idem, invoiceHref, matchesRange, moneyRank, prorationCopy, rangeActive, subscriptionHref,
  totalsByCurrency, useAction, useBillingFormat, useBookList, useCurrencyChoices, useDebounced, useDialogForm,
  useOpenOnQuery, useRecord, useRecordTab, useTableView, visibleRows,
} from './common';
import { ActionMenu, CreditDialog, Headline, SubscriptionCreateDialog } from './subscriptions';
import { BillNowDialog, CustomerInvoices } from './invoices';
import { PaymentsTab, TaxRegistrationsCard } from './payments';
import type { BillingFormatter, CsvColumn } from './common';
import type { BalanceTransaction, Customer, CustomerSummary, Invoice, RevenueAccount } from './types';

/* ================================== list ================================== */

const currencyOfRow = (row: { currency: string }): string => row.currency;

export function CustomersPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const toast = useToast();
  const action = useAction();
  const platform = usePlatform(true);
  const [currency, setCurrency] = useSearchParam('currency', '');
  const [standing, setStanding] = useSearchParam('standing', '');
  const [view, setView] = useTableView({ columnId: 'name', direction: 'asc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [crediting, setCrediting] = useState<Customer | null>(null);
  useOpenOnQuery('new', useCallback(() => setCreating(true), []));

  // The grid's own search filters the rows it holds; sending the same string to
  // the server first means it is searching the whole book rather than page one.
  const search = useDebounced(view.query.trim(), 250);
  const book = useBookList<Customer>('/v1/customers', useMemo(() => ({
    ...(search ? { query: search } : {}),
    ...(currency ? { currency } : {}),
    ...(standing === 'delinquent' ? { delinquent: true } : {}),
    ...(standing === 'subscribed' ? { has_subscription: true } : {}),
  }), [search, currency, standing]));

  const hasRevenue = platform.serves('GET', '/v1/revenue/accounts');
  const accounts = useQuery<ListEnvelope<RevenueAccount>>('/v1/revenue/accounts', { limit: 500 }, { enabled: hasRevenue });
  const mrrByCustomer = useMemo(() => {
    const map = new Map<string, RevenueAccount>();
    for (const row of accounts.data?.data ?? []) map.set(row.customer, row);
    return map;
  }, [accounts.data]);

  const [rangeParam, setRangeParam] = useSearchParam('amount', '');
  const { currencies, preferred } = useCurrencyChoices(book.rows, currencyOfRow, f.currency);
  const range = useMemo(() => decodeRange(rangeParam, preferred), [rangeParam, preferred]);

  const columns = useMemo<DataTableColumn<Customer>[]>(() => {
    const cols: DataTableColumn<Customer>[] = [
      {
        id: 'name',
        header: 'Account',
        pinned: true,
        width: 260,
        sortable: true,
        accessor: (row) => row.name,
        cell: (row) => (
          <div className="bl-cellstack">
            <RecordLink to={customerHref(row.id)}>{row.name}</RecordLink>
            <span className="bl-cellstack__sub">{row.email ?? row.id}</span>
          </div>
        ),
      },
      {
        id: 'currency',
        header: 'Currency',
        width: 110,
        filter: 'set',
        accessor: (row) => row.currency.toUpperCase(),
        cell: (row) => (
          <Inline gap={3}>
            <span>{row.currency.toUpperCase()}</span>
            {row.currency_locked && (
              <Tooltip content="Fixed by the first invoice raised on this account."><span className="bl-muted"><Icons.lock size={12} /></span></Tooltip>
            )}
          </Inline>
        ),
      },
    ];
    if (hasRevenue) {
      cols.push(
        {
          id: 'mrr',
          header: 'MRR',
          align: 'right',
          width: 120,
          sortable: true,
          headerTitle: 'MRR',
          accessor: (row) => moneyRank(mrrByCustomer.get(row.id)?.mrr ?? 0, mrrByCustomer.get(row.id)?.currency ?? row.currency),
          cell: (row) => {
            const account = mrrByCustomer.get(row.id);
            if (!account) return <span className="bl-muted">—</span>;
            return <span className="bl-amount">{f.money(account.mrr, { currency: account.currency })}</span>;
          },
          total: (rows) => (
            <MoneyTotals
              totals={totalsByCurrency(
                rows.filter((row) => mrrByCustomer.has(row.id)),
                (row) => mrrByCustomer.get(row.id)?.mrr ?? 0,
                (row) => mrrByCustomer.get(row.id)?.currency ?? row.currency,
              )}
            />
          ),
        },
        {
          id: 'subscriptions',
          header: 'Subs',
          align: 'right',
          width: 80,
          sortable: true,
          defaultHidden: true,
          accessor: (row) => mrrByCustomer.get(row.id)?.subscriptions ?? 0,
        },
      );
    }
    cols.push(
      {
        id: 'balance',
        header: 'Balance',
        align: 'right',
        width: 140,
        sortable: true,
        headerTitle: 'Balance',
        accessor: (row) => moneyRank(row.balance, row.currency),
        cell: (row) => (
          row.balance === 0
            ? <span className="bl-muted">—</span>
            : row.balance < 0
              ? <span className="bl-amount bl-amount--credit">{f.money(-row.balance, { currency: row.currency })} credit</span>
              : <span className="bl-amount">{f.money(row.balance, { currency: row.currency })} owed</span>
        ),
      },
      {
        id: 'standing',
        header: 'Standing',
        width: 130,
        filter: 'set',
        accessor: (row) => (row.delinquent ? 'delinquent' : 'good'),
        cell: (row) => (row.delinquent ? <Badge tone="danger" dot pill>Delinquent</Badge> : <Badge tone="success" dot pill>Good standing</Badge>),
      },
      {
        id: 'created',
        header: 'Customer since',
        width: 150,
        sortable: true,
        accessor: (row) => row.created,
        cell: (row) => f.date(row.created, { withYear: true }),
      },
    );
    return cols;
  }, [f, hasRevenue, mrrByCustomer]);

  const rows = useMemo(() => (rangeActive(range)
    ? book.rows.filter((row) => {
      const account = mrrByCustomer.get(row.id);
      return range.field === 'mrr'
        ? !!account && matchesRange(account.mrr, account.currency, range)
        : matchesRange(row.balance, row.currency, range);
    })
    : book.rows), [book.rows, range, mrrByCustomer]);
  // The book with nothing asked of it. `book.total` counts only what the
  // server returned for the filters in force, so "Delinquent only" used to
  // print "0 rows · the whole book" over an empty grid.
  const whole = useBookTotal('/v1/customers', {});
  // Built here rather than at module scope because two of its columns are
  // joined from the revenue book, and a file that silently drops MRR when that
  // read failed would be worse than one that says the column is empty.
  const customerCsv = useMemo<CsvColumn<Customer>[]>(() => [
    { header: 'Account', value: (row) => row.name },
    { header: 'Email', value: (row) => row.email ?? '' },
    { header: 'Currency', value: (row) => row.currency.toUpperCase() },
    { header: 'MRR', value: (row) => {
      const account = mrrByCustomer.get(row.id);
      return account ? csvAmount(account.mrr, account.currency) : '';
    } },
    { header: 'Subscriptions', value: (row) => mrrByCustomer.get(row.id)?.subscriptions ?? '' },
    { header: 'Balance', value: (row) => csvAmount(row.balance, row.currency) },
    { header: 'Balance means', value: (row) => (row.balance === 0 ? 'Settled' : row.balance < 0 ? 'Credit held' : 'Carried forward') },
    { header: 'Standing', value: (row) => (row.delinquent ? 'Delinquent' : 'Good standing') },
    { header: 'Tax exempt', value: (row) => humanize(row.tax_exempt) },
    { header: 'Country', value: (row) => row.address?.country ?? '' },
    { header: 'Created', value: (row) => csvDay(row.created) },
    { header: 'Customer id', value: (row) => row.id },
  ], [mrrByCustomer]);
  const visible = useMemo(() => visibleRows(rows, columns, view), [rows, columns, view]);
  const shown = visible.length;

  const billSelected = async () => {
    const ids = [...selected];
    let ok = 0;
    for (const id of ids) {
      try { await api.post('/v1/invoices', { customer: id }); ok++; } catch { /* reported below */ }
    }
    setSelected([]);
    book.retry();
    if (ok === ids.length) toast.success(`Raised ${ok} ${ok === 1 ? 'invoice' : 'invoices'}`);
    else toast.warning(`Raised ${ok} of ${ids.length}`, 'The rest had nothing waiting to bill.', { duration: 0 });
  };

  const rowMenu = (row: Customer): MenuSection[] => [{
    id: 'customer',
    items: [
      { id: 'open', label: 'Open', icon: <ArrowUpRightIcon size={14} />, onSelect: () => navigate(customerHref(row.id)) },
      { id: 'credit', label: 'Adjust the balance…', icon: <Icons.percent size={14} />, onSelect: () => setCrediting(row) },
      {
        id: 'bill',
        label: 'Bill what is owed now',
        icon: <Icons.invoice size={14} />,
        onSelect: () => {
          void action.run(
            api.post<Invoice>('/v1/invoices', { customer: row.id }, { idempotencyKey: idem() }),
            { success: 'Invoice raised', failure: 'Nothing could be billed' },
            ['/v1/invoices', '/v1/customers'],
          ).then((invoice) => { if (invoice) navigate(invoiceHref(invoice.id)); });
        },
      },
      {
        id: 'delete',
        label: 'Delete this customer',
        icon: <Icons.trash size={14} />,
        danger: true,
        onSelect: () => {
          void action.run(
            api.del(`/v1/customers/${row.id}`),
            { success: `${row.name} deleted`, failure: 'The customer could not be deleted' },
            ['/v1/customers'],
          ).then(() => book.retry());
        },
      },
    ],
  }];

  return (
    <Page
      title="Customers"
      eyebrow="Revenue"
      subtitle="Every account this workspace bills, what it is worth and what it owes."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.repeat size={15} />} onClick={() => navigate('/billing/subscriptions')}>
            Subscriptions
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setCreating(true)}>
            New customer
          </Button>
        </Inline>
      }
    >
      <Stack gap={5}>
        {hasRevenue && accounts.error && (
          <Banner tone="warning" title="MRR could not be read">
            {`${accounts.error.body.message} The accounts below are real; the MRR column is missing, not zero.`}
          </Banner>
        )}
        {book.error && <ListFailure error={book.error} path="GET /v1/customers" onRetry={book.retry} />}
        <div className={book.loading ? 'bl-grid is-loading' : 'bl-grid'}>
        <DataTable
          /* The grid decides which columns start hidden once, on its first
             render. The revenue columns only exist after `/v1/system/map`
             answers, so without this key they arrived late and skipped that
             decision — which is how "MRR amount" and "Subs" ended up on screen
             despite both being defaultHidden. */
          key={hasRevenue ? 'with-revenue' : 'no-revenue'}
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Billing customers"
          loading={book.loading}
          error={null}
          onRetry={book.retry}
          value={view}
          onChange={setView}
          initialSort={{ columnId: 'name', direction: 'asc' }}
          searchable={false}
          selectable
          selected={selected}
          onSelectionChange={setSelected}
          onRowClick={(row) => navigate(customerHref(row.id))}
          rowActions={rowMenu}
          rowTone={(row) => (row.delinquent ? 'danger' : 'default')}
          maxHeight={640}
          toolbar={
            <Inline gap={3}>
              <TableSearch view={view} onChange={setView} label="Search name, email or id" />
              <Select
                size="sm"
                aria-label="Standing"
                value={standing}
                onChange={(value) => { setStanding(value || undefined); setSelected([]); }}
                icon={<Icons.filter size={14} />}
                options={[
                  { value: '', label: 'Every account' },
                  { value: 'subscribed', label: 'With a live subscription' },
                  { value: 'delinquent', label: 'Delinquent only' },
                ]}
              />
              <Select
                size="sm"
                aria-label="Currency"
                value={currency}
                onChange={(value) => setCurrency(value || undefined)}
                options={[
                  { value: '', label: 'Any currency' },
                  { value: 'usd', label: 'USD' },
                  { value: 'eur', label: 'EUR' },
                  { value: 'gbp', label: 'GBP' },
                ]}
              />
              <MoneyRangeFilter
                value={range}
                onChange={(next) => { setRangeParam(encodeRange(next) || undefined); setSelected([]); }}
                // MRR is joined from the revenue book. When that read failed the
                // column is missing rather than zero, so offering a filter over
                // it would answer "nothing matches" about data nobody has.
                fields={hasRevenue && !accounts.error
                  ? [{ value: 'mrr', label: 'MRR' }, { value: 'balance', label: 'Balance' }]
                  : [{ value: 'balance', label: 'Balance' }]}
                currencies={currencies}
                defaultCurrency={preferred}
              />
              <ExportCsvButton
                rows={visible}
                columns={customerCsv}
                name="customers"
                noun="customers"
                disabled={!book.complete}
                reason={book.complete ? undefined : 'Still reading the book — the file would hold fewer rows than the screen.'}
              />
            </Inline>
          }
          bulkActions={(ids) => (
            <Inline gap={3}>
              <Button size="sm" variant="secondary" iconLeft={<Icons.invoice size={13} />} onClick={() => { void billSelected(); }}>
                Bill {ids.length} {ids.length === 1 ? 'account' : 'accounts'}
              </Button>
            </Inline>
          )}
          empty={book.error
            ? <LoadFailedEmpty noun="customers" />
            : (
              <EmptyList
                title="No account matches this filter"
                body="A billing customer is the invoicing face of a company — the one that carries the currency, the tax registration and the balance."
                action={<Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setCreating(true)}>New customer</Button>}
              />
            )}
          footer={<BookFooter book={book} noun="customers" shown={shown} whole={whole} />}
        />
        </div>
        <p className="bl-gridnote">
          MRR and Balance are ranked and totalled inside each currency. There is no exchange-rate table in this
          platform, so nothing here is converted and no figure is added across two books. A negative balance is
          credit the account holds.
        </p>
      </Stack>

      <CustomerCreateDialog open={creating} onClose={() => setCreating(false)} />
      {crediting && (
        <CreditDialog
          customer={crediting.id}
          currency={crediting.currency}
          open
          onClose={() => setCrediting(null)}
        />
      )}
    </Page>
  );
}

/* ============================== create dialog ============================= */

function CustomerCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const action = useAction();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currency, setCurrency] = useState('usd');
  const [description, setDescription] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [line1, setLine1] = useState('');
  const [daysUntilDue, setDaysUntilDue] = useState('30');

  const submit = async () => {
    const created = await action.run(
      api.post<Customer>('/v1/customers', {
        name: name.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        currency,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        // Every part of the address, because the invoice document prints it and
        // the tax engine matches on the most specific line it is given: a
        // customer created here should not need a second screen to be billable.
        ...(line1.trim() || city.trim() || state.trim() || postalCode.trim() || country.trim()
          ? {
            address: {
              ...(line1.trim() ? { line1: line1.trim() } : {}),
              ...(city.trim() ? { city: city.trim() } : {}),
              ...(state.trim() ? { state: state.trim() } : {}),
              ...(postalCode.trim() ? { postal_code: postalCode.trim() } : {}),
              ...(country.trim() ? { country: country.trim() } : {}),
            },
          }
          : {}),
        invoice_settings: { days_until_due: Number(daysUntilDue) || 0 },
      }, { idempotencyKey: idem() }),
      { success: 'Customer created', description: 'They can now hold a subscription, a balance and invoices.', failure: 'The customer was refused' },
      ['/v1/customers'],
    );
    if (created) {
      onClose();
      setName(''); setEmail(''); setDescription(''); setPhone('');
      setLine1(''); setCity(''); setState(''); setPostalCode(''); setCountry('');
      navigate(customerHref(created.id));
    }
  };

  const ready = name.trim().length > 0 && !action.busy;
  const form = useDialogForm(open, ready, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="New customer"
      description="The billing face of a company: it carries the currency, the tax address and the balance. Enter creates it from any field."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!ready} onClick={() => { void submit(); }}>
            Create customer
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        <Field label="Name" required error={action.errorFor('name')}>
          <Input value={name} maxLength={200} placeholder="Cobalt Line Automation" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Grid columns={2} gap={5}>
          <GridItem>
            <Field label="Billing email" optional error={action.errorFor('email')}>
              <Input type="email" value={email} placeholder="ap@cobaltline.com" onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Currency" hint="Fixed once the first invoice is raised." error={action.errorFor('currency')}>
              <Select
                value={currency}
                onChange={setCurrency}
                options={[
                  { value: 'usd', label: 'USD — US dollar' },
                  { value: 'eur', label: 'EUR — euro' },
                  { value: 'gbp', label: 'GBP — pound sterling' },
                ]}
              />
            </Field>
          </GridItem>
        </Grid>
        <Field label="Description" optional error={action.errorFor('description')}>
          <Textarea value={description} maxLength={1000} placeholder="Billing account for Cobalt Line Automation — 1 plant, 34 connected assets." onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Grid columns={2} gap={5}>
          <GridItem>
            <Field label="Phone" optional error={action.errorFor('phone')}>
              <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Net terms" hint="Days until an invoice is due." error={action.errorFor('invoice_settings')}>
              <Select
                value={daysUntilDue}
                onChange={setDaysUntilDue}
                options={[
                  { value: '0', label: 'Due on receipt' },
                  { value: '14', label: 'Net 14' },
                  { value: '30', label: 'Net 30' },
                  { value: '45', label: 'Net 45' },
                  { value: '60', label: 'Net 60' },
                ]}
              />
            </Field>
          </GridItem>
        </Grid>
        <Section title="Billing address" description="Tax is resolved from this address, so a missing country means no rate can match.">
          <Grid columns={3} gap={5}>
            <GridItem span={3}>
              <Field label="Street" optional error={action.errorFor('address')}>
                <Input value={line1} onChange={(e) => setLine1(e.target.value)} />
              </Field>
            </GridItem>
            <GridItem>
              <Field label="City" optional><Input value={city} placeholder="Kitchener" onChange={(e) => setCity(e.target.value)} /></Field>
            </GridItem>
            <GridItem>
              <Field label="State or region" optional><Input value={state} placeholder="Ontario" onChange={(e) => setState(e.target.value)} /></Field>
            </GridItem>
            <GridItem>
              <Field label="Postal code" optional><Input value={postalCode} placeholder="N2L 6R5" onChange={(e) => setPostalCode(e.target.value)} /></Field>
            </GridItem>
            <GridItem span={3}>
              <Field label="Country" optional hint="A missing country means no rate can match, so the bill is taxed at zero by default.">
                <Input value={country} placeholder="Canada" onChange={(e) => setCountry(e.target.value)} />
              </Field>
            </GridItem>
          </Grid>
        </Section>
      </Stack>
      </DialogFields>
    </Modal>
  );
}

/* ================================= detail ================================= */

const CUSTOMER_TABS = ['overview', 'invoices', 'payments', 'ledger', 'details'] as const;

export function CustomerDetailPage() {
  const { id } = useParams();
  const f = useBillingFormat();
  const navigate = useNavigate();
  const action = useAction();
  const [tab, setTab] = useRecordTab(CUSTOMER_TABS, 'overview');
  const [dialog, setDialog] = useState<null | 'credit' | 'subscription' | 'bill'>(null);

  const { data, error, loading, refetch } = useRecord<CustomerSummary>(`/v1/customers/${id}/summary`);

  if (loading) return <Page title="Customer"><Loading label="Loading this account…" /></Page>;
  if (error || !data) {
    return (
      <Page title="Customer" eyebrow="Revenue">
        <Card>
          <RecordMissing
            error={error ?? ({ status: 404, body: { message: `No account with the id ${id}.` } } as ApiClientError)}
            path={`GET /v1/customers/${id}/summary`}
            onRetry={refetch}
            noun="account"
            backTo="/billing/customers"
            backLabel="Back to customers"
          />
        </Card>
      </Page>
    );
  }

  const customer = data.customer;
  const patch = (body: Record<string, unknown>) => action.run(
    api.patch<Customer>(`/v1/customers/${customer.id}`, body),
    { success: 'Saved', failure: 'That edit was refused' },
    ['/v1/customers'],
  ).then((result) => { if (!result) throw new Error('refused'); return result; });

  const sections: MenuSection[] = [{
    id: 'account',
    items: [
      { id: 'credit', label: 'Adjust the balance…', icon: <Icons.percent size={14} />, onSelect: () => setDialog('credit') },
      { id: 'subscription', label: 'Start a subscription…', icon: <Icons.repeat size={14} />, onSelect: () => setDialog('subscription') },
      {
        id: 'delete',
        label: 'Delete this customer',
        icon: <Icons.trash size={14} />,
        danger: true,
        onSelect: () => {
          void action.run(
            api.del(`/v1/customers/${customer.id}`),
            { success: `${customer.name} deleted`, failure: 'The customer could not be deleted' },
            ['/v1/customers'],
          ).then((result) => { if (result) navigate('/billing/customers'); });
        },
      },
    ],
  }];

  return (
    <Page
      title={customer.name}
      eyebrow="Customer"
      badge={customer.delinquent ? <span style={{ marginLeft: 'var(--space-4)' }}><Badge tone="danger" dot pill>Delinquent</Badge></span> : undefined}
      subtitle={accountHeadline(data, f)}
      breadcrumbs={<RecordLink to="/billing/customers">Customers</RecordLink>}
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.invoice size={15} />} onClick={() => setDialog('bill')}>Bill now</Button>
          <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => setDialog('subscription')}>New subscription</Button>
          <ActionMenu sections={sections} label="More account actions" />
        </Inline>
      }
      tabs={
        <Tabs
          aria-label="Customer sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'invoices', label: 'Invoices', count: data.open_invoices.data.length || undefined },
            { id: 'payments', label: 'Payment & credit' },
            { id: 'ledger', label: 'Balance ledger', count: data.balance.transactions.length || undefined },
            { id: 'details', label: 'Details' },
          ]}
        />
      }
    >
      <Stack gap={6}>
        <Card>
          <div className="bl-headline">
            <Headline
              label="Lifetime value"
              value={f.money(data.lifetime_value.amount, { currency: data.lifetime_value.currency })}
              caption={data.lifetime_value.customer_since
                // Not "customer since": this is the first invoice, which on a
                // migrated book is years after the record was created. The list
                // column keeps `created` and this one says what it measures.
                ? `First billed ${f.day(data.lifetime_value.customer_since, { withYear: true })} · ${f.plural(data.lifetime_value.periods_billed, 'period')} billed`
                : `${f.plural(data.lifetime_value.periods_billed, 'period')} billed`}
            />
            <Headline
              label="MRR"
              value={f.money(data.mrr, { currency: customer.currency })}
              // The count beside the money is counted the same way the money is,
              // so a $0.00 MRR is never captioned "1 live".
              caption={`${f.money(data.arr, { currency: customer.currency })} a year · ${subscriptionCountShort(data, f)}`}
            />
            <Headline
              label="Balance"
              value={data.balance.amount === 0 ? '—' : f.money(Math.abs(data.balance.amount), { currency: data.balance.currency })}
              caption={data.balance.description}
            />
            <Headline
              label="Next invoice"
              value={data.next_invoice ? f.day(data.next_invoice.date) : '—'}
              caption={data.next_invoice
                ? `${f.money(data.next_invoice.estimated_total, { currency: data.next_invoice.currency })} estimated`
                : 'No subscription is due to renew'}
            />
          </div>
        </Card>

        {data.attention.length > 0 && (
          <div className="bl-attention">
            {data.attention.map((line) => (
              <Banner key={line} tone="warning" compact><AttentionLine line={line} summary={data} /></Banner>
            ))}
          </div>
        )}

        {tab === 'overview' && <OverviewTab summary={data} onNewSubscription={() => setDialog('subscription')} />}
        {tab === 'invoices' && <CustomerInvoices customerId={customer.id} />}
        {tab === 'payments' && <PaymentsTab customer={customer} />}
        {tab === 'ledger' && <LedgerTab summary={data} onGrant={() => setDialog('credit')} />}
        {tab === 'details' && <DetailsTab customer={customer} onPatch={patch} />}
      </Stack>

      <CreditDialog customer={customer.id} currency={customer.currency} open={dialog === 'credit'} onClose={() => setDialog(null)} />
      <SubscriptionCreateDialog open={dialog === 'subscription'} onClose={() => setDialog(null)} customer={customer.id} />
      <BillNowDialog open={dialog === 'bill'} onClose={() => setDialog(null)} customer={customer.id} />
    </Page>
  );
}

/**
 * The one-line account summary, counted the way the money beside it is counted.
 *
 * The server's own `headline` says "2 live subscriptions, $570.00 MRR" — and
 * MRR excludes a paused agreement while `live` includes it, so the two halves
 * of one sentence are computed on different definitions of live. Rather than
 * pick a side, the count is split whenever they disagree: "1 billing, 1 paused
 * · $570.00 MRR" is both figures reconciled in the sentence itself.
 */
function accountHeadline(summary: CustomerSummary, f: BillingFormatter): string {
  const { by_status: byStatus, total } = summary.subscriptions;
  const billing = (byStatus.active ?? 0) + (byStatus.trialing ?? 0) + (byStatus.past_due ?? 0);
  const paused = byStatus.paused ?? 0;
  const mrr = f.money(summary.mrr, { currency: summary.customer.currency });
  if (total === 0) return 'No subscription on this account yet — nothing recurring is billed here.';
  const counted = paused > 0
    ? `${billing === 0 ? 'Nothing billing' : `${f.plural(billing, 'subscription')} billing`} and ${f.number(paused)} paused`
    : f.plural(billing, 'live subscription');
  return `${counted} · ${mrr} MRR${paused > 0 ? ' — paused agreements are excluded from MRR' : ''}.`;
}

/**
 * The summary's attention lines, with the ids and enums taken out.
 *
 * The server writes them for any client — "Collection on sub_sGghNQZy96toyJYU
 * is paused (keep_as_draft)" is precise and unreadable. The subscription
 * becomes the plan it sells, linked to its record, and the pause behaviour
 * becomes the sentence the pause dialog itself uses.
 */
function AttentionLine({ line, summary }: { line: string; summary: CustomerSummary }) {
  const named = line
    .replace(/\(keep_as_draft\)/g, '— the invoices it raises are held as drafts')
    .replace(/\(void\)/g, '— the invoices it raises are voided')
    .replace(/\(mark_uncollectible\)/g, '— the invoices it raises are written off');
  const parts = named.split(/(sub_[A-Za-z0-9]+)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (!/^sub_[A-Za-z0-9]+$/.test(part)) return <span key={index}>{part}</span>;
        const sub = summary.subscriptions.data.find((row) => row.id === part);
        return (
          <RecordLink key={index} to={subscriptionHref(part)}>
            {sub?.items[0]?.description ?? sub?.description ?? part}
          </RecordLink>
        );
      })}
    </>
  );
}

/** "1 billing, 1 paused, 3 in all" — never a live count that the MRR disagrees with. */
function subscriptionCount(summary: CustomerSummary, f: BillingFormatter): string {
  const { by_status: byStatus, total } = summary.subscriptions;
  const billing = (byStatus.active ?? 0) + (byStatus.trialing ?? 0) + (byStatus.past_due ?? 0);
  const paused = byStatus.paused ?? 0;
  if (total === 0) return 'None on this account';
  return paused > 0
    ? `${f.number(billing)} billing, ${f.number(paused)} paused, ${f.number(total)} in all`
    : `${f.number(billing)} billing of ${f.number(total)}`;
}

/** The same split, for the caption under a money tile. */
function subscriptionCountShort(summary: CustomerSummary, f: BillingFormatter): string {
  const { by_status: byStatus } = summary.subscriptions;
  const billing = (byStatus.active ?? 0) + (byStatus.trialing ?? 0) + (byStatus.past_due ?? 0);
  const paused = byStatus.paused ?? 0;
  return paused > 0
    ? `${f.number(billing)} billing, ${f.number(paused)} paused`
    : `${f.number(billing)} live`;
}

function OverviewTab({ summary, onNewSubscription }: { summary: CustomerSummary; onNewSubscription: () => void }) {
  const f = useBillingFormat();
  const next = summary.next_invoice;
  // Lifetime value is what this account has actually been billed, so a zero
  // period count is the one fact that separates "all settled" from "untouched".
  const billedEver = summary.lifetime_value.periods_billed > 0 || summary.open_invoices.total > 0;
  return (
    <div className="bl-cols">
      <Stack gap={6}>
        <Card
          title="Subscriptions"
          description={subscriptionCount(summary, f)}
          actions={<Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={onNewSubscription}>New</Button>}
        >
          {summary.subscriptions.data.length === 0 && (
            <EmptyState
              size="sm"
              inline
              illustration={null}
              title="Nothing recurring on this account"
              body="Start a subscription and the first period opens immediately, billed for exactly the days it covers."
              action={<Button size="sm" variant="primary" onClick={onNewSubscription}>Start a subscription</Button>}
            />
          )}
          {summary.subscriptions.data.map((sub) => (
            <div key={sub.id} className="bl-row">
              <div className="bl-row__main">
                <div className="bl-row__title">
                  <RecordLink to={subscriptionHref(sub.id)}>{sub.items[0]?.description ?? sub.id}</RecordLink>
                </div>
                <div className="bl-row__sub">
                  {sub.items.length > 1 ? `${sub.items.length} items · ` : ''}
                  {sub.renews_in} · {sub.status_detail}
                </div>
              </div>
              <div className="bl-row__aside">
                <div>{f.money(sub.mrr, { currency: sub.currency })}</div>
                <div className="bl-sub"><StatusPill status={sub.status} /></div>
              </div>
            </div>
          ))}
        </Card>

        <Card title="Open invoices" description={summary.open_invoices.total > 0 ? 'Still owed by this account.' : billedEver ? 'Nothing is outstanding.' : 'Nothing has been billed yet.'}>
          {summary.open_invoices.data.length === 0 && (
            // An account created a minute ago has not settled anything; saying
            // so is the difference between a fact and a flattering guess.
            billedEver
              ? <EmptyState size="sm" inline illustration={null} title="Nothing outstanding" body="Every bill raised on this account has been settled." />
              : (
                <EmptyState
                  size="sm"
                  inline
                  illustration={null}
                  title="No bill has been raised yet"
                  body="The first invoice lands when a subscription's period opens, or when you bill what is waiting by hand."
                />
              )
          )}
          {summary.open_invoices.data.map((invoice) => (
            <div key={invoice.id} className="bl-row">
              <div className="bl-row__main">
                <div className="bl-row__title"><RecordLink to={invoiceHref(invoice.id)}>{invoice.number ?? invoice.id}</RecordLink></div>
                <div className="bl-row__sub">{invoice.due_date ? `Due ${f.day(invoice.due_date)}` : 'Payable on receipt'}</div>
              </div>
              <div className="bl-row__aside">
                <div>{f.money(invoice.amount_due, { currency: invoice.currency })}</div>
                <div className="bl-sub"><StatusPill status={invoice.status} /></div>
              </div>
            </div>
          ))}
        </Card>

        {summary.uninvoiced_items.data.length > 0 && (
          <Card
            title="Waiting for an invoice"
            description="Proration lines already priced, which the next bill will pick up."
          >
            {summary.uninvoiced_items.data.map((item) => (
              <div key={item.id} className="bl-row">
                <div className="bl-row__main">
                  <div className="bl-row__title">{item.description}</div>
                  {/* The sentence, without the ten-digit rational the server
                      appends for auditors — the invoice's own lines keep that
                      behind a disclosure, and this card has no room for one. */}
                  <div className="bl-row__sub">{prorationCopy(item.explanation, item.proration).sentence}</div>
                </div>
                <div className="bl-row__aside">{f.money(item.amount, { currency: item.currency })}</div>
              </div>
            ))}
            <div className="bl-total bl-total--grand">
              <span className="bl-total__label">Total waiting</span>
              <span className="bl-total__value">{f.money(summary.uninvoiced_items.total, { currency: summary.customer.currency })}</span>
            </div>
          </Card>
        )}
      </Stack>

      <Stack gap={6}>
        {next && (
          <Card title={`Next invoice · ${f.day(next.date)}`} description={next.note}>
            <div className="bl-tablewrap">
              <table className="bl-lines">
                <thead><tr><th>Line</th><th className="bl-num">Amount</th></tr></thead>
                <tbody>
                  {next.lines.map((line, i) => (
                    <tr key={`${line.price}-${i}`}>
                      <td>
                        <div>{line.description}</div>
                        <div className="bl-lines__why">{f.dayRange(line.period.start, line.period.end)}</div>
                      </td>
                      <td className="bl-num">
                        {line.amount === null ? <span className="bl-muted">from usage</span> : f.money(line.amount, { currency: line.currency })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bl-totals" style={{ marginTop: 'var(--space-5)' }}>
              <div className="bl-total"><span className="bl-total__label">Recurring subtotal</span><span className="bl-total__value">{f.money(next.subtotal, { currency: next.currency })}</span></div>
              {next.uninvoiced_total !== 0 && (
                <div className="bl-total"><span className="bl-total__label">Prorations waiting</span><span className="bl-total__value">{f.money(next.uninvoiced_total, { currency: next.currency })}</span></div>
              )}
              {next.balance_applied !== 0 && (
                <div className="bl-total"><span className="bl-total__label">Balance applied</span><span className="bl-total__value">{f.money(next.balance_applied, { currency: next.currency })}</span></div>
              )}
              <div className="bl-total bl-total--grand"><span className="bl-total__label">Estimated total</span><span className="bl-total__value">{f.money(next.estimated_total, { currency: next.currency })}</span></div>
            </div>
          </Card>
        )}

      </Stack>
    </div>
  );
}

function LedgerTab({ summary, onGrant }: { summary: CustomerSummary; onGrant: () => void }) {
  const f = useBillingFormat();
  const rows = summary.balance.transactions;
  return (
    <Card
      title="Balance ledger"
      description={summary.balance.description}
      actions={<Button size="sm" variant="secondary" iconLeft={<Icons.percent size={13} />} onClick={onGrant}>Adjust the balance</Button>}
    >
      {rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="The balance has never moved"
          body="Credits, prorations that netted negative and overpayments all land here, and the next invoice draws them down."
          action={<Button size="sm" variant="primary" onClick={onGrant}>Adjust the balance</Button>}
        />
      )}
      {rows.length > 0 && (
        <div className="bl-tablewrap">
          <table className="bl-lines">
            <thead>
              <tr>
                <th>When</th>
                <th>What happened</th>
                <th>Type</th>
                {/* The tile above says "$100.00 of credit". Printing the same
                    fact here as "-$100.00" made one screen state a balance two
                    ways, so the sign is spelled out in the words the tile uses
                    and the header says which way is which. */}
                <th className="bl-num" title="A credit reduces what the account owes; a charge adds to it.">Movement</th>
                <th className="bl-num" title="The balance the account stood at after this movement.">Balance after</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: BalanceTransaction) => (
                <tr key={row.id}>
                  <td className="bl-nowrap">{f.date(row.created, { withYear: true })}</td>
                  <td>
                    <div>{row.description}</div>
                    {row.invoice && <div className="bl-lines__why"><RecordLink to={invoiceHref(row.invoice)} mono>{row.invoice}</RecordLink></div>}
                  </td>
                  <td><Badge tone="neutral">{humanize(row.type)}</Badge></td>
                  <td className="bl-num">
                    <span className={row.amount < 0 ? 'bl-amount bl-amount--credit' : 'bl-amount'}>
                      {balanceWords(row.amount, row.currency, f)}
                    </span>
                  </td>
                  <td className="bl-num">{balanceWords(row.ending_balance, row.currency, f, 'settled')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DetailsTab({ customer, onPatch }: { customer: Customer; onPatch: (body: Record<string, unknown>) => Promise<unknown> }) {
  const f = useBillingFormat();
  const address = customer.address;
  const setAddress = (patch: Record<string, string>) => onPatch({
    address: {
      line1: address?.line1 ?? undefined,
      line2: address?.line2 ?? undefined,
      city: address?.city ?? undefined,
      state: address?.state ?? undefined,
      postal_code: address?.postal_code ?? undefined,
      country: address?.country ?? undefined,
      ...patch,
    },
  });

  return (
    <div className="bl-cols">
      <Card title="Account" description="Every field here is editable — click it, type, press Enter.">
        <FieldRow label="Name">
          <InlineEdit label="Name" value={customer.name} onSave={(value) => onPatch({ name: value })} />
        </FieldRow>
        <FieldRow label="Billing email">
          <InlineEdit label="Billing email" type="email" value={customer.email ?? ''} empty="No email on file" onSave={(value) => onPatch({ email: value })} />
        </FieldRow>
        <FieldRow label="Phone">
          <InlineEdit label="Phone" type="tel" value={customer.phone ?? ''} empty="No phone on file" onSave={(value) => onPatch({ phone: value })} />
        </FieldRow>
        <FieldRow label="Description">
          <InlineEdit label="Description" value={customer.description ?? ''} empty="No description" onSave={(value) => onPatch({ description: value })} />
        </FieldRow>
        <FieldRow
          label="Currency"
          hint={customer.currency_locked ? 'Fixed by the first invoice raised on this account.' : 'Free to change until the first invoice.'}
        >
          {customer.currency_locked
            ? <span>{customer.currency.toUpperCase()}</span>
            : (
              <InlineEdit
                label="Currency"
                value={customer.currency}
                options={[{ value: 'usd', label: 'USD' }, { value: 'eur', label: 'EUR' }, { value: 'gbp', label: 'GBP' }]}
                onSave={(value) => onPatch({ currency: value })}
              />
            )}
        </FieldRow>
        <FieldRow
          label="Net terms"
          hint="Days until an invoice sent for payment is due. A subscription that charges the card on file collects the moment a bill is raised, so nothing on it waits for this."
        >
          <InlineEdit
            label="Net terms"
            value={String(customer.invoice_settings.days_until_due ?? 0)}
            options={[
              { value: '0', label: 'Due on receipt' },
              { value: '14', label: 'Net 14' },
              { value: '30', label: 'Net 30' },
              { value: '45', label: 'Net 45' },
              { value: '60', label: 'Net 60' },
            ]}
            onSave={(value) => onPatch({ invoice_settings: { days_until_due: Number(value) } })}
          />
        </FieldRow>
        <FieldRow label="Tax treatment" hint="Exempt means a certificate is on file; reverse means the customer accounts for the tax.">
          <InlineEdit
            label="Tax treatment"
            value={customer.tax_exempt}
            options={[
              { value: 'none', label: 'Taxed normally' },
              { value: 'exempt', label: 'Exempt — certificate on file' },
              { value: 'reverse', label: 'Reverse charge' },
            ]}
            onSave={(value) => onPatch({ tax_exempt: value })}
          />
        </FieldRow>
        <FieldRow
          label="Created"
          hint={invoiceClockNote(customer.created, f)}
        >
          {f.date(customer.created, { withYear: true })}
        </FieldRow>
        <FieldRow label="Id"><span className="u-mono bl-sub">{customer.id}</span></FieldRow>
      </Card>

      <Stack gap={6}>
        <Card title="Billing address" description="Tax is matched against this address — the most specific active rate wins.">
          <FieldRow label="Street">
            <InlineEdit label="Street" value={address?.line1 ?? ''} empty="No street" onSave={(value) => setAddress({ line1: value })} />
          </FieldRow>
          <FieldRow label="City">
            <InlineEdit label="City" value={address?.city ?? ''} empty="No city" onSave={(value) => setAddress({ city: value })} />
          </FieldRow>
          <FieldRow label="State or region">
            <InlineEdit label="State" value={address?.state ?? ''} empty="No state" onSave={(value) => setAddress({ state: value })} />
          </FieldRow>
          <FieldRow label="Postal code">
            <InlineEdit label="Postal code" value={address?.postal_code ?? ''} empty="No postal code" onSave={(value) => setAddress({ postal_code: value })} />
          </FieldRow>
          <FieldRow label="Country">
            <InlineEdit label="Country" value={address?.country ?? ''} empty="No country — nothing can match a tax rate" onSave={(value) => setAddress({ country: value })} />
          </FieldRow>
        </Card>

        <TaxRegistrationsCard customer={customer} />

        <DocumentSettingsCard customer={customer} onPatch={onPatch} />

        <MetadataCard customer={customer} onPatch={onPatch} />
      </Stack>
    </div>
  );
}

/**
 * What this account's own copy of a bill says.
 *
 * Two different lifetimes, and the copy has to be honest about both. A custom
 * field is read from the customer every time the document is rendered, so
 * changing one changes every bill this account already holds. The footer is
 * snapshotted onto the invoice the moment it is raised — `invoices.ts` copies
 * `customer.invoice_settings.footer` onto the record — so a change here reaches
 * the next bill and leaves the ones already issued exactly as they were sent.
 */
function DocumentSettingsCard({ customer, onPatch }: {
  customer: Customer; onPatch: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const fields = customer.invoice_settings.custom_fields;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const setFields = (next: { name: string; value: string }[]) =>
    onPatch({ invoice_settings: { custom_fields: next } });

  // Both halves are collected before anything is written, because a reference
  // is printed in the bill-to block the moment it exists — a row added with a
  // placeholder in it is a placeholder on the customer's own document.
  const add = async () => {
    if (!name.trim() || !value.trim()) return;
    await setFields([...fields, { name: name.trim(), value: value.trim() }]);
    setName('');
    setValue('');
    setAdding(false);
  };

  return (
    <Card
      title="The customer’s copy"
      description="What this account’s printed invoice carries beyond the lines and the totals."
      actions={
        <Button
          size="sm"
          variant="secondary"
          iconLeft={<Icons.plus size={13} />}
          disabled={fields.length >= 4 || adding}
          title={fields.length >= 4 ? 'Four is the most an invoice can print.' : undefined}
          onClick={() => setAdding(true)}
        >
          Add a reference
        </Button>
      }
    >
      <FieldRow
        label="Footer"
        hint="Printed under the totals. Copied onto each bill as it is raised, so bills already issued keep the wording they were sent with."
      >
        <InlineEdit
          label="Invoice footer"
          value={customer.invoice_settings.footer ?? ''}
          empty="Nothing is printed under the totals"
          onSave={(next) => onPatch({ invoice_settings: { footer: next } })}
        />
      </FieldRow>
      {fields.length === 0 && !adding && (
        <FieldRow label="References" hint="A PO number, a cost centre, a contract id — printed in the bill-to block.">
          <span className="bl-inline__empty">None on this account</span>
        </FieldRow>
      )}
      {fields.map((field, index) => (
        <FieldRow
          key={`${field.name}-${index}`}
          label={(
            <InlineEdit
              label={`Reference ${index + 1} name`}
              value={field.name}
              onSave={(next) => setFields(fields.map((row, i) => (i === index ? { ...row, name: next } : row)))}
            />
          )}
        >
          <Inline gap={3} justify="between">
            <InlineEdit
              label={`Reference ${index + 1} value`}
              value={field.value}
              onSave={(next) => setFields(fields.map((row, i) => (i === index ? { ...row, value: next } : row)))}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove the reference ${field.name}`}
              iconLeft={<Icons.trash size={13} />}
              onClick={() => { void setFields(fields.filter((_, i) => i !== index)); }}
            />
          </Inline>
        </FieldRow>
      ))}
      {adding && (
        <div className="bl-metaadd">
          <Input
            size="sm"
            aria-label="Reference name"
            placeholder="Purchase order"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          />
          <Input
            size="sm"
            aria-label="Reference value"
            placeholder="NW-2026-0142"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          />
          <Inline gap={2}>
            <Button size="sm" variant="primary" disabled={!name.trim() || !value.trim()} onClick={() => { void add(); }}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setName(''); setValue(''); }}>Cancel</Button>
          </Inline>
        </div>
      )}
    </Card>
  );
}

/**
 * Metadata, editable.
 *
 * `PATCH /v1/customers/:id` merges the map it is sent onto the one already
 * there — `{ ...before.metadata, ...input.metadata }` — and nothing in that
 * write path treats any value as a deletion. So there is no "remove", because
 * there is no route that removes: a key can be given a new value or emptied,
 * and the control says which of those it does.
 */
function MetadataCard({ customer, onPatch }: {
  customer: Customer; onPatch: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const entries = Object.entries(customer.metadata);

  const replace = (next: Record<string, string>) => onPatch({ metadata: next });

  const add = async () => {
    if (!key.trim()) return;
    await replace({ ...customer.metadata, [key.trim()]: value.trim() });
    setKey('');
    setValue('');
    setAdding(false);
  };

  return (
    <Card
      title="Metadata"
      description="Your own keys, carried on the record and returned on every read of it. The API merges what it is sent, so a key can be re-valued or emptied but never removed."
      actions={
        <Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={() => setAdding(true)}>
          Add a key
        </Button>
      }
    >
      {entries.length === 0 && !adding && (
        <FieldRow label="Nothing yet">
          <span className="bl-inline__empty">No metadata is set on this account</span>
        </FieldRow>
      )}
      {entries.map(([name, held]) => (
        <FieldRow key={name} label={<span className="u-mono">{name}</span>}>
          <Inline gap={3} justify="between">
            <InlineEdit
              label={`Value of ${name}`}
              value={held}
              empty="Empty"
              mono
              onSave={(next) => replace({ ...customer.metadata, [name]: next })}
            />
            <Tooltip content={`Empties ${name}. The key stays on the record — the billing API has no route that removes one.`}>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Clear the value of ${name}`}
                disabled={held === ''}
                iconLeft={<Icons.trash size={13} />}
                onClick={() => { void replace({ ...customer.metadata, [name]: '' }); }}
              />
            </Tooltip>
          </Inline>
        </FieldRow>
      ))}
      {adding && (
        <div className="bl-metaadd">
          <Input
            size="sm"
            aria-label="Metadata key"
            placeholder="contract_id"
            value={key}
            autoFocus
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          />
          <Input
            size="sm"
            aria-label="Metadata value"
            placeholder="NW-2026-0142"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          />
          <Inline gap={2}>
            <Button size="sm" variant="primary" disabled={!key.trim()} onClick={() => { void add(); }}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setKey(''); setValue(''); }}>Cancel</Button>
          </Inline>
        </div>
      )}
    </Card>
  );
}

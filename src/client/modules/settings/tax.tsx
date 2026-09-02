/**
 * Tax: where this workspace is registered to collect, and what its customers
 * have told it about themselves.
 *
 * Two halves that answer two different questions.
 *
 * A **registration** is a rate this workspace charges. Every tax figure on
 * every invoice is a snapshot of one of these rows — the engine matches the
 * customer's address against all of them and charges the sum of everything that
 * matches, then copies the name, jurisdiction and exact decimal percentage onto
 * the line. That is why retiring a rate here never moves a number on an invoice
 * already raised: the invoice keeps its own copy.
 *
 * A **customer registration** is a number the customer supplied. Whether it is
 * real is answered by the register that issued it, not by us — and only a
 * `verified` number moves the tax onto the customer under the reverse charge,
 * because the supplier is who the authority collects from. So the status is
 * shown for what it is, and recording a check is a first-class action rather
 * than something buried on one account at a time.
 *
 * The percentage is an exact decimal string on the wire and is never parsed to
 * a float on the way to the screen: `"8.875"` renders as 8.875%, not 8.874999.
 */
import { useMemo, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Icons, Inline, Input,
  Modal, Select, Stat, Stack, Switch, Tooltip,
  humanize, useFormat,
  type DataTableColumn, type MenuSection,
  CheckCircleIcon, XCircleIcon,
} from '../../design';
import { ListFailure, SettingsShell, idem, useAction } from './common';
import type { AutomaticTaxSettings, CustomerLite, CustomerTaxId, TaxRate } from './types';

const TAX_TYPES = ['vat', 'gst', 'sales_tax', 'hst', 'pst', 'qst', 'jct', 'igst', 'service_tax', 'other'] as const;

const TAX_TYPE_LABEL: Record<string, string> = {
  vat: 'VAT', gst: 'GST', sales_tax: 'Sales tax', hst: 'HST', pst: 'PST',
  qst: 'QST', jct: 'JCT', igst: 'IGST', service_tax: 'Service tax', other: 'Other',
};

const VERIFICATION_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  verified: 'success', pending: 'neutral', unverified: 'warning', unavailable: 'neutral',
};

const VERIFICATION_LABEL: Record<string, string> = {
  verified: 'Verified', pending: 'Not checked', unverified: 'Register said no', unavailable: 'Register silent',
};

interface CustomerRegistration {
  key: string;
  customer: CustomerLite;
  taxId: CustomerTaxId;
}

export function TaxPage() {
  const f = useFormat();
  const session = useSession();
  const navigate = useNavigate();
  const action = useAction();

  const [showRetired, setShowRetired] = useState(false);
  const [creating, setCreating] = useState(false);
  const [retiring, setRetiring] = useState<TaxRate | null>(null);
  const [checking, setChecking] = useState<CustomerRegistration | null>(null);

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';
  const member = admin || session.me?.role === 'member';

  const rates = useQuery<ListEnvelope<TaxRate>>('/v1/tax_rates', { limit: 500 });
  const hold = useQuery<AutomaticTaxSettings>('/v1/billing/automatic_tax');
  const customers = useQuery<ListEnvelope<CustomerLite>>('/v1/customers', { limit: 200 });

  const allRates = rates.data?.data ?? [];
  const rateRows = showRetired ? allRates : allRates.filter((rate) => rate.active);
  const retiredCount = allRates.filter((rate) => !rate.active).length;
  const countries = new Set(allRates.filter((rate) => rate.active).map((rate) => rate.country));
  const reverseCharged = allRates.filter((rate) => rate.active && rate.reverse_charge).length;

  const registrations = useMemo<CustomerRegistration[]>(() => {
    const rows: CustomerRegistration[] = [];
    for (const customer of customers.data?.data ?? []) {
      for (const taxId of customer.tax_ids ?? []) {
        rows.push({ key: `${customer.id}:${taxId.value}`, customer, taxId });
      }
    }
    return rows;
  }, [customers.data]);

  const unchecked = registrations.filter((row) => (row.taxId.verification?.status ?? 'pending') !== 'verified').length;

  const rateColumns = useMemo<DataTableColumn<TaxRate>[]>(() => [
    {
      id: 'jurisdiction',
      header: 'Jurisdiction',
      pinned: true,
      width: 230,
      accessor: (row) => row.jurisdiction,
      cell: (row) => (
        <span style={{ display: 'block', minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }} className="u-truncate">{row.jurisdiction}</span>
          <span className="st-sub">{row.applies_to}</span>
        </span>
      ),
    },
    {
      id: 'display_name',
      header: 'On the invoice',
      width: 160,
      accessor: (row) => row.display_name,
    },
    {
      id: 'tax_type',
      header: 'Kind',
      width: 140,
      filter: 'set',
      accessor: (row) => row.tax_type ?? 'other',
      filterOptionLabel: (value) => TAX_TYPE_LABEL[value] ?? humanize(value),
      cell: (row) => <Badge tone="neutral">{TAX_TYPE_LABEL[row.tax_type ?? 'other'] ?? humanize(row.tax_type ?? 'other')}</Badge>,
    },
    {
      id: 'percentage',
      header: 'Rate',
      align: 'right',
      width: 110,
      // The wire value is an exact decimal string; sorting on the number keeps
      // 8.875 above 8.5 without ever rendering the parsed float.
      accessor: (row) => Number(row.percentage),
      cell: (row) => <span className="u-num">{row.percentage_display}</span>,
    },
    {
      id: 'reverse_charge',
      header: 'Reverse charge',
      width: 170,
      filter: 'set',
      accessor: (row) => (row.reverse_charge ? 'yes' : 'no'),
      cell: (row) => (row.reverse_charge
        ? (
          <Tooltip content="A business customer that supplies a verified registration number is charged 0% and accounts for the tax itself.">
            <span><Badge tone="info" pill>Reverse charged</Badge></span>
          </Tooltip>
        )
        : <span className="st-sub">Charged in full</span>),
    },
    {
      id: 'active',
      header: 'Status',
      width: 120,
      filter: 'set',
      accessor: (row) => (row.active ? 'active' : 'retired'),
      cell: (row) => (row.active
        ? <Badge tone="success" pill dot>Active</Badge>
        : <Badge tone="neutral" pill dot>Retired</Badge>),
    },
  ], []);

  const registrationColumns = useMemo<DataTableColumn<CustomerRegistration>[]>(() => [
    {
      id: 'customer',
      header: 'Account',
      pinned: true,
      width: 250,
      accessor: (row) => row.customer.name,
      cell: (row) => (
        <span style={{ display: 'block', minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }} className="u-truncate">{row.customer.name}</span>
          <span className="st-sub u-truncate" style={{ display: 'block' }}>{row.customer.email ?? row.customer.id}</span>
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Kind',
      width: 130,
      filter: 'set',
      accessor: (row) => row.taxId.type,
      cell: (row) => <span className="st-mono">{row.taxId.type}</span>,
    },
    {
      id: 'value',
      header: 'Number',
      width: 200,
      accessor: (row) => row.taxId.value,
      cell: (row) => <span className="st-mono">{row.taxId.value}</span>,
    },
    {
      id: 'country',
      header: 'Country',
      width: 160,
      filter: 'set',
      accessor: (row) => row.taxId.country ?? row.customer.address?.country ?? '',
      cell: (row) => row.taxId.country ?? row.customer.address?.country ?? <span className="st-sub">—</span>,
    },
    {
      id: 'status',
      header: 'Register says',
      width: 190,
      filter: 'set',
      accessor: (row) => row.taxId.verification?.status ?? 'pending',
      filterOptionLabel: (value) => VERIFICATION_LABEL[value] ?? humanize(value),
      cell: (row) => {
        const status = row.taxId.verification?.status ?? 'pending';
        const note = row.taxId.verification?.note;
        const badge = <Badge tone={VERIFICATION_TONE[status] ?? 'neutral'} pill dot>{VERIFICATION_LABEL[status] ?? humanize(status)}</Badge>;
        return note ? <Tooltip content={note}><span>{badge}</span></Tooltip> : badge;
      },
    },
    {
      id: 'checked_at',
      header: 'Checked',
      align: 'right',
      width: 150,
      accessor: (row) => row.taxId.verification?.checked_at ?? 0,
      cell: (row) => (row.taxId.verification?.checked_at
        ? f.when(row.taxId.verification.checked_at)
        : <span className="st-sub">Never</span>),
    },
  ], [f]);

  const rateActions = (row: TaxRate): MenuSection[] => [{
    id: 'rate',
    items: [{
      id: 'retire',
      label: 'Retire this rate…',
      icon: <XCircleIcon size={14} />,
      danger: true,
      disabled: !row.active || !admin,
      onSelect: () => { action.clear(); setRetiring(row); },
    }],
  }];

  const registrationActions = (row: CustomerRegistration): MenuSection[] => [{
    id: 'registration',
    items: [
      {
        id: 'check',
        label: 'Record a check…',
        icon: <CheckCircleIcon size={14} />,
        disabled: !member,
        onSelect: () => { action.clear(); setChecking(row); },
      },
      {
        id: 'open',
        label: 'Open the account',
        icon: <Icons.external size={14} />,
        onSelect: () => navigate(`/billing/customers/${row.customer.id}`),
      },
    ],
  }];

  const toggleHold = async (enabled: boolean) => {
    await action.run(
      api.post<AutomaticTaxSettings>('/v1/billing/automatic_tax', { enabled }),
      {
        success: enabled ? 'Bills with no tax location are now held' : 'Bills with no tax location will finalise',
        description: enabled
          ? 'An invoice for an account Ain cannot place stays a draft until the address is complete.'
          : 'They still carry the mark and are still findable — they are simply no longer held back.',
        failure: 'The setting was not changed',
      },
      ['/v1/billing/automatic_tax', '/v1/invoices', '/v1/audit-log'],
    );
  };

  return (
    <SettingsShell
      title="Tax"
      subtitle="Where this workspace is registered to collect, and what its customers have told it about themselves."
      actions={
        <Button
          variant="primary"
          iconLeft={<Icons.plus size={15} />}
          disabled={!admin}
          onClick={() => { action.clear(); setCreating(true); }}
        >
          Register a rate
        </Button>
      }
    >
      <Stack gap={6}>
        {rates.error && <ListFailure error={rates.error} path="GET /v1/tax_rates" onRetry={rates.refetch} />}

        <div className="st-tiles">
          <Card padding="tight">
            <Stat
              label="Active registrations"
              value={f.number(allRates.filter((rate) => rate.active).length)}
              caption={`Across ${f.plural(countries.size, 'country')}`}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Reverse charged"
              value={f.number(reverseCharged)}
              caption="A verified business number moves the tax to the customer"
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Customer registrations"
              value={f.number(registrations.length)}
              caption={unchecked
                ? `${f.number(unchecked)} not confirmed by their register`
                : 'Every one confirmed by its register'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Bills with no location"
              value={f.number(hold.data?.invoices_missing_a_tax_location ?? 0)}
              caption={hold.data?.enabled
                ? `${f.number(hold.data?.invoices_held_in_draft ?? 0)} held as drafts`
                : 'Finalising anyway — the hold is off'}
            />
          </Card>
        </div>

        <Card
          title="Bills Ain cannot place"
          description="A short tax figure means two different things, and only one of them is safe to send."
        >
          <Stack gap={4}>
            <Switch
              checked={!!hold.data?.enabled}
              disabled={!admin || !hold.data || action.busy}
              onChange={(next) => void toggleHold(next)}
              label="Hold an invoice as a draft when the account’s address cannot be placed"
              hint={hold.data?.detail}
            />
            {!hold.data?.enabled && (hold.data?.invoices_missing_a_tax_location ?? 0) > 0 && (
              <Banner
                tone="warning"
                compact
                title={`${f.plural(hold.data?.invoices_missing_a_tax_location ?? 0, 'invoice')} was taxed at nothing because nothing matched`}
                actions={<Button size="sm" variant="secondary" onClick={() => navigate('/billing/invoices?tax=missing')}>Show them</Button>}
              >
                {'They were sent. Zero tax there means "we do not know where they are", not "nothing is due" — and the '
                  + 'authority collects from the supplier either way.'}
              </Banner>
            )}
          </Stack>
        </Card>

        <Card
          padding="none"
          title="Registered rates"
          description="A customer address is matched against every one of these and owes the sum of all that match — a state, a city and a transit district stack."
          actions={retiredCount > 0
            ? (
              <Switch
                checked={showRetired}
                onChange={setShowRetired}
                size="sm"
                label={`Show ${f.plural(retiredCount, 'retired rate')}`}
              />
            )
            : undefined}
        >
          <DataTable
            rows={rateRows}
            columns={rateColumns}
            getRowId={(row) => row.id}
            caption="Tax registrations"
            loading={rates.loading}
            searchable
            searchPlaceholder="Search by jurisdiction, country or name"
            showFilters
            showColumnToggle
            initialSort={{ columnId: 'jurisdiction', direction: 'asc' }}
            rowActions={rateActions}
            rowTone={(row) => (row.active ? 'default' : 'danger')}
            maxHeight={480}
            empty={
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.percent size={22} />}
                title="Nothing is registered"
                body="With no registration, every invoice is taxed at nothing and says so. Register the first jurisdiction this workspace collects in."
                action={<Button size="sm" variant="primary" disabled={!admin} onClick={() => setCreating(true)}>Register a rate</Button>}
              />
            }
          />
        </Card>

        <Card
          padding="none"
          title="Customer registrations"
          description="Numbers customers supplied. Only a number its own register confirms moves the tax onto the customer."
        >
          {customers.error && <ListFailure error={customers.error} path="GET /v1/customers" onRetry={customers.refetch} />}
          <DataTable
            rows={registrations}
            columns={registrationColumns}
            getRowId={(row) => row.key}
            caption="Customer tax registrations"
            loading={customers.loading}
            searchable
            searchPlaceholder="Search by account, number or country"
            showFilters
            showColumnToggle
            initialSort={{ columnId: 'status', direction: 'asc' }}
            rowActions={registrationActions}
            maxHeight={480}
            empty={
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.building size={22} />}
                title="No customer has supplied a registration number"
                body="A number is added on the account it belongs to, where the address that has to agree with it also lives."
                action={<Button size="sm" variant="secondary" onClick={() => navigate('/billing/customers')}>Open customers</Button>}
              />
            }
          />
        </Card>
      </Stack>

      <CreateRateDialog open={creating} action={action} onClose={() => setCreating(false)} />

      <ConfirmDialog
        open={!!retiring}
        onCancel={() => setRetiring(null)}
        onConfirm={async () => {
          if (!retiring) return;
          const done = await action.run(
            api.post<TaxRate>(`/v1/tax_rates/${retiring.id}/deactivate`),
            {
              success: `${retiring.jurisdiction} is retired`,
              description: 'New invoices stop matching it. Every invoice already raised keeps its own snapshot.',
              failure: 'The rate was not retired',
            },
            ['/v1/tax_rates', '/v1/audit-log'],
          );
          if (done) setRetiring(null);
        }}
        tone="danger"
        title={retiring ? `Retire ${retiring.display_name} in ${retiring.jurisdiction}?` : ''}
        confirmLabel="Retire it"
        cancelLabel="Keep collecting"
        loading={action.busy}
        body={retiring
          ? `New invoices for addresses in ${retiring.applies_to} will stop being charged ${retiring.percentage_display}. `
            + 'Every invoice already raised under it keeps the copy it took and still explains itself. A retired rate '
            + 'can be shown again with the toggle above, but not reactivated — register it again to start collecting.'
          : ''}
      />

      <VerifyDialog registration={checking} action={action} onClose={() => setChecking(null)} />
    </SettingsShell>
  );
}

type Action = ReturnType<typeof useAction>;

/* ============================== register a rate =========================== */

function CreateRateDialog({ open, action, onClose }: { open: boolean; action: Action; onClose: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [country, setCountry] = useState('');
  const [state, setState] = useState('');
  const [taxType, setTaxType] = useState<string>('vat');
  const [percentage, setPercentage] = useState('');
  const [reverseCharge, setReverseCharge] = useState(false);

  const close = () => {
    setDisplayName(''); setJurisdiction(''); setCountry(''); setState('');
    setTaxType('vat'); setPercentage(''); setReverseCharge(false);
    action.clear(); onClose();
  };

  // The wire wants an exact decimal, never a float: "19", "8.875".
  const decimal = /^\d{1,3}(\.\d{1,4})?$/.test(percentage.trim());
  const valid = displayName.trim() && jurisdiction.trim() && country.trim().length >= 2 && decimal;

  const submit = async () => {
    const saved = await action.run(
      api.post<TaxRate>('/v1/tax_rates', {
        display_name: displayName.trim(),
        jurisdiction: jurisdiction.trim(),
        country: country.trim(),
        ...(state.trim() ? { state: state.trim() } : {}),
        tax_type: taxType,
        percentage: percentage.trim(),
        reverse_charge: reverseCharge,
      }, { idempotencyKey: idem() }),
      {
        success: `${jurisdiction.trim()} is registered`,
        description: `Invoices for matching addresses now carry ${displayName.trim()} at ${percentage.trim()}%.`,
        failure: 'The rate was not registered',
        inlineOnly: true,
      },
      ['/v1/tax_rates', '/v1/audit-log'],
    );
    if (saved) close();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Register a tax rate"
      description="One active rate per jurisdiction. A different jurisdiction over the same address stacks with it — both are charged."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!valid} onClick={() => void submit()}>
            Register it
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The rate was not registered">{action.error.body.message}</Banner>
        )}

        <Field
          label="Jurisdiction"
          required
          hint="The place, for a human — “Germany”, “New York”, “Manhattan transit district”. This is what identifies the registration."
          error={action.errorFor('jurisdiction')}
        >
          <Input
            value={jurisdiction}
            autoFocus
            placeholder="New York"
            invalid={!!action.errorFor('jurisdiction')}
            onChange={(e) => setJurisdiction(e.target.value)}
            aria-label="Jurisdiction"
          />
        </Field>

        <Field
          label="What appears on the invoice"
          required
          hint="The name a customer reads on the tax line: “VAT”, “NY sales tax”."
          error={action.errorFor('display_name')}
        >
          <Input
            value={displayName}
            placeholder="NY sales tax"
            invalid={!!action.errorFor('display_name')}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-label="What appears on the invoice"
          />
        </Field>

        <Inline gap={5} align="start">
          <Field
            label="Country"
            required
            hint="An ISO-3166 two-letter code, or the country name customer addresses are written with."
            error={action.errorFor('country')}
            className="u-grow"
          >
            <Input
              value={country}
              placeholder="US"
              maxLength={80}
              invalid={!!action.errorFor('country')}
              onChange={(e) => setCountry(e.target.value)}
              aria-label="Country"
            />
          </Field>
          <Field
            label="State or province"
            optional
            hint="Spelled the way customer addresses spell it — that is what it is matched against."
            error={action.errorFor('state')}
            className="u-grow"
          >
            <Input
              value={state}
              placeholder="New York"
              onChange={(e) => setState(e.target.value)}
              aria-label="State or province"
            />
          </Field>
        </Inline>

        <Inline gap={5} align="start">
          <Field label="Kind" className="u-grow" error={action.errorFor('tax_type')}>
            <Select
              value={taxType}
              onChange={setTaxType}
              options={TAX_TYPES.map((type) => ({ value: type, label: TAX_TYPE_LABEL[type] }))}
              aria-label="Kind of tax"
            />
          </Field>
          <Field
            label="Percentage"
            required
            hint="An exact decimal, never a float: 19, 8.875."
            error={action.errorFor('percentage') ?? (percentage && !decimal ? 'Digits, with up to four decimal places.' : undefined)}
            className="u-grow"
          >
            <Input
              value={percentage}
              placeholder="8.875"
              inputMode="decimal"
              suffix="%"
              invalid={!!action.errorFor('percentage') || (!!percentage && !decimal)}
              onChange={(e) => setPercentage(e.target.value)}
              aria-label="Percentage"
            />
          </Field>
        </Inline>

        <Switch
          checked={reverseCharge}
          onChange={setReverseCharge}
          label="Reverse charge for verified businesses"
          hint="A business customer that supplies a registration number its own register confirms is charged 0% and accounts for the tax itself."
        />
      </Stack>
    </Modal>
  );
}

/* ============================ record a check ============================== */

const CHECK_OPTIONS = [
  { value: 'verified', label: 'Verified — the register confirmed it' },
  { value: 'unverified', label: 'Unverified — the register does not recognise it' },
  { value: 'unavailable', label: 'Unavailable — the register did not answer' },
  { value: 'pending', label: 'Not checked — clear the result' },
];

function VerifyDialog({ registration, action, onClose }: {
  registration: CustomerRegistration | null;
  action: Action;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('verified');
  const [verifiedName, setVerifiedName] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);

  if (registration && seeded !== registration.key) {
    setSeeded(registration.key);
    setStatus(registration.taxId.verification?.status ?? 'verified');
    setVerifiedName(registration.taxId.verification?.verified_name ?? registration.customer.name);
  }
  if (!registration) return null;

  const submit = async () => {
    const saved = await action.run(
      api.post<CustomerLite>(`/v1/customers/${registration.customer.id}/tax_ids/verify`, {
        value: registration.taxId.value,
        status,
        ...(status === 'verified' && verifiedName.trim() ? { verified_name: verifiedName.trim() } : {}),
      }),
      {
        success: `${registration.taxId.value} is recorded as ${VERIFICATION_LABEL[status].toLowerCase()}`,
        description: status === 'verified'
          ? 'Supplies to this account under a reverse-charge rate now move the tax onto them.'
          : 'Anything but verified is charged as normal — the supplier is who the authority collects from.',
        failure: 'The check was not recorded',
        inlineOnly: true,
      },
      ['/v1/customers', '/v1/invoices', '/v1/audit-log'],
    );
    if (saved) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Record a check on ${registration.taxId.value}`}
      description={`${registration.customer.name} · ${registration.taxId.type}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.busy} onClick={() => void submit()}>Record it</Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The check was not recorded">{action.error.body.message}</Banner>
        )}
        <Banner tone="info" compact title="This records an answer, it does not ask for one">
          {'Ain does not call VIES or HMRC for you. Point a connector at this route, or record here what a human '
            + 'saw when they checked. Only a verified number changes what a bill charges.'}
        </Banner>
        <Field label="What the register said" required error={action.errorFor('status')}>
          <Select value={status} onChange={setStatus} options={CHECK_OPTIONS} aria-label="What the register said" />
        </Field>
        {status === 'verified' && (
          <Field
            label="Name the register holds"
            optional
            hint="Printed beside the number on the invoice, so a mismatch with the account name is visible."
            error={action.errorFor('verified_name')}
          >
            <Input value={verifiedName} onChange={(e) => setVerifiedName(e.target.value)} aria-label="Name the register holds" />
          </Field>
        )}
      </Stack>
    </Modal>
  );
}

/**
 * Where this workspace is registered to collect tax, and what happens to a
 * bill it cannot place.
 *
 * Every tax figure on an invoice in this product is a snapshot of a row on this
 * screen: the engine matches the customer's address against these registrations
 * — state before country, most specific active rate wins — and copies the name,
 * jurisdiction and exact decimal percentage onto the line. That is why retiring
 * a rate here never moves a number on an invoice already raised: the invoice
 * holds its own copy.
 *
 * The switch at the top is the other half of the story. A bill for an account
 * with no resolvable country is taxed at 0%, and 0% means two entirely
 * different things — "nothing is due here" and "we never learned where they
 * are". With the hold on, the second kind is kept as a draft rather than sent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Grid, GridItem, Icons, Inline,
  Input, Modal, Page, Select, Skeleton, Stack, Stat, Switch, Tooltip, humanize,
  type DataTableColumn,
} from '../../design';
import {
  DialogFields, EmptyList, ListFailure, LoadFailedEmpty, SectionError, TableSearch, idem, useAction,
  useBillingFormat, useDialogForm, useTableView,
} from './common';
import type { AutomaticTaxSettings, TaxRate } from './types';

/** A hyphenated icon name cannot be written as a JSX tag, so it is bound first. */
const RetireIcon = Icons['x-circle'];

const TAX_TYPES = ['vat', 'gst', 'sales_tax', 'hst', 'pst', 'qst', 'jct', 'igst', 'service_tax', 'other'] as const;

const TAX_TYPE_LABEL: Record<string, string> = {
  vat: 'VAT', gst: 'GST', sales_tax: 'Sales tax', hst: 'HST', pst: 'PST',
  qst: 'QST', jct: 'JCT', igst: 'IGST', service_tax: 'Service tax', other: 'Other',
};

const taxTypeLabel = (type: string): string => TAX_TYPE_LABEL[type] ?? humanize(type);

/* ================================== page ================================== */

export function TaxRatesPage() {
  const f = useBillingFormat();
  const navigate = useNavigate();
  const session = useSession();
  const [view, setView] = useTableView({ columnId: 'jurisdiction', direction: 'asc' });
  const [showRetired, setShowRetired] = useState(false);
  const [creating, setCreating] = useState(false);
  const [retiring, setRetiring] = useState<TaxRate | null>(null);
  const action = useAction();

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';
  const rates = useQuery<ListEnvelope<TaxRate>>('/v1/tax_rates', showRetired ? { limit: 500 } : { active: true, limit: 500 });
  const settings = useQuery<AutomaticTaxSettings>('/v1/billing/automatic_tax');
  /**
   * The last settings that arrived, kept so the card is never torn down.
   *
   * Invalidating after the toggle empties the cache entry, `settings.data` goes
   * undefined for one paint, and rendering the skeleton there unmounts the
   * switch — which the browser answers by blurring it. A keyboard operator
   * pressed space to turn the hold on and then had nothing under their hands to
   * turn it off with. The panel keeps rendering what it last knew instead.
   */
  const lastSettings = useRef<AutomaticTaxSettings | null>(null);
  useEffect(() => { if (settings.data) lastSettings.current = settings.data; }, [settings.data]);
  const hold = settings.data ?? lastSettings.current;

  const rows = rates.data?.data ?? [];
  const columns = useMemo<DataTableColumn<TaxRate>[]>(() => [
    {
      id: 'display_name',
      header: 'Rate',
      pinned: true,
      width: 220,
      sortable: true,
      accessor: (row) => row.display_name,
      cell: (row) => (
        <div className="bl-cellstack">
          <span className="bl-cellstack__main">{row.display_name}</span>
          <span className="bl-cellstack__sub">{taxTypeLabel(row.tax_type)}</span>
        </div>
      ),
    },
    {
      id: 'jurisdiction',
      header: 'Jurisdiction',
      width: 200,
      sortable: true,
      filter: 'set',
      accessor: (row) => row.jurisdiction,
      cell: (row) => (
        <div className="bl-cellstack">
          <span className="bl-cellstack__main">{row.jurisdiction}</span>
          <span className="bl-cellstack__sub">{row.applies_to}</span>
        </div>
      ),
    },
    {
      id: 'percentage',
      header: 'Rate applied',
      width: 130,
      align: 'right',
      sortable: true,
      accessor: (row) => Number(row.percentage),
      cell: (row) => <span className="bl-num">{row.percentage_display}</span>,
    },
    {
      id: 'reverse_charge',
      header: 'Reverse charge',
      width: 150,
      sortable: true,
      filter: 'set',
      accessor: (row) => (row.reverse_charge ? 'Yes' : 'No'),
      cell: (row) => (row.reverse_charge
        ? (
          <Tooltip content="A business in this jurisdiction that supplies a valid registration number accounts for the tax itself, so nothing is added.">
            <span><Badge tone="info" pill>Reverse charged</Badge></span>
          </Tooltip>
        )
        : <span className="bl-sub">Charged as normal</span>),
    },
    {
      id: 'active',
      header: 'Status',
      width: 130,
      sortable: true,
      filter: 'set',
      accessor: (row) => (row.active ? 'Active' : 'Retired'),
      cell: (row) => <Badge tone={row.active ? 'success' : 'neutral'} dot pill>{row.active ? 'Active' : 'Retired'}</Badge>,
    },
    {
      id: 'created',
      header: 'Registered',
      width: 140,
      sortable: true,
      defaultHidden: true,
      accessor: (row) => row.created,
      cell: (row) => f.day(row.created, { withYear: true }),
    },
  ], [f]);

  const retire = () => {
    const rate = retiring;
    setRetiring(null);
    if (!rate) return;
    void action.run(
      api.post<TaxRate>(`/v1/tax_rates/${rate.id}/deactivate`, {}),
      {
        success: `${rate.display_name} retired`,
        description: `New invoices stop matching ${rate.applies_to}. Every invoice already raised under it keeps its own copy.`,
        failure: 'The rate could not be retired',
      },
      ['/v1/tax_rates', '/v1/invoices'],
    );
  };

  const setHold = (enabled: boolean) => {
    void action.run(
      api.post<AutomaticTaxSettings>('/v1/billing/automatic_tax', { enabled }),
      {
        success: enabled ? 'Bills with no tax location are held' : 'The hold is off',
        description: enabled
          ? 'An invoice for an account with no resolvable country stays a draft until one is on file.'
          : 'Those bills finalise untaxed. They are still marked, and still findable on the invoice list.',
        failure: 'That setting was refused',
      },
      ['/v1/billing/automatic_tax', '/v1/invoices'],
    );
  };

  return (
    <Page
      title="Tax"
      eyebrow="Revenue"
      subtitle="The registrations every invoice is taxed from, and what happens to a bill this workspace cannot place."
      actions={
        <Inline gap={3}>
          <Button variant="secondary" iconLeft={<Icons.invoice size={15} />} onClick={() => navigate('/billing/invoices?tax=missing')}>
            Bills with no location
          </Button>
          <Button
            variant="primary"
            iconLeft={<Icons.plus size={15} />}
            disabled={!admin}
            title={admin ? undefined : 'Registering a rate needs an admin.'}
            onClick={() => setCreating(true)}
          >
            Register a rate
          </Button>
        </Inline>
      }
    >
      <Stack gap={6}>
        {settings.error && <Card><SectionError error={settings.error} path="GET /v1/billing/automatic_tax" onRetry={settings.refetch} /></Card>}
        {!settings.error && !hold && <Card padding="tight"><Skeleton height={92} /></Card>}
        {hold && (
          <Card
            title="Bills this workspace cannot place"
            description={hold.enabled
              ? 'A bill for an account with no resolvable country is held as a draft until an address is on file. '
                + 'Nothing goes out taxed at a zero nobody decided on.'
              : 'A bill for an account with no resolvable country is finalised untaxed. It is still marked as unplaced, '
                + 'still counted here, and still on the list behind the button above.'}
            actions={
              <Switch
                // Not disabled while the write is in flight: a control that
                // disables itself under the operator's hand is blurred by the
                // browser, and the keyboard user who pressed space to turn it
                // on cannot press space to turn it off again. The request
                // carries the value it wants rather than a delta, so the last
                // press is the one that lands either way.
                checked={hold.enabled}
                disabled={!admin}
                onChange={setHold}
                label="Hold them as drafts"
                aria-label="Hold bills with no tax location as drafts"
              />
            }
          >
            <div className="bl-tiles">
              <Card padding="tight">
                <Stat
                  label="Missing a tax location"
                  value={f.number(hold.invoices_missing_a_tax_location)}
                  caption="Bills raised for an account with no resolvable country"
                />
              </Card>
              <Card padding="tight">
                <Stat
                  label="Held in draft"
                  value={f.number(hold.invoices_held_in_draft)}
                  caption={hold.enabled ? 'Waiting on an address before they can be sent' : 'The hold is off, so nothing is waiting'}
                />
              </Card>
              <Card padding="tight">
                <Stat
                  label="Active registrations"
                  value={f.number(rows.filter((row) => row.active).length)}
                  caption={rates.error ? 'The registrations could not be read' : 'Places an address can match'}
                />
              </Card>
            </div>
            {hold.invoices_missing_a_tax_location > 0 && (
              <div style={{ marginTop: 'var(--space-5)' }}>
                <Banner
                  tone="warning"
                  compact
                  actions={
                    <Button size="sm" variant="secondary" onClick={() => navigate('/billing/invoices?tax=missing')}>
                      Open those bills
                    </Button>
                  }
                >
                  {`${f.plural(hold.invoices_missing_a_tax_location, 'bill')} could not be placed. `}
                  {'A country on the account fixes it — the address is what a rate is matched against.'}
                </Banner>
              </div>
            )}
          </Card>
        )}

        {rates.error && <ListFailure error={rates.error} path="GET /v1/tax_rates" onRetry={rates.refetch} />}
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Tax rates"
          loading={rates.loading && !rates.data}
          error={null}
          onRetry={rates.refetch}
          value={view}
          onChange={setView}
          initialSort={{ columnId: 'jurisdiction', direction: 'asc' }}
          searchable={false}
          maxHeight={620}
          rowActions={(row) => [{
            id: 'rate',
            items: [{
              id: 'retire',
              label: 'Retire this rate…',
              icon: <RetireIcon size={14} />,
              danger: true,
              disabled: !row.active || !admin,
              onSelect: () => setRetiring(row),
            }],
          }]}
          toolbar={
            <Inline gap={3}>
              <TableSearch view={view} onChange={setView} label="Search name, jurisdiction or country" />
              <Select
                size="sm"
                aria-label="Which registrations"
                value={showRetired ? 'all' : 'active'}
                icon={<Icons.filter size={14} />}
                onChange={(value) => setShowRetired(value === 'all')}
                options={[
                  { value: 'active', label: 'Active registrations' },
                  { value: 'all', label: 'Including retired' },
                ]}
              />
            </Inline>
          }
          empty={rates.error
            ? <LoadFailedEmpty noun="tax rates" />
            : (
              <EmptyList
                title="This workspace is not registered anywhere yet"
                body="Until a rate exists, every invoice is taxed at nothing and says so on the document. Register the first place you collect."
                action={(
                  <Button variant="primary" iconLeft={<Icons.plus size={15} />} disabled={!admin} onClick={() => setCreating(true)}>
                    Register a rate
                  </Button>
                )}
              />
            )}
          emptyFiltered={(
            <EmptyState
              size="sm"
              inline
              illustration={null}
              title="No registration matches this filter"
              body="Clear the search, or include retired rates."
            />
          )}
          footer={
            <Inline justify="between" gap={4} className="bl-listfoot">
              <span className="bl-listfoot__count">
                {rates.error
                  ? 'The registrations could not be loaded'
                  : `${f.plural(rows.length, 'registration')}${showRetired ? '' : ' active'}`}
              </span>
              <span className="bl-listfoot__count">
                A customer address matches the most specific active rate — state before country.
              </span>
            </Inline>
          }
        />
      </Stack>

      <TaxRateDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={retiring !== null}
        onCancel={() => setRetiring(null)}
        title={retiring ? `Retire ${retiring.display_name} in ${retiring.jurisdiction}?` : 'Retire this rate?'}
        body={retiring
          ? `New invoices stop matching ${retiring.applies_to}, so an address there is taxed at nothing until another rate covers it. `
            + `Every invoice already raised under ${retiring.display_name} keeps its own snapshot at ${retiring.percentage_display} and is unchanged.`
          : undefined}
        confirmLabel="Retire it"
        onConfirm={retire}
      />
    </Page>
  );
}

/* ============================== create dialog ============================= */

export function TaxRateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const action = useAction();
  const [displayName, setDisplayName] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [country, setCountry] = useState('');
  const [state, setState] = useState('');
  const [percentage, setPercentage] = useState('');
  const [taxType, setTaxType] = useState<string>('vat');
  const [reverseCharge, setReverseCharge] = useState(false);

  const reset = () => {
    setDisplayName('');
    setJurisdiction('');
    setCountry('');
    setState('');
    setPercentage('');
    setTaxType('vat');
    setReverseCharge(false);
    action.clear();
  };

  // The percentage is sent as the exact decimal string the operator typed —
  // never through a float — because that string is what gets snapshotted onto
  // every line the rate ever touches.
  const validPercentage = /^\d{1,3}(\.\d{1,4})?$/.test(percentage.trim()) && Number(percentage) <= 100;
  const ready = displayName.trim().length > 0 && jurisdiction.trim().length > 0
    && country.trim().length >= 2 && validPercentage;

  const submit = async () => {
    const result = await action.run(
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
        success: `${displayName.trim()} registered`,
        description: 'New invoices for an address it matches are taxed at this rate from now on.',
        failure: 'The registration was refused',
        inlineOnly: true,
      },
      ['/v1/tax_rates'],
    );
    if (result) { reset(); onClose(); }
  };

  const form = useDialogForm(open, ready && !action.busy, () => { void submit(); });

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="md"
      title="Register a tax rate"
      description="One active rate per country and state, so a customer address can never match two."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!ready} onClick={() => { void submit(); }}>
            Register it
          </Button>
        </>
      }
    >
      <DialogFields form={form}>
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="That was refused">{action.error.body.message}</Banner>
        )}
        <Grid columns={2} gap={5}>
          <GridItem>
            <Field label="What appears on the invoice" error={action.errorFor('display_name')} required>
              <Input
                aria-label="What appears on the invoice"
                value={displayName}
                placeholder="VAT"
                invalid={!!action.errorFor('display_name')}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
          </GridItem>
          <GridItem>
            <Field label="Kind" error={action.errorFor('tax_type')}>
              <Select
                aria-label="Kind"
                value={taxType}
                onChange={setTaxType}
                options={TAX_TYPES.map((type) => ({ value: type, label: taxTypeLabel(type) }))}
              />
            </Field>
          </GridItem>
        </Grid>

        <Field label="Jurisdiction" hint="The place, written for a human: Germany, New York." error={action.errorFor('jurisdiction')} required>
          <Input
            aria-label="Jurisdiction"
            value={jurisdiction}
            placeholder="Germany"
            invalid={!!action.errorFor('jurisdiction')}
            onChange={(e) => setJurisdiction(e.target.value)}
          />
        </Field>

        <Grid columns={2} gap={5}>
          <GridItem>
            <Field
              label="Country"
              hint="An ISO-3166 two-letter code, or the country name customer addresses use."
              error={action.errorFor('country')}
              required
            >
              <Input
                aria-label="Country"
                value={country}
                placeholder="DE"
                invalid={!!action.errorFor('country')}
                onChange={(e) => setCountry(e.target.value)}
              />
            </Field>
          </GridItem>
          <GridItem>
            <Field
              label="State or region"
              hint="Leave empty for the whole country. A state rate beats a country rate."
              error={action.errorFor('state')}
            >
              <Input
                aria-label="State or region"
                value={state}
                placeholder="Ohio"
                invalid={!!action.errorFor('state')}
                onChange={(e) => setState(e.target.value)}
              />
            </Field>
          </GridItem>
        </Grid>

        <Field
          label="Percentage"
          hint="An exact decimal, stored as typed and snapshotted onto every line it touches: 19, 8.875."
          error={action.errorFor('percentage') ?? (percentage && !validPercentage ? 'A percentage between 0 and 100, with up to four decimals.' : undefined)}
          required
        >
          <Input
            aria-label="Percentage"
            value={percentage}
            placeholder="19"
            inputMode="decimal"
            suffix="%"
            invalid={!!action.errorFor('percentage') || (!!percentage && !validPercentage)}
            onChange={(e) => setPercentage(e.target.value)}
          />
        </Field>

        <Switch
          checked={reverseCharge}
          onChange={setReverseCharge}
          label="Reverse charged for registered businesses"
          hint="A customer here who supplies a valid registration number accounts for the tax themselves, so nothing is added to their bill."
        />
      </Stack>
      </DialogFields>
    </Modal>
  );
}

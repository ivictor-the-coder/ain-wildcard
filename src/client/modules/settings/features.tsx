/**
 * Features and entitlements: what a plan lets an account do, and why.
 *
 * The catalogue is the vocabulary — a `boolean` an account either has or does
 * not, a `limit` on a standing quantity, a `metered` allowance drawn down by
 * real events. Products grant values of them, and an account's set is derived
 * from its live subscriptions plus any support override, recomputed inside the
 * same transaction as the subscription change that moved it.
 *
 * Which is why the second half of this screen shows *why* rather than only
 * *what*. `source.description` on every active entitlement names the plan, the
 * override or the feature default that granted it, and the usage block beside
 * it is read live from the meter and the credit ledger rather than from a
 * counter kept beside them. A screen that showed "25 seats" without saying
 * "included in Telemetry Cloud Growth" would send a support agent to the wrong
 * place every time an account disagreed with its bill.
 */
import { useMemo, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useSearchParam } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, Combobox, ConfirmDialog, DataTable, DatePicker, EmptyState, Field,
  Icons, Inline, Input, Meter, Modal, NumberInput, Select, Stat, Stack, Switch, Tabs, Textarea, Tooltip,
  humanize, useFormat,
  type DataTableColumn, type MenuSection, type TabDef,
  XCircleIcon,
} from '../../design';
import { ListFailure, Loading, SettingsShell, useAction } from './common';
import type {
  ActiveEntitlement, CustomerLite, EntitlementOverride, EntitlementSet, EntitlementsOverview, Feature,
} from './types';

const FEATURE_TYPES = ['boolean', 'limit', 'metered'] as const;
const USAGE_WINDOWS = ['billing_period', 'calendar_month', 'day', 'lifetime'] as const;
const ALLOWANCE_INTERVALS = ['day', 'week', 'month', 'year'] as const;

const TYPE_TONE: Record<string, 'brand' | 'info' | 'teal'> = {
  boolean: 'brand', limit: 'info', metered: 'teal',
};

const TYPE_HINT: Record<string, string> = {
  boolean: 'The account either has it or does not.',
  limit: 'A ceiling on a standing quantity — seats, connected robots.',
  metered: 'A per-period allowance drawn down by real events.',
};

type Tab = 'catalogue' | 'accounts';

export function FeaturesPage() {
  const [tab, setTab] = useState<Tab>('catalogue');
  const tabs: TabDef<Tab>[] = [
    { id: 'catalogue', label: 'The catalogue' },
    { id: 'accounts', label: 'What an account holds' },
  ];

  return (
    <SettingsShell
      title="Features & entitlements"
      subtitle="What a plan lets an account do, derived from its live subscriptions and never out of step with the bill."
    >
      <Stack gap={6}>
        <Tabs tabs={tabs} value={tab} onChange={setTab} aria-label="Features and entitlements" />
        {tab === 'catalogue' ? <Catalogue /> : <AccountEntitlements />}
      </Stack>
    </SettingsShell>
  );
}

/* ================================ catalogue =============================== */

function Catalogue() {
  const f = useFormat();
  const session = useSession();
  const navigate = useNavigate();
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Feature | null>(null);

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';
  const features = useQuery<ListEnvelope<Feature>>('/v1/features', { expand: 'products' });
  const overview = useQuery<EntitlementsOverview>('/v1/entitlements/overview');
  // The overview names accounts by id. An operator cannot act on `cus_SIQeXBq…`,
  // so the same list the accounts tab reads is used to put a name on each one.
  const customers = useQuery<ListEnvelope<CustomerLite>>('/v1/customers', { limit: 200 });
  const accountName = useMemo(() => {
    const names = new Map((customers.data?.data ?? []).map((row) => [row.id, row.name]));
    return (id: string) => names.get(id) ?? id;
  }, [customers.data]);

  const rows = features.data?.data ?? [];
  const byKey = useMemo(
    () => new Map((overview.data?.features ?? []).map((row) => [row.feature, row])),
    [overview.data],
  );
  const atRisk = (overview.data?.features ?? []).flatMap((row) => row.at_risk);

  const columns = useMemo<DataTableColumn<Feature>[]>(() => [
    {
      id: 'name',
      header: 'Feature',
      pinned: true,
      width: 300,
      accessor: (row) => row.name,
      cell: (row) => (
        <span style={{ display: 'block', minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }} className="u-truncate">{row.name}</span>
          <span className="st-mono" style={{ display: 'block' }}>{row.key}</span>
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Kind',
      width: 130,
      filter: 'set',
      accessor: (row) => row.type,
      cell: (row) => (
        <Tooltip content={TYPE_HINT[row.type]}>
          <span><Badge tone={TYPE_TONE[row.type] ?? 'neutral'} pill>{humanize(row.type)}</Badge></span>
        </Tooltip>
      ),
    },
    {
      id: 'unit',
      header: 'Unit',
      width: 110,
      accessor: (row) => row.unit_label ?? '',
      cell: (row) => (row.unit_label ? <span>{row.unit_label}</span> : <span className="st-sub">—</span>),
    },
    {
      id: 'meter',
      header: 'Usage read from',
      width: 200,
      accessor: (row) => row.meter ?? '',
      cell: (row) => (row.meter
        ? <span className="st-mono">{row.meter}</span>
        : <Tooltip content="No meter, so the ceiling is reported without live consumption against it."><span className="st-sub">Not metered</span></Tooltip>),
    },
    {
      id: 'products',
      header: 'Granted by',
      align: 'right',
      width: 130,
      accessor: (row) => row.products?.length ?? byKey.get(row.key)?.granted_by ?? 0,
      cell: (row) => {
        const count = row.products?.length ?? byKey.get(row.key)?.granted_by ?? 0;
        return count
          ? (
            <Tooltip content={(row.products ?? []).map((product) => `${product.product_name ?? product.product}: ${product.unlimited ? 'unlimited' : f.number(product.value ?? 0)}`).join('\n')}>
              <span className="u-num">{f.plural(count, 'product')}</span>
            </Tooltip>
          )
          : <span className="st-sub">No plan</span>;
      },
    },
    {
      id: 'accounts',
      header: 'Held by',
      align: 'right',
      width: 120,
      accessor: (row) => byKey.get(row.key)?.accounts ?? 0,
      cell: (row) => {
        const stats = byKey.get(row.key);
        if (!stats) return <span className="st-sub">—</span>;
        return (
          <Tooltip content={`${f.number(stats.unlimited_accounts)} of them without a ceiling`}>
            <span className="u-num">{f.number(stats.accounts)}</span>
          </Tooltip>
        );
      },
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
  ], [f, byKey]);

  const rowActions = (row: Feature): MenuSection[] => [{
    id: 'feature',
    items: [{
      id: 'edit',
      label: 'Edit this feature…',
      icon: <Icons.edit size={14} />,
      disabled: !admin,
      onSelect: () => { action.clear(); setEditing(row); },
    }],
  }];

  return (
    <Stack gap={6}>
      {features.error && <ListFailure error={features.error} path="GET /v1/features" onRetry={features.refetch} />}

      <div className="st-tiles">
        <Card padding="tight">
          <Stat
            label="Features defined"
            value={f.number(rows.length)}
            caption={`${f.number(rows.filter((row) => row.active).length)} active`}
          />
        </Card>
        <Card padding="tight">
          <Stat
            label="Metered"
            value={f.number(rows.filter((row) => row.type === 'metered').length)}
            caption="Drawn down by real events, checked against the meter"
          />
        </Card>
        <Card padding="tight">
          <Stat
            label="Live overrides"
            value={f.number(overview.data?.overrides_live ?? 0)}
            caption="Per-account grants and suspensions in force"
          />
        </Card>
        <Card padding="tight">
          <Stat
            label="Accounts under pressure"
            value={f.number(atRisk.length)}
            caption={atRisk.length ? 'Past their approaching threshold' : 'Nobody is near a ceiling'}
          />
        </Card>
      </div>

      {atRisk.length > 0 && (
        <Banner
          tone="warning"
          title={`${f.plural(atRisk.length, 'account')} ${atRisk.length === 1 ? 'is' : 'are'} close to a ceiling`}
        >
          <Stack gap={2}>
            {atRisk.slice(0, 4).map((row) => (
              <div key={`${row.customer}:${row.feature}`}>
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => navigate(`/settings/features?customer=${row.customer}`)}
                >
                  {accountName(row.customer)}
                </Button>
                {` · ${row.feature}: ${f.number(row.used)} of ${row.value === null ? 'unlimited' : f.number(row.value)}`}
                {row.percent_used !== null ? ` — ${f.number(row.percent_used)}% used` : ''}
              </div>
            ))}
            {atRisk.length > 4 && <div>{`…and ${f.plural(atRisk.length - 4, 'more')}.`}</div>}
          </Stack>
        </Banner>
      )}

      <Card
        padding="none"
        title="The catalogue"
        description="A feature key is what product code checks against, so it is immutable once created and never reused."
        actions={
          <Button size="sm" variant="primary" iconLeft={<Icons.plus size={14} />} disabled={!admin} onClick={() => { action.clear(); setCreating(true); }}>
            Define a feature
          </Button>
        }
      >
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.key}
          caption="Feature catalogue"
          loading={features.loading}
          searchable
          searchPlaceholder="Search by name, key or meter"
          showFilters
          showColumnToggle
          initialSort={{ columnId: 'name', direction: 'asc' }}
          rowActions={rowActions}
          onRowClick={(row) => { if (admin) { action.clear(); setEditing(row); } }}
          maxHeight={520}
          empty={
            <EmptyState
              size="sm"
              inline
              illustration={<Icons.sliders size={22} />}
              title="No feature is defined"
              body="Until a feature exists, nothing a plan sells can be checked at runtime — every check answers unlimited because nothing is bounded."
              action={<Button size="sm" variant="primary" disabled={!admin} onClick={() => setCreating(true)}>Define a feature</Button>}
            />
          }
        />
      </Card>

      <FeatureDialog open={creating} feature={null} action={action} onClose={() => setCreating(false)} />
      <FeatureDialog open={!!editing} feature={editing} action={action} onClose={() => setEditing(null)} />
    </Stack>
  );
}

type Action = ReturnType<typeof useAction>;

function FeatureDialog({ open, feature, action, onClose }: {
  open: boolean;
  feature: Feature | null;
  action: Action;
  onClose: () => void;
}) {
  const editing = feature !== null;
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>('limit');
  const [unit, setUnit] = useState('');
  const [meter, setMeter] = useState('');
  const [window, setWindow] = useState<string>('billing_period');
  const [interval, setInterval] = useState<string>('month');
  const [threshold, setThreshold] = useState<number | null>(80);
  const [creditBacked, setCreditBacked] = useState(false);
  const [active, setActive] = useState(true);
  const [seeded, setSeeded] = useState<string | null>(null);

  const identity = feature ? feature.key : '__new__';
  if (open && seeded !== identity) {
    setSeeded(identity);
    setKey(feature?.key ?? '');
    setName(feature?.name ?? '');
    setDescription(feature?.description ?? '');
    setType(feature?.type ?? 'limit');
    setUnit(feature?.unit_label ?? '');
    setMeter(feature?.meter ?? '');
    setWindow(feature?.usage_window ?? 'billing_period');
    setInterval(feature?.allowance_interval ?? 'month');
    setThreshold(feature?.approaching_threshold_percent ?? 80);
    setCreditBacked(feature?.credit_backed ?? false);
    setActive(feature?.active ?? true);
  }
  if (!open) return null;

  const keyValid = editing || /^[a-z0-9_]{2,64}$/.test(key);
  const valid = keyValid && name.trim().length > 0 && (type !== 'metered' || meter.trim().length > 0);

  const submit = async () => {
    const shared = {
      name: name.trim(),
      usage_window: window,
      allowance_interval: window === 'billing_period' ? interval : null,
      credit_backed: creditBacked,
      approaching_threshold_percent: threshold ?? 80,
      active,
    };
    // Only the patch body declares these three nullable. On create, "empty"
    // means "do not send it" — an explicit null there is refused by the
    // validator, which is the correct answer to a field that has no null.
    const optional = { description: description.trim(), unit_label: unit.trim(), meter: meter.trim() };
    const saved = await action.run(
      editing
        ? api.patch<Feature>(`/v1/features/${feature!.key}`, {
          ...shared,
          description: optional.description || null,
          unit_label: optional.unit_label || null,
          meter: optional.meter || null,
        })
        : api.post<Feature>('/v1/features', {
          ...shared,
          key: key.trim(),
          type,
          ...(optional.description ? { description: optional.description } : {}),
          ...(optional.unit_label ? { unit_label: optional.unit_label } : {}),
          ...(optional.meter ? { meter: optional.meter } : {}),
        }),
      {
        success: editing ? `${name.trim()} was updated` : `${name.trim()} is defined`,
        description: editing
          ? 'Every account holding it was recomputed — nothing is left to drift until its next subscription event.'
          : `Product code can check it as ${key.trim()} from now on.`,
        failure: editing ? 'The feature was not updated' : 'The feature was not defined',
        inlineOnly: true,
      },
      ['/v1/features', '/v1/entitlements', '/v1/audit-log'],
    );
    if (saved) { setSeeded(null); onClose(); }
  };

  return (
    <Modal
      open
      onClose={() => { setSeeded(null); onClose(); }}
      title={editing ? feature!.name : 'Define a feature'}
      description={editing
        ? `${feature!.key} · changing a default recomputes every account holding it`
        : 'A feature is something a plan can grant and product code can check.'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => { setSeeded(null); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!valid} onClick={() => void submit()}>
            {editing ? 'Save' : 'Define it'}
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The server refused this">{action.error.body.message}</Banner>
        )}

        <Inline gap={5} align="start">
          <Field
            label="Key"
            required
            className="u-grow"
            hint={editing
              ? 'Immutable — product code checks against it, so it is never reused or renamed.'
              : 'Lower case, digits and underscores. Product code checks against this exact string forever.'}
            error={action.errorFor('key') ?? (key && !keyValid ? 'Two to sixty-four lower-case letters, digits or underscores.' : undefined)}
          >
            <Input
              value={key}
              mono
              disabled={editing}
              placeholder="connected_robots"
              invalid={!!key && !keyValid}
              onChange={(e) => setKey(e.target.value)}
              aria-label="Feature key"
            />
          </Field>
          <Field label="Kind" required className="u-grow" error={action.errorFor('type')}>
            <Select
              value={type}
              disabled={editing}
              onChange={setType}
              options={FEATURE_TYPES.map((value) => ({ value, label: `${humanize(value)} — ${TYPE_HINT[value]}` }))}
              aria-label="Kind of feature"
            />
          </Field>
        </Inline>

        <Field label="Name" required error={action.errorFor('name')}>
          <Input value={name} placeholder="Connected robots" onChange={(e) => setName(e.target.value)} aria-label="Feature name" />
        </Field>

        <Field
          label="Description"
          optional
          hint="Written for the person reading a pricing page or an over-limit message, not for the developer."
          error={action.errorFor('description')}
        >
          <Textarea
            value={description}
            autosize
            minRows={2}
            maxRows={5}
            placeholder="Cells, arms and AGVs streaming into the cloud at once."
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Description"
          />
        </Field>

        <Inline gap={5} align="start">
          <Field
            label="Unit"
            optional
            className="u-grow"
            hint="Singular noun for one of them — seat, robot, event."
            error={action.errorFor('unit_label')}
          >
            <Input value={unit} placeholder="robot" onChange={(e) => setUnit(e.target.value)} aria-label="Unit label" />
          </Field>
          <Field
            label="Meter"
            required={type === 'metered'}
            optional={type !== 'metered'}
            className="u-grow"
            hint={type === 'metered'
              ? 'Required: the meter whose events are this feature’s consumption.'
              : 'A limit with a meter reports live usage; one without reports only its ceiling.'}
            error={action.errorFor('meter')}
          >
            <Input value={meter} mono placeholder="connected_robots" onChange={(e) => setMeter(e.target.value)} aria-label="Meter" />
          </Field>
        </Inline>

        <Inline gap={5} align="start">
          <Field
            label="Measured over"
            className="u-grow"
            hint="billing_period follows the granting subscription’s own cycle."
            error={action.errorFor('usage_window')}
          >
            <Select
              value={window}
              onChange={setWindow}
              options={USAGE_WINDOWS.map((value) => ({ value, label: humanize(value) }))}
              aria-label="Measured over"
            />
          </Field>
          {window === 'billing_period' && (
            <Field
              label="Allowance refills every"
              className="u-grow"
              hint="“5,000,000 events a month” means five million a month on an annual term too."
              error={action.errorFor('allowance_interval')}
            >
              <Select
                value={interval}
                onChange={setInterval}
                options={ALLOWANCE_INTERVALS.map((value) => ({ value, label: humanize(value) }))}
                aria-label="Allowance interval"
              />
            </Field>
          )}
        </Inline>

        <Field
          label="Warn at"
          hint="The percent of the ceiling at which entitlement.limit_approaching fires."
          error={action.errorFor('approaching_threshold_percent')}
        >
          <NumberInput value={threshold} min={1} max={100} onChange={setThreshold} suffix="%" aria-label="Approaching threshold percent" />
        </Field>

        <Switch
          checked={creditBacked}
          onChange={setCreditBacked}
          label="Prepaid credit raises the allowance"
          hint="A credit pack denominated in the meter’s units extends the ceiling rather than being spent separately."
        />

        <Switch
          checked={active}
          onChange={setActive}
          label="Active"
          hint="Deactivating recomputes every account holding it immediately."
        />
      </Stack>
    </Modal>
  );
}

/* ============================== per account =============================== */

function AccountEntitlements() {
  const f = useFormat();
  const session = useSession();
  const navigate = useNavigate();
  const action = useAction();
  const [customerId, setCustomerId] = useSearchParam('customer');
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<EntitlementOverride | null>(null);

  const member = ['owner', 'admin', 'member'].includes(session.me?.role ?? '');
  const customers = useQuery<ListEnvelope<CustomerLite>>('/v1/customers', { limit: 200 });
  const features = useQuery<ListEnvelope<Feature>>('/v1/features', { active: true });
  const set = useQuery<EntitlementSet>(customerId ? `/v1/customers/${customerId}/entitlements` : null);
  const overrides = useQuery<ListEnvelope<EntitlementOverride>>(
    '/v1/entitlement-overrides',
    customerId ? { customer: customerId, status: 'all', limit: 200 } : { status: 'active', limit: 200 },
  );

  const options = useMemo(
    () => (customers.data?.data ?? []).map((customer) => ({
      value: customer.id,
      label: customer.name,
      description: customer.email ?? customer.id,
    })),
    [customers.data],
  );

  const customer = (customers.data?.data ?? []).find((row) => row.id === customerId) ?? null;
  const entitlements = set.data?.entitlements ?? [];
  const rows = overrides.data?.data ?? [];
  /**
   * An entitlement granted by an override says only "Granted by a support
   * override" — the sentence somebody wrote to justify it lives on the override
   * row. Joining them here is the difference between a screen that says *what*
   * an account holds and one that answers *why* it holds it.
   */
  const overrideById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  return (
    <Stack gap={6}>
      <Card
        title="Pick an account"
        description="The set below is what the platform would answer to a runtime check right now, and what granted each line."
      >
        <Inline gap={4} wrap>
          <Combobox
            value={customerId}
            onChange={(next) => setCustomerId(next || undefined)}
            options={options}
            placeholder={customers.loading ? 'Reading accounts…' : 'Search the accounts this workspace bills'}
            emptyMessage="No account matches"
            aria-label="Choose an account"
            className="u-grow"
          />
          {customerId && (
            <Button variant="secondary" iconLeft={<Icons.external size={14} />} onClick={() => navigate(`/billing/customers/${customerId}`)}>
              Open the account
            </Button>
          )}
          <Button
            variant="primary"
            iconLeft={<Icons.plus size={15} />}
            disabled={!member || !customerId}
            onClick={() => { action.clear(); setGranting(true); }}
          >
            Grant or suspend
          </Button>
        </Inline>
      </Card>

      {!customerId && (
        <Card>
          <EmptyState
            illustration={<Icons.shield size={26} />}
            title="Choose an account to see what it holds"
            body={
              'An entitlement set is derived from the account’s live subscriptions and any support override, stored, '
              + 'and recomputed inside the same transaction as the subscription change that moved it. Reading one is a '
              + 'single indexed lookup, which is why product code can check it on a hot path.'
            }
          />
        </Card>
      )}

      {customerId && set.error && <ListFailure error={set.error} path={`GET /v1/customers/${customerId}/entitlements`} onRetry={set.refetch} />}

      {customerId && set.loading && <Card><Loading label="Reading the entitlement set…" /></Card>}

      {customerId && !set.loading && !set.error && (
        <Card
          title={customer ? `${customer.name} holds ${f.plural(entitlements.length, 'entitlement')}` : 'Entitlements'}
          description={
            `Version ${f.number(set.data?.version ?? 0)} — the number an edge cache keys on. Consumption is read live `
            + 'from the meter and the credit ledger every time this page loads, never from a counter kept beside them.'
          }
        >
          {entitlements.length === 0 && (
            <EmptyState
              size="sm"
              inline
              illustration={<Icons.lock size={22} />}
              title="This account is entitled to nothing"
              body="No live subscription grants it a feature, and no override has been written for it. Every runtime check on this account is refused."
            />
          )}
          {entitlements.map((entitlement) => (
            <EntitlementRow
              key={entitlement.id}
              entitlement={entitlement}
              override={entitlement.source.override ? overrideById.get(entitlement.source.override) ?? null : null}
            />
          ))}
        </Card>
      )}

      <Card
        padding="none"
        title={customerId ? 'Overrides on this account' : 'Live overrides across the workspace'}
        description="A temporary raise or suspension support can hand out without touching the plan. Give it an expiry and it takes itself away — the expiry is a queued job, so the time machine replays it exactly."
      >
        {overrides.error && <ListFailure error={overrides.error} path="GET /v1/entitlement-overrides" onRetry={overrides.refetch} />}
        <OverrideTable
          rows={rows}
          loading={overrides.loading}
          showCustomer={!customerId}
          onRevoke={member ? (row) => { action.clear(); setRevoking(row); } : undefined}
          onPick={(id) => setCustomerId(id)}
        />
      </Card>

      <GrantDialog
        open={granting}
        customerId={customerId}
        customerName={customer?.name ?? customerId}
        features={features.data?.data ?? []}
        action={action}
        onClose={() => setGranting(false)}
      />

      <ConfirmDialog
        open={!!revoking}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          const done = await action.run(
            api.del<EntitlementOverride>(`/v1/entitlement-overrides/${revoking.id}`),
            {
              success: 'The override is revoked',
              description: 'The set it was shaping has been recomputed.',
              failure: 'The override was not revoked',
            },
            ['/v1/entitlement-overrides', '/v1/customers', '/v1/entitlements', '/v1/audit-log'],
          );
          if (done) setRevoking(null);
        }}
        tone="danger"
        title="Revoke this override now?"
        confirmLabel="Revoke it"
        cancelLabel="Leave it in force"
        loading={action.busy}
        body={revoking
          ? `${revoking.effect === 'grant' ? 'The raise' : 'The suspension'} on ${revoking.feature_name ?? revoking.feature} ends immediately and the `
            + 'account goes back to whatever its plan grants. Written because: “' + revoking.reason + '”'
          : ''}
      />
    </Stack>
  );
}

function EntitlementRow({ entitlement, override }: {
  entitlement: ActiveEntitlement;
  override: EntitlementOverride | null;
}) {
  const f = useFormat();
  const usage = entitlement.usage;
  const unit = entitlement.unit_label ?? 'unit';
  const ceiling = entitlement.unlimited
    ? 'Unlimited'
    : entitlement.type === 'boolean'
      ? (entitlement.value ? 'Included' : 'Not included')
      : `${f.number(entitlement.value ?? 0)} ${f.plural(entitlement.value ?? 0, unit, { hideCount: true })}`;

  return (
    <div className="st-ent">
      <div className="st-ent__head">
        <div style={{ minWidth: 0 }}>
          <div className="st-ent__name">
            {entitlement.feature_name}
            {' '}
            <Badge tone={TYPE_TONE[entitlement.type] ?? 'neutral'} pill>{humanize(entitlement.type)}</Badge>
            {entitlement.source.type === 'override' && <> <Badge tone="warning" pill>Override</Badge></>}
          </div>
          <div className="st-ent__why">
            {entitlement.source.description}
            {override ? <>{' — “'}{override.reason}{'”'}</> : null}
          </div>
        </div>
        <div className="st-ent__value">{ceiling}</div>
      </div>

      {usage && usage.limit !== null && (
        <Meter
          value={usage.used}
          limit={usage.limit}
          label={`${usage.meter_name} this period`}
          format={(value) => `${f.number(value)} ${f.plural(value, usage.unit_label ?? unit, { hideCount: true })}`}
          footnote={
            usage.credit_units > 0
              ? `${f.number(usage.included ?? 0)} included by the plan plus ${f.number(usage.credit_units)} from prepaid credit · read ${f.time(usage.as_of)}`
              : `Read ${f.time(usage.as_of)}`
          }
        />
      )}
      {usage && usage.limit === null && (
        <div className="st-sub">
          {`${f.number(usage.used)} ${f.plural(usage.used, usage.unit_label ?? unit, { hideCount: true })} used against no ceiling.`}
        </div>
      )}

      {entitlement.period && (
        <div className="st-hint">
          {`Measured over ${f.date(entitlement.period.start, { timeZone: 'UTC' })} – ${f.date(entitlement.period.end, { timeZone: 'UTC' })}`}
          {entitlement.source.expires_at !== null
            ? ` · this grant ends ${f.date(entitlement.source.expires_at)}`
            : ''}
        </div>
      )}
    </div>
  );
}

function OverrideTable({ rows, loading, showCustomer, onRevoke, onPick }: {
  rows: EntitlementOverride[];
  loading: boolean;
  showCustomer: boolean;
  onRevoke?: (row: EntitlementOverride) => void;
  onPick: (id: string) => void;
}) {
  const f = useFormat();
  const columns = useMemo<DataTableColumn<EntitlementOverride>[]>(() => {
    const base: DataTableColumn<EntitlementOverride>[] = [
      {
        id: 'feature',
        header: 'Feature',
        pinned: true,
        width: 220,
        accessor: (row) => row.feature_name ?? row.feature,
        cell: (row) => (
          <span style={{ display: 'block', minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }} className="u-truncate">{row.feature_name ?? row.feature}</span>
            <span className="st-mono">{row.feature}</span>
          </span>
        ),
      },
      {
        id: 'effect',
        header: 'Effect',
        width: 140,
        filter: 'set',
        accessor: (row) => row.effect,
        cell: (row) => <Badge tone={row.effect === 'grant' ? 'success' : 'danger'} pill>{row.effect === 'grant' ? 'Grant' : 'Suspend'}</Badge>,
      },
      {
        id: 'value',
        header: 'Value',
        align: 'right',
        width: 120,
        accessor: (row) => (row.unlimited ? Number.MAX_SAFE_INTEGER : row.value ?? 0),
        cell: (row) => (row.unlimited ? 'Unlimited' : <span className="u-num">{f.number(row.value ?? 0)}</span>),
      },
      {
        id: 'reason',
        header: 'Why',
        accessor: (row) => row.reason,
        cell: (row) => <Tooltip content={row.reason}><span className="u-truncate" style={{ display: 'block' }}>{row.reason}</span></Tooltip>,
      },
      {
        id: 'expires_at',
        header: 'Ends',
        align: 'right',
        width: 160,
        accessor: (row) => row.expires_at ?? 0,
        cell: (row) => (row.expires_at
          ? <Tooltip content={f.dateTime(row.expires_at)}><span>{f.when(row.expires_at)}</span></Tooltip>
          : <span className="st-sub">Never — until revoked</span>),
      },
      {
        id: 'status',
        header: 'Status',
        width: 130,
        filter: 'set',
        accessor: (row) => row.status,
        cell: (row) => (
          <Badge tone={row.status === 'active' ? 'success' : row.status === 'revoked' ? 'danger' : 'neutral'} pill dot>
            {humanize(row.status)}
          </Badge>
        ),
      },
    ];
    if (showCustomer) {
      base.splice(1, 0, {
        id: 'customer',
        header: 'Account',
        width: 220,
        accessor: (row) => row.customer,
        cell: (row) => <span className="st-mono">{row.customer}</span>,
      });
    }
    return base;
  }, [f, showCustomer]);

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Entitlement overrides"
      loading={loading}
      searchable
      searchPlaceholder="Search by feature, account or reason"
      showFilters
      initialSort={{ columnId: 'status', direction: 'asc' }}
      onRowClick={showCustomer ? (row) => onPick(row.customer) : undefined}
      rowActions={onRevoke
        ? (row) => [{
          id: 'override',
          items: [{
            id: 'revoke',
            label: 'Revoke now…',
            icon: <XCircleIcon size={14} />,
            danger: true,
            disabled: row.status !== 'active',
            onSelect: () => onRevoke(row),
          }],
        }]
        : undefined}
      maxHeight={420}
      empty={
        <EmptyState
          size="sm"
          inline
          illustration={<Icons.shield size={22} />}
          title="No override is in force"
          body="Every account holds exactly what its plan grants. An override is how support raises one ceiling for one account without changing the plan everyone else is on."
        />
      }
    />
  );
}

function GrantDialog({ open, customerId, customerName, features, action, onClose }: {
  open: boolean;
  customerId: string;
  customerName: string;
  features: Feature[];
  action: Action;
  onClose: () => void;
}) {
  const f = useFormat();
  const [feature, setFeature] = useState('');
  const [effect, setEffect] = useState('grant');
  const [value, setValue] = useState<number | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const chosen = features.find((row) => row.key === feature) ?? null;
  const needsValue = effect === 'grant' && chosen?.type !== 'boolean' && !unlimited;
  const valid = feature && reason.trim().length >= 3 && (!needsValue || (value !== null && value >= 0));

  const close = () => {
    setFeature(''); setEffect('grant'); setValue(null); setUnlimited(false); setReason(''); setExpiresAt(null);
    action.clear(); onClose();
  };

  const submit = async () => {
    const saved = await action.run(
      api.post<EntitlementOverride>('/v1/entitlement-overrides', {
        customer: customerId,
        feature,
        effect,
        ...(effect === 'grant' && !unlimited ? { value: chosen?.type === 'boolean' ? 1 : value } : {}),
        ...(effect === 'grant' && unlimited ? { unlimited: true } : {}),
        reason: reason.trim(),
        ...(expiresAt !== null ? { expires_at: expiresAt } : {}),
      }),
      {
        success: effect === 'grant' ? 'The grant is in force' : 'The feature is suspended',
        description: expiresAt !== null
          ? `It takes itself away on ${f.date(expiresAt)} — the expiry is a queued job with a run_at.`
          : 'It stays until somebody revokes it.',
        failure: 'The override was not written',
        inlineOnly: true,
      },
      ['/v1/entitlement-overrides', '/v1/customers', '/v1/entitlements', '/v1/audit-log'],
    );
    if (saved) close();
  };

  if (!open) return null;

  return (
    <Modal
      open
      onClose={close}
      title={`Override a feature for ${customerName}`}
      description="A change to one account only. The plan everyone else is on does not move."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!valid} onClick={() => void submit()}>
            {effect === 'grant' ? 'Grant it' : 'Suspend it'}
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The override was not written">{action.error.body.message}</Banner>
        )}

        <Field label="Feature" required error={action.errorFor('feature')}>
          <Select
            value={feature}
            onChange={setFeature}
            placeholder="Choose the feature to override"
            options={features.map((row) => ({
              value: row.key,
              label: `${row.name} · ${humanize(row.type)}${row.unit_label ? ` · ${row.unit_label}` : ''}`,
            }))}
            aria-label="Feature"
          />
        </Field>

        <Field label="Effect" required error={action.errorFor('effect')}>
          <Select
            value={effect}
            onChange={setEffect}
            options={[
              { value: 'grant', label: 'Grant — raise the ceiling, or turn it on' },
              { value: 'suspend', label: 'Suspend — take it away regardless of the plan' },
            ]}
            aria-label="Effect"
          />
        </Field>

        {effect === 'grant' && chosen?.type !== 'boolean' && (
          <>
            <Switch
              checked={unlimited}
              onChange={setUnlimited}
              label="No ceiling at all"
              hint="Every check on this feature is answered yes, whatever the plan says."
            />
            {!unlimited && (
              <Field
                label={chosen?.unit_label ? `How many ${f.plural(2, chosen.unit_label, { hideCount: true })}` : 'Value'}
                required
                error={action.errorFor('value')}
              >
                <NumberInput value={value} min={0} onChange={setValue} aria-label="Override value" />
              </Field>
            )}
          </>
        )}

        <Field
          label="Why"
          required
          hint="Never optional. An override with no reason is an unexplained bill three months from now."
          error={action.errorFor('reason')}
        >
          <Textarea
            value={reason}
            autosize
            minRows={2}
            maxRows={5}
            placeholder="Second line commissioning at Leeds — ceiling raised for the cutover, reverting when the old line is retired."
            onChange={(e) => setReason(e.target.value)}
            aria-label="Why"
          />
        </Field>

        <Field
          label="Ends on"
          optional
          hint="Leave it empty and the override stays until somebody revokes it. Given a date, it takes itself away — replayable by the time machine."
          error={action.errorFor('expires_at')}
        >
          <DatePicker
            value={expiresAt}
            onChange={setExpiresAt}
            placeholder="No expiry"
            aria-label="Ends on"
          />
        </Field>
      </Stack>
    </Modal>
  );
}

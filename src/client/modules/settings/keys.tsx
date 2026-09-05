/**
 * API keys: the credentials that reach this workspace without a browser.
 *
 * Two things this screen refuses to be vague about.
 *
 * The secret is returned by `POST /v1/api-keys` and by nothing else, ever —
 * the list only ever holds `sk_test_••••…0001`, because only a hash is stored.
 * So the one moment it exists is given its own panel, with a copy control and a
 * warning that says plainly it cannot be shown again.
 *
 * And the scopes are shown for what they actually do. `keyRole` in
 * `src/server/app.ts` reads them as a ladder — `*` is admin, anything naming a
 * write is a member *everywhere*, everything else is read-only — because no
 * route in the platform declares `meta.scopes` yet. Rendering `crm:write` as
 * though it confined a key to CRM would be the most dangerous sentence on this
 * surface, so the reach is spelled out under every key.
 */
import { useMemo, useRef, useState } from 'react';
import { api, useQuery, type ListEnvelope } from '../../kernel/api';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, Checkbox, CopyField, DataTable, EmptyState, Field, Icons, Inline, Input,
  Modal, RadioGroup, Stack, Switch, TagInput, Tooltip,
  useFormat,
  type DataTableColumn, type MenuSection,
  AlertTriangleIcon, XCircleIcon,
} from '../../design';
import { ListFailure, NeedsAdmin, SettingsShell, scopeReach, useAction, useOpenFromQuery } from './common';
import type { ApiKey, MintedApiKey } from './types';

/**
 * The three reaches the platform actually distinguishes, named as such. A
 * custom set is still allowed — it is read through the same ladder, and the
 * dialog says which rung it lands on before the key is minted.
 */
const PRESETS = [
  { id: 'full', label: 'Full access', scopes: ['*'] },
  { id: 'write', label: 'Read and write', scopes: ['read', 'write'] },
  { id: 'read', label: 'Read only', scopes: ['read'] },
  { id: 'custom', label: 'Custom scopes', scopes: [] as string[] },
] as const;

type PresetId = (typeof PRESETS)[number]['id'];

export function ApiKeysPage() {
  const session = useSession();
  const f = useFormat();
  const action = useAction();
  const keys = useQuery<ListEnvelope<ApiKey>>('/v1/api-keys');

  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<MintedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';
  // The palette's Create entry lands here with the dialog already open.
  useOpenFromQuery('new', () => { if (admin) { action.clear(); setCreating(true); } });
  const all = keys.data?.data ?? [];
  const rows = showRevoked ? all : all.filter((key) => key.revoked_at === null);
  const revokedCount = all.filter((key) => key.revoked_at !== null).length;
  const liveCount = all.filter((key) => key.revoked_at === null && key.livemode).length;

  const columns = useMemo<DataTableColumn<ApiKey>[]>(() => [
    {
      id: 'name',
      header: 'Key',
      pinned: true,
      width: 260,
      accessor: (row) => row.name,
      cell: (row) => (
        <span style={{ minWidth: 0, display: 'block' }}>
          <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }} className="u-truncate">{row.name}</span>
          <span className="st-mono" style={{ display: 'block' }}>{row.masked}</span>
        </span>
      ),
    },
    {
      id: 'mode',
      header: 'Mode',
      width: 110,
      filter: 'set',
      accessor: (row) => (row.livemode ? 'live' : 'test'),
      cell: (row) => <Badge tone={row.livemode ? 'warning' : 'neutral'} pill>{row.livemode ? 'Live' : 'Test'}</Badge>,
    },
    {
      id: 'reach',
      header: 'Reach',
      width: 300,
      accessor: (row) => scopeReach(row.scopes).role,
      cell: (row) => {
        const reach = scopeReach(row.scopes);
        return (
          <Tooltip content={reach.summary}>
            <span className="u-row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <Badge tone={reach.tone} pill>{reach.role}</Badge>
              {row.scopes.map((scope) => <span key={scope} className="st-mono">{scope}</span>)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      id: 'last_used',
      header: 'Last used',
      align: 'right',
      width: 150,
      accessor: (row) => row.last_used ?? 0,
      cell: (row) => (row.last_used
        ? <Tooltip content={f.dateTime(row.last_used)}><span>{f.relative(row.last_used)}</span></Tooltip>
        : <span className="st-sub">Never used</span>),
    },
    {
      id: 'created',
      header: 'Created',
      align: 'right',
      width: 140,
      accessor: (row) => row.created,
      cell: (row) => f.date(row.created),
      defaultHidden: true,
    },
    {
      id: 'status',
      header: 'Status',
      width: 150,
      filter: 'set',
      accessor: (row) => (row.revoked_at ? 'revoked' : 'active'),
      cell: (row) => (row.revoked_at
        ? <Tooltip content={`Revoked ${f.dateTime(row.revoked_at)}`}><span><Badge tone="danger" pill dot>Revoked</Badge></span></Tooltip>
        : <Badge tone="success" pill dot>Active</Badge>),
    },
  ], [f]);

  const rowActions = (row: ApiKey): MenuSection[] => [{
    id: 'key',
    items: [{
      id: 'revoke',
      label: 'Revoke this key…',
      icon: <XCircleIcon size={14} />,
      danger: true,
      disabled: row.revoked_at !== null,
      onSelect: () => { action.clear(); setRevoking(row); },
    }],
  }];

  if (!admin) {
    return (
      <SettingsShell title="API keys" subtitle="Credentials for the API, and what each of them reaches.">
        <Card><NeedsAdmin what="Reading API keys" route="GET /v1/api-keys" /></Card>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell
      title="API keys"
      subtitle="Every credential that can reach this workspace without a browser."
      actions={
        <Button variant="primary" iconLeft={<Icons.plus size={15} />} onClick={() => { action.clear(); setCreating(true); }}>
          Create a key
        </Button>
      }
    >
      <Stack gap={6}>
        {keys.error && <ListFailure error={keys.error} path="GET /v1/api-keys" onRetry={keys.refetch} />}

        {liveCount > 0 && (
          <Banner tone="warning" compact title={`${f.plural(liveCount, 'live key')} can move real money`}>
            {'A live key authenticates against the same workspace as a test key and is bounded only by its scopes and '
              + 'by the role of whoever minted it. Revoking one takes effect on the next request.'}
          </Banner>
        )}

        <Card
          padding="none"
          title="Keys"
          description="A key is stored as a hash — the secret shown at creation is the only copy that ever exists."
          actions={
            <Inline gap={4}>
              {revokedCount > 0 && (
                <Switch
                  checked={showRevoked}
                  onChange={setShowRevoked}
                  size="sm"
                  label={`Show ${f.plural(revokedCount, 'revoked key')}`}
                />
              )}
            </Inline>
          }
        >
          <DataTable
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            caption="API keys"
            loading={keys.loading}
            searchable
            searchPlaceholder="Search by name, prefix or scope"
            showFilters
            showColumnToggle
            initialSort={{ columnId: 'created', direction: 'desc' }}
            rowActions={rowActions}
            rowTone={(row) => (row.revoked_at ? 'danger' : 'default')}
            empty={
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.key size={22} />}
                title={showRevoked ? 'No key has ever been minted here' : 'No key is active'}
                body={
                  'An API key is how a build server, an ingest pipeline or a partner integration reaches this '
                  + 'workspace. The secret is shown once, at creation.'
                }
                action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>Create a key</Button>}
              />
            }
          />
        </Card>

        <Card title="How a key is bounded" description="Two ceilings, both enforced on every request.">
          <div className="st-rows">
            <div className="st-row">
              <div className="st-row__main">
                <div className="st-row__title">Its own scopes</div>
                <div className="st-row__sub">
                  {'No route declares scopes by domain yet, so the platform reads them as a ladder: '}
                  <code className="st-mono">*</code>
                  {' authenticates as admin, anything naming a write authenticates as member on every write in the '
                    + 'product, and everything else is read-only. A restricted key can never move the clock, mint '
                    + 'keys or read this screen.'}
                </div>
              </div>
            </div>
            <div className="st-row">
              <div className="st-row__main">
                <div className="st-row__title">The role of whoever minted it</div>
                <div className="st-row__sub">
                  {'Authority is transitive, so authorship is too. A key carries the lower of its own scopes and its '
                    + 'author’s current role — and removing that person from the workspace revokes every key they '
                    + 'minted. Only a key with genuinely no person behind it stays a workspace credential.'}
                </div>
              </div>
            </div>
            <div className="st-row">
              <div className="st-row__main">
                <div className="st-row__title">Sending one</div>
                <div className="st-row__sub">
                  <code className="st-mono">Authorization: Bearer sk_test_…</code>
                  {' on any route under /api. A session cookie works the same way from a browser.'}
                </div>
              </div>
            </div>
          </div>
        </Card>
      </Stack>

      <CreateKeyDialog
        open={creating}
        action={action}
        onClose={() => setCreating(false)}
        onMinted={(key) => { setCreating(false); setMinted(key); }}
      />

      <SecretDialog minted={minted} onClose={() => setMinted(null)} />

      <RevokeDialog apiKey={revoking} action={action} onClose={() => setRevoking(null)} />
    </SettingsShell>
  );
}

type Action = ReturnType<typeof useAction>;

/* ================================= create ================================= */

function CreateKeyDialog({ open, action, onClose, onMinted }: {
  open: boolean;
  action: Action;
  onClose: () => void;
  onMinted: (key: MintedApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<PresetId>('write');
  const [custom, setCustom] = useState<string[]>([]);
  const [livemode, setLivemode] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const scopes: string[] = preset === 'custom' ? custom : [...PRESETS.find((p) => p.id === preset)!.scopes];
  const reach = scopeReach(scopes);
  const valid = name.trim().length > 0 && scopes.length > 0;

  const close = () => { setName(''); setPreset('write'); setCustom([]); setLivemode(false); action.clear(); onClose(); };

  const submit = async () => {
    const key = await action.run(
      api.post<MintedApiKey>('/v1/api-keys', { name: name.trim(), livemode, scopes }),
      {
        success: 'The key is live',
        description: 'Copy the secret now — it is not stored and cannot be shown again.',
        failure: 'The key was not created',
        inlineOnly: true,
      },
      ['/v1/api-keys', '/v1/audit-log'],
    );
    if (key) {
      setName(''); setPreset('write'); setCustom([]); setLivemode(false);
      onMinted(key);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Create an API key"
      description="The secret is generated on the server and shown to you once."
      size="md"
      initialFocus={first}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={action.busy} disabled={!valid} onClick={() => void submit()}>
            Create key
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && !action.error.body.param && (
          <Banner tone="danger" compact title="The key was not created">{action.error.body.message}</Banner>
        )}

        <Field
          label="What is this key for"
          required
          hint="Name the system that will hold it — this is what an operator reads when deciding whether it is safe to revoke."
          error={action.errorFor('name')}
        >
          <Input
            ref={first}
            value={name}
            placeholder="Fleet telemetry ingest"
            maxLength={80}
            invalid={!!action.errorFor('name')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && valid) void submit(); }}
            aria-label="What is this key for"
          />
        </Field>

        <Field label="Reach" required error={action.errorFor('scopes')}>
          <RadioGroup
            label="Reach"
            value={preset}
            onChange={setPreset}
            options={PRESETS.map((option) => ({
              value: option.id,
              label: option.label,
              hint: option.id === 'custom'
                ? 'Your own scope strings. They are read through the same ladder.'
                : scopeReach(option.scopes).summary,
            }))}
          />
        </Field>

        {preset === 'custom' && (
          <Field
            label="Scopes"
            required
            hint="Enter to add. A scope ending in write, admin or * makes this key a member everywhere; anything else keeps it read-only."
          >
            <TagInput
              value={custom}
              onChange={setCustom}
              placeholder="metering:write"
              aria-label="Scopes"
              max={12}
              validate={(tag) => (/^[a-z0-9_:.*-]+$/i.test(tag) ? null : 'Letters, digits, colons, dots, dashes and * only.')}
            />
          </Field>
        )}

        <Banner tone={reach.tone === 'warning' ? 'warning' : 'info'} compact title={`This key will authenticate as ${reach.role}`}>
          {reach.summary}
        </Banner>

        <Field
          label="Mode"
          hint="A live key is the credential your production systems hold. Test and live keys reach the same workspace; the flag is what an integration branches on."
        >
          <Switch
            checked={livemode}
            onChange={setLivemode}
            label={livemode ? 'Live key — sk_live_…' : 'Test key — sk_test_…'}
          />
        </Field>
      </Stack>
    </Modal>
  );
}

/* ================================= secret ================================= */

function SecretDialog({ minted, onClose }: { minted: MintedApiKey | null; onClose: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  if (minted && seeded !== minted.id) { setSeeded(minted.id); setAcknowledged(false); }
  if (!minted) return null;

  return (
    <Modal
      open
      // Dismissing by accident is how a secret is lost, so Esc and the backdrop
      // do nothing until the operator has said they have it.
      dismissable={acknowledged}
      showClose={acknowledged}
      onClose={onClose}
      title={`“${minted.name}” is live`}
      description="This is the only time this secret exists outside your clipboard."
      icon={<Icons.key size={18} />}
      iconTone="warning"
      size="md"
      footer={
        <Button variant="primary" disabled={!acknowledged} onClick={onClose}>
          {acknowledged ? 'Done' : 'Copy it first'}
        </Button>
      }
    >
      <Stack gap={5}>
        <div className="st-secret">
          <div>
            <div style={{ fontWeight: 'var(--weight-semibold)' }}>Copy this now</div>
            <div className="st-sub">
              {'The server stores only a SHA-256 hash of it. Nobody — not you, not an owner, not support — can read it '
                + 'back. If it is lost, revoke this key and create another.'}
            </div>
          </div>
          <CopyField value={minted.secret} secret label="Copy the secret" />
        </div>

        <div className="st-rows">
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">How to send it</div>
              <div className="st-row__sub"><code className="st-mono">Authorization: Bearer {minted.prefix}_…</code></div>
            </div>
          </div>
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">What it reaches</div>
              <div className="st-row__sub">{scopeReach(minted.scopes).summary}</div>
            </div>
            <div className="st-row__aside"><Badge tone={scopeReach(minted.scopes).tone} pill>{scopeReach(minted.scopes).role}</Badge></div>
          </div>
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">In the list it will read</div>
              <div className="st-row__sub"><span className="st-mono">{minted.masked}</span></div>
            </div>
          </div>
        </div>

        <Checkbox
          checked={acknowledged}
          onChange={setAcknowledged}
          label="I have stored this secret somewhere safe."
        />
      </Stack>
    </Modal>
  );
}

/* ================================= revoke ================================= */

function RevokeDialog({ apiKey, action, onClose }: {
  apiKey: ApiKey | null;
  action: Action;
  onClose: () => void;
}) {
  const f = useFormat();
  if (!apiKey) return null;

  const submit = async () => {
    // 204 resolves to `null`, which `run` also returns for a refusal. Mapping
    // it to `true` keeps "the key is revoked" distinct from "it was not".
    const done = await action.run(
      api.del<void>(`/v1/api-keys/${apiKey.id}`).then(() => true),
      {
        success: `“${apiKey.name}” is revoked`,
        description: 'The next request that presents it is refused.',
        failure: 'The key was not revoked',
        inlineOnly: true,
      },
      ['/v1/api-keys', '/v1/audit-log'],
    );
    if (done) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Revoke “${apiKey.name}”?`}
      icon={<AlertTriangleIcon size={18} />}
      iconTone="danger"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={action.busy} onClick={() => void submit()}>Revoke it</Button>
        </>
      }
    >
      <Stack gap={5}>
        {action.error && <Banner tone="danger" compact title="The key was not revoked">{action.error.body.message}</Banner>}
        <Banner tone="danger" compact title="Anything holding this key stops working">
          {apiKey.last_used
            ? `It was last used ${f.relative(apiKey.last_used)}, so something is presenting it. Revoking cannot be undone — a replacement is a new key with a new secret.`
            : 'It has never been used, so nothing should break. Revoking cannot be undone — a replacement is a new key with a new secret.'}
        </Banner>
        <div className="st-rows">
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">Key</div>
              <div className="st-row__sub"><span className="st-mono">{apiKey.masked}</span></div>
            </div>
          </div>
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">Reach</div>
              <div className="st-row__sub">{scopeReach(apiKey.scopes).summary}</div>
            </div>
          </div>
          <div className="st-row">
            <div className="st-row__main">
              <div className="st-row__title">Created</div>
              <div className="st-row__sub">{f.dateTime(apiKey.created)}</div>
            </div>
          </div>
        </div>
      </Stack>
    </Modal>
  );
}

/**
 * One deal.
 *
 * The record-page shape — properties, timeline, associations — plus the two
 * things a deal has that a contact does not: a forecast that is derived from
 * the stage it sits in, and the contract its account is actually billed on.
 * The stage rail at the top is the primary control: clicking a stage is the
 * same move the board makes, with the same confirmation.
 */
import { useMemo, useState } from 'react';
import { api, invalidate, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import {
  Avatar, Badge, Banner, Breadcrumbs, Button, Card, ChevronRightIcon, ConfirmDialog, DescriptionList,
  EmptyState, ErrorState, GitBranchIcon, humanize, iconByName, Icons, MenuButton, Page, Skeleton,
  SkeletonText, Split, Timeline, useFormat, useToast,
  type DescriptionItem, type MenuSection, type TimelineEntry,
} from '@/client/design';
import {
  accountOf, contactsOf, dealAmount, dealCloseDate, dealEnteredStage, dealStage, dealWeighted,
  num, recordHref, str, useDealProperties, usePipelines, useUserIndex, useUsers, useVelocity,
  type DealRecord, type PipelineStage, type PropertyDef, type StageHistory, type TimelineItem,
} from './api';
import { EditDealDialog, LogActivityDialog, StageMoveDialog } from './dialogs';

const DAY_MS = 86_400_000;

interface DealDetail extends DealRecord {
  timeline?: TimelineItem[];
}

interface BillingCustomer { id: string; name: string; currency: string; crm_record_id: string | null }
interface SubscriptionItem { id: string; description: string | null; quantity: number; amount: number | null; metered: boolean; price: string }
interface Subscription {
  id: string; status: string; currency: string; interval: string; interval_count: number;
  items: SubscriptionItem[]; current_period_end: number;
}

/* ------------------------------- value copy ------------------------------- */

/** Renders a stored property the way a person reads it, never in minor units. */
function useValueRenderer(currency: string) {
  const f = useFormat();
  return (property: PropertyDef, value: unknown): string => {
    if (value === undefined || value === null || value === '') return '—';
    switch (property.type) {
      case 'currency': return f.money(num(value), { currency: (property.currency ?? currency) as never });
      case 'number': return f.number(num(value));
      case 'date': return f.date(num(value));
      case 'datetime': return f.dateTime(num(value));
      case 'bool':
      case 'boolean': return value ? 'Yes' : 'No';
      case 'enum': return property.options.find((option) => option.value === value)?.label ?? humanize(str(value));
      default: return str(value);
    }
  };
}

/* -------------------------------- timeline -------------------------------- */

const timelineTone = (kind: string): TimelineEntry['tone'] => {
  if (kind === 'stage') return 'brand';
  if (kind === 'association') return 'neutral';
  if (kind === 'note') return 'success';
  return 'neutral';
};

/* ================================== page ================================== */

export function DealRecordPage({ id }: { id: string }) {
  const f = useFormat();
  const session = useSession();
  const toast = useToast();
  const { navigate } = useRouter();

  const record = useQuery<DealDetail>(`/v1/records/deal/${encodeURIComponent(id)}`, { expand: 'timeline' });
  const history = useQuery<StageHistory>(`/v1/records/deal/${encodeURIComponent(id)}/stage-history`);
  const pipelines = usePipelines();
  const properties = useDealProperties();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);

  const deal = record.data ?? null;
  const pipeline = useMemo(
    () => (pipelines.data?.data ?? []).find((p) => p.name === str(deal?.properties.pipeline)),
    [pipelines.data, deal],
  );
  const velocity = useVelocity(pipeline?.name);
  const stage = pipeline?.stages.find((s) => s.name === str(deal?.properties.deal_stage));
  const stageVelocity = (velocity.data?.stages ?? []).find((row) => row.stage === stage?.name);

  const account = deal ? accountOf(deal) : undefined;
  const committee = deal ? contactsOf(deal) : [];

  // The contract behind the deal: the account's billing customer, and what it
  // bills today. Absent for a prospect that has never been invoiced, which is
  // why the whole card is conditional rather than showing zeroes.
  const customers = useQuery<ListEnvelope<BillingCustomer>>(
    account ? '/v1/customers' : null,
    account ? { crm_record_id: account.record_id, limit: 1 } : undefined,
  );
  const customer = customers.data?.data[0];
  const subscriptions = useQuery<ListEnvelope<Subscription>>(
    customer ? '/v1/subscriptions' : null,
    customer ? { customer: customer.id, status: 'active_like', expand: 'items', limit: 5 } : undefined,
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [move, setMove] = useState<PipelineStage | null>(null);
  const [archiving, setArchiving] = useState(false);

  const archive = useMutation<void, void>(
    () => api.del(`/v1/records/deal/${encodeURIComponent(id)}`),
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: () => {
        toast.success('Deal archived', 'It is off the board. Restore it from the record list if that was a mistake.');
        navigate('/deals');
      },
      onError: (e) => toast.error('The deal was not archived', e.body.message),
    },
  );

  const renderValue = useValueRenderer(session.currency);
  const props = useMemo(() => properties.data?.data ?? [], [properties.data]);
  const groups = useMemo(() => {
    const order = properties.data?.groups ?? [];
    const map = new Map<string, PropertyDef[]>();
    for (const property of props) {
      const list = map.get(property.group) ?? [];
      list.push(property);
      map.set(property.group, list);
    }
    return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [props, properties.data]);
  const refresh = () => {
    invalidate(`/v1/records/deal/${id}`, '/v1/records/deal', '/v1/pipelines');
    record.refetch();
    history.refetch();
  };

  /* ------------------------------- failure -------------------------------- */

  if (record.error) {
    const error: ApiClientError = record.error;
    return (
      <Page title="Deal" subtitle={id}>
        <Card>
          <ErrorState
            title={error.status === 404 ? 'No such deal' : 'This deal could not be read'}
            message={error.body.message}
            code={`${error.status} /v1/records/deal/${id}`}
            requestId={error.body.request_id ?? null}
            action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={record.refetch}>Try again</Button>}
            secondaryAction={<Button onClick={() => navigate('/deals')}>Back to the board</Button>}
          />
        </Card>
      </Page>
    );
  }

  if (!deal) {
    return (
      <Page title="Deal" subtitle="Loading…">
        <Skeleton height={120} />
        <div style={{ height: 'var(--space-6)' }} />
        <SkeletonText lines={8} />
      </Page>
    );
  }

  /* -------------------------------- content ------------------------------- */

  const amount = dealAmount(deal);
  const close = dealCloseDate(deal);
  const entered = dealEnteredStage(deal);
  const now = session.now();
  const daysInStage = entered ? Math.floor((now - entered) / DAY_MS) : null;
  const daysToClose = close ? Math.round((close - now) / DAY_MS) : null;
  const owner = deal.owner_id ? userIndex.get(deal.owner_id) : undefined;

  const timeline: TimelineEntry[] = (deal.timeline ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    description: item.body ?? undefined,
    time: f.relative(item.at),
    tone: timelineTone(item.kind),
    icon: (() => { const Glyph = iconByName(item.icon); return <Glyph size={12} />; })(),
  }));

  const spells: TimelineEntry[] = (history.data?.data ?? []).map((spell) => ({
    id: `${spell.stage}-${spell.entered_at}`,
    title: spell.stage_label,
    description: `${spell.probability}% · ${spell.is_current ? `${f.plural(spell.days_in_stage, 'day')} and counting` : `${f.plural(spell.days_in_stage, 'day')}`}`,
    time: f.date(spell.entered_at, { withYear: false }),
    tone: spell.is_current ? 'brand' : spell.is_won ? 'success' : 'neutral',
    icon: <GitBranchIcon size={12} />,
  }));

  const actions: MenuSection[] = [
    {
      id: 'move',
      label: 'Move to stage',
      items: (pipeline?.stages ?? [])
        .filter((s) => s.name !== stage?.name)
        .map((s) => ({
          id: s.name,
          label: s.label,
          description: `${s.probability}% · ${f.money(Math.round((amount * s.probability) / 100))} weighted`,
          onSelect: () => setMove(s),
        })),
    },
    {
      id: 'record',
      items: [
        { id: 'log', label: 'Log activity', icon: <Icons.note size={14} />, onSelect: () => setLogging(true) },
        { id: 'edit', label: 'Edit properties', icon: <Icons.edit size={14} />, onSelect: () => setEditing('') },
        {
          id: 'ask',
          label: 'Ask the copilot about this deal',
          icon: <Icons.sparkles size={14} />,
          onSelect: () => navigate(`/copilot?new=1&ask=${encodeURIComponent(`Where does ${deal.display_name} stand right now?`)}`),
        },
        {
          id: 'archive',
          label: 'Archive this deal',
          icon: <Icons.trash size={14} />,
          danger: true,
          onSelect: () => setArchiving(true),
        },
      ],
    },
  ];

  const facts: { label: string; value: string; hint?: string }[] = [
    { label: 'Amount', value: f.money(amount), hint: `${humanize(str(deal.properties.deal_type) || 'deal')}${deal.properties.contract_term_months ? ` · ${f.plural(num(deal.properties.contract_term_months), 'month')} term` : ''}` },
    { label: 'Probability', value: `${num(deal.properties.probability)}%`, hint: stage ? `Set by ${stage.label}` : undefined },
    { label: 'Weighted', value: f.money(dealWeighted(deal)), hint: 'At this stage’s probability' },
    {
      label: 'Forecast',
      value: humanize(str(deal.properties.forecast_category) || '—'),
      hint: `Status ${humanize(str(deal.properties.deal_status) || 'open')}`,
    },
    {
      label: 'Close date',
      value: close ? f.date(close) : 'Not set',
      hint: daysToClose === null ? undefined : daysToClose >= 0 ? `in ${f.plural(daysToClose, 'day')}` : `${f.plural(Math.abs(daysToClose), 'day')} overdue`,
    },
    {
      label: 'In this stage',
      value: daysInStage === null ? '—' : f.plural(daysInStage, 'day'),
      hint: stageVelocity ? `Median here is ${f.plural(stageVelocity.median_days_in_stage, 'day')}` : undefined,
    },
  ];

  const stalled = !!(stageVelocity && daysInStage !== null && stageVelocity.stalled_after_days > 0 && daysInStage > stageVelocity.stalled_after_days);

  return (
    <Page
      width="wide"
      eyebrow={pipeline ? `Deal · ${pipeline.label}` : 'Deal'}
      breadcrumbs={<Breadcrumbs items={[{ label: 'Deals', onClick: () => navigate('/deals') }, { label: deal.display_name }]} />}
      title={deal.display_name}
      badge={stage ? <Badge tone={stage.is_won ? 'success' : stage.is_closed ? 'neutral' : 'info'} size="sm">{stage.label}</Badge> : undefined}
      subtitle={[
        account ? account.display_name : 'No account linked',
        `${f.money(amount)} at ${num(deal.properties.probability)}%`,
        owner ? `Owned by ${owner.name}` : 'Unassigned',
        `Updated ${f.relative(deal.updated)}`,
      ].join(' · ')}
      actions={
        <>
          <Button iconLeft={<Icons.note size={14} />} onClick={() => setLogging(true)}>Log activity</Button>
          <Button iconLeft={<Icons.edit size={14} />} onClick={() => setEditing('')}>Edit</Button>
          <MenuButton sections={actions} label="Deal actions" variant="secondary" icon={<GitBranchIcon size={14} />}>
            Move stage
          </MenuButton>
        </>
      }
    >
      {stalled && stageVelocity && (
        <Banner
          tone="warning"
          title="This deal has stopped moving"
          bar
          actions={<Button size="sm" onClick={() => setLogging(true)}>Log what happened</Button>}
        >
          It has been in {stage?.label} for {f.plural(daysInStage ?? 0, 'day')}. Deals on {pipeline?.label} stall
          after {f.plural(stageVelocity.stalled_after_days, 'day')} — twice this stage’s own median.
        </Banner>
      )}

      {pipeline && (
        <Card title="Stage" description={`Clicking a stage moves the deal and restamps its probability, forecast category and close stamps.`}>
          <div className="pl-rail">
            {pipeline.stages.map((s) => {
              const current = s.name === stage?.name;
              const done = !!stage && s.position < stage.position && !s.is_closed;
              return (
                <button
                  key={s.name}
                  type="button"
                  className={`pl-rail__step${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                  aria-current={current ? 'step' : undefined}
                  onClick={() => (current ? undefined : setMove(s))}
                  disabled={current}
                  title={s.description ?? s.label}
                >
                  <span className="pl-rail__label">{s.label}</span>
                  <span className="pl-rail__sub">{s.probability}% · {f.money(Math.round((amount * s.probability) / 100))}</span>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      <Split
        asideWidth={320}
        gap={6}
        aside={
          <>
            <Card title="Account" description="Who this deal belongs to">
              {account ? (
                <button type="button" className="pl-assoc" onClick={() => navigate(recordHref('company', account.record_id))}>
                  <Avatar name={account.display_name} seed={account.record_id} size={28} square />
                  <span className="pl-assoc__text">
                    <span className="pl-assoc__title u-truncate">{account.display_name}</span>
                    <span className="pl-assoc__sub">{account.label}</span>
                  </span>
                  <ChevronRightIcon size={14} />
                </button>
              ) : (
                <EmptyState
                  size="sm"
                  inline
                  illustration={null}
                  title="No account linked"
                  body="Associate a company so the invoice, the tickets and this deal all agree on who the customer is."
                />
              )}
            </Card>

            <div style={{ height: 'var(--space-6)' }} />

            <Card title="Buying committee" description={`${f.plural(committee.length, 'contact')} on this deal`}>
              {committee.length === 0 && (
                <EmptyState size="sm" inline illustration={null} title="Nobody named yet" body="Add the people who have to say yes." />
              )}
              {committee.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  className="pl-assoc"
                  onClick={() => navigate(recordHref('contact', contact.record_id))}
                >
                  <Avatar name={contact.display_name} seed={contact.record_id} size={26} />
                  <span className="pl-assoc__text">
                    <span className="pl-assoc__title u-truncate">{contact.display_name}</span>
                    <span className="pl-assoc__sub">{contact.label}</span>
                  </span>
                  <ChevronRightIcon size={14} />
                </button>
              ))}
            </Card>

            <div style={{ height: 'var(--space-6)' }} />

            <Card
              title="Stage history"
              description={history.data ? `${f.plural(history.data.total_days, 'day')} in this pipeline` : 'Replayed from the property history'}
            >
              {history.error && (
                <ErrorState
                  title="The stage history did not answer"
                  message={history.error.body.message}
                  code={`${history.error.status} /v1/records/deal/${id}/stage-history`}
                  requestId={history.error.body.request_id ?? null}
                  action={<Button size="sm" variant="primary" onClick={history.refetch}>Try again</Button>}
                />
              )}
              {!history.error && history.loading && <SkeletonText lines={4} />}
              {!history.error && spells.length > 0 && <Timeline entries={spells} />}
              {!history.error && !history.loading && spells.length === 0 && (
                <EmptyState size="sm" inline illustration={null} title="No stage moves recorded" body="The first move writes the first spell." />
              )}
            </Card>

            <div style={{ height: 'var(--space-6)' }} />

            <Card title="Record">
              <DescriptionList
                items={[
                  { term: 'Owner', value: owner ? owner.name : 'Unassigned' },
                  { term: 'Created', value: f.dateTime(deal.created) },
                  { term: 'Last updated', value: f.dateTime(deal.updated) },
                  { term: 'Source', value: humanize(deal.source ?? 'manual') },
                  { term: 'Id', value: <span className="u-mono">{deal.id}</span> },
                ]}
              />
            </Card>
          </>
        }
      >
        <Card title="Forecast" description="Everything the stage decides, and what the clock has done to it">
          <div className="pl-facts">
            {facts.map((fact) => (
              <div className="pl-fact" key={fact.label}>
                <span className="pl-fact__label">{fact.label}</span>
                <span className="pl-fact__value">{fact.value}</span>
                {fact.hint && <span className="pl-fact__hint">{fact.hint}</span>}
              </div>
            ))}
          </div>
        </Card>

        <div style={{ height: 'var(--space-6)' }} />

        {customer && subscriptions.data && subscriptions.data.data.length > 0 && (
          <>
            <Card
              title="What this account bills today"
              description={`${customer.name} · ${f.plural(subscriptions.data.data.length, 'live subscription')}`}
              actions={<Button size="sm" variant="ghost" onClick={() => navigate(`/customers/${customer.id}`)}>Open the account</Button>}
            >
              {subscriptions.data.data.map((subscription) => (
                <div key={subscription.id} style={{ marginBottom: 'var(--space-5)' }}>
                  <div className="pl-propgroup__head">
                    <span className="pl-propgroup__title">
                      {humanize(subscription.status)} · every {subscription.interval_count > 1 ? `${subscription.interval_count} ${subscription.interval}s` : subscription.interval}
                    </span>
                    <span className="pl-note">Renews {f.date(subscription.current_period_end)}</span>
                  </div>
                  <DescriptionList
                    divided
                    items={subscription.items.map<DescriptionItem>((item) => ({
                      key: item.id,
                      term: item.description ?? item.price,
                      value: item.metered
                        ? 'Metered — billed in arrears'
                        : `${f.number(item.quantity)} × ${f.money(Math.round((item.amount ?? 0) / Math.max(1, item.quantity)))} = ${f.money(item.amount ?? 0)}`,
                    }))}
                  />
                </div>
              ))}
            </Card>
            <div style={{ height: 'var(--space-6)' }} />
          </>
        )}

        <Card
          title="Properties"
          description="Every field on this deal, in the workspace's own display order"
          actions={<Button size="sm" variant="secondary" iconLeft={<Icons.edit size={13} />} onClick={() => setEditing('')}>Edit</Button>}
        >
          {properties.error && (
            <ErrorState
              title="The property list did not answer"
              message={properties.error.body.message}
              code={`${properties.error.status} /v1/objects/deal/properties`}
              requestId={properties.error.body.request_id ?? null}
              action={<Button size="sm" variant="primary" onClick={properties.refetch}>Try again</Button>}
            />
          )}
          {!properties.error && properties.loading && <SkeletonText lines={10} />}
          <div className="pl-proplist">
            {groups.map(([group, rows]) => (
              <section key={group}>
                <div className="pl-propgroup__head">
                  <span className="pl-propgroup__title">{group}</span>
                  {rows.some((property) => !property.read_only && !property.calculated) && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(group)}>Edit {group.toLowerCase()}</Button>
                  )}
                </div>
                <DescriptionList
                  divided
                  items={rows.map<DescriptionItem>((property) => ({
                    key: property.name,
                    term: property.label,
                    value: renderValue(property, deal.properties[property.name]),
                    hint: property.read_only || property.calculated
                      ? <Badge size="sm" tone="neutral">derived</Badge>
                      : undefined,
                  }))}
                />
              </section>
            ))}
          </div>
        </Card>

        <div style={{ height: 'var(--space-6)' }} />

        <Card
          title="Timeline"
          description="Calls, notes, emails, stage moves and links, newest first"
          actions={<Button size="sm" variant="secondary" iconLeft={<Icons.plus size={13} />} onClick={() => setLogging(true)}>Log activity</Button>}
        >
          {timeline.length === 0 && (
            <EmptyState
              size="sm"
              inline
              illustration={null}
              title="Nothing logged on this deal yet"
              body="Notes, calls and meetings you log here show up on the account and in the copilot's answers."
              action={<Button size="sm" variant="primary" onClick={() => setLogging(true)}>Log the first activity</Button>}
            />
          )}
          {timeline.length > 0 && <Timeline entries={timeline} />}
        </Card>
      </Split>

      <StageMoveDialog
        open={!!move}
        deal={deal}
        from={stage}
        to={move}
        properties={props}
        onClose={() => setMove(null)}
        onMoved={refresh}
      />
      <EditDealDialog
        open={editing !== null}
        deal={deal}
        properties={props}
        pipelines={pipelines.data?.data ?? []}
        users={users.data?.data ?? []}
        focusGroup={editing || null}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <LogActivityDialog
        open={logging}
        deal={deal}
        onClose={() => setLogging(false)}
        onLogged={refresh}
      />
      <ConfirmDialog
        open={archiving}
        onCancel={() => setArchiving(false)}
        onConfirm={() => archive.run().catch(() => undefined)}
        loading={archive.loading}
        title="Archive this deal?"
        body={`${deal.display_name} leaves the board and stops counting towards the forecast. Nothing is deleted — it can be restored.`}
        confirmLabel="Archive deal"
      />
    </Page>
  );
}

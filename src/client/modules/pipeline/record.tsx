/**
 * One deal.
 *
 * The record-page shape — properties, timeline, associations — plus the two
 * things a deal has that a contact does not: a forecast that is derived from
 * the stage it sits in, and the contract its account is actually billed on.
 * The stage rail at the top is the primary control: clicking a stage is the
 * same move the board makes, with the same confirmation.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, invalidate, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import {
  Avatar, Badge, Banner, Breadcrumbs, Button, Card, ChevronLeftIcon, ChevronRightIcon, ConfirmDialog,
  DescriptionList, EmptyState, ErrorState, GitBranchIcon, humanize, iconByName, IconButton, Icons,
  MenuButton, Page, Skeleton, SkeletonText, Split, Timeline, useToast,
  type DescriptionItem, type MenuSection, type TimelineEntry,
} from '@/client/design';
import {
  accountOf, contactsOf, dealAmount, dealCloseDate, dealEnteredStage, dealStage, dealWeighted,
  num, recordHref, str, useDealFormat, useDealProperties, usePipelines, useUserIndex, useUsers,
  useVelocity,
  type CalendarFormat, type DealRecord, type PipelineStage, type PropertyDef, type StageHistory,
  type TimelineItem,
} from './api';
import { EditDealDialog, LogActivityDialog, PipelineMoveDialog, StageMoveDialog } from './dialogs';
import { AccountCard, CommitteeCard } from './associations';
import { InlineProperty } from './inline';
import { DraftDialog } from '../copilot/draft';

/**
 * The stage rail's scroller, with an edge that says there is more.
 *
 * Eight stages do not fit a 1100px record page, and `overflow-x: auto` on its
 * own is invisible on any platform with overlay scrollbars: the last stage was
 * simply sliced off at the card's edge with nothing to suggest it existed. The
 * fade and the nudge button appear only on the side that actually has more, and
 * are out of the Tab order because tabbing a stage already scrolls it into view.
 */
function StageRail({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setEdges({
      left: el.scrollLeft > 2,
      right: Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 2,
    });
    read();
    el.addEventListener('scroll', read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => { el.removeEventListener('scroll', read); observer.disconnect(); };
  }, [children]);

  const nudge = (direction: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.7), behavior: 'smooth' });
  };

  return (
    <div className={`pl-railwrap${edges.left ? ' has-left' : ''}${edges.right ? ' has-right' : ''}`}>
      <div className="pl-rail" ref={scroller}>{children}</div>
      {edges.left && (
        <IconButton
          className="pl-rail__nudge pl-rail__nudge--left"
          size="sm"
          tabIndex={-1}
          label="Earlier stages"
          icon={<ChevronLeftIcon size={14} />}
          onClick={() => nudge(-1)}
        />
      )}
      {edges.right && (
        <IconButton
          className="pl-rail__nudge pl-rail__nudge--right"
          size="sm"
          tabIndex={-1}
          label="Later stages"
          icon={<ChevronRightIcon size={14} />}
          onClick={() => nudge(1)}
        />
      )}
    </div>
  );
}

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
function useValueRenderer(currency: string, f: CalendarFormat) {
  return (property: PropertyDef, value: unknown): string => {
    if (value === undefined || value === null || value === '') return '—';
    switch (property.type) {
      case 'currency': return f.money(num(value), { currency: (property.currency ?? currency) as never });
      case 'number': return f.number(num(value));
      // A `date` is a day the workspace picked, not an instant, so it is read
      // back in the day it was stored as rather than shifted into a timezone.
      case 'date': return f.calendarDate(num(value));
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
  const f = useDealFormat();
  const session = useSession();
  const toast = useToast();
  const { navigate, location, setQuery } = useRouter();

  const record = useQuery<DealDetail>(`/v1/records/deal/${encodeURIComponent(id)}`, { expand: 'timeline' });
  const history = useQuery<StageHistory>(`/v1/records/deal/${encodeURIComponent(id)}/stage-history`);
  const pipelines = usePipelines();
  const properties = useDealProperties();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);

  // A write here invalidates `/v1/records/deal`, and `invalidate` matches by
  // prefix — so the detail key goes with the list key and `record.data` is
  // briefly undefined. Falling back to the skeleton on that would unmount this
  // whole subtree mid-interaction: the dialog that just saved would vanish, and
  // every save would flash the page. The last deal read stays on screen while
  // the next one is in flight. The route keys this component on the id, so a
  // different deal remounts rather than inheriting the one before it.
  const lastRead = useRef<DealDetail | null>(null);
  if (record.data) lastRead.current = record.data;
  const deal = record.data ?? lastRead.current;
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
  /**
   * `?edit=Deal information` opens the edit form on that property group, and
   * `?edit=1` opens the whole of it.
   *
   * It exists so a dead end elsewhere can hand over to the screen that works.
   * The copilot cannot set a deal's amount or its owner — its write extractor
   * reads a stage and nothing else — and until now the only thing it could say
   * about that was "name the property and the value", which is advice the
   * reader has already followed. This is the link it offers instead, and it
   * lands with the field on screen rather than on a page to hunt through.
   */
  useEffect(() => {
    const asked = location.query.edit;
    if (!asked) return;
    setEditing(asked === '1' ? '' : asked);
    setQuery({ edit: undefined }, { replace: true });
  }, [location.query.edit, setQuery]);
  const [logging, setLogging] = useState(false);
  const [move, setMove] = useState<PipelineStage | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [repiping, setRepiping] = useState(false);

  const restore = useMutation<void, DealRecord>(
    () => api.post<DealRecord>(`/v1/records/deal/${encodeURIComponent(id)}/restore`),
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: (deal) => {
        toast.success('Deal restored', `${deal.display_name} is back on the board and counting towards the forecast.`);
        navigate(recordHref('deal', id));
      },
      onError: (e) => toast.error('The deal was not restored', e.body.message),
    },
  );

  // Archiving is reversible and the route leaves this page, so the way back has
  // to travel with the notification rather than live on the screen being left.
  const archive = useMutation<void, void>(
    () => api.del(`/v1/records/deal/${encodeURIComponent(id)}`),
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: () => {
        toast.success('Deal archived', 'It is off the board and out of the forecast.', {
          action: { label: 'Undo', onClick: () => { void restore.run().catch(() => undefined); } },
        });
        navigate('/deals');
      },
      onError: (e) => toast.error('The deal was not archived', e.body.message),
    },
  );

  const renderValue = useValueRenderer(session.currency, f);
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

  /**
   * Send the person to the control that actually moves a deal.
   *
   * The stage and the pipeline are the two properties this page will not edit
   * in place, because writing them restamps the probability, the forecast
   * category and the close stamps. The rail at the top is where that move is
   * made, with its confirmation — so the property row points at it rather than
   * opening a dialog for a stage nobody chose.
   */
  const focusStageRail = () => {
    const rail = document.querySelector<HTMLElement>('.pl-rail');
    rail?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    rail?.querySelector<HTMLButtonElement>('.pl-rail__step:not([aria-disabled])')?.focus();
  };

  /**
   * Put the keyboard back on the stage it was moved to.
   *
   * `Modal` restores focus to whatever opened it, but a move invalidates
   * `/v1/records/deal/:id`, which empties the cache, which renders this page as
   * a skeleton — so the rail the dialog would restore to is detached by the
   * time it tries, and the caret lands on `<body>`, 31 Tab stops from the deal.
   * Moving deals one after another is the most repeated thing on this screen,
   * so the rail is re-found once the record has come back with its new stage.
   */
  const landedOn = useRef<string | null>(null);
  /** Open the confirmation, remembering where the keyboard should come back to. */
  const requestMove = (to: PipelineStage) => { landedOn.current = to.name; setMove(to); };
  const currentStage = deal ? dealStage(deal) : null;
  useEffect(() => {
    const wanted = landedOn.current;
    if (!wanted || wanted !== currentStage) return;
    landedOn.current = null;
    // The move invalidates `/v1/pipelines` as well as the record, so the rail
    // is briefly gone from the DOM entirely — and a single frame of waiting
    // lands on whichever side of that gap the two refetches happen to fall.
    // The caret is put back for as long as the reload takes, and only ever when
    // it has been lost: a person who clicked elsewhere keeps their focus.
    const until = Date.now() + 1400;
    let timer = 0;
    let cancelled = false;
    const land = () => {
      if (cancelled) return;
      const lost = !document.activeElement || document.activeElement === document.body;
      const step = document.querySelector<HTMLElement>(`.pl-rail__step[data-stage="${wanted.replace(/["\\]/g, '')}"]`);
      if (lost && step) { step.focus(); return; }
      if (Date.now() < until) timer = window.setTimeout(land, 60);
    };
    timer = window.setTimeout(land, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [currentStage]);

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
          onSelect: () => requestMove(s),
        })),
    },
    {
      id: 'record',
      items: [
        {
          id: 'pipeline',
          label: 'Move to another pipeline',
          icon: <GitBranchIcon size={14} />,
          onSelect: () => setRepiping(true),
        },
        { id: 'log', label: 'Log activity', icon: <Icons.note size={14} />, onSelect: () => setLogging(true) },
        {
          id: 'draft',
          label: 'Draft a follow-up',
          icon: <Icons.edit size={14} />,
          onSelect: () => setDrafting(true),
        },
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
      value: close ? f.calendarDate(close) : 'Not set',
      hint: close === null
        ? undefined
        : stage?.is_closed
          ? `Booked ${f.calendarRelative(close)}`
          : f.calendarDaysUntil(close) < 0
            ? `${f.plural(-f.calendarDaysUntil(close), 'day')} overdue`
            : f.calendarRelative(close),
    },
    {
      label: 'In this stage',
      value: daysInStage === null ? '—' : f.plural(daysInStage, 'day'),
      // A closed stage has no median because deals do not wait in one; saying
      // that is more useful than an em dash where a number belongs.
      hint: !stageVelocity
        ? undefined
        : stage?.is_closed
          ? 'Deals do not wait here'
          : stageVelocity.median_days_in_stage > 0
            ? `Median here is ${f.plural(stageVelocity.median_days_in_stage, 'day')}`
            : 'Nothing has sat here long enough to have a median',
    },
  ];

  // Same rule as the board: a closed stage has no stall threshold, because a
  // deal that has closed is finished rather than stuck.
  const stalled = !!(
    stageVelocity && !stage?.is_closed && daysInStage !== null
    && stageVelocity.stalled_after_days > 0 && daysInStage > stageVelocity.stalled_after_days
  );

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
      {deal.archived && (
        <Banner
          tone="neutral"
          title="This deal is archived"
          bar
          actions={
            <Button size="sm" variant="primary" loading={restore.loading} onClick={() => { void restore.run().catch(() => undefined); }}>
              Restore it
            </Button>
          }
        >
          It is off the board and out of the forecast. Nothing has been deleted — restoring puts it back
          in {stage?.label ?? 'its stage'} at {num(deal.properties.probability)}%.
        </Banner>
      )}

      {!deal.archived && stalled && stageVelocity && (
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
          <StageRail>
            {pipeline.stages.map((s) => {
              const current = s.name === stage?.name;
              const done = !!stage && s.position < stage.position && !s.is_closed;
              return (
                <button
                  key={s.name}
                  type="button"
                  data-stage={s.name}
                  className={`pl-rail__step${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                  aria-current={current ? 'step' : undefined}
                  // The stage the deal is in is not a control, but it must stay
                  // in the Tab order: `disabled` takes it out, and the browser
                  // drops focus the moment a move makes the step the caret is
                  // on the current one — which is how the keyboard ended up on
                  // `<body>` after every stage move made from this rail.
                  aria-disabled={current || undefined}
                  onClick={() => (current ? undefined : requestMove(s))}
                  title={current ? `${s.label} — the stage this deal is in` : (s.description ?? s.label)}
                >
                  <span className="pl-rail__label">{s.label}</span>
                  <span className="pl-rail__sub">{s.probability}% · {f.money(Math.round((amount * s.probability) / 100))}</span>
                </button>
              );
            })}
          </StageRail>
        </Card>
      )}

      <Split
        asideWidth={320}
        gap={6}
        aside={
          <>
            <AccountCard deal={deal} account={account} onChanged={refresh} />

            <div style={{ height: 'var(--space-6)' }} />

            <CommitteeCard deal={deal} contacts={committee} onChanged={refresh} />

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
          description="Every field on this deal, in the workspace’s own display order. Click a value to change it."
          actions={<Button size="sm" variant="secondary" iconLeft={<Icons.edit size={13} />} onClick={() => setEditing('')}>Edit them all</Button>}
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
                    value: (
                      <InlineProperty
                        deal={deal}
                        property={property}
                        currency={session.currency}
                        display={renderValue(property, deal.properties[property.name])}
                        onSaved={refresh}
                        onMoveStage={focusStageRail}
                        onMovePipeline={() => setRepiping(true)}
                      />
                    ),
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
      <PipelineMoveDialog
        open={repiping}
        deal={deal}
        pipelines={pipelines.data?.data ?? []}
        properties={props}
        onClose={() => setRepiping(false)}
        onMoved={refresh}
      />
      <LogActivityDialog
        open={logging}
        deal={deal}
        onClose={() => setLogging(false)}
        onLogged={refresh}
      />
      <DraftDialog
        open={drafting}
        subject={{ id: deal.id, objectType: 'deal', name: deal.display_name }}
        onClose={() => setDrafting(false)}
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

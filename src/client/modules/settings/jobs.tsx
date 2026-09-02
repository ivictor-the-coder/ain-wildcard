/**
 * The durable job queue.
 *
 * Nothing in this platform sleeps on a timer. Deferred work — a renewal, a
 * dunning retry, a credit expiry, a scheduled agent run — is a row in `jobs`
 * with a `run_at`, which is what makes `POST /v1/time/advance` able to replay a
 * year of billing in one second and get the same answers. This screen is where
 * that stops being an architectural claim and becomes something you can look
 * at: every piece of future work the workspace has promised itself, with the
 * instant it comes due, how many attempts it has had and, when one has broken,
 * the error the handler threw.
 *
 * The drain control runs everything already *due*. Work scheduled for next
 * month stays scheduled — moving the clock is what reaches that, and the button
 * says so rather than quietly doing nothing.
 */
import { useMemo, useState } from 'react';
import { api, invalidate, useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useNavigate, useSearchParam } from '../../kernel/router';
import { useSession } from '../../kernel/session';
import {
  Badge, Banner, Button, Card, ConfirmDialog, DataTable, Drawer, EmptyState, Icons, Inline, KeyValue,
  Stat, Stack, Tabs, Tooltip,
  useFormat, useToast,
  type DataTableColumn, type TabDef,
} from '../../design';
import { JsonBlock, ListFailure, SettingsShell } from './common';
import type { JobDrainResult, JobRow, JobStatus } from './types';

/** The most the route serves in one read. Named so no count ever overstates. */
const PAGE = 200;

const STATUSES: JobStatus[] = ['pending', 'running', 'failed', 'done', 'cancelled'];

const STATUS_TONE: Record<JobStatus, 'info' | 'warning' | 'danger' | 'success' | 'neutral'> = {
  pending: 'info', running: 'warning', failed: 'danger', done: 'success', cancelled: 'neutral',
};

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Pending', running: 'Running', failed: 'Failed', done: 'Done', cancelled: 'Cancelled',
};

export function JobsPage() {
  const f = useFormat();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  /**
   * Which tab is open is in the address, so "Jobs that failed" in the palette
   * lands on the failed queue rather than on the pending one, and a link to a
   * broken queue is a link somebody else can open.
   */
  const [tabParam, setTabParam] = useSearchParam('status', 'pending');
  const tab = (STATUSES as string[]).includes(tabParam) ? (tabParam as JobStatus) : 'pending';
  const setTab = (next: JobStatus) => setTabParam(next === 'pending' ? undefined : next);
  const [open, setOpen] = useState<JobRow | null>(null);
  const [draining, setDraining] = useState(false);
  const [busy, setBusy] = useState(false);

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';

  // One read per status: the route pages by status, and a single unfiltered
  // read of 200 rows would report "how many failed" as "how many failed inside
  // the most recent 200", which is the number an operator would act on.
  const pending = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'pending', limit: PAGE });
  const running = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'running', limit: PAGE });
  const failed = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'failed', limit: PAGE });
  const done = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'done', limit: PAGE });
  const cancelled = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'cancelled', limit: PAGE });

  const byStatus: Record<JobStatus, typeof pending> = { pending, running, failed, done, cancelled };
  const current = byStatus[tab];
  const rows = current.data?.data ?? [];

  /** The workspace's exact pending count — every page carries it. */
  const pendingTotal = pending.data?.total_count ?? pending.data?.data.length ?? 0;
  const now = session.now();
  const dueNow = (pending.data?.data ?? []).filter((job) => job.run_at <= now);
  const nextRunAt = useMemo(() => {
    const upcoming = (pending.data?.data ?? []).filter((job) => job.run_at > now).map((job) => job.run_at);
    return upcoming.length ? Math.min(...upcoming) : null;
  }, [pending.data, now]);

  const count = (result: typeof pending): string => {
    const n = result.data?.data.length ?? 0;
    return n === PAGE ? `${PAGE}+` : f.number(n);
  };

  const tabs: TabDef<JobStatus>[] = STATUSES.map((status) => ({
    id: status,
    label: STATUS_LABEL[status],
    count: status === 'pending' ? pendingTotal : (byStatus[status].data?.data.length ?? 0),
  }));

  const columns = useMemo<DataTableColumn<JobRow>[]>(() => [
    {
      id: 'type',
      header: 'Work',
      pinned: true,
      width: 260,
      filter: 'set',
      accessor: (row) => row.type,
      cell: (row) => (
        <span style={{ display: 'block', minWidth: 0 }}>
          <span className="st-mono" style={{ display: 'block', color: 'var(--text-primary)' }}>{row.type}</span>
          {row.idem_key && <span className="st-sub u-truncate" style={{ display: 'block' }}>{row.idem_key}</span>}
        </span>
      ),
    },
    {
      id: 'run_at',
      header: 'Runs at',
      width: 200,
      accessor: (row) => row.run_at,
      cell: (row) => (
        <Tooltip content={f.dateTime(row.run_at)}>
          <span className="u-num">
            {f.when(row.run_at)}
            {row.status === 'pending' && row.run_at <= now ? <span style={{ color: 'var(--text-warning)' }}> · due</span> : null}
          </span>
        </Tooltip>
      ),
    },
    {
      id: 'attempts',
      header: 'Attempts',
      align: 'right',
      width: 120,
      accessor: (row) => row.attempts,
      cell: (row) => (
        <span className="u-num">
          {f.number(row.attempts)}
          <span className="st-sub"> / {f.number(row.max_attempts)}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 130,
      accessor: (row) => row.status,
      cell: (row) => <Badge tone={STATUS_TONE[row.status]} pill dot>{STATUS_LABEL[row.status]}</Badge>,
    },
    {
      id: 'last_error',
      header: 'Last error',
      accessor: (row) => row.last_error ?? '',
      cell: (row) => (row.last_error
        ? <Tooltip content={row.last_error}><span className="u-truncate" style={{ display: 'block', color: 'var(--text-danger)' }}>{row.last_error}</span></Tooltip>
        : <span className="st-sub">—</span>),
    },
    {
      id: 'updated',
      header: 'Updated',
      align: 'right',
      width: 150,
      accessor: (row) => row.updated,
      cell: (row) => f.when(row.updated),
      defaultHidden: true,
    },
  ], [f, now]);

  /**
   * The counts only exist once the server has answered, and they are the whole
   * point of pressing the button — so the report is built from the response
   * rather than from a hopeful sentence written before the call.
   */
  const drain = async () => {
    setDraining(false);
    setBusy(true);
    try {
      const result = await api.post<JobDrainResult>('/v1/jobs/drain');
      invalidate('/v1/jobs', '/v1/events', '/v1/health', '/v1/audit-log');
      const ran = `${f.plural(result.ran, 'job')} ran`;
      const still = `${f.plural(result.pending, 'job')} still waiting on a future run_at.`;
      if (result.failed) toast.warning(`${ran}, ${f.plural(result.failed, 'job')} failed`, still);
      else if (result.ran) toast.success(ran, still);
      else toast.info('Nothing was due', still);
    } catch (e) {
      const err = e as ApiClientError;
      toast.error('The queue was not drained', err?.body?.message ?? 'The server refused the request.', { duration: 0 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsShell
      title="Jobs"
      subtitle="Every piece of deferred work this workspace has promised itself, and when it comes due."
      actions={
        <Inline gap={3}>
          <Button
            variant="secondary"
            iconLeft={<Icons.refresh size={15} />}
            loading={current.validating}
            onClick={() => { pending.refetch(); running.refetch(); failed.refetch(); done.refetch(); cancelled.refetch(); }}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            iconLeft={<Icons.play size={15} />}
            disabled={!admin || dueNow.length === 0}
            loading={busy}
            onClick={() => setDraining(true)}
          >
            {dueNow.length ? `Run ${f.plural(dueNow.length, 'due job')}` : 'Nothing is due'}
          </Button>
        </Inline>
      }
    >
      <Stack gap={6}>
        {current.error && <ListFailure error={current.error} path={`GET /v1/jobs?status=${tab}`} onRetry={current.refetch} />}

        <div className="st-tiles">
          <Card padding="tight">
            <Stat
              label="Waiting"
              value={f.number(pendingTotal)}
              caption={nextRunAt !== null ? `Next runs ${f.when(nextRunAt)}` : 'Nothing scheduled ahead'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Due right now"
              value={f.number(dueNow.length)}
              caption={dueNow.length
                ? 'Their run_at has passed — draining runs them'
                : 'Everything waiting is scheduled for later'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Failed"
              value={count(failed)}
              caption={(failed.data?.data.length ?? 0) > 0
                ? 'Out of attempts — the error is on the row'
                : 'No handler has run out of attempts'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Completed"
              value={count(done)}
              caption="Kept, so a replay can be checked against what actually ran"
            />
          </Card>
        </div>

        {(failed.data?.data.length ?? 0) > 0 && (
          <Banner
            tone="danger"
            title={`${f.plural(failed.data?.data.length ?? 0, 'job')} exhausted every attempt`}
            actions={<Button size="sm" variant="secondary" onClick={() => setTab('failed')}>Show them</Button>}
          >
            {'A failed job has been retried up to its max_attempts and stopped. Whatever it was going to do — bill an '
              + 'account, settle a period, retry a payment — has not happened.'}
          </Banner>
        )}

        <Card
          padding="none"
          title="The queue"
          description="Ordered by run_at, furthest ahead first — the way the queue itself is read."
        >
          <div style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
            <Tabs tabs={tabs} value={tab} onChange={setTab} aria-label="Job status" />
          </div>
          <DataTable
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            caption={`${STATUS_LABEL[tab]} jobs`}
            loading={current.loading}
            searchable
            searchPlaceholder="Search by handler, idempotency key or error"
            showFilters
            showColumnToggle
            initialSort={{ columnId: 'run_at', direction: tab === 'pending' ? 'asc' : 'desc' }}
            onRowClick={setOpen}
            maxHeight={560}
            empty={
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.layers size={22} />}
                title={emptyTitle(tab)}
                body={emptyBody(tab)}
                action={tab === 'pending'
                  ? <Button size="sm" variant="secondary" onClick={() => navigate('/settings/time')}>Open the time machine</Button>
                  : undefined}
              />
            }
          />
        </Card>

        <Card title="Why this is a table and not a cron" padding="tight">
          <div className="st-rows">
            <div className="st-row">
              <div className="st-row__main">
                <div className="st-row__title">Every deferral is a row</div>
                <div className="st-row__sub">
                  <code className="st-mono">ctx.enqueue()</code>
                  {' writes a job with a '}
                  <code className="st-mono">run_at</code>
                  {'. No handler in the platform calls setTimeout, so there is no work in flight that a restart '
                    + 'could lose and none that a clock jump could skip.'}
                </div>
              </div>
            </div>
            <div className="st-row">
              <div className="st-row__main">
                <div className="st-row__title">Draining runs what is due</div>
                <div className="st-row__sub">
                  {'A job whose run_at is in the future stays where it is. Reaching that work means moving the '
                    + 'workspace clock, which runs each job at its own run_at rather than all of them at the far end.'}
                </div>
              </div>
            </div>
            <div className="st-row">
              <div className="st-row__main">
                <div className="st-row__title">Idempotency keys stop double work</div>
                <div className="st-row__sub">
                  {'A job carrying an idem_key can only be enqueued once for that key, which is what lets a renewal be '
                    + 'scheduled defensively without ever billing twice.'}
                </div>
              </div>
            </div>
          </div>
        </Card>
      </Stack>

      <ConfirmDialog
        open={draining}
        onCancel={() => setDraining(false)}
        onConfirm={drain}
        tone="brand"
        title={`Run ${f.plural(dueNow.length, 'job')} now?`}
        confirmLabel="Run them"
        cancelLabel="Not now"
        loading={busy}
        body={
          `Every job whose run_at has already passed is executed for real — invoices are raised, payments are `
          + `attempted, entitlements move. ${nextRunAt !== null
            ? `Work scheduled for ${f.dateTime(nextRunAt)} and later is untouched.`
            : 'Nothing is scheduled beyond what is due.'}`
        }
      />

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        size="md"
        title={open?.type ?? ''}
        description={open ? `${STATUS_LABEL[open.status]} · scheduled for ${f.dateTime(open.run_at)}` : undefined}
      >
        {open && (
          <Stack gap={6}>
            <Card padding="tight" title="The row">
              <Stack gap={3}>
                <KeyValue label="Job id" value={<span className="st-mono">{open.id}</span>} />
                <KeyValue label="Handler" value={<span className="st-mono">{open.type}</span>} />
                <KeyValue label="Status" value={<Badge tone={STATUS_TONE[open.status]} pill dot>{STATUS_LABEL[open.status]}</Badge>} />
                <KeyValue label="Runs at" value={f.dateTime(open.run_at)} />
                <KeyValue label="Attempts" value={`${f.number(open.attempts)} of ${f.number(open.max_attempts)}`} />
                <KeyValue label="Enqueued" value={f.dateTime(open.created)} />
                <KeyValue label="Last touched" value={f.dateTime(open.updated)} />
                <KeyValue
                  label="Idempotency key"
                  value={open.idem_key
                    ? <span className="st-mono">{open.idem_key}</span>
                    : <span className="st-sub">None — this job may be enqueued again.</span>}
                />
              </Stack>
            </Card>

            {open.last_error && (
              <Banner tone="danger" title="The handler threw">
                <span className="st-mono">{open.last_error}</span>
              </Banner>
            )}

            {open.status === 'failed' && (
              <Banner tone="warning" compact title="What can be done with it">
                {'This row is out of attempts and the queue will not pick it up again: the drain claims '}
                <code className="st-mono">status = &apos;pending&apos;</code>
                {' rows whose run_at has passed, and nothing else. The API serves no per-job retry, so the work is '
                  + 'redone by repeating the action that enqueued it — the payload below is exactly what the handler '
                  + 'was given, and the id and idempotency key are what to quote when reporting it.'}
              </Banner>
            )}

            <JsonBlock label="payload — what the handler is given" value={open.payload} maxHeight={320} />
          </Stack>
        )}
      </Drawer>
    </SettingsShell>
  );
}

const emptyTitle = (status: JobStatus): string => ({
  pending: 'Nothing is waiting',
  running: 'Nothing is running',
  failed: 'Nothing has failed',
  done: 'Nothing has completed yet',
  cancelled: 'Nothing has been cancelled',
}[status]);

const emptyBody = (status: JobStatus): string => ({
  pending: 'No renewal, retry, expiry or scheduled run is booked. Moving the workspace clock forward is what creates the next round of them.',
  running: 'Jobs only hold this state while a handler is executing, which in this platform is milliseconds.',
  failed: 'Every handler that has run either succeeded or still has attempts left.',
  done: 'A job moves here the moment its handler returns. Draining the queue or advancing the clock fills this list.',
  cancelled: 'A job is cancelled when the thing it was going to act on no longer exists — a subscription ended before its renewal came due.',
}[status]);

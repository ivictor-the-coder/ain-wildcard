/**
 * The time machine, as a screen rather than a hidden API.
 *
 * Stripe puts test clocks behind `POST /v1/test_helpers/test_clocks/:id/advance`
 * and nowhere else, so the only way to watch a year of billing happen is to
 * write a script. Here it is a control: the workspace clock, how far it has been
 * pushed from real time, four jumps and a date picker — and, underneath, the
 * durable record of every move anyone has made and the work each one executed.
 *
 * That record is the part worth building carefully. `POST /v1/time/advance`
 * steps the clock to each due batch and drains it there, so a renewal that came
 * due on day one is priced and dated on day one rather than at the far end of
 * the jump. Every job it ran therefore carries its own workspace instant in
 * `updated`, and every move writes an audit entry with `before.now` and
 * `after.now`. But the audit entry does not carry the count the response did,
 * and two windows can hold the same job once the clock has been returned to
 * real time and jumped again — so the count on each move comes from `moves.ts`,
 * which credits a job to one move only and prefers the number the server
 * actually answered whenever this browser was the one that asked.
 */
import { useCallback, useMemo, useState } from 'react';
import { ApiClientError, invalidate, request, useQuery, type ListEnvelope } from '../../kernel/api';
import { useSession } from '../../kernel/session';
import { TIME_JUMPS, civilDayStart, clockOutcome, describeOffset, jumpDays, jumpTarget, type ClockAftermath } from '../../kernel/shell-core';
import {
  Badge, Banner, Button, Card, ConfirmDialog, DatePicker, Divider, EmptyState, Icons, Inline,
  KeyValue, Stat, Stack, Tooltip,
  useFormat, useToast,
  ChevronDownIcon, ChevronUpIcon, RotateCcwIcon,
} from '../../design';
import { DAY } from '../../../shared/time';
import { ListFailure, Loading, SettingsShell, useActorName } from './common';
import {
  attributeJobs, covers, dueBy, readRecordedMoves, recordMove, recordedFor, tallyMove,
  type MoveTally, type RecordedMove,
} from './moves';
import { tileOf } from './tiles';
import type { AuditEntry, ClockResult, JobRow } from './types';

const PAGE = 200;

interface Move {
  id: string;
  at: number;
  from: number;
  to: number;
  actor: string;
  requestId: string | null;
  tally: MoveTally;
  /** Completed jobs this window alone holds. */
  own: JobRow[];
  /** Completed jobs this window holds together with another move's. */
  shared: JobRow[];
  failed: JobRow[];
}

/** What one clock move did, from the server's answer and the read-back after it. */
interface ClockMoveResult {
  now: number;
  previous: number | null;
  jobsRun: number;
  jobsFailed: number;
  aftermath: ClockAftermath | null;
}

/** `{ now: 123 }` off an audit payload, or null when the row shaped differently. */
const instant = (value: unknown): number | null => {
  if (typeof value !== 'object' || value === null) return null;
  const now = (value as { now?: unknown }).now;
  return typeof now === 'number' && Number.isFinite(now) ? now : null;
};

/** "Nothing is due" → "nothing is due", for the middle of a sentence. */
const quiet = (text: string): string => (text ? text[0].toLowerCase() + text.slice(1) : text);

const storage = (): Storage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

/**
 * A clock move, then a read-back, then the answer kept.
 *
 * The kernel's own hook does the first two, but hands back neither `previous`
 * nor the request's answer in a form the history can find again — and
 * `previous` is the one instant the audit entry stores verbatim (`before.now`),
 * which is what lets the count the server gave be pinned to the row the trail
 * later shows for it.
 */
function useClockMoves(orgId: string | null, onSettled: () => void) {
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<RecordedMove[]>(() => (orgId ? readRecordedMoves(storage(), orgId) : []));

  const move = useCallback(async (path: string, body?: unknown): Promise<ClockMoveResult> => {
    setBusy(true);
    try {
      const result = await request<Partial<ClockResult>>(path, { method: 'POST', body });
      let aftermath: ClockAftermath | null = null;
      try {
        await request('/v1/me');
      } catch (e) {
        const err = e instanceof ApiClientError ? e : null;
        aftermath = {
          status: err?.status ?? 0,
          message: err?.body.message ?? (e instanceof Error ? e.message : 'The workspace could not be read back.'),
          requestId: err?.body.request_id ?? null,
        };
      }
      const outcome: ClockMoveResult = {
        now: result.now ?? Date.now(),
        previous: typeof result.previous === 'number' ? result.previous : null,
        jobsRun: result.jobs_run ?? 0,
        jobsFailed: result.jobs_failed ?? 0,
        aftermath,
      };
      if (orgId && outcome.previous !== null && path.endsWith('/advance')) {
        setRecords(recordMove(storage(), orgId, {
          from: outcome.previous, to: outcome.now, jobsRun: outcome.jobsRun, jobsFailed: outcome.jobsFailed, recordedAt: Date.now(),
        }));
      }
      onSettled();
      return outcome;
    } finally { setBusy(false); }
  }, [orgId, onSettled]);

  const advance = useCallback((body: { to: number }) => move('/v1/time/advance', body), [move]);
  const reset = useCallback(() => move('/v1/time/reset'), [move]);
  return { advance, reset, busy, records };
}

export function TimeMachinePage() {
  const session = useSession();
  const f = useFormat();
  const toast = useToast();
  const actorName = useActorName();
  /**
   * `null` means "nothing picked yet", and it is never handed to the picker.
   *
   * The calendar puts its roving tabindex on the day it opens with, and every
   * day before tomorrow is disabled here — so opening with no value put the
   * only tabbable cell on a disabled button, focus stayed on the trigger, and
   * the arrow keys the grid implements were delivered to nothing. Opening on
   * the first day that can actually be chosen is what makes the whole grid
   * reachable without a mouse.
   */
  const [chosen, setChosen] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';
  const clock = session.me?.clock;
  const virtual = clock?.kind === 'virtual';
  const offset = clock?.offset_ms ?? 0;
  const now = session.now();
  const shifted = Math.abs(offset) > 60_000;

  // Tomorrow on the workspace's own calendar — the first day the picker offers,
  // and the day it opens on so its grid is reachable from the keyboard. The
  // picker speaks in UTC calendar days; the jump itself lands on that day at
  // the wall-clock time the workspace is at now, so the chip reads the day
  // that was chosen and the button counts whole days.
  const earliest = civilDayStart(now, f.timeZone) + DAY;
  const picked = chosen !== null && chosen >= earliest ? chosen : earliest;
  const target = jumpTarget(picked, now, f.timeZone);
  const daysAhead = Math.max(1, jumpDays(target, now, f.timeZone));

  const settle = useCallback(() => { invalidate(); session.refresh(); }, [session]);
  const { advance, reset, busy, records } = useClockMoves(session.me?.org.id ?? null, settle);

  // The move history is read off the audit trail, which is the one read on this
  // screen the server gates at admin. Everything else here is served to anyone.
  const log = useQuery<ListEnvelope<AuditEntry>>('/v1/audit-log', { limit: 500 }, { enabled: admin });
  const doneJobs = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'done', limit: PAGE });
  const failedJobs = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'failed', limit: PAGE });
  const pendingJobs = useQuery<ListEnvelope<JobRow>>('/v1/jobs', { status: 'pending', limit: PAGE });

  const pending = pendingJobs.data?.data ?? [];
  const pendingCapped = pending.length >= PAGE;
  const nextDue = useMemo(() => {
    const upcoming = pending.map((job) => job.run_at).filter((at) => at > now);
    return upcoming.length ? Math.min(...upcoming) : null;
  }, [pending, now]);

  /**
   * Every move anyone has made, newest first, with what it ran attached.
   *
   * A completed job is credited to the one move whose window holds its instant.
   * Where two windows hold it — a jump made after a return to real time covers
   * the same span the earlier jump did — it is credited to neither, and the
   * count on each of those moves is the one the server answered when the move
   * was made from this browser, or nothing at all. A number this screen cannot
   * stand behind is not shown.
   */
  const moves = useMemo<Move[]>(() => {
    const entries = (log.data?.data ?? []).filter((row) => row.action === 'time.advanced');
    const windows = entries.map((row) => ({
      id: row.id,
      from: instant(row.before) ?? row.created,
      to: instant(row.after) ?? row.created,
    }));
    const done = doneJobs.data?.data ?? [];
    const broke = failedJobs.data?.data ?? [];
    const creditedDone = attributeJobs(windows, done);
    const creditedFailed = attributeJobs(windows, broke);
    const coverage = {
      now,
      capped: done.length >= PAGE,
      floor: done.length ? Math.min(...done.map((job) => job.run_at)) : null,
    };
    return entries.map((row, index) => {
      const window = windows[index];
      const own = creditedDone.get(window.id)!;
      const failed = creditedFailed.get(window.id)!;
      const sharesWindow = own.shared.length > 0 || failed.shared.length > 0;
      const recorded = recordedFor(records, window.from);
      return {
        id: row.id,
        at: row.created,
        from: window.from,
        to: window.to,
        actor: actorName(row.actor_id, row.actor_type),
        requestId: row.request_id,
        tally: tallyMove({
          recorded,
          own: { ran: own.own.length, failed: failed.own.length },
          sharesWindow,
          covered: covers(window, coverage),
        }),
        own: own.own,
        shared: own.shared,
        failed: [...failed.own, ...failed.shared],
      };
    });
  }, [log.data, doneJobs.data, failedJobs.data, actorName, records, now]);

  const report = (move: ClockMoveResult, label: string) => {
    const outcome = clockOutcome({
      movedTo: f.date(move.now),
      label,
      jobsRun: move.jobsRun,
      jobsFailed: move.jobsFailed,
      aftermath: move.aftermath,
    });
    const raise = outcome.tone === 'success' ? toast.success : toast.error;
    raise(outcome.title, outcome.description, outcome.pinned ? { duration: 0 } : undefined);
  };

  const jump = async (to: number, label: string) => {
    try {
      const move = await advance({ to });
      setChosen(null);
      report(move, label);
    } catch (e) {
      toast.error('The clock did not move', e instanceof Error ? e.message : 'The server refused the request.', { duration: 0 });
    }
  };

  const back = async () => {
    setConfirmReset(false);
    try {
      const move = await reset();
      if (move.aftermath) report(move, 'Returned to real time');
      else toast.success('Back to real time', `The workspace clock reads ${f.dateTime(move.now)} again.`);
    } catch (e) {
      toast.error('Could not return to real time', e instanceof Error ? e.message : 'The server refused the request.', { duration: 0 });
    }
  };

  /** "12 jobs due", "Nothing due", "12+ jobs due" — what a jump to `to` will run. */
  const dueLabel = (to: number): { text: string; tone: 'brand' | 'neutral' } => {
    const due = dueBy(pending, to, pendingCapped);
    if (due.count === 0 && !due.atLeast) return { text: 'Nothing is due — the clock moves, no job runs', tone: 'neutral' };
    return { text: `${f.number(due.count)}${due.atLeast ? '+' : ''} ${due.count === 1 && !due.atLeast ? 'job runs' : 'jobs run'} on the way`, tone: 'brand' };
  };

  const describeTally = (tally: MoveTally): { badge: string; tone: 'success' | 'neutral' | 'warning'; why: string } => {
    switch (tally.kind) {
      case 'recorded':
        return {
          badge: f.plural(tally.ran, 'job'),
          tone: tally.ran ? 'success' : 'neutral',
          why: `The server answered ${f.plural(tally.ran, 'job')} ran${tally.failed ? ` and ${f.plural(tally.failed, 'failure')}` : ''} when this move was made from this browser.`,
        };
      case 'matched':
        return {
          badge: f.plural(tally.ran, 'job'),
          tone: tally.ran ? 'success' : 'neutral',
          why: 'Counted from completed jobs whose workspace instant falls inside this window and no other move’s.',
        };
      case 'shared':
        return {
          badge: 'Count not recorded',
          tone: 'warning',
          why: 'Another move’s window overlaps this one — the clock was returned to real time and jumped again over the same span — so the completed jobs in it cannot be told apart. The server’s count for this move was only reported to whoever pressed the button.',
        };
      case 'beyond':
        return {
          // A floor is honest where a count would not be: the jobs still
          // readable certainly ran in this window, and more may have.
          badge: tally.readable > 0 ? `At least ${f.plural(tally.readable, 'job')}` : 'Count not recorded',
          tone: 'warning',
          why: `The completed jobs this screen can read no longer reach the whole of this window — the queue keeps a done job for seven workspace days, a long jump prunes its own early days on the way, and the read is capped at ${PAGE}. ${tally.readable > 0 ? `${f.plural(tally.readable, 'job')} from it ${tally.readable === 1 ? 'is' : 'are'} still readable, so the true count is at least that. ` : ''}The server’s count was only reported to whoever pressed the button.`,
        };
    }
  };

  const nextTile = tileOf([pendingJobs], 'GET /v1/jobs?status=pending', () => ({
    value: nextDue !== null ? f.when(nextDue) : 'Nothing ahead',
    caption: nextDue !== null ? `Jumping past ${f.date(nextDue)} runs it` : 'No pending job carries a future run_at',
  }));

  return (
    <SettingsShell
      title="Time machine"
      subtitle="Every deferral in this platform is a row with a run_at, so the clock is the only thing standing between now and next year’s billing."
      actions={
        <Button
          variant={shifted ? 'secondary' : 'ghost'}
          iconLeft={<RotateCcwIcon size={15} />}
          disabled={!admin || !virtual || !shifted || busy}
          loading={busy}
          onClick={() => setConfirmReset(true)}
        >
          Return to now
        </Button>
      }
    >
      <Stack gap={6}>
        {!admin && (
          <Banner tone="info" title="Moving the workspace clock needs the admin role">
            {'Every read on this screen is served to you — the clock, the queue and what is due next are all below. '
              + 'It is '}
            <code className="st-mono">POST /v1/time/advance</code>
            {' that is gated at admin, so the jumps are disabled rather than offered and refused. The move history '
              + 'underneath is read from the audit trail, which is the one read here the server does close below '
              + 'admin.'}
          </Banner>
        )}
        {!virtual && (
          <Banner tone="neutral" title="This workspace runs on the real clock">
            {'The server was started without a virtual clock, so '}
            <code className="st-mono">POST /v1/time/advance</code>
            {' answers '}
            <code className="st-mono">clock_not_virtual</code>
            {' and nothing below can move. Everything else on this screen still reads: the queue is the queue '
              + 'either way.'}
          </Banner>
        )}

        <div className="st-tiles">
          <Card padding="tight">
            <Stack gap={3}>
              <span className="st-hint">Workspace time</span>
              <span className="st-clock__value">{f.dateTime(now)}</span>
              <span className="st-sub">{f.timeZone.replace(/_/g, ' ')}</span>
            </Stack>
          </Card>
          <Card padding="tight">
            <Stat
              label="Distance from real time"
              value={shifted ? describeOffset(offset).replace(/ (ahead of|behind) real time$/, '') : 'In step'}
              caption={shifted
                ? `${offset > 0 ? 'Ahead of' : 'Behind'} the machine clock, which reads ${f.dateTime(Date.now())}`
                : 'The workspace clock and the machine clock agree'}
            />
          </Card>
          <Card padding="tight">
            <Stat label="Next scheduled work" value={nextTile.value} caption={nextTile.caption} />
          </Card>
          <Card padding="tight">
            <Stat
              label="Moves recorded"
              value={admin ? f.number(moves.length) : '—'}
              caption={admin
                ? (moves.length
                  ? 'Every jump forward is in the audit trail; a return to real time leaves no entry'
                  : 'The clock has not been jumped yet')
                : 'Counted from the audit trail, which is closed to your role — not a count of zero'}
            />
          </Card>
        </div>

        <Card
          title="Jump forward"
          description="Every job that comes due on the way is executed for real, at its own run_at — not at the far end of the jump."
        >
          <Stack gap={6}>
            <div className="st-jumps">
              {TIME_JUMPS.map((preset) => {
                const to = preset.at(now);
                const due = dueLabel(to);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className="st-jump"
                    disabled={!admin || !virtual || busy}
                    onClick={() => void jump(to, `Jumped forward ${preset.label.toLowerCase()}`)}
                  >
                    <span className="st-jump__title">{preset.label}</span>
                    <span className="st-jump__desc">{preset.description}</span>
                    <span className="st-jump__when">{f.date(to)}</span>
                    <span className={`st-jump__due${due.tone === 'neutral' ? ' is-quiet' : ''}`} data-testid={`due-${preset.id}`}>
                      {pendingJobs.loading ? 'Counting what is due…' : due.text}
                    </span>
                  </button>
                );
              })}
            </div>

            <Divider label="or pick a date" />

            <Inline gap={4} wrap>
              <DatePicker
                value={picked}
                min={earliest}
                clearable={false}
                onChange={(ts) => setChosen(ts)}
                // The default footer offers Today and Clear, and this control
                // can accept neither: the clock only moves forward, and a jump
                // with no date is not a jump. Saying why beats two dead buttons.
                footer={<span className="st-hint">The clock only moves forward, so today and everything before it is struck through.</span>}
                placeholder="Jump the workspace clock to a date"
                disabled={!admin || !virtual || busy}
                aria-label="Jump the workspace clock to a date"
              />
              <Button
                variant="primary"
                loading={busy}
                disabled={!admin || !virtual || busy}
                iconLeft={<Icons.zap size={15} />}
                onClick={() => void jump(target, `Jumped ${f.plural(daysAhead, 'day')} forward`)}
              >
                {`Run ${f.plural(daysAhead, 'day')} of work`}
              </Button>
              {!pendingJobs.loading && (
                <span className="st-sub" data-testid="due-picked">
                  {`${f.date(target)} — ${quiet(dueLabel(target).text)}`}
                </span>
              )}
            </Inline>

            {shifted && (
              <Banner tone="warning" compact title={`The clock is ${describeOffset(offset)}`}>
                {'Every timestamp in the product — an invoice date, a last-seen, a due date — is written from this '
                  + 'clock while it is shifted. Returning to now leaves everything that already happened where it is; '
                  + 'it does not undo the work.'}
              </Banner>
            )}
          </Stack>
        </Card>

        {admin && (
          <Card
            title="What ran when it moved"
            description="Each jump as the audit trail recorded it. The count is the server’s own answer when the jump was made from this browser; otherwise it is counted from completed jobs only where this window is the sole one holding them."
            actions={
              <Button size="sm" variant="ghost" iconLeft={<Icons.refresh size={13} />} onClick={() => { log.refetch(); doneJobs.refetch(); failedJobs.refetch(); }}>
                Refresh
              </Button>
            }
          >
            {log.error && <ListFailure error={log.error} path="GET /v1/audit-log" onRetry={log.refetch} />}
            {log.loading && <Loading label="Reading the move history…" />}
            {!log.loading && !log.error && moves.length === 0 && (
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.clock size={22} />}
                title="The clock has not been moved yet"
                body="Jump forward above and this fills with what the platform did on the way — the renewals it billed, the retries it made, the allowances it reset."
              />
            )}
            {moves.length > 0 && (
              <div className="st-rows">
                {moves.map((move) => {
                  const days = Math.round((move.to - move.from) / DAY);
                  const isOpen = expanded === move.id;
                  const told = describeTally(move.tally);
                  const counted = move.tally.kind === 'recorded' || move.tally.kind === 'matched';
                  const ranNothing = (move.tally.kind === 'recorded' || move.tally.kind === 'matched')
                    && move.tally.ran === 0 && move.tally.failed === 0;
                  // What the expander can show: the jobs credited to this window
                  // alone, plus — when the server's own count says more ran than
                  // that — the ones it holds together with another move.
                  const listed = move.tally.kind === 'recorded' ? [...move.failed, ...move.own, ...move.shared] : [...move.failed, ...move.own];
                  const failedCount = move.tally.kind === 'recorded' || move.tally.kind === 'matched' ? move.tally.failed : move.failed.length;
                  return (
                    <div className="st-row" key={move.id} style={{ display: 'block' }} data-testid="clock-move" data-tally={move.tally.kind}>
                      <div className="u-row" style={{ gap: 'var(--space-6)', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div className="st-row__main">
                          <div className="st-row__title">
                            {`${f.dateTime(move.from)} → ${f.dateTime(move.to)}`}
                          </div>
                          <div className="st-row__sub">
                            {`${days >= 1 ? f.plural(days, 'day') : 'Under a day'} · moved by ${move.actor}`}
                            {move.requestId ? <> · <span className="st-mono">{move.requestId}</span></> : null}
                          </div>
                        </div>
                        <div className="st-row__aside">
                          {failedCount > 0 && <Badge tone="danger" pill>{f.plural(failedCount, 'failure')}</Badge>}
                          <Tooltip content={told.why}>
                            <span><Badge tone={told.tone} pill data-testid="move-count">{told.badge}</Badge></span>
                          </Tooltip>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={ranNothing || listed.length === 0}
                            iconRight={isOpen ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                            onClick={() => setExpanded(isOpen ? null : move.id)}
                          >
                            {isOpen ? 'Hide' : counted ? 'What ran' : 'Jobs in this window'}
                          </Button>
                        </div>
                      </div>
                      {isOpen && (
                        <div style={{ marginTop: 'var(--space-5)' }}>
                          {move.tally.kind === 'recorded' && listed.length !== move.tally.ran + move.tally.failed && (
                            <div className="st-hint" style={{ marginBottom: 'var(--space-3)' }}>
                              {`The server counted ${f.plural(move.tally.ran + move.tally.failed, 'job')}; ${f.plural(listed.length, 'job')} `
                                + `${listed.length === 1 ? 'is' : 'are'} still among the completed jobs this screen can read`
                                + (move.shared.length ? ', and the ones marked shared sit inside another move’s window too.' : '.')}
                            </div>
                          )}
                          {!counted && (
                            <div className="st-hint" style={{ marginBottom: 'var(--space-3)' }}>
                              {'Completed jobs whose instant falls in this window and no other move’s. '
                                + 'This is a floor, not the server’s count.'}
                            </div>
                          )}
                          {listed.map((job) => (
                            <div className="st-diffrow" key={job.id}>
                              <span className="st-diffrow__key">{f.dateTime(job.run_at)}</span>
                              <span>
                                <span className="st-diffrow__now">{job.type}</span>
                                {move.shared.includes(job) ? <span className="st-sub"> · shared window</span> : null}
                                {job.status === 'failed' && job.last_error
                                  ? <span style={{ color: 'var(--text-danger)' }}> · {job.last_error}</span>
                                  : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        <Card title="Why this is safe to press" padding="tight">
          <Stack gap={4}>
            <KeyValue
              label="Nothing is simulated"
              value="Each job runs its real handler. An invoice raised inside a jump is a real invoice, and it is dated the day it was raised."
            />
            <KeyValue
              label="Each batch runs at its own instant"
              value="The clock steps to each due batch before draining it, so a renewal due tomorrow is priced tomorrow even on a jump of a year."
            />
            <KeyValue
              label="Only this workspace"
              value="The queue is read under this workspace’s scope, so another tenant’s pending row can never decide where this clock stops."
            />
            <KeyValue
              label="Going back does not undo"
              value="Returning to real time moves the clock. Everything the jump created stays exactly where it was written."
            />
          </Stack>
        </Card>
      </Stack>

      <ConfirmDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={back}
        tone="brand"
        title="Return the clock to real time?"
        confirmLabel="Return to now"
        cancelLabel="Keep the simulated clock"
        loading={busy}
        body={
          `The workspace clock goes back to ${f.dateTime(Date.now())}. Everything the simulation created — invoices, `
          + 'payments, credit movements, agent runs — stays exactly as it was written, dated in the future. Jobs that '
          + 'already ran do not run again.'
        }
      />
    </SettingsShell>
  );
}

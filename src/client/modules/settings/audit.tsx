/**
 * The audit trail: who changed what, what it was before, what it is now, and
 * the request id that produced it.
 *
 * `ctx.audit()` is called by every route that changes something an auditor
 * would ask about — a role, a key, the workspace, the clock — and it stores the
 * whole `before` row alongside the patch that was applied. That pairing is the
 * only thing on this surface that can answer "what did this actually change",
 * so the drawer diffs them field by field rather than printing two JSON blobs
 * and leaving the reader to compare them by eye. Both blobs are still there,
 * underneath, because a diff is an opinion and the payload is the record.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, type ListEnvelope } from '../../kernel/api';
import {
  Badge, Banner, Button, Card, DataTable, DateRangePicker, Drawer, EmptyState, Icons, Inline, KeyValue,
  Stack, Tooltip,
  filterRows, searchRows, sortRows, useFormat, useMediaQuery, useToast,
  type CellValue, type DataTableColumn, type DateRange, type TableState,
  ArrowRightIcon,
} from '../../design';
import { DAY } from '../../../shared/time';
import {
  JsonBlock, ListFailure, NeedsAdmin, SettingsShell, TargetLink, downloadFile, fileStamp, toCsv, useActorName,
  useConsumeQuery,
  type CsvColumn,
} from './common';
import { seatsFromTrail } from './audit-core';
import { useSession } from '../../kernel/session';
import type { ApiKey, AuditEntry } from './types';

/** The page the server will serve at most. Named, so the count never lies. */
const PAGE = 500;

const actionTone = (action: string): 'neutral' | 'danger' | 'warning' | 'info' | 'success' => {
  if (/removed|revoked|deleted|voided/.test(action)) return 'danger';
  if (/role_changed|advanced|updated/.test(action)) return 'warning';
  if (/created|invited/.test(action)) return 'success';
  return 'info';
};

interface Change { key: string; was: unknown; now: unknown }

/**
 * What actually moved.
 *
 * `before` is the whole row as it stood and `after` is the patch that was
 * applied, so the comparison runs over the keys the patch names — plus any key
 * the patch dropped. `updated` is excluded: every write stamps it, so including
 * it makes every entry claim a change nobody made.
 */
function changesBetween(before: unknown, after: unknown): Change[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(before) && !isRecord(after)) return [];
  const b = isRecord(before) ? before : {};
  const a = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b).filter((key) => key in a)])];
  const changes: Change[] = [];
  for (const key of keys.sort()) {
    if (key === 'updated') continue;
    const was = b[key];
    const now = a[key];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    changes.push({ key, was, now });
  }
  return changes;
}

/** `{ now: 123 }` off a clock move's payload, or null. */
const instant = (value: unknown): number | null => {
  if (typeof value !== 'object' || value === null) return null;
  const now = (value as { now?: unknown }).now;
  return typeof now === 'number' && Number.isFinite(now) ? now : null;
};

const show = (value: unknown): string => {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value || '""';
  return JSON.stringify(value);
};

export function AuditLogPage() {
  const session = useSession();
  const f = useFormat();
  const toast = useToast();
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const [range, setRange] = useState<DateRange>({ start: null, end: null });
  /**
   * The grid's own search, filters and sort, held here rather than inside it —
   * so the export can hand over exactly the rows on screen, in the order they
   * are shown, instead of the whole read.
   */
  const [view, setView] = useState<TableState>({ query: '', sort: { columnId: 'created', direction: 'desc' }, filters: {} });

  const admin = session.me?.role === 'owner' || session.me?.role === 'admin';
  // At 1024 the card is about 500px wide; the fixed columns yield so the
  // sentence keeps the room, and the ids under the target truncate with a title.
  const narrow = useMediaQuery('(max-width: 1100px)');
  const log = useQuery<ListEnvelope<AuditEntry>>('/v1/audit-log', { limit: PAGE }, { enabled: admin });
  // The one target type the session cannot name. Same gate as the trail itself.
  const keys = useQuery<ListEnvelope<ApiKey>>('/v1/api-keys', undefined, { enabled: admin });
  const rows = log.data?.data ?? [];
  /**
   * What each target is called. Keys are named off the key list; a teammate
   * the roster no longer holds is named off the invitation the trail itself
   * recorded, and marked as removed when the trail says so — the row for a
   * removal is the one an auditor reads most carefully, and it used to read a
   * bare `usr_…` linking to a roster search that found nobody.
   */
  const seats = useMemo(() => seatsFromTrail(rows), [rows]);
  const names = useMemo(() => {
    const map = new Map((keys.data?.data ?? []).map((key) => [key.id, key.name]));
    for (const [id, seat] of seats) if (seat.email) map.set(id, seat.email);
    return map;
  }, [keys.data, seats]);
  const notes = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, seat] of seats) if (seat.removed) map.set(id, 'removed');
    return map;
  }, [seats]);
  /**
   * The actor is named from the same two things the target is: the key list
   * this screen is allowed to read, and the trail's own memory of a seat. A
   * teammate the roster has dropped used to be a bare `usr_…` in the Actor
   * column, the summary's second line and the export — while the Target column
   * beside it named the very same person.
   */
  const actorName = useActorName({ known: names, seats });
  const now = session.now();

  /**
   * `?target=usr_…` is the address the team screen writes when a deep link
   * names a seat the roster no longer holds: the trail answers with every entry
   * about that id, through the same search box, and then drops the parameter.
   */
  const [wantedTarget, setWantedTarget] = useState<string | null>(null);
  useConsumeQuery('target', setWantedTarget);
  useEffect(() => {
    if (!wantedTarget) return;
    setView((current) => ({ ...current, query: wantedTarget }));
    setWantedTarget(null);
  }, [wantedTarget]);

  /**
   * The server's summary for a clock move quotes the new instant as a raw ISO
   * string, which no other sentence on this surface does. The instant is also
   * in `after.now`, so the sentence is rebuilt from that in the workspace's own
   * format; every other summary is shown as written.
   */
  const summaryOf = useCallback((row: AuditEntry): string => {
    if (row.action === 'time.advanced') {
      const to = instant(row.after);
      if (to !== null) return `Advanced the workspace clock to ${f.dateTime(to)}`;
    }
    return row.summary;
  }, [f]);
  /**
   * `created` is the *workspace* clock, not wall time — which is the honest
   * thing to record, and the reason a trail can look out of order. Anything
   * written while the time machine had the clock a month ahead carries a
   * timestamp a month ahead, and sorts above everything done since. Saying so
   * is better than a reader deciding the trail is unreliable.
   */
  const ahead = (row: AuditEntry) => row.created > now + 60_000;
  const fromTheFuture = rows.filter(ahead).length;

  const bounded = range.start !== null || range.end !== null;
  // The picker hands back day starts; an entry written at 16:40 on the closing
  // day belongs inside the window the auditor asked for.
  const windowed = useMemo(() => (bounded
    ? rows.filter((row) => (range.start === null || row.created >= range.start)
      && (range.end === null || row.created < range.end + DAY))
    : rows), [rows, range, bounded]);

  /**
   * The summary is why the row exists, so it gets the flexible width. Actor and
   * action ride under it as a second line, and their own columns start hidden
   * — still there for the filter menu and the column toggle, but not taking
   * 370px from the sentence, which at 1440 wide had been cut to "Workspace
   * setti…" and at 1024 was off the edge of the grid's own scroll.
   */
  const columns = useMemo<DataTableColumn<AuditEntry>[]>(() => [
    {
      id: 'created',
      header: 'When',
      pinned: true,
      width: narrow ? 128 : 170,
      accessor: (row) => row.created,
      // A change already made cannot be "in 24 hours". An entry the shifted
      // clock stamped ahead of now reads as the absolute instant it carries,
      // marked as such, rather than as a relative phrase about the future.
      cell: (row) => (ahead(row)
        ? (
          <Tooltip content="Recorded while the time machine had the workspace clock ahead of real time — this is the instant the clock read.">
            <span className="u-num" style={{ display: 'block' }}>
              <span style={{ display: 'block' }}>{f.dateTime(row.created)}</span>
              <span className="st-sub">clock was ahead</span>
            </span>
          </Tooltip>
        )
        : (
          <Tooltip content={f.dateTime(row.created)}>
            <span className="u-num">{f.when(row.created)}</span>
          </Tooltip>
        )),
    },
    {
      id: 'summary',
      header: 'What happened',
      accessor: (row) => summaryOf(row),
      cell: (row) => (
        <span style={{ display: 'block', minWidth: 0 }}>
          <span className="u-truncate" style={{ display: 'block' }} data-testid="audit-summary">{summaryOf(row)}</span>
          <span className="st-sub u-truncate" style={{ display: 'block' }}>
            {`${actorName(row.actor_id, row.actor_type)} · `}
            <Badge tone={actionTone(row.action)} size="sm">{row.action}</Badge>
          </span>
        </span>
      ),
    },
    {
      id: 'actor',
      header: 'Actor',
      width: 190,
      filter: 'set',
      filterLabel: 'Actor',
      defaultHidden: true,
      accessor: (row) => actorName(row.actor_id, row.actor_type),
      cell: (row) => (
        <span>
          <span style={{ display: 'block' }} className="u-truncate">{actorName(row.actor_id, row.actor_type)}</span>
          <span className="st-sub">{row.actor_type}</span>
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      width: 180,
      filter: 'set',
      defaultHidden: true,
      accessor: (row) => row.action,
      cell: (row) => <Badge tone={actionTone(row.action)} pill>{row.action}</Badge>,
    },
    {
      id: 'target',
      header: 'Target',
      width: narrow ? 170 : 240,
      filter: 'text',
      filterLabel: 'Target id',
      accessor: (row) => row.target_id ?? '',
      cell: (row) => (row.target_id
        ? <TargetLink type={row.target_type} id={row.target_id} names={names} notes={notes} compact />
        : <span className="st-sub">The workspace</span>),
    },
    {
      id: 'request_id',
      header: 'Request',
      width: 210,
      accessor: (row) => row.request_id ?? '',
      cell: (row) => (row.request_id ? <span className="st-mono">{row.request_id}</span> : <span className="st-sub">—</span>),
      defaultHidden: true,
    },
  ], [f, actorName, names, notes, summaryOf, now, narrow]);

  /**
   * The same three passes the grid runs, over the same accessors, so what is
   * exported is what is on screen — a file that quietly holds more rows than
   * the screen did is how an audit answer goes wrong twice.
   */
  const accessor = useCallback(
    (row: AuditEntry, columnId: string): CellValue => columns.find((column) => column.id === columnId)?.accessor?.(row) ?? null,
    [columns],
  );
  const visible = useMemo(() => {
    const ids = columns.map((column) => column.id);
    let out = windowed;
    if (view.query) out = searchRows(out, view.query, ids, accessor);
    out = filterRows(out, view.filters, accessor);
    return sortRows(out, view.sort, accessor);
  }, [windowed, view, columns, accessor]);

  const exportTrail = () => {
    const csvColumns: CsvColumn<AuditEntry>[] = [
      { header: 'recorded_at', value: (row) => new Date(row.created).toISOString() },
      { header: 'recorded_at_workspace', value: (row) => f.dateTime(row.created) },
      { header: 'actor', value: (row) => actorName(row.actor_id, row.actor_type) },
      { header: 'actor_id', value: (row) => row.actor_id },
      { header: 'actor_type', value: (row) => row.actor_type },
      { header: 'action', value: (row) => row.action },
      { header: 'summary', value: (row) => summaryOf(row) },
      { header: 'target_type', value: (row) => row.target_type },
      { header: 'target_id', value: (row) => row.target_id },
      { header: 'request_id', value: (row) => row.request_id },
      { header: 'ip', value: (row) => row.ip },
      { header: 'before', value: (row) => (row.before === null ? '' : JSON.stringify(row.before)) },
      { header: 'after', value: (row) => (row.after === null ? '' : JSON.stringify(row.after)) },
    ];
    const file = `ain-audit-log-${fileStamp(session.now(), f.timeZone)}.csv`;
    downloadFile(file, toCsv(visible, csvColumns));
    toast.success(
      `Exported ${f.plural(visible.length, 'entry')}`,
      `${file} — the rows on screen, in the order they are shown, with the whole before and after on each one.`,
    );
  };

  if (!admin) {
    return (
      <SettingsShell title="Audit log" subtitle="Who changed what, and what it was before.">
        <Card><NeedsAdmin what="The audit trail" route="GET /v1/audit-log" /></Card>
      </SettingsShell>
    );
  }

  const changes = open ? changesBetween(open.before, open.after) : [];

  return (
    <SettingsShell
      title="Audit log"
      subtitle="Every change a route thought an auditor would ask about, with the request id that made it."
      actions={
        <Inline gap={3}>
          <Button
            variant="secondary"
            iconLeft={<Icons.download size={15} />}
            disabled={visible.length === 0}
            title={visible.length === 0
              ? 'There is nothing to export — no entry matches the search, filters and dates in force.'
              : `${f.plural(visible.length, 'entry')}, exactly as the grid is showing them.`}
            onClick={exportTrail}
          >
            Export
          </Button>
          <Button variant="secondary" iconLeft={<Icons.refresh size={15} />} loading={log.validating} onClick={log.refetch}>
            Refresh
          </Button>
        </Inline>
      }
    >
      <Stack gap={6}>
        {log.error && <ListFailure error={log.error} path="GET /v1/audit-log" onRetry={log.refetch} />}

        {fromTheFuture > 0 && (
          <Banner
            tone="info"
            compact
            title={`${f.plural(fromTheFuture, 'entry')} ${fromTheFuture === 1 ? 'was' : 'were'} recorded on a clock that was running ahead`}
          >
            {'The trail timestamps every change with the workspace clock, so anything done while the time machine had '
              + 'the clock in the future carries a future date — and sorts above changes made since. Nothing is '
              + 'missing and nothing is out of sequence; the dates are simply the ones those changes really happened on.'}
          </Banner>
        )}

        {rows.length === PAGE && (
          <Banner tone="info" compact title={`Showing the ${PAGE} most recent entries`}>
            {'The route serves at most 500 rows in one read and offers no cursor, so the dates, filters and export '
              + 'below all work on this page rather than on the whole trail. Nothing older has been discarded — it is '
              + 'reachable through '}
            <code className="st-mono">GET /v1/audit-log?target_id=…</code>
            {', which narrows the read itself.'}
          </Banner>
        )}

        <Card padding="none">
          <DataTable
            rows={windowed}
            columns={columns}
            getRowId={(row) => row.id}
            caption="Audit trail"
            loading={log.loading}
            searchable
            searchPlaceholder="Search summaries, targets and request ids"
            showFilters
            showColumnToggle
            value={view}
            onChange={setView}
            toolbar={
              <DateRangePicker
                value={range}
                onChange={setRange}
                max={session.now()}
                aria-label="Bound the trail by date"
                placeholder="Bound the trail by date"
              />
            }
            onRowClick={setOpen}
            maxHeight={620}
            // The grid counts what it was handed, and it was handed the rows
            // inside the dates — so the dates have to say what they took out.
            footer={bounded
              ? (
                <span className="st-sub">
                  {`These dates hold ${f.plural(windowed.length, 'entry')} of the ${f.number(rows.length)} in this read`}
                </span>
              )
              : undefined}
            empty={bounded
              ? (
                <EmptyState
                  size="sm"
                  inline
                  illustration={<Icons.calendar size={22} />}
                  title="No change was recorded in that window"
                  body={
                    'The trail holds entries outside these dates. Timestamps here are workspace time, so anything '
                    + 'written while the time machine had the clock ahead carries the date it really happened on.'
                  }
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setRange({ start: null, end: null })}>
                      Clear the dates
                    </Button>
                  }
                />
              )
              : (
                <EmptyState
                  size="sm"
                  inline
                  illustration={<Icons.shield size={22} />}
                  title="Nothing has been audited yet"
                  body={
                    'The trail fills the moment somebody changes something worth remembering — a role, an API key, the '
                    + 'workspace, the clock. A demo workspace starts with an empty trail because none of that has '
                    + 'happened yet.'
                  }
                />
              )}
          />
        </Card>
      </Stack>

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        size="lg"
        title={open ? summaryOf(open) : ''}
        description={open ? `${open.action} · ${f.dateTime(open.created)}` : undefined}
      >
        {open && (
          <Stack gap={6}>
            <Card title="The entry" padding="tight">
              <Stack gap={3}>
                <KeyValue label="Actor" value={`${actorName(open.actor_id, open.actor_type)} · ${open.actor_type}`} />
                <KeyValue label="Action" value={<Badge tone={actionTone(open.action)} pill>{open.action}</Badge>} />
                <KeyValue
                  label="Target"
                  value={<TargetLink type={open.target_type} id={open.target_id} names={names} notes={notes} />}
                />
                <KeyValue
                  label="When"
                  value={ahead(open)
                    ? `${f.dateTime(open.created)} — the workspace clock was ahead of real time when this was recorded`
                    : f.dateTime(open.created)}
                />
                <KeyValue
                  label="Request id"
                  value={open.request_id
                    ? <span className="st-mono">{open.request_id}</span>
                    : <span className="st-sub">Not recorded — this change was made outside an HTTP request.</span>}
                />
                {open.ip && <KeyValue label="From" value={<span className="st-mono">{open.ip}</span>} />}
              </Stack>
            </Card>

            <Card
              title="What changed"
              description={changes.length
                ? `${f.plural(changes.length, 'field')} moved. Fields the patch did not name are unchanged.`
                : 'This entry recorded an action rather than a field change.'}
              padding="tight"
            >
              {changes.length === 0 && (
                <EmptyState
                  size="sm"
                  inline
                  illustration={null}
                  title="No field-level diff"
                  body="The route recorded the action and its summary without a before-and-after pair. The payloads below are what it stored."
                />
              )}
              {changes.map((change) => (
                <div className="st-diffrow" key={change.key}>
                  <span className="st-diffrow__key">{change.key}</span>
                  <span>
                    {change.was !== undefined && (
                      <>
                        <span className="st-diffrow__was">{show(change.was)}</span>
                        <ArrowRightIcon size={12} style={{ margin: '0 var(--space-3)', verticalAlign: 'middle' }} />
                      </>
                    )}
                    <span className="st-diffrow__now">{show(change.now)}</span>
                  </span>
                </div>
              ))}
            </Card>

            <div className="st-diff">
              <JsonBlock label="before" value={open.before} maxHeight={280} />
              <JsonBlock label="after" value={open.after} maxHeight={280} />
            </div>

            <Inline gap={3}>
              <Icons.info size={14} />
              <span className="st-hint">
                <code className="st-mono">before</code>
                {' is the whole row as it stood; '}
                <code className="st-mono">after</code>
                {' is the patch that was applied. A key missing from '}
                <code className="st-mono">after</code>
                {' was not touched.'}
              </span>
            </Inline>
          </Stack>
        )}
      </Drawer>
    </SettingsShell>
  );
}

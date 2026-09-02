/**
 * The event stream — the substrate everything else in this platform is built on.
 *
 * `ctx.emit()` writes one row to `events`, and webhooks, workflow triggers,
 * record timelines and the audit trail all read from that one place. Which
 * means an integrator's first question is never "what happened" but "what shape
 * is the thing that happened", and a screen that summarises an event into three
 * chosen fields answers the wrong one. So the payload is printed whole, exactly
 * as `GET /v1/events/:id` serves it, next to the `previous` snapshot that says
 * what the object looked like before.
 *
 * The type filter is sent to the server rather than applied to what is already
 * on screen: `?type=` is what lets a rare event be found past the two hundred
 * most recent, and filtering the page instead would quietly claim it never
 * happened.
 */
import { useMemo, useState } from 'react';
import { useQuery, type ListEnvelope } from '../../kernel/api';
import { useSearchParam } from '../../kernel/router';
import {
  Badge, Banner, Button, Card, EmptyState, Icons, Inline, Input, KeyValue, Pill, PillGroup,
  SearchInput, Stack, Tooltip,
  useFormat,
  FilterXIcon,
} from '../../design';
import { JsonBlock, ListFailure, Loading, SettingsShell, useActorName } from './common';
import type { PlatformEvent } from './types';

/** The most the route will serve in one read. */
const PAGE = 200;

/** `credit.usage_settled` → the domain it belongs to. */
const domainOf = (type: string): string => type.split('.')[0];

export function EventsPage() {
  const f = useFormat();
  const actorName = useActorName();
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [objectId, setObjectId] = useSearchParam('object');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  /**
   * The catalogue read. Unfiltered, so the chips can offer types that are not
   * on the filtered page — and cached under the same URL as the list read when
   * nothing is selected, so the common case is one request, not two.
   */
  const catalogue = useQuery<ListEnvelope<PlatformEvent>>('/v1/events', { limit: PAGE });

  const listQuery = useMemo(() => ({
    limit: PAGE,
    ...(selectedTypes.length ? { type: selectedTypes.join(',') } : {}),
    ...(objectId.trim() ? { object_id: objectId.trim() } : {}),
  }), [selectedTypes, objectId]);

  const stream = useQuery<ListEnvelope<PlatformEvent>>('/v1/events', listQuery);
  const detail = useQuery<PlatformEvent>(openId ? `/v1/events/${openId}` : null);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of catalogue.data?.data ?? []) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalogue.data]);

  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [type, n] of types) counts.set(domainOf(type), (counts.get(domainOf(type)) ?? 0) + n);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [types]);

  const rows = useMemo(() => {
    const all = stream.data?.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((event) => (
      event.type.toLowerCase().includes(needle)
      || (event.object_id ?? '').toLowerCase().includes(needle)
      || (event.object_type ?? '').toLowerCase().includes(needle)
      || event.id.toLowerCase().includes(needle)
    ));
  }, [stream.data, search]);

  const selected = detail.data ?? rows.find((event) => event.id === openId) ?? null;

  const toggleType = (type: string) => setSelectedTypes((current) => (
    current.includes(type) ? current.filter((t) => t !== type) : [...current, type]
  ));

  const toggleDomain = (domain: string) => {
    const inDomain = types.filter(([type]) => domainOf(type) === domain).map(([type]) => type);
    const allOn = inDomain.every((type) => selectedTypes.includes(type));
    setSelectedTypes((current) => (allOn
      ? current.filter((type) => !inDomain.includes(type))
      : [...new Set([...current, ...inDomain])]));
  };

  return (
    <SettingsShell
      title="Events"
      subtitle="One append-only stream. Webhooks, workflow triggers, record timelines and the audit trail all read from it."
      actions={
        <Button variant="secondary" iconLeft={<Icons.refresh size={15} />} loading={stream.validating} onClick={stream.refetch}>
          Refresh
        </Button>
      }
    >
      <Stack gap={6}>
        {stream.error && <ListFailure error={stream.error} path="GET /v1/events" onRetry={stream.refetch} />}

        <Card
          title="Filter the stream"
          description="Types are sent to the server, so a rare one is still found past the most recent page."
          actions={selectedTypes.length || objectId
            ? (
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<FilterXIcon size={13} />}
                onClick={() => { setSelectedTypes([]); setObjectId(undefined); }}
              >
                Clear
              </Button>
            )
            : undefined}
        >
          <Stack gap={5}>
            <div>
              <div className="st-hint" style={{ marginBottom: 'var(--space-3)' }}>By domain</div>
              <PillGroup label="Filter by event domain">
                {domains.map(([domain, count]) => {
                  const inDomain = types.filter(([type]) => domainOf(type) === domain).map(([type]) => type);
                  const on = inDomain.length > 0 && inDomain.every((type) => selectedTypes.includes(type));
                  return (
                    <Pill key={domain} active={on} onClick={() => toggleDomain(domain)} count={count}>
                      {domain}
                    </Pill>
                  );
                })}
                {domains.length === 0 && !catalogue.loading && <span className="st-sub">No event has been emitted yet.</span>}
              </PillGroup>
            </div>

            <div>
              <div className="st-hint" style={{ marginBottom: 'var(--space-3)' }}>
                {`By type · ${f.plural(types.length, 'type')} seen in the ${PAGE} most recent`}
              </div>
              <PillGroup label="Filter by event type">
                {types.map(([type, count]) => (
                  <Pill key={type} active={selectedTypes.includes(type)} onClick={() => toggleType(type)} count={count}>
                    {type}
                  </Pill>
                ))}
              </PillGroup>
            </div>

            <Inline gap={4} wrap>
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search this page by type, object or event id"
                aria-label="Search the events on this page"
                wrapperClassName="u-grow"
              />
              <Input
                value={objectId}
                onChange={(e) => setObjectId(e.target.value || undefined)}
                placeholder="Every event about one object"
                aria-label="Every event about one object — paste an id"
                mono
                clearable
                onClear={() => setObjectId(undefined)}
                iconLeft={<Icons.hash size={14} />}
                wrapperClassName="u-grow"
              />
            </Inline>
          </Stack>
        </Card>

        <div className="st-cols">
          <Card
            padding="none"
            title="The stream"
            description={stream.loading
              ? 'Reading…'
              : `${f.plural(rows.length, 'event')}${selectedTypes.length ? ` of ${f.plural(selectedTypes.length, 'type')}` : ''}, newest first.`}
          >
            {stream.loading && <Loading label="Reading the event stream…" />}
            {!stream.loading && rows.length === 0 && (
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.zap size={22} />}
                title={selectedTypes.length || objectId ? 'Nothing matches this filter' : 'No event has been emitted yet'}
                body={selectedTypes.length || objectId
                  ? 'Nothing in the stream carries these types, or nothing has happened to that object.'
                  : 'The stream fills the moment anything changes — an invoice finalising, a deal moving, an agent running.'}
                action={selectedTypes.length || objectId
                  ? <Button size="sm" variant="secondary" onClick={() => { setSelectedTypes([]); setObjectId(undefined); }}>Clear the filter</Button>
                  : undefined}
              />
            )}
            {!stream.loading && rows.length > 0 && (
              <div className="st-stream" role="list" style={{ maxHeight: 620, overflowY: 'auto' }}>
                {rows.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    role="listitem"
                    className={`st-event${event.id === openId ? ' is-selected' : ''}`}
                    aria-current={event.id === openId ? 'true' : undefined}
                    onClick={() => setOpenId(event.id)}
                  >
                    <span className="st-event__type">{event.type}</span>
                    <span className="st-event__when">
                      <Tooltip content={f.dateTime(event.created)}><span>{f.when(event.created)}</span></Tooltip>
                    </span>
                    <span className="st-event__sub">
                      {event.object_type ? `${event.object_type} · ` : ''}
                      {event.object_id ?? 'no object'}
                      {' · '}
                      {actorName(event.actor_id, event.actor_type)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card
            title={selected ? selected.type : 'The payload'}
            description={selected
              ? `Emitted ${f.dateTime(selected.created)} by ${actorName(selected.actor_id, selected.actor_type)}`
              : 'Choose an event to see exactly what a webhook would receive.'}
            actions={selected ? <Badge tone="neutral" pill>{selected.actor_type}</Badge> : undefined}
          >
            {!selected && (
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.code size={22} />}
                title="Nothing selected"
                body="Every event carries the object it is about, the actor behind it, the request id that produced it and the full payload a subscriber would be delivered."
              />
            )}
            {detail.error && (
              <Banner tone="danger" compact title="That event could not be re-read">
                {detail.error.body.message}
              </Banner>
            )}
            {selected && (
              <Stack gap={5}>
                <Stack gap={3}>
                  <KeyValue label="Event id" value={<span className="st-mono">{selected.id}</span>} />
                  <KeyValue
                    label="Object"
                    value={selected.object_id
                      ? <span className="st-mono">{`${selected.object_type ?? 'object'} · ${selected.object_id}`}</span>
                      : <span className="st-sub">This event is not about one object.</span>}
                  />
                  <KeyValue
                    label="Request id"
                    value={selected.request_id
                      ? <span className="st-mono">{selected.request_id}</span>
                      : <span className="st-sub">Emitted outside an HTTP request — by a job, or by the seed.</span>}
                  />
                  <KeyValue label="When" value={f.dateTime(selected.created)} />
                </Stack>

                <JsonBlock label="data — what a subscriber receives" value={selected.data} maxHeight={320} />

                {selected.previous !== null && selected.previous !== undefined && (
                  <JsonBlock label="previous — the object before this change" value={selected.previous} maxHeight={220} />
                )}
                {(selected.previous === null || selected.previous === undefined) && (
                  <div className="st-hint">
                    {'No '}
                    <code className="st-mono">previous</code>
                    {' snapshot: this event records something that came into existence rather than something that '
                      + 'changed.'}
                  </div>
                )}
              </Stack>
            )}
          </Card>
        </div>
      </Stack>
    </SettingsShell>
  );
}

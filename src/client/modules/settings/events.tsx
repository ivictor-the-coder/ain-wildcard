/**
 * The event stream — the substrate everything else in this platform is built on.
 *
 * `ctx.emit()` writes one row to `events`, and webhooks, workflow triggers,
 * record timelines and the audit trail all read from that one place. Which
 * means an integrator's first question is never "what happened" but "what shape
 * is the thing that happened", and a screen that summarises an event into three
 * chosen fields answers the wrong one. So the payload is printed whole, exactly
 * as a subscriber is posted it.
 *
 * That last clause used to be a promise this screen could not keep. It offered
 * to show "exactly what a webhook would receive" over `event.data` — which is
 * not what a webhook receives; the envelope around it is — and it said so in a
 * product that had no endpoint, no delivery and no webhook at all. Both halves
 * are answered by the delivery module now: `GET /v1/events/:id/webhook-payload`
 * returns the signed envelope, the endpoints subscribed to that type, and every
 * delivery actually made of it, with each attempt and what the subscriber
 * answered. Where there is no delivery the screen says which of the two reasons
 * it is, rather than showing a payload and implying one.
 *
 * The type filter is sent to the server rather than applied to what is already
 * on screen: `?type=` is what lets a rare event be found past the two hundred
 * most recent, and filtering the page instead would quietly claim it never
 * happened.
 */
import { useMemo, useState } from 'react';
import { useQuery, type ApiClientError, type ListEnvelope } from '../../kernel/api';
import { useSearchParam } from '../../kernel/router';
import {
  Badge, Banner, Button, Card, Collapsible, EmptyState, Icons, Inline, Input, KeyValue, Pill, PillGroup,
  SearchInput, Stack, StatusPill, Tooltip,
  useFormat,
  FilterXIcon,
} from '../../design';
import { JsonBlock, ListFailure, Loading, SettingsShell, TargetLink, useActorName } from './common';
import { unattributedBecause } from './audit-core';
import { readActor, seatsFromStream } from './events-core';
import type { PlatformEvent } from './types';

/** The most the route will serve in one read. */
const PAGE = 200;

/**
 * `.st-mono` is `white-space: nowrap`, which is what an id wants and what a
 * hundred-character signature header does not: it ran off the side of the card
 * rather than wrapping inside it.
 */
const WRAP = { whiteSpace: 'break-spaces', wordBreak: 'break-all' } as const;

/** `credit.usage_settled` → the domain it belongs to. */
const domainOf = (type: string): string => type.split('.')[0];

/* --------------------------- the delivery module -------------------------- */

/**
 * The wire shapes served by `src/server/modules/notifications`. Transcribed
 * here rather than imported: this file is the only part of the settings
 * surface that reads them, and `./types` is shared with five other screens.
 */
interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  status: 'enabled' | 'disabled';
  enabled_events: string[];
  secret_last4: string;
  retry_policy: string;
  disabled_reason: string | null;
  deliveries: { pending: number; succeeded: number; failed: number };
  detail: string;
}

interface WebhookAttemptView {
  id: string;
  attempt: number;
  at: number;
  status: 'succeeded' | 'failed';
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number;
  signature: string;
  next_attempt_at: number | null;
  summary: string;
}

interface WebhookDeliveryView {
  id: string;
  endpoint: string;
  endpoint_url: string;
  event: string;
  event_type: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number | null;
  last_status_code: number | null;
  detail: string;
  payload: unknown;
  attempts?: WebhookAttemptView[];
}

interface SignatureRecipeView {
  header: string;
  algorithm: string;
  format: string;
  signed_payload: string;
  tolerance_ms: number;
  instructions: string;
}

interface WebhookPayloadPreview {
  event: string;
  type: string;
  payload: unknown;
  signature: SignatureRecipeView;
  retry_policy: string;
  subscribed_endpoints: { id: string; url: string; status: string }[];
  deliveries: WebhookDeliveryView[];
  detail: string;
}

/**
 * Modules register themselves, so a workspace can be running without the
 * delivery module in it — and then these routes are not 404 "no such endpoint",
 * they are "that is not installed here". A red panel would be the wrong answer:
 * the stream is fine, and it is the only thing this screen is really about.
 */
const notInstalled = (error: ApiClientError | null): boolean =>
  !!error && error.status === 404 && error.body.code === 'unknown_endpoint';

export function EventsPage() {
  const f = useFormat();
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
  const endpoints = useQuery<ListEnvelope<WebhookEndpointView>>('/v1/webhook-endpoints');
  const preview = useQuery<WebhookPayloadPreview>(openId ? `/v1/events/${openId}/webhook-payload` : null);

  /**
   * Who each actor is, as far as the stream itself can tell.
   *
   * The roster names current seats and nothing else, so a teammate who has
   * been removed arrived here as a bare `usr_…` printed exactly like a name.
   * The stream's own `user.invited` and `user.activated` payloads carry the
   * address, so they are read for it — off the *unfiltered* catalogue page as
   * well as the filtered one, because filtering to `credit.*` must not lose
   * the name of the person who caused it.
   */
  const seats = useMemo(
    () => seatsFromStream([...(catalogue.data?.data ?? []), ...(stream.data?.data ?? [])]),
    [catalogue.data, stream.data],
  );
  const actorName = useActorName({ seats });
  const readActorOf = (event: PlatformEvent) => readActor(event.actor_id, event.actor_type, actorName(event.actor_id, event.actor_type));

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
  const selectedActor = selected ? readActorOf(selected) : null;
  const subscribers = endpoints.data?.data ?? [];
  const spineMissing = notInstalled(endpoints.error);

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

        <Subscribers
          endpoints={subscribers}
          loading={endpoints.loading}
          error={endpoints.error}
          missing={spineMissing}
          onRetry={endpoints.refetch}
        />

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
                {rows.map((event) => {
                  const actor = readActorOf(event);
                  return (
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
                        {/* An id is set in the id face and carries why it is an
                            id. Printed plain it read as this person's name. */}
                        {actor.isId
                          ? <span className="st-mono" title={actor.note ?? undefined}>{actor.label}<span className="st-sub"> · unnamed actor</span></span>
                          : actor.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          <Card
            title={selected ? selected.type : 'The payload'}
            description={selected
              ? (
                <>
                  {`Emitted ${f.dateTime(selected.created)} by `}
                  {/* "by usr_8kww…" in the sentence's own face claimed that
                      string was the person's name. The Actor row below says
                      what it is instead. */}
                  {selectedActor?.isId
                    ? <span className="st-mono">{selectedActor.label}</span>
                    : selectedActor?.label}
                </>
              )
              : 'Choose an event to see the envelope a subscriber is posted, and every delivery made of it.'}
            actions={selected ? <Badge tone="neutral" pill>{selected.actor_type}</Badge> : undefined}
          >
            {!selected && (
              <EmptyState
                size="sm"
                inline
                illustration={<Icons.code size={22} />}
                title="Nothing selected"
                body="Every event carries the object it is about, the actor behind it, the request id that produced it and the full payload a subscriber is delivered."
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
                      ? <TargetLink type={selected.object_type} id={selected.object_id} />
                      : <span className="st-sub">This event is not about one object.</span>}
                  />
                  <KeyValue
                    label="Request id"
                    value={selected.request_id
                      ? <span className="st-mono">{selected.request_id}</span>
                      : <span className="st-sub">Not recorded — the route did not bind this event to its request.</span>}
                  />
                  {unattributedBecause(selected.actor_id, selected.actor_type, selected.request_id) && (
                    <KeyValue
                      label="Actor"
                      value={<span className="st-sub">{unattributedBecause(selected.actor_id, selected.actor_type, selected.request_id)}</span>}
                    />
                  )}
                  {/*
                    * An actor the roster cannot name is a fact about the
                    * record, not a rendering accident, so it is stated: the id
                    * as a link to whatever screen resolves it, and underneath
                    * why there is no name to show. `GET /v1/events` carries no
                    * seat to read one from — see `events-core.ts`.
                    */}
                  {selectedActor?.isId && (
                    <KeyValue
                      label="Actor"
                      value={
                        <Stack gap={2}>
                          <TargetLink type={selected.actor_type === 'api_key' ? 'api_key' : 'user'} id={selected.actor_id} />
                          <span className="st-sub">{selectedActor.detail}</span>
                        </Stack>
                      }
                    />
                  )}
                  <KeyValue label="When" value={f.dateTime(selected.created)} />
                </Stack>

                <Envelope
                  event={selected}
                  preview={preview.data ?? null}
                  loading={preview.loading}
                  error={preview.error}
                  missing={notInstalled(preview.error)}
                  onRetry={preview.refetch}
                />
              </Stack>
            )}
          </Card>
        </div>
      </Stack>
    </SettingsShell>
  );
}

/* ------------------------------- subscribers ------------------------------ */

function Subscribers({ endpoints, loading, error, missing, onRetry }: {
  endpoints: WebhookEndpointView[];
  loading: boolean;
  error: ApiClientError | null;
  missing: boolean;
  onRetry: () => void;
}) {
  const f = useFormat();
  const live = endpoints.filter((e) => e.status === 'enabled').length;
  return (
    <Card
      title="Where these events go"
      description={missing || !endpoints.length
        ? 'Every subscriber to this stream, and how its deliveries have been going.'
        : `${f.plural(endpoints.length, 'endpoint')} registered, ${live} enabled. Each delivery is a job with a run_at, `
          + `so the ladder replays under the workspace clock. ${endpoints[0].retry_policy}`}
    >
      {loading && <Loading label="Reading the subscribers…" />}
      {missing && (
        <EmptyState
          size="sm"
          inline
          illustration={<Icons.zap size={22} />}
          title="The delivery module is not installed in this workspace"
          body="Events are still recorded — everything below is real — but nothing is subscribed to them, so nothing leaves. Adding the notifications module registers the endpoint, delivery and attempt routes this panel reads."
        />
      )}
      {error && !missing && <ListFailure error={error} path="GET /v1/webhook-endpoints" onRetry={onRetry} />}
      {!loading && !error && endpoints.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={<Icons.zap size={22} />}
          title="No endpoint is subscribed yet"
          body="POST /v1/webhook-endpoints registers a URL, a signing secret and the event selectors it wants. An endpoint receives only what happens after it is registered, so pointing one at this workspace will not replay the history below at it."
        />
      )}
      {endpoints.length > 0 && (
        <div className="st-rows">
          {endpoints.map((endpoint) => (
            <div className="st-row" key={endpoint.id}>
              <div className="st-row__main">
                <div className="st-row__title">
                  <span className="st-mono" style={WRAP}>{endpoint.url}</span>
                </div>
                <div className="st-row__sub">{endpoint.detail}</div>
                <Inline gap={2} wrap>
                  {endpoint.enabled_events.map((selector) => (
                    <Badge key={selector} tone="neutral" pill>{selector}</Badge>
                  ))}
                </Inline>
                <div className="st-row__sub">
                  {'Signed with the secret ending '}
                  <span className="st-mono">{endpoint.secret_last4}</span>
                </div>
              </div>
              <div className="st-row__aside">
                <Tooltip content={`${endpoint.deliveries.succeeded} acknowledged · ${endpoint.deliveries.pending} on the ladder · ${endpoint.deliveries.failed} gave up`}>
                  <span className="st-sub">
                    {/* A bare "0 / 6" beside a status pill reads as a score
                        with no units. The noun is what makes it a fact. */}
                    {`${f.number(endpoint.deliveries.succeeded)} of ${f.number(endpoint.deliveries.succeeded + endpoint.deliveries.pending + endpoint.deliveries.failed)} delivered`}
                  </span>
                </Tooltip>
                <StatusPill status={endpoint.status} title={endpoint.disabled_reason ?? undefined} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- envelope ------------------------------- */

/**
 * What a subscriber receives, and what happened when it was sent.
 *
 * The envelope comes from the server rather than being assembled here, because
 * a screen that builds its own copy of the wire format is a second definition
 * of it — and the first time the two drift, this one is the lie.
 */
function Envelope({ event, preview, loading, error, missing, onRetry }: {
  event: PlatformEvent;
  preview: WebhookPayloadPreview | null;
  loading: boolean;
  error: ApiClientError | null;
  missing: boolean;
  onRetry: () => void;
}) {
  const f = useFormat();

  if (missing) {
    // No delivery module: show the event's own payload and say plainly that
    // the envelope around it is not this screen's to invent.
    return (
      <Stack gap={4}>
        <JsonBlock label="data — the payload this event carries" value={event.data} maxHeight={320} />
        <div className="st-hint">
          {'Nothing is subscribed to this stream in this workspace, so no envelope was built and no delivery was made. '}
          <code className="st-mono">data</code>
          {' above is the object a subscriber would find under '}
          <code className="st-mono">data.object</code>
          {'.'}
        </div>
      </Stack>
    );
  }
  if (loading) return <Loading label="Reading the envelope…" />;
  if (error) return <ListFailure error={error} path={`GET /v1/events/${event.id}/webhook-payload`} onRetry={onRetry} />;
  if (!preview) return null;

  return (
    <Stack gap={5}>
      <JsonBlock label="The envelope a subscriber is posted, signed byte for byte" value={preview.payload} maxHeight={340} />

      <Stack gap={3}>
        <KeyValue label="Signature header" value={<span className="st-mono">{preview.signature.header}</span>} />
        <KeyValue label="Signed material" value={<span className="st-mono">{preview.signature.signed_payload}</span>} />
        <KeyValue
          label="Replay window"
          value={`${preview.signature.algorithm}, rejected past ${f.duration(preview.signature.tolerance_ms)}`}
        />
      </Stack>

      <div>
        <div className="st-hint" style={{ marginBottom: 'var(--space-3)' }}>
          {preview.deliveries.length
            ? `${f.plural(preview.deliveries.length, 'delivery')} of this event`
            : 'Deliveries'}
        </div>
        {preview.deliveries.length === 0 && <div className="st-sub">{preview.detail}</div>}
        {preview.deliveries.map((delivery) => (
          <Collapsible
            key={delivery.id}
            title={
              <Inline gap={3} wrap>
                <StatusPill status={delivery.status} />
                <span className="st-mono" style={WRAP}>{delivery.endpoint_url}</span>
                <span className="st-sub">{`${f.plural(delivery.attempt_count, 'attempt')} of ${delivery.max_attempts}`}</span>
              </Inline>
            }
          >
            <Stack gap={3}>
              <div className="st-row__sub">{delivery.detail}</div>
              {delivery.next_attempt_at && (
                <div className="st-row__sub">{`The next attempt is queued for ${f.dateTime(delivery.next_attempt_at)}.`}</div>
              )}
              <div className="st-rows">
                {(delivery.attempts ?? []).map((attempt) => (
                  <div className="st-row" key={attempt.id}>
                    <div className="st-row__main">
                      <div className="st-row__title">{`Attempt ${attempt.attempt} · ${f.dateTime(attempt.at)}`}</div>
                      <div className="st-row__sub">{attempt.summary}</div>
                      {attempt.response_body && (
                        <div className="st-row__sub">
                          <span className="st-mono" style={WRAP}>{attempt.response_body}</span>
                        </div>
                      )}
                      <div className="st-row__sub">
                        {'Sent with '}
                        <span className="st-mono" style={WRAP}>{attempt.signature}</span>
                      </div>
                    </div>
                    <div className="st-row__aside">
                      <StatusPill status={attempt.status} />
                    </div>
                  </div>
                ))}
                {!(delivery.attempts ?? []).length && (
                  <div className="st-row__sub">This delivery is queued and has not been attempted yet.</div>
                )}
              </div>
            </Stack>
          </Collapsible>
        ))}
      </div>

      {(event.previous === null || event.previous === undefined) && (
        <div className="st-hint">
          {'No '}
          <code className="st-mono">previous_attributes</code>
          {' in the envelope: this event records something that came into existence rather than something that '
            + 'changed.'}
        </div>
      )}
    </Stack>
  );
}

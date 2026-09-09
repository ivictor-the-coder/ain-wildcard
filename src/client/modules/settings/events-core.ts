/**
 * What the event stream can say about the people behind it, on its own.
 *
 * The stream carries `actor_id` and nothing else about the actor, and the only
 * roster this screen has is `/v1/me`'s — which is a join against `memberships`
 * and therefore holds *current* seats only. Removing a teammate deletes that
 * row, so the moment anyone leaves, every event they ever caused reads as a
 * bare `usr_TVRkMLhpY9xBZcxM` in the same plain text as "Dana Whitfield" beside
 * it: an id printed where the reader has been taught to expect a name.
 *
 * The audit trail solved this by reading the address back out of its own
 * `user.invited` summary (`seatsFromTrail`), but the trail is admin-only and
 * `GET /v1/events` is not, so the stream needs its own answer. It has one:
 * `user.invited` and `user.activated` carry `email` in the payload a subscriber
 * receives, and `user.removed` and `user.invitation_cancelled` say the seat is
 * gone. So a teammate the roster has forgotten is named from the stream's own
 * memory of them whenever that memory is on the page.
 *
 * Whenever it is not — the invitation is older than the two hundred events the
 * route will serve, or the actor is a key rather than a person — the id stays
 * an id, styled and labelled as one, with what *is* known about it beside it.
 * That is the floor, not the fix: only the server can close this properly, by
 * expanding the actor on the event the way the object is expanded elsewhere.
 */
import type { TrailSeat } from './audit-core';

/** The fields of an event this reads. `data` is the payload as served. */
export interface StreamEvent {
  type: string;
  object_type: string | null;
  object_id: string | null;
  data: unknown;
}

/** The seat events whose payload carries the address. */
const ADDRESSED = new Set(['user.invited', 'user.activated']);

/** The seat events that say the seat is gone. */
const ENDED = new Set(['user.removed', 'user.invitation_cancelled']);

const emailIn = (data: unknown): string | null => {
  if (!data || typeof data !== 'object') return null;
  const value = (data as { email?: unknown }).email;
  return typeof value === 'string' && value.includes('@') ? value : null;
};

/**
 * Every teammate id the stream names, with what its own payloads can say about
 * them. The same shape the trail produces, so one `actorLabel` names both.
 */
export function seatsFromStream(events: readonly StreamEvent[]): Map<string, TrailSeat> {
  const seats = new Map<string, TrailSeat>();
  for (const event of events) {
    if (event.object_type !== 'user' || !event.object_id) continue;
    const seat = seats.get(event.object_id) ?? { email: null, removed: false };
    if (ADDRESSED.has(event.type)) seat.email = emailIn(event.data) ?? seat.email;
    if (ENDED.has(event.type)) seat.removed = true;
    seats.set(event.object_id, seat);
  }
  return seats;
}

export interface ActorReading {
  /** What to put on screen. */
  label: string;
  /** True when the label is an opaque id: render it as an id, never as a name. */
  isId: boolean;
  /** Why there is no name, short enough for a row's title attribute. */
  note: string | null;
  /** The same, at the length a detail panel has room for. */
  detail: string | null;
}

/**
 * Whether the label the naming ladder produced is a name or an id, and what to
 * say when it is an id.
 *
 * `actorLabel` is the one ladder — roster, then the stream's own memory, then
 * the id — and this reads its answer rather than resolving anything itself, so
 * the two can never disagree about who acted.
 */
export function readActor(id: string | null, kind: string | undefined, label: string): ActorReading {
  if (!id || label !== id) return { label, isId: false, note: null, detail: null };
  if (kind === 'api_key') {
    return {
      label,
      isId: true,
      note: 'An API key with no author recorded — the stream carries the key’s id.',
      detail: 'This event was caused by an API key that has no author on the roster, so the stream records the key '
        + 'rather than a person. The API keys screen names it, for an admin.',
    };
  }
  if (kind === 'user' || kind === 'agent') {
    return {
      label,
      isId: true,
      note: 'Not on this workspace’s roster — a teammate who has been removed, and nothing on this page records their address.',
      detail: 'The names on this screen come from the workspace roster, which holds current seats only: removing a '
        + 'teammate deletes the seat, and every event they ever caused is left holding their id. Nothing on this page '
        + 'names this one — the invitation that carried their address is older than the events the route will serve. '
        + 'The audit trail keeps it.',
    };
  }
  return {
    label,
    isId: true,
    note: `The stream records actor_type ${kind ?? 'unknown'} and this id, and nothing on this page names it.`,
    detail: `This event records actor_type ${kind ?? 'unknown'} with this id. Nothing on this page can name it, so it `
      + 'is shown as the id it is.',
  };
}

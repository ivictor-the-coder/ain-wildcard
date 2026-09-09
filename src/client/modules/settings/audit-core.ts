/**
 * What the trail can say about the people and things it names, on its own.
 *
 * A removed teammate is gone from `/v1/me`'s roster, so the row that records
 * the removal — the one an auditor reads most carefully — named its target as
 * `usr_TVRkMLhpY9xBZcxM · Teammate` and linked to a roster search that found
 * nobody. But the trail already knows who that was: the `user.invited` entry
 * for the same id carries the address in its summary. These helpers read the
 * trail for what it holds, so a target is named wherever the trail can name it
 * and marked as removed wherever it says so.
 */

export interface TrailEntry {
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
}

export interface TrailSeat {
  /** The address the invitation named. */
  email: string | null;
  removed: boolean;
}

/** `Invited nina@northwind.io as analyst` → `nina@northwind.io`. */
const INVITED = /^Invited (\S+@\S+) as \S+$/;

/**
 * `Cancelled the invitation to nina@northwind.io — the link no longer works`.
 * A seat that never accepted is removed by the same route as one that did, and
 * this is the only entry that carries its address.
 */
const CANCELLED = /^Cancelled the invitation to (\S+@\S+)\b/;

/** Every teammate id the trail names, with what it can say about them. */
export function seatsFromTrail(entries: readonly TrailEntry[]): Map<string, TrailSeat> {
  const seats = new Map<string, TrailSeat>();
  for (const entry of entries) {
    if (entry.target_type !== 'user' || !entry.target_id) continue;
    const seat = seats.get(entry.target_id) ?? { email: null, removed: false };
    if (entry.action === 'user.invited') {
      const match = INVITED.exec(entry.summary.trim());
      if (match) seat.email = match[1];
    }
    if (entry.action === 'user.invitation_cancelled') {
      const match = CANCELLED.exec(entry.summary.trim());
      if (match) seat.email = match[1];
      seat.removed = true;
    }
    if (entry.action === 'user.removed') seat.removed = true;
    seats.set(entry.target_id, seat);
  }
  return seats;
}

/**
 * What to call the actor on an entry or an event.
 *
 * `actor_type: 'system'` with no id used to read "The platform", which is a
 * claim: that a job or the seed did this. The event stream carries exactly
 * that pair for `user.invited`, `user.role_changed` and `user.removed` — three
 * things only a signed-in admin can do — because the routes that emit them do
 * not bind the event to the request. A label that says who did it when the
 * record does not is the wrong label; this one says only what the record says.
 *
 * `seats` is the other half of that honesty. The roster behind `name` holds
 * the people who are *still* here, so the moment a teammate is removed every
 * change they ever made read `usr_TVRkMLhpY9xBZcxM` — on the one screen whose
 * whole purpose is accountability, and for exactly the person an auditor is
 * most likely to be asking about. The trail itself recorded their address when
 * they were invited, so a name the roster has forgotten is read back out of
 * it, marked as removed because that is also something the reader needs.
 */
export function actorLabel(
  id: string | null,
  kind: string | undefined,
  name: (id: string) => string | undefined,
  seats?: ReadonlyMap<string, TrailSeat>,
): string {
  if (!id) return 'Unattributed';
  const known = name(id);
  if (known) return known;
  const seat = seats?.get(id);
  if (!seat) return id;
  const called = seat.email ?? id;
  return seat.removed ? `${called} · removed` : called;
}

/** Why an actor is unattributed, for the detail card — or nothing when it is not. */
export function unattributedBecause(id: string | null, kind: string | undefined, requestId: string | null): string | null {
  if (id) return null;
  if (kind === 'system' && !requestId) {
    return 'The record carries actor_type system, no actor id and no request id. That is what a job or the seed writes — '
      + 'and also what the teammate routes write for a change a signed-in admin made, so it cannot be read as either.';
  }
  if (kind === 'system') return 'The record carries actor_type system and no actor id, but it was written inside a request.';
  return `The record carries actor_type ${kind ?? 'unknown'} and no actor id.`;
}

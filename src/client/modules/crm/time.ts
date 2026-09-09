/**
 * Wall-clock arithmetic in the workspace's timezone.
 *
 * Everything the operator reads is rendered in `org.timezone` — the record
 * header, the timeline, the clock chip. A `<input type="datetime-local">` is
 * the one control that does not go through the formatter: the browser both
 * renders and parses it in *its own* zone. So a person in London backdating
 * "yesterday 09:00" on a New York workspace wrote an instant five hours off,
 * and the same instant showed as two different days on one screen.
 *
 * These helpers move an instant to and from a zoned wall-clock string, so the
 * composer speaks the same language as the rest of the product.
 */

import { SECOND } from '../../../shared/time';

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = partsCache.get(timeZone);
  if (!dtf) {
    try {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      // An unknown zone name must not take down the dialog that used it.
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      });
    }
    partsCache.set(timeZone, dtf);
  }
  return dtf;
}

export interface WallClock {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
}

/** The wall clock a named zone showed at an instant. */
export function wallClockIn(ts: number, timeZone: string): WallClock {
  const found: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(ts)) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }
  return {
    year: Number(found.year), month: Number(found.month), day: Number(found.day),
    // Some engines render midnight as hour 24 under h23/hourCycle edge cases.
    hour: Number(found.hour) % 24, minute: Number(found.minute), second: Number(found.second),
  };
}

/** `2026-09-01` — the calendar day that zone was on at that instant. */
export function zonedDay(ts: number, timeZone: string): string {
  const w = wallClockIn(ts, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The value a `datetime-local` input needs to show this instant in that zone. */
export function toZonedInput(ts: number, timeZone: string): string {
  if (!Number.isFinite(ts)) return '';
  const w = wallClockIn(ts, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** How far a zone ran ahead of UTC at an instant, in milliseconds. */
function offsetAt(ts: number, timeZone: string): number {
  const w = wallClockIn(ts, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * A zoneless `YYYY-MM-DDTHH:mm` typed into a `datetime-local` input, read as
 * that wall clock *in the workspace's zone*. Two passes settle the daylight
 * saving boundary, where the first guess can sit on the wrong side of a jump.
 */
export function fromZonedInput(value: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(guess)) return null;
  const first = guess - offsetAt(guess, timeZone);
  const settled = guess - offsetAt(first, timeZone);
  return Number.isFinite(settled) ? settled : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "Eastern Time" rather than "America/New_York" — what a person calls the zone
 * they are entering a time in. Falls back to the IANA name where the engine
 * has no generic name for it.
 */
export function zoneLabel(ts: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' }).formatToParts(ts);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^GMT/.test(name)) return name;
  } catch { /* unknown zone */ }
  return timeZone.replace(/_/g, ' ');
}

/* ------------------------------ service levels ---------------------------- */

const SOON = 24 * 60 * 60 * 1000;

export type SlaState = 'overdue' | 'due_soon' | 'due' | 'closed';

/**
 * A due stamp read against the clock. "SLA due · last week" on an open ticket
 * is a breach the screen was quietly reporting as a date; a closed ticket's
 * target is history whichever side of now it fell.
 */
export function slaState(dueAt: number, now: number, closed: boolean): { state: SlaState; ms: number } {
  const ms = Math.abs(dueAt - now);
  if (closed) return { state: 'closed', ms };
  if (dueAt <= now) return { state: 'overdue', ms };
  if (dueAt - now <= SOON) return { state: 'due_soon', ms };
  return { state: 'due', ms };
}

/* ------------------------------- calendar days ---------------------------- */

/**
 * The instant a calendar day begins in the workspace's zone.
 *
 * The kit's calendar speaks in day *stamps* — midnight UTC on the day whose
 * cell was clicked — because a calendar has no time of day to offer. A `date`
 * property is stored in exactly that shape, so the stamp goes straight in. A
 * `datetime` property is a real instant, and storing the stamp itself put
 * every pick a day early on any workspace west of Greenwich: a task due
 * "Sep 18" was written as `2026-09-18T00:00:00Z`, which is 8pm on the 17th in
 * New York, and that is the day the list, the SLA badge and the record page
 * all read back.
 */
export function zonedDayStart(dayStamp: number, timeZone: string): number {
  if (!Number.isFinite(dayStamp)) return dayStamp;
  const d = new Date(dayStamp);
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00`;
  return fromZonedInput(iso, timeZone) ?? dayStamp;
}

/**
 * Move an instant onto the calendar day a picker handed back, keeping the time
 * of day it already had.
 *
 * Re-dating an SLA target that was due at 17:00 must leave it due at 17:00 on
 * the new day, not at midnight — the picker only offers a day, so the hours it
 * cannot ask about are the hours already on the record. A stamp with nothing
 * behind it lands at the start of that day where the business is.
 */
export function onCivilDay(dayStamp: number, timeZone: string, keepTimeOf: number | null): number {
  const start = zonedDayStart(dayStamp, timeZone);
  if (keepTimeOf === null || !Number.isFinite(keepTimeOf) || !Number.isFinite(dayStamp)) return start;
  // The wall clock, not a millisecond offset from midnight: a day that lost or
  // gained an hour to daylight saving is 23 or 25 hours long, and 09:00 has to
  // stay 09:00 across one of those rather than slip to 08:00.
  const d = new Date(dayStamp);
  const when = wallClockIn(keepTimeOf, timeZone);
  const moved = fromZonedInput(
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(when.hour)}:${pad(when.minute)}`,
    timeZone,
  );
  return moved === null ? start : moved + when.second * SECOND;
}

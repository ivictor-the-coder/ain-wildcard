/**
 * All server time flows through a Clock. Production uses the wall clock;
 * tests and the product's own "time machine" (our answer to Stripe test
 * clocks, but usable on live demo data) use a frozen or offset clock so an
 * operator can watch a renewal, a dunning cycle or a credit expiry play out.
 */
export interface Clock {
  now(): number;
  /** Advance the clock. Returns the new time. Throws on a real clock. */
  advance(ms: number): number;
  set(ts: number): number;
  readonly kind: 'real' | 'virtual';
  /** Offset applied over the wall clock, in ms. Always 0 for a real clock. */
  readonly offset: number;
}

export function realClock(): Clock {
  return {
    kind: 'real',
    offset: 0,
    now: () => Date.now(),
    advance() { throw new Error('Cannot advance a real clock. Use a virtual clock.'); },
    set() { throw new Error('Cannot set a real clock. Use a virtual clock.'); },
  };
}

/** A clock that tracks wall time but carries a persisted offset. */
export function offsetClock(getOffset: () => number, setOffset: (ms: number) => void): Clock {
  return {
    kind: 'virtual',
    get offset() { return getOffset(); },
    now: () => Date.now() + getOffset(),
    advance(ms: number) { setOffset(getOffset() + ms); return this.now(); },
    set(ts: number) { setOffset(ts - Date.now()); return this.now(); },
  };
}

/** A fully frozen clock — deterministic for tests. */
export function frozenClock(start: number): Clock {
  let t = start;
  return {
    kind: 'virtual',
    get offset() { return t - Date.now(); },
    now: () => t,
    advance(ms: number) { t += ms; return t; },
    set(ts: number) { t = ts; return t; },
  };
}

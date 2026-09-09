import v from '../../../shared/validate';

/**
 * An instant a caller can actually type.
 *
 * `v.timestamp()` takes a JSON number or an ISO string, but a query string is
 * always text — so an endpoint that emits `period_end: 1788130545105` would
 * reject that exact value coming back as `?end=1788130545105`. Numeric strings
 * coerce here, which is the difference between an API you can curl and one you
 * can only call from a client that knows the trick.
 */
export const instant = () => v.transform(
  v.union(v.int(), v.timestamp()),
  (value: number) => value,
  { type: 'integer', format: 'unix-ms', description: 'Unix milliseconds, or an ISO-8601 timestamp.' },
);

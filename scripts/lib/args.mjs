/**
 * The command line for the scripts in this directory.
 *
 * There is one rule a hand-rolled parser usually gets wrong, and this one did:
 * **a boolean flag never consumes the token after it.** The old parser decided
 * what `--fresh` meant by looking at the next token — `'true'` if that token
 * started with `--`, otherwise the token itself — so `--fresh` written last on
 * the line had no next token, came back `undefined`, and every
 * `if (args.fresh !== undefined)` in the script went quiet. The flag was
 * accepted, silently ignored, and the stale database it existed to delete was
 * reused for the whole preview.
 *
 * So flags are declared rather than guessed. A name in `booleans` is `true`
 * wherever it appears and takes nothing with it; anything else takes the next
 * token as its value, unless that token is another flag or there isn't one, in
 * which case it is present with no value and the readers below say so out loud
 * rather than handing back a default nobody asked for.
 */

const NEGATIVE = new Set(['false', '0', 'no', 'off']);

/**
 * Split `argv` into named options and positional arguments.
 *
 * @param {string[]} argv           Arguments only — `process.argv.slice(2)`.
 * @param {{ booleans?: string[] }} [opts]  Flags that carry no value.
 * @returns {{ options: Record<string, string | true>, positional: string[] }}
 */
export function parseArgs(argv, opts = {}) {
  const booleans = new Set(opts.booleans ?? []);
  /** @type {Record<string, string | true>} */
  const options = Object.create(null);
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('--')) { positional.push(token); continue; }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const name = body.slice(0, eq);
      if (!name) { positional.push(token); continue; }
      options[name] = body.slice(eq + 1);
      continue;
    }
    if (booleans.has(body)) { options[body] = true; continue; }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { options[body] = true; continue; }
    options[body] = next;
    i++;
  }

  return { options, positional };
}

/** Was the flag passed? `--fresh=false` and its spellings mean it was not. */
export function bool(options, name) {
  const value = options[name];
  if (value === undefined) return false;
  if (value === true) return true;
  return !NEGATIVE.has(value.toLowerCase());
}

/**
 * A flag's string value, or `fallback` when it was not passed at all. A flag
 * passed with nothing after it is a mistake worth stopping for: it is what the
 * old parser turned into `undefined` and then into silence.
 */
export function text(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (value === true) throw new Error(`--${name} needs a value, e.g. --${name} ${fallback === undefined ? '<value>' : fallback}`);
  return value;
}

/** The same, as a whole number, refusing anything that is not one. */
export function int(options, name, fallback) {
  const value = text(options, name, undefined);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} has to be a whole number, not "${value}".`);
  return parsed;
}

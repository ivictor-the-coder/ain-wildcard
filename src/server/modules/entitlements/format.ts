import { formatDate } from '../../../shared/time';
import type { Feature } from './types';

/**
 * The words an entitlement answer is made of.
 *
 * `reason` on a check is not a log line: it is shown to the person who just hit
 * the wall, so it says what they have, what they used, what it would take them
 * to, and when it resets. Every sentence in here is written to be printed
 * unedited by a product that never wants to think about billing copy.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();

export function formatCount(value: number, locale = 'en-US'): string {
  let f = numberFormats.get(locale);
  if (!f) { f = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }); numberFormats.set(locale, f); }
  return f.format(value);
}

/**
 * "seat" → "seats", "GB" → "GB". An all-caps label is an abbreviation and is
 * already its own plural; anything else takes an s, with the two English
 * endings that do not.
 */
export function pluralUnit(unit: string | null | undefined, count: number): string {
  if (!unit) return '';
  if (count === 1) return unit;
  if (unit === unit.toUpperCase() && /[A-Z]/.test(unit)) return unit;
  if (/(s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
  if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
  return `${unit}s`;
}

/** "42 seats", "1 robot", "1,000,000 events" — or just the number, unitless. */
export function quantity(value: number, unit: string | null, locale: string): string {
  const n = formatCount(value, locale);
  return unit ? `${n} ${pluralUnit(unit, value)}` : n;
}

/**
 * Lower-case a feature name for the middle of a sentence, without flattening
 * the acronyms in it: "SAML single sign-on" and "Cross-site benchmarking and
 * OEE reporting" both have to survive.
 */
export function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function lowerFirst(text: string): string {
  const first = text.split(' ')[0] ?? '';
  if (first.length > 1 && first === first.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** How the granting thing is named in a sentence. */
export interface SourceWords {
  /** "Telemetry Cloud Growth", "a support grant", "this account". */
  name: string;
  /** True when the name is a product, so copy can say "included in". */
  isPlan: boolean;
}

export interface ReasonInput {
  feature: Feature;
  locale: string;
  timeZone: string;
  entitled: boolean;
  unlimited: boolean;
  limit: number | null;
  includedLimit: number | null;
  creditUnits: number;
  used: number;
  requested: number;
  remaining: number | null;
  allowed: boolean;
  metered: boolean;
  /**
   * True when the feature names a meter, so `requested` is an increment on top
   * of live consumption. A limit with no meter is a ceiling on a settable value
   * instead, and `requested` is the value being asked for.
   */
  counted: boolean;
  resetsAt: number | null;
  source: SourceWords | null;
  /** The plan the customer is on today, when it is not the granting source. */
  currentPlan: string | null;
}

const on = (source: SourceWords | null): string =>
  !source ? '' : source.isPlan ? ` on ${source.name}` : ` by ${source.name}`;

const includedIn = (source: SourceWords | null): string =>
  !source ? 'on this account' : source.isPlan ? `in ${source.name}` : `by ${source.name}`;

function resetClause(input: ReasonInput): string {
  if (!input.metered || input.resetsAt === null) return '';
  return ` The allowance resets on ${formatDate(input.resetsAt, { locale: input.locale, timeZone: input.timeZone })}.`;
}

function creditClause(input: ReasonInput): string {
  if (input.creditUnits <= 0) return '';
  const units = quantity(input.creditUnits, input.feature.unit_label, input.locale);
  return ` That includes ${units} of prepaid credit.`;
}

/** One sentence a product can show a user, for every outcome of a check. */
export function reasonFor(input: ReasonInput): string {
  const { feature, locale } = input;
  const name = feature.name;
  const unit = feature.unit_label;

  if (!input.entitled) {
    const plan = input.currentPlan;
    return plan
      ? `${name} is not included in ${plan}.`
      : `${name} is not included on this account.`;
  }

  // A component sold under the feature's own name would otherwise stutter:
  // "Bulk data export is included in Bulk data export".
  const stutters = !!input.source && input.source.name.toLowerCase() === name.toLowerCase();

  if (feature.type === 'boolean') {
    return stutters ? `${name} is included.` : `${name} is included ${includedIn(input.source)}.`;
  }

  if (input.unlimited) {
    if (stutters) return `${name} is included with no limit on volume.`;
    if (!input.source) return `${name} is unlimited on this account.`;
    return input.source.isPlan
      ? `${input.source.name} includes unlimited ${lowerFirst(name)}.`
      : `${capitalizeFirst(input.source.name)} makes ${lowerFirst(name)} unlimited.`;
  }

  const limit = input.limit ?? 0;
  const used = input.used;
  const after = used + input.requested;

  // A ceiling on a settable value — retention days, a plan's maximum project
  // count. Nothing is consumed, so the sentence is about the cap, not usage.
  if (!input.counted) {
    if (input.requested === 0) {
      return `${name} is ${quantity(limit, unit, locale)}${on(input.source)}.`;
    }
    return input.allowed
      ? `${name} can be set to ${quantity(input.requested, unit, locale)} — up to ${quantity(limit, unit, locale)} is included ${includedIn(input.source)}.`
      : `${name} cannot be set to ${quantity(input.requested, unit, locale)} — only ${quantity(limit, unit, locale)} is included ${includedIn(input.source)}.`;
  }

  if (!input.allowed) {
    if (input.requested > 0 && used < limit) {
      return `Adding ${quantity(input.requested, unit, locale)} would take you to ${formatCount(after, locale)}, past the ${quantity(limit, unit, locale)} included ${includedIn(input.source)}.`
        + creditClause(input) + resetClause(input);
    }
    if (used >= limit) {
      return input.metered
        ? `You have used all ${quantity(limit, unit, locale)} included ${includedIn(input.source)}.`
          + creditClause(input) + resetClause(input)
        : `All ${quantity(limit, unit, locale)} included ${includedIn(input.source)} are in use.`
          + creditClause(input);
    }
    return `This would take you past the ${quantity(limit, unit, locale)} included ${includedIn(input.source)}.`
      + creditClause(input) + resetClause(input);
  }

  const left = Math.max(0, limit - after);
  if (input.requested > 0) {
    return `Adding ${quantity(input.requested, unit, locale)} takes you to ${formatCount(after, locale)} of ${quantity(limit, unit, locale)}${on(input.source)} — ${formatCount(left, locale)} left.`
      + creditClause(input) + resetClause(input);
  }
  return `You have used ${formatCount(used, locale)} of ${quantity(limit, unit, locale)}${on(input.source)} — ${formatCount(left, locale)} left.`
    + creditClause(input) + resetClause(input);
}

/** The sentence written into an entitlement version's change list. */
export function changeSummary(
  kind: 'granted' | 'revoked' | 'changed',
  feature: Feature,
  from: { value: number | null; unlimited: boolean } | null,
  to: { value: number | null; unlimited: boolean } | null,
  sourceName: string | null,
  locale: string,
): string {
  const by = sourceName ? ` by ${sourceName}` : '';
  const describe = (v: { value: number | null; unlimited: boolean }): string =>
    v.unlimited ? 'unlimited'
      : feature.type === 'boolean' ? 'included'
        : quantity(v.value ?? 0, feature.unit_label, locale);

  if (kind === 'granted' && to) return `${feature.name} granted${by}${feature.type === 'boolean' ? '' : ` at ${describe(to)}`}.`;
  if (kind === 'revoked' && from) return `${feature.name} revoked — it was ${describe(from)}.`;
  if (from && to) {
    if (from.unlimited === to.unlimited && from.value === to.value) return `${feature.name} re-sourced${by}.`;
    const direction = to.unlimited || (to.value ?? 0) > (from.value ?? 0) ? 'raised' : 'lowered';
    return `${feature.name} ${direction} from ${describe(from)} to ${describe(to)}${by}.`;
  }
  return `${feature.name} changed.`;
}

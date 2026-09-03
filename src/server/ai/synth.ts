/**
 * Answer synthesis.
 *
 * The rule here is that every clause has to be earned by a fact that came back
 * from a tool. Templates decide the shape of a sentence; the data decides
 * whether that sentence exists at all. An answer with nothing behind it says so
 * plainly and offers the nearest thing that is true — which is the difference
 * between a copilot people trust and one they stop opening.
 */
import { formatMoney } from '../../shared/money';
import { DAY, formatDate, formatRelative } from '../../shared/time';
import type { WorkspaceProfile } from './grounding';
import type { IntentResult } from './intent';
import type { TimeWindow } from './dates';
import { describeWindow, labelIsPrepositional } from './dates';
import type { MetricDetection, MetricSubject, StageSets } from './metrics';
import { isValueQuestion, metricUndefinedWhenEmpty } from './metrics';
import type { AccountProfileResult, MeteredUsageResult, MetricToolResult, RecordSearchResult, StaleAccountsResult, TimelineItem, WorkspaceSearchResult, RecordAggregateResult } from './functions';
import { formatUnits } from './functions';
import type { ResolvedEntity } from './resolve';
import type { BlockedCapability, WindowPair } from './plan';
import { askedFor } from './plan';
import type { DraftResult } from './draft';
import type { PendingApproval } from './runtime';
import { orderWord, rankingLimit, stageLabelIn, type QualifierVocabulary } from './qualifiers';
import { acronymOf, countOf, formatSignedPercent, humanise, listPhrase, normalise, sentenceJoin, truncate } from './text';

export interface StepResult {
  tool: string;
  ok: boolean;
  why: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
  /** True when this step changed the workspace, not just read it. */
  write?: boolean;
}

export interface Citation { id: string; label: string; type: string }

export interface SynthesisInput {
  question: string;
  intent: IntentResult;
  workspace: WorkspaceProfile;
  window: TimeWindow;
  /** Every period the question named, in the order it named them. */
  windows?: TimeWindow[];
  /** The two periods a comparison measured, when this is one. */
  comparison?: WindowPair | null;
  /** True when the question asks who is biggest rather than what the total is. */
  ranking?: boolean;
  subject: MetricSubject | null;
  entities: ResolvedEntity[];
  steps: StepResult[];
  metric: MetricDetection | null;
  draft: DraftResult | null;
  pendingApprovals: PendingApproval[];
  /** Set when the request asked for a write that could not be prepared. */
  writeBlocked?: { wanted: string; reason: string } | null;
  /** Tool names this run was scoped to, when the caller restricted it. */
  scopedTools?: string[] | null;
  /** Tools the question matched but could not arm, so the answer can say so. */
  skippedTools?: { tool: string; missing: string[] }[];
  /**
   * Which deal stages this workspace counts as open, won and lost.
   *
   * A list lead-in has to name the filter that produced its count, and the only
   * thing that can turn `deal_stage in (qualification, discovery, …)` back into
   * the word "open" is the pipeline definition the workspace publishes.
   */
  stages?: StageSets;
  /**
   * The pipelines and stages this workspace publishes, with their labels.
   *
   * A filter has to be read back in the words the workspace uses for it.
   * Concatenating the property name and the stored value produced "2 deals deal
   * stage Negotiation" and "3 open deals pipeline Renewal" — the parser talking
   * where a sentence belongs.
   */
  vocabulary?: QualifierVocabulary;
  /**
   * Ledger capabilities the question asked for and the run could not use.
   *
   * These lead the answer. A refusal printed under a confident paragraph about
   * something else is not a refusal — the reader has already stopped.
   */
  blocked?: BlockedCapability[];
  /**
   * A scope the run applied through a set of associated records rather than
   * through a column of its own.
   *
   * "How much open pipeline is with pharmaceutical companies?" filters
   * companies and sums deals, so the industry reaches the query as three
   * account ids. The sentence still has to name it, or the reader cannot tell
   * a scoped figure from the workspace total — which is the whole substitution
   * this engine exists to refuse, one step further down.
   */
  associationScopes?: { ids: string[]; label: string; noun: string; objectType: string }[];
  /** The record carried in from the conversation when this turn named none. */
  carriedSubject?: { label: string; pinned: boolean } | null;
  /**
   * Answers this thread has already given.
   *
   * Turns two, three and four each answered correctly on the first line and
   * then reprinted the identical four-paragraph account profile from turn one.
   * A fact the reader has already been given is not context, it is noise in
   * front of the sentence they asked for.
   */
  priorAnswers?: string[];
}

export interface SynthesisOutput {
  content: string;
  citations: Citation[];
  /**
   * Every step that ran and succeeded, and what became of its result.
   *
   * A tool result that reaches nobody is a defect, not a silence: the run spent
   * the budget, the trace says `ok=true`, and the reader is never told their
   * question went unanswered. There are exactly three outcomes — the answer
   * rendered it, it came back with nothing in it to render, or the answer names
   * it and says why — and every `discarded` entry is also stated out loud in
   * the content, by name and with the reason.
   */
  rendering: ResultOutcome[];
}

export interface ResultOutcome {
  tool: string;
  outcome: 'rendered' | 'empty' | 'discarded';
  why: string | null;
}

/* -------------------------------- plumbing -------------------------------- */

const ok = (step: StepResult) => step.ok && step.result !== undefined && step.result !== null;

const resultsOf = <T>(steps: StepResult[], tool: string, guard: (value: unknown) => boolean): T[] =>
  steps.filter((s) => s.tool === tool && ok(s) && guard(s.result)).map((s) => s.result as T);

const isMetric = (value: unknown): boolean => !!value && typeof value === 'object' && 'metric' in (value as object) && 'formatted' in (value as object);
const isProfile = (value: unknown): boolean => !!value && typeof value === 'object' && 'totals' in (value as object) && 'contacts' in (value as object);
const isTimeline = (value: unknown): boolean => !!value && typeof value === 'object' && 'items' in (value as object);
const isSearch = (value: unknown): boolean => !!value && typeof value === 'object' && 'matches' in (value as object);
const isRecordList = (value: unknown): boolean =>
  !!value && typeof value === 'object' && 'records' in (value as object) && 'object_type' in (value as object);
const isAggregate = (value: unknown): boolean => !!value && typeof value === 'object' && 'measure' in (value as object) && 'groups' in (value as object);

export class Facts {
  constructor(private readonly workspace: WorkspaceProfile) {}
  money(amount: number): string {
    return this.moneyIn(amount, this.workspace.currency);
  }
  /** The same, in the currency the figure is actually in. */
  moneyIn(amount: number, currency: string): string {
    return formatMoney({ amount: Math.round(amount), currency }, { locale: this.workspace.locale, trimZeroFraction: true });
  }
  /** A genuine instant — `closed_at`, `created`, when something happened. */
  day(ts: number): string { return formatDate(ts, { locale: this.workspace.locale, timeZone: this.workspace.timezone }); }
  /**
   * A date-only property — `close_date`, `renewal_date`, `due_date`.
   *
   * A date picker writes midnight UTC for the day a person chose, so reading it
   * back in the workspace's zone lands it on the previous evening everywhere
   * west of Greenwich: the board says a deal closes Sep 1 and the answer says
   * Aug 31. Calendar days are read back in the zone they were stored in, which
   * is what `describeWrite` already does for `*_date` properties below.
   */
  calendarDay(ts: number): string { return formatDate(ts, { locale: this.workspace.locale, timeZone: 'UTC' }); }
  ago(ts: number): string { return formatRelative(ts, this.workspace.now, this.workspace.locale); }
  days(ts: number): number { return Math.round((this.workspace.now - ts) / DAY); }
}

const bullet = (line: string) => `• ${line}`;

/**
 * A question whose subject is the ledger, not the CRM record.
 *
 * "What credit does Aldergate have left?" opened with the account card, its
 * buying committee and its open deals, and put the credit balance last. The
 * reader takes the first sentence, so the first sentence has to be the one they
 * asked for.
 */
const LEDGER_QUESTION =
  /\b(credits?|entitlements?|usage|metered?|invoices?|invoiced|subscriptions?|balances?|owe[sd]?|owing|outstanding|past\s+due|overdue|dunning|recovery|quota|allowance|receivables?|collections?|billing|billed)\b/i;

/**
 * What the answer actually used.
 *
 * A step that ran, succeeded and then contributed nothing is the failure this
 * class exists to make impossible. `revenue_collections` returned the ageing,
 * the DSO and the failed-payment exposure, the trace said `ok=true`, and not
 * one of those numbers reached the reader — because the composer had no
 * renderer for that shape and silently moved on. Every composer below marks
 * the payload it consumed; anything still unmarked at the end is recorded as
 * discarded, with the reason, on `analysis.results`.
 */
class Ledger {
  private readonly used = new Set<unknown>();
  use<T>(value: T): T {
    if (value !== null && typeof value === 'object') this.used.add(value);
    return value;
  }
  useAll(values: readonly unknown[]): void { for (const value of values) this.use(value); }
  has(value: unknown): boolean { return this.used.has(value); }
}

/** "Brightline Foods'" — a name that already ends in s does not take another. */
const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/**
 * A database id, in the place a name belongs.
 *
 * Nothing an answer says out loud may be one of these. When a side of a
 * comparison, a group or a write target has no resolvable name, the answer says
 * so rather than printing the row's primary key into a sentence a board reads.
 */
export const RAW_ID = /^[a-z][a-z_]{1,12}_[A-Za-z0-9_]{2,40}$/;

export const looksLikeId = (value: string): boolean => RAW_ID.test(value.trim());

/** A label safe to say out loud, or `null` when the record has no name. */
const namedOrNull = (label: string | null | undefined): string | null =>
  label && !looksLikeId(label) ? label : null;

/** How each metric reads with two periods either side of it. */
const COMPARE_VERB: Record<string, string> = {
  spend: 'spent', revenue: 'collected', invoiced: 'invoiced', closed_won: 'booked',
  closed_lost: 'lost', outstanding: 'carried', pipeline: 'carried', weighted_pipeline: 'carried',
  avg_deal_size: 'averaged', sales_cycle: 'averaged', win_rate: 'closed', mrr: 'held', arr: 'held',
  new_customers: 'added', customers: 'had', deal_count: 'had', open_tickets: 'had',
  tickets_created: 'logged', resolution_time: 'averaged', csat: 'averaged',
};

const verb = (metric: MetricToolResult): string => COMPARE_VERB[metric.metric] ?? 'recorded';

/** What one row of a ranking is, per the source the number came from. */
const ROW_NOUN: Record<string, string> = {
  invoices: 'invoice', subscriptions: 'subscription', deals: 'deal', tickets: 'ticket',
  activities: 'activity', records: 'record',
};

/**
 * Two runs of the same metric over different periods — the shape a real period
 * comparison takes. Two runs over different *accounts* is a different answer,
 * so this returns null for that and the account branch handles it.
 */
function periodPair(metrics: MetricToolResult[]): [MetricToolResult, MetricToolResult] | null {
  if (metrics.length < 2) return null;
  const [a, b] = metrics;
  if (a.metric !== b.metric) return null;
  if ((a.subject?.id ?? null) !== (b.subject?.id ?? null)) return null;
  if (a.window.start === b.window.start && a.window.end === b.window.end) return null;
  return [a, b];
}

/** A write, described the way the person approving it needs to read it. */
export function describeWrite(
  tool: string,
  args: Record<string, unknown>,
  nameOf: (id: string) => string | null = () => null,
): string[] {
  // The card a human approves has to read as records, not as primary keys. An
  // id that resolves to nothing is a target that has changed since the write
  // was prepared, and saying so is the point of showing the card at all. The
  // ids stay in `pending_approvals[].args`, where a machine reads them.
  const named = (id: string) => namedOrNull(nameOf(id)) ?? 'a record I can no longer name';
  const value = (key: string) => (args[key] === undefined || args[key] === null ? '' : String(args[key]));
  if (tool === 'add_note') {
    const ids = Array.isArray(args.record_ids) ? (args.record_ids as unknown[]).map(String) : [];
    return [
      `Note on ${ids.map(named).join(', ') || 'no record'}`,
      value('subject') ? `Subject: ${value('subject')}` : '',
      value('body'),
    ].filter(Boolean);
  }
  if (tool === 'create_record') {
    const properties = (args.properties ?? {}) as Record<string, unknown>;
    const associate = Array.isArray(args.associate_to) ? (args.associate_to as unknown[]).map(String) : [];
    return [
      `New ${humanise(value('object_type')).toLowerCase()}`,
      ...Object.entries(properties)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${humanise(k)}: ${/(_at|_date)$/.test(k) && typeof v === 'number' ? formatDate(v, { timeZone: 'UTC' }) : truncate(String(v), 160)}`),
      associate.length ? `Linked to ${associate.map(named).join(', ')}` : '',
    ].filter(Boolean);
  }
  if (tool === 'update_record') {
    const properties = (args.properties ?? {}) as Record<string, unknown>;
    return [
      `${humanise(value('object_type'))} ${named(value('id'))}`,
      // A date property reads back as a date. The approval card is the last
      // thing a person sees before a write lands, and "Close date →
      // 1796115600000" is not something anybody can approve.
      ...Object.entries(properties).map(([k, v]) => `${humanise(k)} → ${/(_at|_date)$/.test(k) && typeof v === 'number'
        ? formatDate(v, { timeZone: 'UTC' })
        : truncate(String(v), 120)}`),
    ];
  }
  if (tool === 'schedule_followup') {
    return [
      `Follow-up on ${named(value('record_id'))}`,
      `Due in ${value('in_days')} ${value('in_days') === '1' ? 'day' : 'days'}`,
      value('assignee_id') ? `Assigned to ${named(value('assignee_id'))}` : 'Assigned to you',
      value('note'),
    ].filter(Boolean);
  }
  return Object.entries(args).map(([k, v]) => `${humanise(k)}: ${truncate(String(v), 120)}`);
}

/* ------------------------------- composers -------------------------------- */

/** How each metric reads in a sentence — a total is not always "booked". */
function headline(metric: MetricToolResult, who: string, period: string, hasSubject: boolean): string {
  const value = metric.formatted;
  // A stage the question named replaces the metric's own stage set, so the
  // noun has to follow: "8 open deals at the Closed won stage" is a sentence
  // that contradicts itself.
  const dealNoun = metric.scope?.stage ? 'deal' : 'open deal';
  switch (metric.metric) {
    case 'spend': return `${who} spent ${value} in ${period}`;
    case 'revenue': return `${who} collected ${value} in ${period}`;
    case 'invoiced': return hasSubject ? `${who} was invoiced ${value} in ${period}` : `${who} invoiced ${value} in ${period}`;
    case 'outstanding': return `${who} has ${value} outstanding`;
    case 'pipeline': return `${who} is carrying ${value} in ${metric.scope?.stage ? 'pipeline' : 'open pipeline'}`;
    case 'weighted_pipeline': return `${who} has ${value} of weighted pipeline`;
    case 'closed_won': return `${who} booked ${value} in ${period}`;
    case 'closed_lost': return `${who} lost ${value} of business in ${period}`;
    case 'avg_deal_size': return `${who} averaged ${value} per closed-won deal in ${period}`;
    case 'sales_cycle': return `${who} took ${value} on average to close a deal in ${period}`;
    case 'win_rate': return `${who} closed ${value} of the deals it decided in ${period}`;
    case 'churn': return `${who} churned ${value} of its accounts in ${period}`;
    // Phrased so it reads the same whether the rate is one figure or one per
    // currency: "kept 110.44% in GBP, 100.16% in USD of its revenue" does not.
    case 'net_revenue_retention': return `Net revenue retention for ${who} in ${period} was ${value}, expansion and reactivation included`;
    case 'gross_revenue_retention': return `Gross revenue retention for ${who} in ${period} was ${value}, before any expansion`;
    case 'mrr': return `${who} has ${value} in monthly recurring revenue`;
    case 'arr': return `${who} has ${value} in annual recurring revenue`;
    case 'csat': return `Customer satisfaction in ${period} averaged ${value} out of 5`;
    case 'resolution_time': return `${who} took ${value} on average to resolve a ticket in ${period}`;
    // A count needs a noun that agrees with it. "1 open tickets" is the kind of
    // sentence that makes a reader distrust the number in front of it.
    case 'open_tickets': return `${who} has ${countOf(metric.value, 'open ticket')} right now`;
    case 'deal_count': return `${who} has ${countOf(metric.value, dealNoun)} right now`;
    case 'customers': return `${who} has ${countOf(metric.value, 'customer')} on the books`;
    case 'new_customers': return `${who} added ${countOf(metric.value, 'new customer')} in ${period}`;
    case 'tickets_created': return `${who} logged ${countOf(metric.value, 'ticket')} in ${period}`;
    case 'connected_assets': return `${who} has ${countOf(metric.value, 'connected asset')} reporting telemetry`;
    case 'activities': return `${who} logged ${countOf(metric.value, 'activity', 'activities')} in ${period}`;
    case 'meetings': return `${who} held ${countOf(metric.value, 'meeting')} in ${period}`;
    default:
      return metric.snapshot
        ? `${who} has ${value} ${metric.label.toLowerCase()} right now`
        : `${who} has ${value} ${metric.label.toLowerCase()} in ${period}`;
  }
}

/**
 * A movement, in the unit the metric is actually in.
 *
 * A win rate that moved from 78.6% to 75% moved 3.6 percentage points; printing
 * the raw 3.571 next to two correctly formatted percentages is a number with no
 * unit sitting where a unit belongs, and the reader cannot tell what it is.
 */
function unitDelta(magnitude: number, unit: MetricToolResult['unit'], facts: Facts, locale: string, currency?: string | null): string {
  switch (unit) {
    // A change in a euro book is a euro figure. Printing it with the
    // workspace's own symbol says a different number in a different currency.
    case 'money': return currency ? facts.moneyIn(magnitude, currency) : facts.money(magnitude);
    case 'percent': return `${Number(magnitude.toFixed(1))} ${Number(magnitude.toFixed(1)) === 1 ? 'point' : 'points'}`;
    case 'days': return `${Number(magnitude.toFixed(1))} ${Number(magnitude.toFixed(1)) === 1 ? 'day' : 'days'}`;
    case 'hours': return `${Number(magnitude.toFixed(1))} ${Number(magnitude.toFixed(1)) === 1 ? 'hour' : 'hours'}`;
    case 'score': return magnitude.toFixed(2);
    default: return Math.round(magnitude).toLocaleString(locale);
  }
}

function metricSentence(metric: MetricToolResult, input: SynthesisInput, facts: Facts, ledger: Ledger): string[] {
  ledger.use(metric);
  const lines: string[] = [];
  const who = metric.subject ? metric.subject.label : input.workspace.name;
  const period = metric.window.label || describeWindow(input.window, input.workspace.locale);

  if (metric.count === 0 && metric.value === 0) {
    // The scope the question named belongs in the empty sentence too. "No win
    // rate recorded for Q3 2026 to date" under a question about the Expansion
    // pipeline reads as a statement about the whole book.
    const emptyScope = metric.scope?.label ? ` ${metric.scope.label}` : '';
    // A rate with nothing in its denominator is not zero, it is undefined: no
    // deal was decided, so there is no proportion to report either way. The
    // same is true of every average — "no average deal size, so the honest
    // answer is zero" says each of ten open deals is worth nothing — and the
    // basis the measure imposed is named, because the reader did not ask for
    // it: the average is over closed-won deals, and this book has none.
    const basis = metric.source.replace(/^0\s+/, '').replace(/\bdeals\b/, 'deals');
    const because = metric.unit === 'percent'
      ? `no deal in it reached a decision, so there is no rate to report; a zero would say every one of them was lost`
      : metricUndefinedWhenEmpty(metric.metric)
        ? `it is an average over ${basis} and there are none, so there is no average to report; a zero would say the rows there are measured nothing`
        : 'the query matched no rows, so the honest answer is zero rather than a number';
    // A currency the *question* named belongs in the sentence with the zero.
    // "Brightline Foods has no outstanding balance right now" is false — they
    // owe $127,840, 56 days past due — and the EUR scope that makes it true
    // appeared two paragraphs below it.
    const step = input.steps.find((one) => one.result === metric);
    const named = typeof (step?.args as Record<string, unknown> | undefined)?.currency === 'string'
      ? String((step!.args as Record<string, unknown>).currency).toUpperCase()
      : '';
    const book = named ? ` ${named}` : '';
    // A window that has not started is not a window with nothing in it. "How
    // much will we invoice next quarter?" came back as a historical zero for
    // Q4 2026 — a period that has not happened, answered as though it had.
    const ahead = !metric.snapshot && metric.window.start >= input.workspace.now;
    lines.push(ahead
      ? `${period} has not started, so there is no ${metric.label.toLowerCase()}${book}${emptyScope} to report for it — this measure counts what has already been recorded, and a zero would read as a forecast of nothing.`
      : metric.snapshot
        // A snapshot was never measured over the period, so blaming the period
        // for the zero is a second wrong statement on top of the first.
        ? `${who} has no${book} ${metric.label.toLowerCase()}${emptyScope} right now — ${because}.`
        : `${who} has no${book} ${metric.label.toLowerCase()}${emptyScope} recorded for ${period} — ${because}.`);
  } else {
    // The supporting-row clause is dropped when it would just repeat the number.
    const redundant = metric.unit === 'count' && Math.round(metric.value) === metric.count;
    // The pipeline or stage the question named goes in the sentence with the
    // number, not in a note under it. A scoped figure printed under an unscoped
    // sentence reads as the workspace total, which is how a $1.46M renewal book
    // was reported as $9.0M.
    const scoped = metric.scope?.label ? ` ${metric.scope.label}` : '';
    lines.push(`${headline(metric, who, period, !!metric.subject)}${scoped}${redundant ? '' : `, from ${metric.source}`}.`);
  }

  if (metric.change && metric.count > 0) {
    const direction = metric.change.delta > 0 ? 'up' : metric.change.delta < 0 ? 'down' : 'flat';
    const deltaText = unitDelta(Math.abs(metric.change.delta), metric.unit, facts, input.workspace.locale, metric.currency);
    lines.push(direction === 'flat'
      ? `That is level with the preceding period (${metric.change.previous_formatted}).`
      : `That is ${direction} ${deltaText}${metric.change.percent !== null ? ` (${formatSignedPercent(metric.change.percent)})` : ''} against ${metric.change.previous_formatted} in the period before.`);
  }
  if (metric.window.partial && !metric.snapshot) lines.push(`${period} is still running, so this is a period-to-date figure.`);
  // A question about movement, answered with a figure that has no history
  // behind it, reads as an answer to the question about movement. Saying
  // nothing here is how "did MRR grow this year?" got a number and no warning
  // that the number cannot say whether anything grew.
  if (metric.snapshot && !metric.change && CHANGE_QUESTION.test(input.question) && !input.steps.some((s) => ok(s) && isRevenueMovement(s.result))) {
    lines.push([
      `That is where ${metric.label.toLowerCase()} stands today, not whether it moved:`,
      `it is recomputed from the rows that stand right now, so on its own it cannot tell you the direction.`,
      `Ask for the movement — new business, expansion, contraction and churn month by month — or for invoiced,`,
      `revenue or closed-won bookings, all of which measure a period rather than a moment.`,
    ].join(' '));
  }
  if (metric.note) lines.push(metric.note);
  return lines;
}

/** A question about movement rather than about a level. */
const CHANGE_QUESTION =
  /\b(grow(?:n|ing|th)?|grew|increase[ds]?|decrease[ds]?|decline[ds]?|fall(?:en|ing)?|fell|rise|risen|rose|shrink|shrank|trend(?:ing|ed)?|change[ds]?|movement|moved|up\s+or\s+down|year\s+on\s+year|month\s+on\s+month|since\s+last)\b/i;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/**
 * A comparison measures two periods. When the question named more, the answer
 * has to say which ones it left out — a period the caller named, parsed, and
 * then never saw again is the same silent substitution as measuring the wrong
 * quarter, just later in the sentence.
 */
function droppedPeriods(input: SynthesisInput, measured: string[]): string[] {
  const named = input.windows ?? [];
  if (named.length <= measured.length) return [];
  const dropped = named.filter((w) => !measured.includes(w.label));
  if (!dropped.length) return [];
  return [[
    `You named ${numberWord(named.length)} periods; I compared ${listPhrase(measured)} and left ${listPhrase(dropped.map((w) => w.label))} out —`,
    `a comparison is between two periods.`,
    `Ask again naming two, or ask about ${listPhrase(dropped.map((w) => w.label), 'or')} on ${dropped.length === 1 ? 'its' : 'their'} own.`,
  ].join(' ')];
}

/**
 * The ranked answer: who is biggest, in order, with the money on every row.
 * This is what "which accounts booked the most" has to return — the total alone
 * does not answer it, and a list of records ordered by recency answers a
 * different question entirely.
 */
function rankedAnswer(metric: MetricToolResult, input: SynthesisInput): string[] {
  // Which end of the ranking ran. Reading the rows from the bottom and calling
  // the first of them "the biggest" is the answer contradicting its own list.
  const ascending = input.steps.find((step) => step.result === metric)?.args.direction === 'asc';
  const grouped: { key: string; label: string; formatted: string; value: number; count: number; currency: string | null }[] =
    metric.groups.length ? metric.groups : metric.top_accounts.map((a) => ({
      key: a.id, label: a.label, formatted: a.formatted, value: 0, count: 0, currency: a.currency ?? null,
    }));
  const rows = grouped.filter((row) => !looksLikeId(row.label));
  const period = metric.snapshot ? 'right now'
    : metric.window.label === 'all time' ? 'across all time'
      : labelIsPrepositional(metric.window.label) ? metric.window.label
        : `in ${metric.window.label}`;
  const noun = metric.label.toLowerCase();
  if (!rows.length) {
    return grouped.length
      ? [
          `I can rank ${countOf(grouped.length, 'group')} by ${noun} ${period}, but none of them carries a name I can print — every row came back as a bare id.`,
          `I will not put primary keys in a ranking, so here is the total instead: ${metric.formatted} from ${metric.source}.`,
        ]
      : [
          `Nothing to rank: no account has any ${noun} ${period}, so the total is ${metric.formatted} and the list would be empty.`,
          `That is the honest answer rather than a ranking of records by how recently they were touched.`,
        ];
  }
  // "Top 5" means five. Asking for a number and getting eight is the same class
  // of not-listening as asking for a quarter and getting a year.
  // The cut-off, wherever the sentence puts it. Reading only "top N" meant
  // "give me the 4 largest accounts by revenue" came back with eight rows per
  // book — the reader's own number dropped, silently, by a renderer that had
  // one phrasing of it hard-coded. The ledger already parses every phrasing;
  // this reads the same parser rather than a second, smaller one.
  const asked = rankingLimit(input.question) ?? 0;
  const size = asked > 0 ? asked : 8;
  // One ordering over three currencies puts €292,800 above $498,854 because
  // 292,800 is the larger number, which is not a ranking of anything. With no
  // exchange rates in this platform each currency is ranked in its own book.
  // The books the metric measured, not just the ones that made the top rows:
  // a currency with one small account still has a book, and dropping it from
  // the sentence would say the workspace bills in fewer currencies than it does.
  const currencies = metric.books.length
    ? metric.books.map((b) => b.currency)
    : [...new Set(rows.map((r) => r.currency).filter((c): c is string => !!c))];
  if (metric.unit === 'money' && currencies.length > 1) {
    const home = rows.find((r) => r.currency === currencies[0]) ?? rows[0];
    const lines = [
      ascending
        ? `${home.label} has the least ${noun} ${period} in ${(home.currency ?? '').toUpperCase()}, at ${home.formatted}.`
        : `${home.label} is the biggest by ${noun} ${period} in ${(home.currency ?? '').toUpperCase()}, at ${home.formatted}.`,
      [
        `${noun.charAt(0).toUpperCase()}${noun.slice(1)} here is booked in ${listPhrase(currencies.map((c) => c.toUpperCase()))}`,
        `and this platform holds no exchange rates, so ranking them in one list would order euros against dollars.`,
        `Each book is ranked on its own, ${ascending ? 'smallest' : 'largest'} first:`,
      ].join(' '),
    ];
    for (const currency of currencies) {
      const book = rows.filter((r) => r.currency === currency).slice(0, size);
      const total = metric.books.find((b) => b.currency === currency);
      lines.push(`${currency.toUpperCase()}${total ? ` — ${total.formatted} across ${countOf(total.count, ROW_NOUN[metric.sourceKind] ?? 'record')}` : ''}:`);
      lines.push(book.length
        ? book.map((row, index) =>
          `${index + 1}. ${row.label} — ${row.formatted}${row.count ? ` from ${countOf(row.count, ROW_NOUN[metric.sourceKind] ?? 'record')}` : ''}`).join('\n')
        : bullet(`No account in this book carries a name I can print, so the total above is all I will state for it.`));
      const held = rows.filter((r) => r.currency === currency).length;
      if (asked > 0 && held > size) {
        lines.push(`${countOf(held - size, 'other account')} had ${noun} ${period} in ${currency.toUpperCase()}; say a larger number and I will show them.`);
      }
    }
    if (!(input.windows ?? []).length && !metric.snapshot) {
      lines.push(`You named no period, so this covers ${metric.window.label} — name a quarter or a year and I will re-rank on it.`);
    }
    return lines;
  }
  const shown = rows.slice(0, size);
  const [top, ...rest] = shown;
  const tail = metric.value > 0 && metric.unit === 'money' && !metric.mixedCurrency ? ` of ${metric.formatted} across the workspace` : '';
  const lines = [
    ascending
      ? `${top.label} has the least ${noun} ${period}, at ${top.formatted}${tail}.`
      : `${top.label} is the biggest by ${noun} ${period}, at ${top.formatted}${tail}.`,
  ];
  lines.push(shown.map((row, index) =>
    `${index + 1}. ${row.label} — ${row.formatted}${row.count ? ` from ${countOf(row.count, ROW_NOUN[metric.sourceKind] ?? 'record')}` : ''}`).join('\n'));
  if (asked > 0 && rows.length > asked) {
    lines.push(`${countOf(rows.length - asked, 'other account')} had ${noun} ${period}; say a larger number and I will show them.`);
  }
  if (!rest.length) lines.push(`Only one account has any ${noun} ${period}, so there is nothing behind it to rank.`);
  if (!(input.windows ?? []).length && !metric.snapshot) {
    lines.push(`You named no period, so this covers ${metric.window.label} — name a quarter or a year and I will re-rank on it.`);
  }
  return lines;
}

/**
 * The verb a date property reads as in a sentence about the rows it filtered.
 *
 * "13 deal records in the workspace" was the lead-in on a list of the thirteen
 * deals closing in September, out of seventy-seven the workspace holds. The
 * count was right and the sentence around it was false, which is the worse
 * half: a reader takes the sentence.
 */
/** The same dates as a scope clause rather than as a verb phrase. */
const DATE_SCOPE: Record<string, string> = {
  close_date: 'closing in',
  created: 'created in',
  updated: 'last updated in',
  occurred_at: 'that happened in',
  resolved_at: 'resolved in',
  became_customer_at: 'that became customers in',
  last_activity_at: 'last touched in',
};

/** The CRM property each catalogue money measure is a sum of. */
const MEASURE_PROPERTY: Record<string, string> = {
  pipeline: 'amount', weighted_pipeline: 'weighted_amount',
  closed_won: 'amount', closed_lost: 'amount', avg_deal_size: 'amount',
};

/** "Who owns the biggest deal?" — a question whose answer is a person's name. */
const OWNER_QUESTION = /\bwho\s+(?:owns?|has|have|holds?|is\s+(?:the\s+)?(?:owner|rep|ae))\b/i;

const DATE_VERB: Record<string, string> = {
  close_date: 'close',
  created: 'were created',
  occurred_at: 'happened',
  resolved_at: 'were resolved',
  became_customer_at: 'became customers',
  last_activity_at: 'were last touched',
};

/**
 * The word a set of conditions actually means, when there is one.
 *
 * "7 tickets match" tells a reader nothing about which seven. The stage and
 * status filters the planner builds are the two that matter, and both have a
 * plain English name once the pipeline definition is in hand.
 */
const OPEN_TICKET_STATUSES = ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'];

/**
 * Object types the CRM actually stores, so an empty search of one is a fact.
 *
 * An empty `record_search` for an invoice means the CRM does not hold invoices,
 * not that the workspace has none — the ledger answers that one.
 */
const CRM_LIST_TYPES = new Set(['company', 'contact', 'deal', 'ticket', 'task', 'note', 'call', 'meeting', 'email']);

function conditionPhrase(
  conditions: { property?: string; value?: unknown; values?: unknown[] }[],
  stages: StageSets | undefined,
): string | null {
  for (const condition of conditions) {
    const values = (Array.isArray(condition.values) ? condition.values : condition.value === undefined ? [] : [condition.value])
      .map((v) => String(v));
    if (!values.length) continue;
    const every = (set: string[] | undefined) => !!set?.length && values.every((v) => set.includes(v)) && values.length === set.length;
    if (condition.property === 'deal_stage') {
      if (every(stages?.open)) return 'open';
      if (every(stages?.won)) return 'closed-won';
      if (every(stages?.lost)) return 'closed-lost';
    }
    if (condition.property === 'status' && values.length === OPEN_TICKET_STATUSES.length
      && values.every((v) => OPEN_TICKET_STATUSES.includes(v))) return 'open';
  }
  return null;
}

/** How each operator reads in a sentence about the rows it kept. */
const OP_PHRASE: Record<string, string> = {
  gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most',
};

/** A column that holds an instant, whose thresholds are ages rather than amounts. */
const DATE_COLUMN = /(_at|_date)$|^(created|updated)$/;

/**
 * A threshold on a stored count, in the column's own words.
 *
 * `connected_assets` is a plural of things you can have more than 500 of;
 * `probability` is a scalar a row has one of. Reading both as "worth more than
 * N" said money about neither.
 */
function countNoun(property: string, comparator: string, value: number): string {
  const counted = property.replace(/_count$/, '');
  const noun = humanise(counted).toLowerCase();
  if (property.endsWith('_count')) return `${comparator} ${value.toLocaleString()} ${noun}s`;
  if (/s$/.test(noun)) return `${comparator} ${value.toLocaleString()} ${noun}`;
  return `a ${noun} of ${comparator} ${value.toLocaleString()}`;
}

/**
 * Every filter the search actually ran, said out loud.
 *
 * The rule this enforces: the headline describes the conditions that were sent,
 * never the population. "77 deal records in the workspace" over a list of five
 * deals above half a million is a true count of the wrong set, and a reader
 * takes the sentence.
 */
function conditionClauses(
  conditions: { property?: string; op?: string; value?: unknown; values?: unknown[] }[],
  facts: Facts,
  adjective: string | null,
  vocabulary?: QualifierVocabulary,
): string[] {
  const clauses: string[] = [];
  const labelFor = (list: { value: string; label: string }[] | undefined, value: string): string =>
    list?.find((row) => row.value === value)?.label ?? humanise(value);
  // The pipeline in the same filter set decides what the stage is called:
  // `discovery` is "Scoping" in Expansion and "Discovery" in New business, and
  // a list scoped to one that reads back the other's word misdescribes itself.
  const scopedPipeline = conditions.find((c) => String(c.property ?? '') === 'pipeline'
    && typeof c.value === 'string')?.value as string | undefined;
  const stageName = (value: string): string => (vocabulary
    ? stageLabelIn(vocabulary, value, scopedPipeline ?? null) ?? labelFor(vocabulary.stages, value)
    : humanise(value));
  for (const condition of conditions) {
    const property = String(condition.property ?? '');
    const op = String(condition.op ?? 'eq');
    // The stage or status filter is already carried by the adjective.
    if (adjective && (property === 'deal_stage' || property === 'status')) continue;
    // A stage and a pipeline have names people use out loud. "deal stage
    // Negotiation" is the column and the stored value with a space between
    // them, which is how the parser would say it.
    if (property === 'deal_stage' || property === 'pipeline') {
      const raw = (Array.isArray(condition.values) ? condition.values : condition.value === undefined ? [] : [condition.value]).map(String);
      if (raw.length && raw.length <= 3) {
        const names = raw.map((value) => property === 'pipeline'
          ? labelFor(vocabulary?.pipelines, value)
          : stageName(value));
        clauses.push(property === 'pipeline'
          ? `in the ${listPhrase(names)} pipeline${names.length > 1 ? 's' : ''}`
          : `at the ${listPhrase(names)} stage${names.length > 1 ? 's' : ''}`);
        continue;
      }
    }
    if (op === 'is_not_set') { clauses.push(`with no ${humanise(property).toLowerCase()}`); continue; }
    if (op === 'is_set') { clauses.push(`with a ${humanise(property).toLowerCase()}`); continue; }
    // A threshold on a date column is an age, not a price. Rendering the epoch
    // milliseconds through the money phrase produced "worth less than
    // 1,783,185,687,392" over a correct set of rows — the filter applied, and
    // the sentence describing it nonsense.
    if (OP_PHRASE[op] && typeof condition.value === 'number' && DATE_COLUMN.test(property)) {
      const days = Math.max(0, facts.days(condition.value));
      const longer = op === 'lt' || op === 'lte';
      clauses.push(property === 'stage_entered_at'
        ? `in that stage for ${longer ? 'more' : 'less'} than ${days} ${days === 1 ? 'day' : 'days'}`
        : `${humanise(property).toLowerCase()} ${longer ? 'more' : 'less'} than ${days} ${days === 1 ? 'day' : 'days'} ago`);
      continue;
    }
    // A stored count whose unit is in its own column name reads as a term, not
    // as a bare number after a machine name: "contract term months 36".
    const unit = property.match(/_(months|days|years|weeks)$/)?.[1];
    if (unit && typeof condition.value === 'number' && (op === 'eq' || OP_PHRASE[op])) {
      const noun = humanise(property.replace(/_(months|days|years|weeks)$/, '')).toLowerCase();
      clauses.push(op === 'eq'
        ? `on a ${condition.value}-${unit.replace(/s$/, '')} ${noun}`
        : `with a ${noun} of ${OP_PHRASE[op]} ${condition.value} ${unit}`);
      continue;
    }
    if (OP_PHRASE[op] && typeof condition.value === 'number') {
      const money = /amount|value|revenue|price|cost|spend/.test(property);
      if (money) { clauses.push(`worth ${OP_PHRASE[op]} ${facts.money(condition.value)}`); continue; }
      // A count is not a price. "7 companies worth more than 500" over a
      // `connected_assets` threshold reads as half a thousand dollars, and the
      // column the reader named is nowhere in the sentence — the same silent
      // substitution as a dropped filter, printed as a caption.
      clauses.push(`with ${countNoun(property, OP_PHRASE[op], condition.value)}`);
      continue;
    }
    const values = (Array.isArray(condition.values) ? condition.values : condition.value === undefined ? [] : [condition.value])
      .map((v) => humanise(String(v)));
    if (!values.length || values.length > 3) continue;
    clauses.push(`${humanise(property).toLowerCase()} ${values.length === 1 ? values[0] : listPhrase(values)}`);
  }
  return clauses;
}

/** The lead-in for a list: what was counted, and every filter that produced it. */
function listLead(list: RecordSearchResult, args: Record<string, unknown>, input: SynthesisInput): string {
  const noun = countOf(list.total, list.object_type);
  const clauses: string[] = [];
  const start = Number(args.start ?? NaN);
  const end = Number(args.end ?? NaN);
  const dateProperty = typeof args.date_property === 'string' ? args.date_property : null;
  // The window the plan actually passed, named the way the question named it.
  const period = dateProperty && Number.isFinite(start) && Number.isFinite(end)
    ? (input.windows ?? []).find((w) => w.start === start && w.end === end)?.label
      ?? (input.window.start === start && input.window.end === end ? input.window.label : null)
    : null;
  if (typeof args.owner_id === 'string') {
    const owner = input.workspace.people.find((p) => p.id === args.owner_id);
    if (owner) clauses.push(`owned by ${owner.name}`);
  }
  if (input.subject && args.associated_to === input.subject.id) clauses.push(`on ${input.subject.label}`);
  const listAssociation = associationClause(args, input);
  if (listAssociation) clauses.push(listAssociation);
  const conditions = Array.isArray(args.conditions) ? (args.conditions as { property?: string; op?: string; value?: unknown; values?: unknown[] }[]) : [];
  const qualifier = conditionPhrase(conditions, input.stages);
  const facts = new Facts(input.workspace);
  clauses.push(...conditionClauses(conditions, facts, qualifier, input.vocabulary));
  const filtered = conditions.length > 0;
  // Zero rows is an answer, and "0 closed-lost deals" is a table cell. The
  // sentence a reader needs says no.
  const qualified = list.total === 0
    ? `No ${qualifier ? `${qualifier} ` : ''}${list.object_type}s`
    : qualifier
      ? `${list.total} ${qualifier} ${list.object_type}${list.total === 1 ? '' : 's'}`
      : noun;
  if (period) {
    // A deal that is already closed did not "close in 2026" in the future
    // tense the present verb reads as — it closed.
    const verb = qualifier?.startsWith('closed') && dateProperty === 'close_date'
      ? 'closed'
      : DATE_VERB[dateProperty as string] ?? 'fall';
    // A close date runs to the end of the period whether or not the period has
    // finished, so "Sep 2026 to date" would describe a range these rows are not
    // in: three of them close after today.
    const label = dateProperty === 'close_date' ? period.replace(/\s+to date$/i, '') : period;
    // "close in after December 2026" — a comparator label brings its own
    // preposition, and pasting a second one in front of it garbles the only
    // sentence that says which side of the date the answer is on.
    const into = labelIsPrepositional(label) ? '' : 'in ';
    return `${qualified}${clauses.length ? ` ${listPhrase(clauses)}` : ''} ${verb} ${into}${label}.`;
  }
  // "4 open deals worth more than $500,000" already says what was counted;
  // "match" after it is the parser talking. It is only needed when the filters
  // have no plain-English name.
  if (qualifier || clauses.length) return `${qualified}${clauses.length ? ` ${listPhrase(clauses)}` : ''}.`;
  if (filtered) {
    return `${qualified} ${list.total === 1 ? 'matches' : 'match'}.`;
  }
  return `${countOf(list.total, `${list.object_type} record`)} in the workspace.`;
}

/**
 * A record aggregate, in English.
 *
 * "count of records for contact records: 148 across 148 records." was the
 * measure id and the object type concatenated with a colon between them —
 * machine-generated non-English with the right number inside it, and the
 * conditions that produced the number nowhere in the sentence.
 */

/** The clause naming a scope the plan applied through a set of associated records. */
function associationClause(args: Record<string, unknown>, input: SynthesisInput): string | null {
  const ids = Array.isArray(args.associated_to_any) ? (args.associated_to_any as string[]) : null;
  if (!ids?.length) return null;
  const scope = (input.associationScopes ?? []).find((one) =>
    one.ids.length === ids.length && one.ids.every((id, i) => id === ids[i]));
  if (!scope) return `at ${ids.length} named ${ids.length === 1 ? 'record' : 'records'}`;
  return `at the ${scope.ids.length} ${scope.objectType === 'company' ? 'account' : scope.objectType}${scope.ids.length === 1 ? '' : 's'}`
    + ` whose ${scope.noun.toLowerCase()} is ${scope.label}`;
}

function aggregateSentence(agg: RecordAggregateResult, input: SynthesisInput, ledger: Ledger): string[] {
  ledger.use(agg);
  const step = input.steps.find((s) => s.result === agg);
  const args = (step?.args ?? {}) as Record<string, unknown>;
  const conditions = Array.isArray(args.conditions) ? (args.conditions as { property?: string; op?: string; value?: unknown; values?: unknown[] }[]) : [];
  const facts = new Facts(input.workspace);
  const qualifier = conditionPhrase(conditions, input.stages);
  const scope: string[] = [...conditionClauses(conditions, facts, qualifier, input.vocabulary)];
  // A rep named in the question is the answer's scope, and an answer that
  // never mentions them gives the reader no signal the filter was applied.
  const owner = typeof args.owner_id === 'string'
    ? input.workspace.people.find((p) => p.id === args.owner_id)
    : undefined;
  if (owner) scope.push(`owned by ${owner.name}`);
  if (input.subject && args.associated_to === input.subject.id) scope.push(`on ${input.subject.label}`);
  const association = associationClause(args, input);
  if (association) scope.push(association);
  // A window the aggregate actually filtered on belongs in the sentence: "3
  // closed-won deals" and "3 closed-won deals in Q2 2026" are different claims,
  // and the second is the one the plan computed.
  const start = Number(args.start ?? NaN);
  const end = Number(args.end ?? NaN);
  const dateProperty = typeof args.date_property === 'string' ? args.date_property : null;
  const period = dateProperty && Number.isFinite(start) && Number.isFinite(end)
    ? (input.windows ?? []).find((w) => w.start === start && w.end === end)?.label
      ?? (input.window.start === start && input.window.end === end ? input.window.label : null)
    : null;
  if (period) {
    const label = dateProperty === 'close_date' ? period.replace(/\s+to date$/i, '') : period;
    const preposition = dateProperty === 'close_date'
      ? (qualifier?.startsWith('closed') ? 'closed in' : 'closing in')
      : DATE_SCOPE[dateProperty as string] ?? 'in';
    scope.push(`${preposition} ${label}`);
  }
  const where = scope.length ? ` ${scope.join(', ')}` : '';
  // `measure` arrives as the tool's own label — "count of records", "sum of
  // Amount" — which is a column heading, not a clause in a sentence.
  const counting = agg.measure === 'count of records';
  const subject = qualifier
    ? `${agg.matched_records.toLocaleString(input.workspace.locale)} ${qualifier} ${agg.object_type}${agg.matched_records === 1 ? '' : 's'}`
    : countOf(agg.matched_records, agg.object_type);
  // `record_aggregate` reports its measure as a column heading — "sum of
  // amount", "sum of weighted amount" — and those are raw CRM property keys.
  // The metric path phrases the identical figure as "open pipeline"; one run
  // must not speak two vocabularies about the same number.
  const property = typeof args.property === 'string' ? args.property : null;
  // ...unless the rows the step actually measured contradict the measure's own
  // name. "What is the total value of deals we won in the Renewal pipeline
  // last year?" ran a closed-won aggregate and headlined it "$0 in open
  // pipeline across 0 closed-won deals" — the noun and the set in one clause,
  // disagreeing.
  const outcome = conditions.find((c) => String(c.property ?? '') === 'deal_stage');
  const decided = !!outcome && (Array.isArray(outcome.values) ? outcome.values : [outcome.value])
    .every((value) => /^closed_/.test(String(value)));
  const measured = !counting && input.metric && property
    && MEASURE_PROPERTY[input.metric.metric.id] === property
    && !(decided && /pipeline/i.test(input.metric.metric.label))
    ? input.metric.metric.label.toLowerCase()
    : null;
  const lines = [counting
    ? owner
      ? `${owner.name} has ${subject}${where.replace(`, owned by ${owner.name}`, '').replace(` owned by ${owner.name}`, '')}.`
      : `${input.workspace.name} has ${subject}${where}.`
    : measured
      ? `${agg.formatted} in ${measured} across ${subject}${where}.`
      // No catalogue measure behind it, so the property's own name is the best
      // available — but as English, not as a column key.
      : `${agg.formatted} is the ${agg.measure.toLowerCase().replace(/^sum of /, 'total ').replace(/^avg of /, 'average ').replace(/_/g, ' ')} across ${subject}${where}.`];
  if (agg.groups.length) {
    lines.push(`Breakdown: ${agg.groups.slice(0, 8).map((g) => `${g.label} ${g.value.toLocaleString(input.workspace.locale)}`).join(' · ')}.`);
  }
  return lines;
}

function metricBreakdown(metric: MetricToolResult): string[] {
  const lines: string[] = [];
  if (metric.groups.length) {
    const rows = metric.groups.slice(0, 8).map((g) => `${g.label} ${g.formatted}`);
    lines.push(`Breakdown: ${rows.join(' · ')}.`);
  }
  if (metric.top_accounts.length) {
    lines.push(`Biggest contributors: ${metric.top_accounts.map((a) => `${a.label} ${a.formatted}`).join(' · ')}.`);
  }
  return lines;
}

/**
 * The one sentence the question actually asked for, put first.
 *
 * "Who owns the Meridian Forge Systems account?" was answered with four
 * paragraphs of industry, employees, connected assets, open deals, tickets and
 * buying committee, with "owned by Marcus Ilori" as a trailing clause of the
 * first sentence. "Who is the CFO?" got the same four paragraphs, with the CFO
 * as an incidental clause inside the committee list. The profile is good
 * context; it is not an answer, and a reader stops at the first sentence.
 */
function leadAnswer(question: string, profile: AccountProfileResult, facts: Facts): string | null {
  const text = normalise(question);

  if (/\b(who\s+owns|who\s+is\s+(?:the\s+)?(?:owner|account\s+(?:owner|manager|executive|exec))|whose\s+account|which\s+rep\s+owns|owner\s+of)\b/.test(text)) {
    return profile.owner
      ? `${profile.name} is owned by ${profile.owner}.`
      : `${profile.name} has no owner on the record — nobody is assigned to it.`;
  }

  // A role question is matched against the titles this account actually
  // carries, and its acronym, so "CFO" reaches "Chief Financial Officer"
  // without a hard-coded table of job titles.
  if (/\b(who\s+is|who'?s|who\s+are|contact\s+for|which\s+contact)\b/.test(text) || /\b(cfo|ceo|cto|coo|cio|ciso|cro|cmo)\b/.test(text)) {
    const hits = profile.contacts.filter((contact) => {
      if (!contact.title) return false;
      const title = normalise(contact.title);
      const acronym = acronymOf(contact.title).toLowerCase();
      return (title.length > 3 && text.includes(title))
        || (acronym.length >= 2 && new RegExp(`\\b${acronym}\\b`).test(text));
    });
    if (hits.length) {
      return hits.length === 1
        ? `${hits[0].name} is ${profile.name}'s ${hits[0].title}${hits[0].email ? ` — ${hits[0].email}` : ''}${hits[0].role ? `, mapped as the ${hits[0].role.toLowerCase()}` : ''}.`
        : `${profile.name} has ${countOf(hits.length, 'contact')} with that title: ${listPhrase(hits.map((c) => `${c.name}${c.email ? ` (${c.email})` : ''}`))}.`;
    }
    // Only claim the absence when the question really did name a role.
    const role = text.match(/\b(cfo|ceo|cto|coo|cio|ciso|cro|cmo)\b/);
    if (role && profile.contacts.length) {
      return `No contact on ${profile.name} carries that title. The buying committee is ${listPhrase(profile.contacts.slice(0, 4).map((c) => `${c.name}${c.title ? ` (${c.title})` : ''}`))}.`;
    }
  }

  if (/\b(when\s+did\s+(?:we|anyone)\s+last|last\s+(?:touch(?:ed)?|contact(?:ed)?|activity|spoke|talked)|how\s+long\s+since)\b/.test(text)) {
    const days = profile.last_activity.days_ago;
    return days === null || days === undefined
      ? `Nothing has ever been logged on ${profile.name} — the timeline is empty.`
      : `${profile.name} was last touched ${days} ${days === 1 ? 'day' : 'days'} ago${profile.last_activity.at ? ` (${facts.day(profile.last_activity.at)})` : ''}${profile.last_activity.summary ? `: "${profile.last_activity.summary}"` : ''}.`;
  }

  if (/\b(how\s+many\s+(?:connected\s+)?(?:assets|machines|robots))\b/.test(text) && profile.properties.connected_assets) {
    return `${profile.name} has ${Number(profile.properties.connected_assets).toLocaleString('en-US')} connected assets reporting telemetry.`;
  }

  if (/\b(what\s+(?:deals?|opportunit(?:y|ies))\s+(?:are|is)\s+open|which\s+deals?\s+(?:are|is)\s+open|open\s+deals?)\b/.test(text)) {
    return profile.open_deals.length
      ? `${profile.name} has ${countOf(profile.open_deals.length, 'open deal')} worth ${profile.totals.open_pipeline_formatted}.`
      : `${profile.name} has no open deals — nothing on it is still in play.`;
  }

  return null;
}

/** True when this thread has already printed that account's profile. */
function alreadyProfiled(input: SynthesisInput, profile: AccountProfileResult): boolean {
  const prior = input.priorAnswers ?? [];
  if (!prior.length) return false;
  const marker = `${profile.name} — ${profile.headline}`;
  return prior.some((answer) => answer.includes(marker));
}

function profileParagraph(
  profile: AccountProfileResult, facts: Facts, workspace: WorkspaceProfile, ledger: Ledger,
  seenBefore = false,
): string[] {
  ledger.use(profile);
  // Already given in this thread. The step still counts as rendered — it was
  // read, and its facts are on the screen a few turns up.
  if (seenBefore) return [];
  const lines: string[] = [];
  const parts = [`${profile.name}${profile.headline ? ` — ${profile.headline}` : ''}`];
  if (profile.owner) parts.push(`owned by ${profile.owner}`);
  lines.push(`${parts.join(', ')}.`);

  const commercial: string[] = [];
  if (profile.open_deals.length) {
    const top = profile.open_deals[0];
    commercial.push(
      `${countOf(profile.open_deals.length, 'open deal')} worth ${profile.totals.open_pipeline_formatted}` +
      `, led by ${top.name} at ${top.amount_formatted} in ${top.stage.toLowerCase()}` +
      `${top.close_date ? `, closing ${facts.calendarDay(top.close_date)}` : ''}`,
    );
  } else if (profile.totals.lifetime_won) {
    commercial.push(`no open pipeline, ${profile.totals.lifetime_won_formatted} closed-won to date`);
  }
  if (profile.totals.open_tickets) {
    commercial.push(`${countOf(profile.totals.open_tickets, 'open ticket')}${profile.open_tickets[0] ? ` — the oldest is "${profile.open_tickets[0].subject}" at ${profile.open_tickets[0].priority.toLowerCase()} priority` : ''}`);
  }
  if (commercial.length) lines.push(`${sentenceJoin([commercial.join('; ')])}`);

  if (profile.contacts.length) {
    const named = profile.contacts.slice(0, 3).map((c) => `${c.name}${c.title ? ` (${c.title})` : ''}`);
    lines.push(`Buying committee: ${listPhrase(named)}${profile.contacts.length > 3 ? ` and ${profile.contacts.length - 3} more` : ''}.`);
  }
  if (profile.last_activity.days_ago !== null && profile.last_activity.days_ago !== undefined) {
    lines.push(profile.last_activity.days_ago > 30
      ? `Nobody has touched this account in ${profile.last_activity.days_ago} days${profile.last_activity.summary ? ` — the last thing on the timeline is "${profile.last_activity.summary}"` : ''}.`
      : `Last activity was ${profile.last_activity.days_ago} ${profile.last_activity.days_ago === 1 ? 'day' : 'days'} ago${profile.last_activity.summary ? `: ${profile.last_activity.summary}` : ''}.`);
  }
  void workspace;
  return lines;
}

function timelineLines(timeline: { record: string; items: TimelineItem[] }, limit: number, facts: Facts, ledger: Ledger): string[] {
  ledger.use(timeline);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of timeline.items) {
    // The same email logged against two contacts is one thing that happened.
    const key = `${item.title}|${Math.round(item.at / 60_000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = item.body ? truncate(item.body.replace(/\s+/g, ' ').trim(), 120) : '';
    lines.push(bullet(`${facts.day(item.at)} — ${item.title}${item.actor ? ` (${item.actor})` : ''}${body ? `: ${body}` : ''}`));
    if (lines.length >= limit) break;
  }
  return lines;
}

function recordLines(list: RecordSearchResult, facts: Facts, workspace: WorkspaceProfile, ledger: Ledger, limit = 6): string[] {
  ledger.use(list);
  return list.records.slice(0, limit).map((record) => {
    const props = record.properties;
    const bits: string[] = [];
    // "Katrin Pfeiffer — Sofia Alvarez" reads as Katrin's title or her company
    // contact; it is our rep's name. A person is described by their job and how
    // to reach them, and the owner is a fact about the record, not about them.
    if (list.object_type === 'contact') {
      if (props.job_title) bits.push(String(props.job_title));
      else if (props.title) bits.push(String(props.title));
      if (props.email) bits.push(String(props.email));
      if (props.buying_role) bits.push(humanise(String(props.buying_role)));
      if (!bits.length && record.owner) bits.push(`owned by ${record.owner}`);
      return bullet(`${record.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
    }
    if (props.amount !== undefined) bits.push(facts.money(Number(props.amount)));
    if (props.deal_stage) bits.push(humanise(String(props.deal_stage)));
    if (props.close_date) bits.push(`closes ${facts.calendarDay(Number(props.close_date))}`);
    if (props.status) bits.push(humanise(String(props.status)));
    if (props.priority) bits.push(`${humanise(String(props.priority))} priority`);
    if (record.owner) bits.push(record.owner);
    void workspace;
    return bullet(`${record.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
  });
}

/* ----------------------------- billing answers ---------------------------- */

/**
 * The revenue half of the platform answers in its own shapes.
 *
 * A run whose trace reads `billing_list_subscriptions ok=true => total=35` above
 * the sentence "No subscription records match that" did not fail to find the
 * rows — it found them and then threw them away, because only CRM-shaped
 * payloads had a renderer. These are the renderers for the other half, matched
 * structurally rather than by tool name so a tool that returns the same shape
 * under another name still gets an answer.
 */
interface BillingSubscriptionRow {
  id: string;
  customer_name?: string | null;
  status?: string;
  items?: string[];
  mrr_display?: string;
  current_period_end?: string;
  cancel_at_period_end?: boolean;
}
interface BillingSubscriptionList { total: number; subscriptions: BillingSubscriptionRow[] }

interface BillingInvoiceRow {
  id: string;
  number?: string | null;
  customer_name?: string | null;
  status?: string;
  total_display?: string;
  amount_due_display?: string;
  due?: string;
  billing_reason?: string;
}
interface BillingInvoiceList { total: number; outstanding_display?: string; invoices: BillingInvoiceRow[] }

interface BillingInvoiceExplanation {
  number: string;
  customer_name?: string | null;
  status: string;
  covers: string;
  lines: { description: string; amount_display: string; proration?: boolean; why?: string }[];
  subtotal_display: string;
  tax_display?: string;
  balance_applied_display?: string;
  total_display: string;
  adds_up?: boolean;
}

interface BillingUpcomingInvoice {
  due: string;
  covers: string;
  lines: string[];
  subtotal_display: string;
  balance_applied_display?: string;
  total_display: string;
}

interface BillingCustomerSummary {
  object: 'customer_summary';
  headline: string;
  customer: { id?: string; name: string };
  mrr: number;
  arr: number;
  subscriptions: { total: number; live: number };
  balance: { amount: number; credit: boolean; description: string };
  lifetime_value: { amount: number; periods_billed: number };
  next_invoice: { date: number; estimated_total: number; note: string } | null;
  /** `total` here is money still owed, not a row count — the rows are `data`. */
  open_invoices: { data: { id: string }[]; total: number; oldest_due: number | null };
  attention: string[];
}

const field = (value: unknown, key: string): boolean =>
  !!value && typeof value === 'object' && key in (value as object);
const arrayField = (value: unknown, key: string): boolean =>
  field(value, key) && Array.isArray((value as Record<string, unknown>)[key]);

const isSubscriptionList = (v: unknown): boolean => arrayField(v, 'subscriptions') && field(v, 'total');
const isInvoiceList = (v: unknown): boolean => arrayField(v, 'invoices') && field(v, 'total');
const isCustomerSummary = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'customer_summary';
const isInvoiceExplanation = (v: unknown): boolean =>
  arrayField(v, 'lines') && field(v, 'total_display') && field(v, 'covers') && field(v, 'number');
const isUpcomingInvoice = (v: unknown): boolean =>
  arrayField(v, 'lines') && field(v, 'total_display') && field(v, 'due') && !field(v, 'number');

/* ------------------- meters, entitlements, credits, catalog ---------------- */

/**
 * The rest of the revenue half answers in its own shapes too.
 *
 * Same rule as the billing renderers above: matched structurally, on the fields
 * a payload carries rather than on the name of the tool that produced it, so a
 * module that returns the same shape under another name still gets a sentence
 * instead of having its payload printed with its own column names.
 */
interface MeterRow {
  object: 'meter';
  id: string;
  name: string;
  event_name: string;
  aggregation: string;
  unit_label?: string | null;
  status?: string;
  description?: string | null;
}

interface MeterUsage {
  object: 'meter_usage';
  meter_name: string;
  event_name: string;
  aggregation: string;
  unit_label: string | null;
  period_start: number;
  period_end: number;
  value: number;
  billable_quantity: number;
  event_count: number;
  pending: boolean;
}

interface EntitlementRow {
  feature_name: string;
  unit_label: string | null;
  value: number | null;
  unlimited: boolean;
  usage: { used: number; remaining?: number | null; unit_label?: string | null } | null;
}
interface EntitlementSetPayload {
  object: 'entitlement_set';
  entitlements: EntitlementRow[];
  sources: { status: string; products: string[] }[];
}

interface CreditBurnOrder {
  object: 'credit_burn_order';
  order: string[];
}

interface CreditBalancePayload {
  object: 'credit_balance';
  totals_by_currency: { currency: string; monetary_available: number; unit_pots: number; next_expiry: number | null }[];
  /**
   * The pots themselves, each with its own denomination.
   *
   * `totals_by_currency` counts the unit pots and cannot say what is in them,
   * which is how an account holding 9,131 live telemetry events was reported
   * as "$0.00 available and 1 unit pot".
   */
  balances?: {
    currency: string;
    kind?: 'monetary' | 'unit';
    unit_label?: string | null;
    available?: number;
    next_expiry?: { at: number } | null;
  }[];
  /** Grants that exist but have not started yet — credit the account will have. */
  scheduled?: {
    name?: string; currency?: string; balance?: number; effective_at?: number | null; category?: string;
    kind?: 'monetary' | 'unit'; unit_label?: string | null;
  }[];
  burn_order: string[];
}

interface CatalogProduct {
  id: string;
  name: string;
  tagline?: string | null;
  category?: string;
  unit_label?: string | null;
  prices: { summary?: string; nickname?: string | null; lookup_key?: string | null }[];
}

interface PriceQuote {
  price: string;
  product: string | null;
  quantity: number;
  amount_display: string;
  effective_unit_display?: string;
  warning?: string | null;
  breakdown: string[];
}

const isMeterList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((row) => !!row && typeof row === 'object' && (row as { object?: unknown }).object === 'meter');
const isMeterUsage = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'meter_usage';
const isEntitlementSet = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'entitlement_set';
const isCreditBalance = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'credit_balance';
const isBurnOrder = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'credit_burn_order';
const isProductList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((row) => !!row && typeof row === 'object'
    && typeof (row as { name?: unknown }).name === 'string' && Array.isArray((row as { prices?: unknown }).prices));
const isPriceQuote = (v: unknown): boolean =>
  !!v && typeof v === 'object' && field(v, 'amount_display') && field(v, 'quantity') && arrayField(v, 'breakdown');
const isMeteredUsage = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'metered_usage';
const isStaleAccounts = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'stale_accounts';

/* ----------------------------- one CRM record ----------------------------- */

interface CrmRecordPayload {
  object: 'record';
  id: string;
  object_type: string;
  display_name: string;
  owner?: string | null;
  formatted?: Record<string, string>;
  associations?: { object_type?: string; display_name?: string }[];
}
const isCrmRecord = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'record'
  && typeof (v as CrmRecordPayload).object_type === 'string'
  && typeof (v as CrmRecordPayload).display_name === 'string';

/** Fields nobody wants read back: internal plumbing and the name we already said. */
const RECORD_NOISE = /^(subject|name|content|body|description|.*_at|.*_by|pipeline)$/;

/**
 * One record, in its own words.
 *
 * "Summarise the Alert storm from vibration thresholds ticket" resolved that
 * ticket and was answered with the workspace's quarterly bookings, because a
 * record that is not an account had no way of being the subject of a summary.
 */
function crmRecordBlocks(record: CrmRecordPayload, workspace: WorkspaceProfile): string[] {
  const formatted = record.formatted ?? {};
  const facts = Object.entries(formatted)
    .filter(([key, value]) => !RECORD_NOISE.test(key) && !!value)
    .slice(0, 8)
    .map(([key, value]) => `${humanise(key)} ${value}`);
  const body = formatted.content ?? formatted.body ?? formatted.description ?? '';
  const accounts = (record.associations ?? [])
    .filter((a) => a.object_type === 'company' && a.display_name)
    .map((a) => a.display_name!);
  return [
    `${humanise(record.object_type)} "${record.display_name}"${accounts.length ? ` on ${listPhrase([...new Set(accounts)].slice(0, 3))}` : ''}`
    + `${record.owner ? `, owned by ${record.owner}` : ''}${facts.length ? ` — ${facts.join(' · ')}` : ''}.`,
    ...(body ? [truncate(body.replace(/\s+/g, ' ').trim(), 400)] : []),
  ].filter(Boolean).map((line) => { void workspace; return line; });
}

/* --------------------- schema, pipelines and recovery ---------------------- */

interface PropertyRow {
  name: string; label: string; type: string; group?: string | null;
  required?: boolean; read_only?: boolean; options?: { value: string; label: string }[];
}
const isPropertyList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((row) => !!row && typeof row === 'object'
    && typeof (row as PropertyRow).name === 'string' && typeof (row as PropertyRow).label === 'string'
    && typeof (row as PropertyRow).type === 'string' && !('stages' in (row as object)));

/** The fields a record type carries, grouped the way the schema groups them. */
function propertyBlocks(rows: PropertyRow[], objectType: string | null): string[] {
  const groups = new Map<string, PropertyRow[]>();
  for (const row of rows) {
    const key = row.group?.trim() || 'Other';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const blocks = [`${countOf(rows.length, 'property')} on ${objectType ? `a ${objectType}` : 'this record type'}, by group:`];
  for (const [group, members] of [...groups].slice(0, 8)) {
    blocks.push(bullet(`${group} — ${members.slice(0, 14).map((m) => `${m.label} (\`${m.name}\`, ${m.type}${m.required ? ', required' : ''})`).join(' · ')}${members.length > 14 ? ` and ${members.length - 14} more` : ''}`));
  }
  const picklists = rows.filter((r) => r.options?.length);
  if (picklists.length) {
    blocks.push(`Picklists: ${picklists.slice(0, 4).map((p) => `${p.label} — ${p.options!.slice(0, 8).map((o) => o.label).join(', ')}`).join(' · ')}.`);
  }
  return blocks;
}

interface PipelineRow {
  name: string; label: string; is_default?: boolean; description?: string | null;
  stages: { name: string; label: string; probability?: number; is_closed?: boolean; is_won?: boolean; forecast_category?: string }[];
}
const isPipelineList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((row) => !!row && typeof row === 'object'
    && typeof (row as PipelineRow).label === 'string' && Array.isArray((row as PipelineRow).stages));

/**
 * The pipelines and their stages.
 *
 * This payload used to end the answer with "I could not read anything back from
 * list pipelines: it carries no field I can name to you" — a false statement
 * about a payload whose every field is nameable, printed under the correct
 * stage breakdown, with the internal tool name in the prose.
 */
function pipelineBlocks(rows: PipelineRow[]): string[] {
  const blocks = [`${countOf(rows.length, 'pipeline')} in this workspace:`];
  for (const pipeline of rows.slice(0, 6)) {
    const stages = pipeline.stages.filter((s) => !s.is_closed);
    blocks.push(bullet(
      `${pipeline.label}${pipeline.is_default ? ' (default)' : ''} — ${stages.map((s) => `${s.label} ${s.probability ?? 0}%`).join(' → ')}`
      + `${pipeline.description ? `. ${pipeline.description}` : ''}`,
    ));
  }
  return blocks;
}

interface RecoveryCampaign {
  dunning: string; customer: string; invoice: string; at_risk: string; attempts: string;
  last_decline?: string; next_attempt_at?: number | null; payment_method?: string | null;
  recommended_action?: string; needs_human?: boolean;
}
const isRecoveryQueue = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'recovery_queue';

/** Every subscription in payment recovery, and what happens to each one next. */
function recoveryBlocks(queue: { total: number; campaigns: RecoveryCampaign[] }, facts: Facts, workspace: WorkspaceProfile): string[] {
  if (!queue.total) return [`Nothing is in payment recovery in ${workspace.name} — no invoice is being retried and no card has declined into dunning.`];
  const needsHuman = queue.campaigns.filter((c) => c.needs_human);
  const blocks = [
    `${countOf(queue.total, 'account')} in payment recovery:`,
    queue.campaigns.slice(0, 8).map((c) => bullet(
      `${c.customer} — ${c.at_risk} on ${c.invoice}, attempt ${c.attempts}`
      + `${c.last_decline ? `, last declined ${humanise(c.last_decline).toLowerCase()}` : ''}`
      + `${c.next_attempt_at ? `, next retry ${facts.day(c.next_attempt_at)}` : ''}`
      + `${c.payment_method ? ` · ${c.payment_method}` : ''}`,
    )).join('\n'),
  ];
  blocks.push(needsHuman.length
    ? `${countOf(needsHuman.length, 'of these')} will not clear on a retry and ${needsHuman.length === 1 ? 'needs' : 'need'} someone to ask for a new card: ${listPhrase(needsHuman.map((c) => c.customer))}.`
    : 'Every one of these is on an automatic retry that is worth making; none needs a person yet.');
  return blocks;
}

/* ------------------------- the revenue reports ---------------------------- */

/**
 * `revenue_summary` and `revenue_collections` answer the two questions a
 * founder asks first — how is the business doing, and who owes us — and both
 * ran, returned, and were thrown away, because nothing here knew their shape.
 *
 * Both are already display-formatted by the module that owns them, and both
 * return `null` for every money scalar in a workspace that bills in more than
 * one currency: there is no exchange-rate table, so there is no single MRR and
 * no single DSO. The renderers below follow that rule rather than fighting it —
 * where a scalar is null the per-currency rows are the answer.
 */
interface RevenueSummaryPayload {
  mrr: number | null;
  arr: number | null;
  accounts: number;
  currency: string | null;
  currency_mode: string;
  mrr_display?: string;
  arr_display?: string;
  receivables_display?: string;
  net_revenue_retention: string | null;
  gross_revenue_retention: string | null;
  by_currency: {
    currency: string; accounts: number;
    mrr_display: string; arr_display: string; receivables_display: string;
    net_revenue_retention: string | null; gross_revenue_retention: string | null;
  }[];
  balanced: boolean;
  currency_note?: string | null;
}

interface CollectionsPayload {
  currency: string | null;
  currency_mode: string;
  outstanding: number | null;
  outstanding_display?: string;
  past_due: number | null;
  dso_days: string | null;
  ageing: { bucket: string; invoices: number; amount: number | null; share: string | null }[];
  by_currency: {
    currency: string; outstanding_display: string; past_due: number; past_due_display: string;
    dso_days: string | null; failed_payment_exposure: number; recovery_rate: string | null;
  }[];
  note?: string | null;
}

/* --------------------------- recurring-revenue movement -------------------- */

interface MovementMonthCurrency {
  currency: string;
  opening: number; new_business: number; expansion: number; reactivation: number;
  contraction: number; churn: number; net: number; closing: number;
}
interface MovementMonth {
  month: string;
  by_currency: MovementMonthCurrency[];
  reconciled: boolean;
  movers: string[];
}
interface MovementPayload {
  currency: string | null;
  currency_mode: string;
  balanced: boolean;
  by_currency: { currency: string; opening: string; net: string; closing: string; balanced: boolean }[];
  months: MovementMonth[];
  currency_note?: string | null;
}

const isRevenueMovement = (v: unknown): boolean =>
  field(v, 'currency_mode') && arrayField(v, 'months') && arrayField(v, 'by_currency')
  && (v as MovementPayload).months.every((m) => !!m && typeof m === 'object' && typeof m.month === 'string' && Array.isArray(m.by_currency));

/** "2026-08" as a reader writes it. */
const monthLabel = (month: string, locale: string): string => {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) return month;
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Month-by-month movement in recurring revenue, per currency.
 *
 * The question this answers — "how did MRR change", "how much new MRR did we
 * add" — was previously answered with the snapshot and a paragraph asserting
 * that this workspace keeps no history of recurring revenue. It keeps it here,
 * balanced, and it is what the churn figures elsewhere in the same answer are
 * already computed from.
 */
function movementBlocks(
  report: MovementPayload, facts: Facts, workspace: WorkspaceProfile, window: TimeWindow | null,
): string[] {
  // A month belongs to the period the question named, not to the report's own
  // default span. "How much new MRR did we add last quarter" is a question
  // about that quarter, and printing six months under it answers a wider one.
  const monthStart = (month: string): number => {
    const [year, mon] = month.split('-').map(Number);
    return year && mon ? Date.UTC(year, mon - 1, 1) : NaN;
  };
  const named = window && window.start > 0 && window.end > window.start ? window : null;
  const inWindow = named
    ? report.months.filter((m) => { const at = monthStart(m.month); return Number.isFinite(at) && at >= named.start && at < named.end; })
    : report.months;
  const months = inWindow.length ? inWindow : report.months;
  const scoped = months !== report.months && named !== null;
  if (!months.length) {
    return [`No month of recurring-revenue movement has closed in ${workspace.name} yet, so there is no new business, expansion, contraction or churn to report.`];
  }
  const span = scoped && named
    ? named.label
    : months.length === 1
      ? monthLabel(months[0].month, workspace.locale)
      : `${monthLabel(months[0].month, workspace.locale)} to ${monthLabel(months[months.length - 1].month, workspace.locale)}`;
  const currencies = report.by_currency.map((row) => row.currency);
  const blocks: string[] = [];

  blocks.push(currencies.length > 1
    ? `Recurring revenue moved like this over ${span}. ${workspace.name} bills in ${listPhrase(currencies.map((c) => c.toUpperCase()))} and this platform holds no exchange rates, so each book moves on its own and they are never added together.`
    : `Recurring revenue moved like this over ${span}.`);

  for (const book of report.by_currency) {
    const rows = months
      .map((m) => ({ month: m.month, row: m.by_currency.find((c) => c.currency === book.currency) }))
      .filter((r): r is { month: string; row: MovementMonthCurrency } => !!r.row);
    if (!rows.length) continue;
    const sum = (pick: (row: MovementMonthCurrency) => number) => rows.reduce((a, r) => a + pick(r.row), 0);
    const money = (amount: number) => facts.moneyIn(amount, book.currency);
    // Opening and closing come from the months actually shown, so a scoped
    // answer reconciles against the span it prints rather than a wider one.
    const opening = rows[0].row.opening;
    const closing = rows[rows.length - 1].row.closing;
    const net = closing - opening;
    const parts = [
      sum((r) => r.new_business) ? `new business ${money(sum((r) => r.new_business))}` : '',
      sum((r) => r.expansion) ? `expansion ${money(sum((r) => r.expansion))}` : '',
      sum((r) => r.reactivation) ? `reactivation ${money(sum((r) => r.reactivation))}` : '',
      sum((r) => r.contraction) ? `contraction −${money(Math.abs(sum((r) => r.contraction)))}` : '',
      sum((r) => r.churn) ? `churn −${money(Math.abs(sum((r) => r.churn)))}` : '',
    ].filter(Boolean);
    blocks.push(parts.length
      ? `${book.currency.toUpperCase()} — opened at ${money(opening)}, closed at ${money(closing)}, net ${net > 0 ? '+' : ''}${money(net)}: ${parts.join(' · ')}.`
      : `${book.currency.toUpperCase()} — flat at ${money(closing)}: nothing was added, expanded, contracted or churned in that span.`);
    const moving = rows.filter((r) => r.row.net !== 0);
    if (moving.length > 1 || (moving.length === 1 && rows.length > 1)) {
      blocks.push(moving.map((r) => bullet(
        `${monthLabel(r.month, workspace.locale)} — ${money(r.row.opening)} → ${money(r.row.closing)}`
        + ` (${r.row.net > 0 ? '+' : ''}${money(r.row.net)})`
        + `${r.row.new_business ? `, new ${money(r.row.new_business)}` : ''}`
        + `${r.row.expansion ? `, expansion ${money(r.row.expansion)}` : ''}`
        + `${r.row.contraction ? `, contraction −${money(Math.abs(r.row.contraction))}` : ''}`
        + `${r.row.churn ? `, churn −${money(Math.abs(r.row.churn))}` : ''}`,
      )).join('\n'));
    }
  }

  const movers = months.flatMap((m) => m.movers).slice(-6);
  if (movers.length) blocks.push(`The accounts behind it: ${movers.join(' · ')}.`);
  blocks.push(report.balanced
    ? 'Opening plus movements equals closing in every month and every currency, so these figures reconcile to the subscription ledger.'
    : 'One or more months do not reconcile against the subscription ledger, so treat these figures as indicative until that is resolved.');
  return blocks;
}

const isRevenueSummary = (v: unknown): boolean =>
  field(v, 'currency_mode') && field(v, 'mrr') && field(v, 'arr') && arrayField(v, 'by_currency');
const isCollections = (v: unknown): boolean =>
  field(v, 'currency_mode') && field(v, 'dso_days') && arrayField(v, 'ageing');

/** "one book" / "three books" — how many currencies the answer has to keep apart. */
const mixed = (payload: { currency: string | null }): boolean => payload.currency === null;

function revenueSummaryBlocks(report: RevenueSummaryPayload, workspace: WorkspaceProfile): string[] {
  const blocks: string[] = [];
  // The tool declares this as `string | null` and the single-currency branch of
  // the report hands back the ratio object instead, which interpolated as
  // "[object Object] net revenue retention" on the first screen of every new
  // workspace. A declared type is not a guarantee about a payload that crossed
  // a module boundary, so the value is checked rather than trusted.
  const percentText = (value: unknown): string | null => {
    const text = typeof value === 'string' ? value.trim()
      : typeof value === 'object' && value !== null && typeof (value as { percent?: unknown }).percent === 'string'
        ? (value as { percent: string }).percent.trim()
        : '';
    // A rate with a zero denominator has no meaning; the ledger renders that as
    // "n/a", and "n/a net revenue retention" is not a clause worth printing.
    return text && text.toLowerCase() !== 'n/a' ? text : null;
  };
  const retention = (row: { net_revenue_retention: string | null; gross_revenue_retention: string | null }): string => {
    const net = percentText(row.net_revenue_retention);
    return net ? `${net} net revenue retention` : '';
  };
  if (!mixed(report) && report.mrr_display) {
    blocks.push(sentenceJoin([[
      `${workspace.name} is running at ${report.mrr_display} a month`,
      `${report.arr_display ? `${report.arr_display} annualised` : ''}`,
      `across ${countOf(report.accounts, 'paying account')}`,
      retention(report),
    ].filter(Boolean).join(', ')]));
    if (report.receivables_display) blocks.push(`${report.receivables_display} is outstanding on the receivables ledger.`);
  } else {
    blocks.push(
      `${workspace.name} bills in ${listPhrase(report.by_currency.map((row) => row.currency.toUpperCase()))}`
      + ` and this platform holds no exchange rates, so there is no single MRR figure — one book per currency:`,
    );
    blocks.push(report.by_currency.map((row) => bullet(
      `${row.currency.toUpperCase()} — ${row.mrr_display} a month, ${row.arr_display} annualised`
      + ` across ${countOf(row.accounts, 'account')}`
      + `${percentText(row.net_revenue_retention) ? `, ${percentText(row.net_revenue_retention)} net revenue retention` : ''}`
      + `${row.receivables_display ? `, ${row.receivables_display} outstanding` : ''}`,
    )).join('\n'));
  }
  // The headline is only safe to read when the reconciliation held; the report
  // says so itself, and an answer that quotes the number has to say it too.
  blocks.push(report.balanced
    ? 'Every month of movement, the recognition schedule and the usage ledger reconcile, so those figures are safe to quote.'
    : 'These figures did not reconcile — a month of MRR movement, the recognition schedule or the usage ledger failed its balance check, so treat the headline as indicative until that is resolved.');
  return blocks;
}

function collectionsBlocks(report: CollectionsPayload, workspace: WorkspaceProfile): string[] {
  const blocks: string[] = [];
  if (!mixed(report) && report.outstanding_display) {
    blocks.push(
      `${workspace.name} is owed ${report.outstanding_display}`
      + `${report.dso_days ? `, and collects in ${report.dso_days} days on average (DSO)` : ''}.`,
    );
  } else {
    blocks.push(
      `Receivables are spread across ${listPhrase(report.by_currency.map((row) => row.currency.toUpperCase()))}`
      + ` with no exchange-rate table behind them, so there is no single outstanding figure and no single DSO:`,
    );
    blocks.push(report.by_currency.map((row) => bullet(
      `${row.currency.toUpperCase()} — ${row.outstanding_display} outstanding`
      + `${row.past_due > 0 ? `, ${row.past_due_display} of it past due` : ', none of it past due'}`
      + `${row.dso_days ? `, DSO ${row.dso_days} days` : ''}`
      + `${row.failed_payment_exposure > 0
        ? `, ${formatMoney({ amount: row.failed_payment_exposure, currency: row.currency }, { locale: workspace.locale })} still in dunning`
        : ''}`,
    )).join('\n'));
  }
  const buckets = report.ageing.filter((bucket) => bucket.invoices > 0);
  if (buckets.length) {
    blocks.push(`Ageing: ${buckets.map((bucket) => `${bucket.bucket} — ${countOf(bucket.invoices, 'invoice')}${bucket.amount !== null && bucket.amount !== undefined ? `, ${formatMoney({ amount: bucket.amount, currency: report.currency ?? workspace.currency }, { locale: workspace.locale })}` : ''}`).join(' · ')}.`);
  }
  if (report.note) blocks.push(report.note);
  return blocks;
}

const isRevenueShape = (v: unknown): boolean =>
  isMeterList(v) || isMeterUsage(v) || isEntitlementSet(v) || isCreditBalance(v) || isProductList(v) || isPriceQuote(v)
  || isRevenueSummary(v) || isCollections(v) || isBurnOrder(v) || isMeteredUsage(v) || isStaleAccounts(v);

function meterBlocks(meters: MeterRow[], workspace: WorkspaceProfile): string[] {
  const live = meters.filter((m) => !m.status || m.status === 'active');
  const shown = (live.length ? live : meters).slice(0, 12);
  return [
    `${countOf(shown.length, 'meter')} in ${workspace.name}${live.length && live.length < meters.length ? `, and ${meters.length - live.length} not active` : ''}:`,
    shown.map((m) => bullet(
      `${m.name} — ${m.aggregation} of \`${m.event_name}\`${m.unit_label ? `, in ${m.unit_label}s` : ''}${m.description ? ` · ${m.description}` : ''}`,
    )).join('\n'),
  ];
}

function usageBlocks(usage: MeterUsage, facts: Facts, workspace: WorkspaceProfile, who: string | null): string[] {
  const unit = usage.unit_label ? `${usage.unit_label}${usage.value === 1 ? '' : 's'}` : 'units';
  const period = `${facts.day(usage.period_start)} – ${facts.day(usage.period_end - 1)}`;
  return [
    `${who ? `${who} used ` : ''}${usage.value.toLocaleString(workspace.locale)} ${unit}`
    + ` on ${usage.meter_name} over ${period}`
    // "3 events" next to "139,134 events" reads as a contradiction: one is the
    // metered total, the other is how many ingested records it was built from.
    + `, aggregated (${usage.aggregation}) from ${countOf(usage.event_count, 'ingested record')} on \`${usage.event_name}\`.`
    + (usage.pending ? ' The period is still open, so the total can still move.' : ''),
    usage.billable_quantity !== usage.value
      ? `${usage.billable_quantity.toLocaleString(workspace.locale)} ${unit} is what the price book bills, rounded once from the exact total.`
      : '',
  ].filter(Boolean);
}

function entitlementBlocks(set: EntitlementSetPayload, workspace: WorkspaceProfile, who: string | null): string[] {
  const account = who ?? 'That account';
  if (!set.entitlements.length) {
    return [`${account} has no entitlements — nothing it is subscribed to grants a feature.`];
  }
  const line = (row: EntitlementRow): string => {
    const unit = row.unit_label ? ` ${row.unit_label}${row.value === 1 ? '' : 's'}` : '';
    const allowance = row.unlimited ? 'unlimited' : row.value === null ? 'included' : `${row.value.toLocaleString(workspace.locale)}${unit}`;
    if (!row.usage) return `${row.feature_name} — ${allowance}`;
    const used = row.usage.used.toLocaleString(workspace.locale);
    const left = row.usage.remaining === null || row.usage.remaining === undefined
      ? ''
      : `, ${row.usage.remaining.toLocaleString(workspace.locale)} left`;
    return `${row.feature_name} — ${used} of ${allowance} used${left}`;
  };
  return [
    `${countOf(set.entitlements.length, 'entitlement')} on ${who ?? 'that account'}:`,
    set.entitlements.slice(0, 10).map((row) => bullet(line(row))).join('\n'),
  ];
}

/**
 * A credit amount in the denomination the grant is actually written in.
 *
 * A unit grant is a count of meter units and a monetary grant is money. They
 * are different types and they do not share a formatter — running a
 * 6,000,000-event pack through `formatMoney` printed "$60,000.00", a figure
 * that is wrong by construction and indistinguishable from a real one.
 */
function creditAmount(
  amount: number,
  denomination: { kind?: 'monetary' | 'unit'; unit_label?: string | null; currency?: string },
  workspace: WorkspaceProfile,
): string {
  return denomination.kind === 'unit'
    ? formatUnits(amount, denomination.unit_label ?? 'unit', workspace.locale)
    : formatMoney({ amount, currency: denomination.currency ?? workspace.currency }, { locale: workspace.locale });
}

function creditBlocks(
  balance: CreditBalancePayload, facts: Facts, workspace: WorkspaceProfile, who: string | null,
  explainBurnOrder = false,
): string[] {
  // The pots themselves, each stated in its own denomination. The per-currency
  // roll-up cannot do this: it counts unit pots without saying what is in them.
  const buckets = (balance.balances ?? []).filter((b) => (b.available ?? 0) > 0);
  const totals = balance.totals_by_currency.filter((t) => t.monetary_available > 0 || t.unit_pots > 0);
  // A grant that starts next month is not "no credit". Saying so and stopping
  // is how a renewal conversation happens without the goodwill already agreed.
  const scheduled = (balance.scheduled ?? []).filter((g) => (g.balance ?? 0) > 0);
  const scheduledLine = scheduled.length
    ? `${scheduled.length === 1 ? 'One grant is' : `${scheduled.length} grants are`} agreed but not yet in force: `
      + `${scheduled.slice(0, 4).map((g) => `${creditAmount(g.balance ?? 0, g, workspace)}${g.name ? ` (${g.name})` : ''}${g.effective_at ? `, effective ${facts.day(g.effective_at)}` : ''}`).join(' · ')}.`
    : null;
  if (!buckets.length && !totals.length) {
    return [
      // True whether every grant is spent and expired or the account never held
      // one: the earlier wording implied grants exist, on an account with none.
      `${who ?? 'That account'} holds no spendable credit right now — nothing in its credit ledger is in force with a balance left.`,
      ...(scheduledLine ? [scheduledLine] : []),
    ];
  }
  const rows = buckets.length
    ? buckets.map((bucket) => bullet(
      `${creditAmount(bucket.available ?? 0, bucket, workspace)} available`
      + `${bucket.kind === 'unit' ? ` on the ${bucket.unit_label ?? 'unit'} pot` : ''}`
      + `${bucket.next_expiry?.at ? `, expiring ${facts.day(bucket.next_expiry.at)}` : ''}`,
    ))
    : totals.map((t) => bullet(
      `${formatMoney({ amount: t.monetary_available, currency: t.currency }, { locale: workspace.locale })} available`
      + `${t.unit_pots ? ` and ${countOf(t.unit_pots, 'unit pot')}` : ''}`
      + `${t.next_expiry ? `, the next expiry ${facts.day(t.next_expiry)}` : ''}`,
    ));
  return [
    `${who ?? 'That account'} is holding credit:`,
    rows.join('\n'),
    ...(scheduledLine ? [scheduledLine] : []),
    // The drawdown policy is an answer to "which grant is spent first", and to
    // nothing else. Appended to every balance it tripled the reply and buried
    // the one number the reader asked for.
    ...(explainBurnOrder ? burnOrderBlocks(balance.burn_order.map((step) => step.replace(/_/g, ' '))) : []),
  ].filter(Boolean);
}

/** "Which credit is spent first?" — a question about the policy, not the pot. */
const BURN_ORDER_ASKED =
  /\b(?:burn\s+order|draw[\s-]?down|drawn\s+down|drawdown|spent\s+first|used\s+first|applied\s+first|consumed\s+first|which\s+(?:grant|credit)s?\s+(?:is|are|gets?|get)\s+(?:spent|used|applied)|what\s+order|in\s+what\s+order|which\s+order|priority\s+order|how\s+(?:is|are|does|do)\s+(?:the\s+)?credits?\b)/i;

/**
 * The burn order is a policy, and a policy reads as a list.
 *
 * Run through `listPhrase` it came out as one 400-character sentence with
 * numbered clauses joined by "and", which is unreadable and looked like a bug
 * because it was one.
 */
function burnOrderBlocks(order: string[]): string[] {
  if (!order.length) return [];
  return [
    'Credit is drawn down in this order:',
    order.slice(0, 8).map((step) => bullet(step.replace(/^\s*\d+\.\s*/, ''))).join('\n'),
  ];
}

function productBlocks(products: CatalogProduct[]): string[] {
  return [
    `${countOf(products.length, 'product')} in the catalogue:`,
    products.slice(0, 10).map((product) => {
      const prices = product.prices.map((p) => p.summary).filter(Boolean).slice(0, 3);
      return bullet(`${product.name}${product.tagline ? ` — ${product.tagline}` : ''}${prices.length ? ` (${prices.join('; ')})` : ''}`);
    }).join('\n'),
  ];
}

function quoteBlocks(quote: PriceQuote, workspace: WorkspaceProfile): string[] {
  const blocks = [
    `${quote.quantity.toLocaleString(workspace.locale)}${quote.product ? ` of ${quote.product}` : ''} costs ${quote.amount_display}`
    + `${quote.effective_unit_display ? `, an effective ${quote.effective_unit_display} a unit` : ''}.`,
  ];
  if (quote.breakdown.length) blocks.push(quote.breakdown.slice(0, 8).map((row) => bullet(row)).join('\n'));
  if (quote.warning) blocks.push(quote.warning);
  return blocks;
}

/**
 * How much of a meter was consumed, as a sentence with the number in it.
 *
 * The question that produced this — "how many telemetry events did we meter
 * last month" — used to be answered with the six-line meter catalogue and no
 * figure anywhere in it.
 */
function meteredUsageBlocks(usage: MeteredUsageResult, facts: Facts, workspace: WorkspaceProfile): string[] {
  const period = usage.window.label && usage.window.label !== 'the selected period'
    ? usage.window.label
    : `${facts.day(usage.window.start)} – ${facts.day(usage.window.end - 1)}`;
  const who = usage.subject ? usage.subject.label : workspace.name;
  if (!usage.accounts) {
    // The meter's display name is plural as often as not — "Telemetry events",
    // "Anomaly alerts raised" — and "No telemetry events was metered" is the
    // kind of sentence that makes a reader distrust the number beside it. The
    // verb follows the noun the name ends in.
    const plural = /s$/i.test(usage.meter.name.replace(/\s+\w+ed$/i, '').trim());
    return [`No ${usage.meter.name.toLowerCase()} ${plural ? 'were' : 'was'} metered ${usage.subject ? `for ${who}` : `in ${workspace.name}`} in ${period} — the meter is live and no \`${usage.meter.event_name}\` event landed in that window, so the honest answer is none rather than a number from somewhere else.`];
  }
  const blocks = [
    `${who} metered ${usage.formatted} on ${usage.meter.name} in ${period}`
    + `, ${usage.meter.aggregation === 'count' ? 'counted' : `${usage.meter.aggregation === 'sum' ? 'summed' : usage.meter.aggregation}`} from ${countOf(usage.event_count, 'ingested event')} on \`${usage.meter.event_name}\``
    + `${usage.scope === 'workspace' ? ` across ${countOf(usage.accounts, 'account')}` : ''}.`,
  ];
  if (usage.scope === 'workspace' && usage.by_account.length > 1) {
    blocks.push(`Biggest consumers: ${usage.by_account.slice(0, 5).map((row) => `${row.label} ${row.formatted}`).join(' · ')}.`);
  }
  if (usage.note) blocks.push(usage.note);
  return blocks;
}

interface DelinquentCustomersPayload {
  object: 'delinquent_customers';
  total: number;
  customers: {
    id: string; name: string; outstanding_formatted: string; open_invoices: number;
    oldest_due_at: number | null; days_overdue: number | null; past_due_subscriptions: number;
  }[];
}
const isDelinquentCustomers = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { object?: unknown }).object === 'delinquent_customers';

/** Who owes, how much, and how long it has been sitting there. */
function delinquentBlocks(result: DelinquentCustomersPayload, facts: Facts, workspace: WorkspaceProfile): string[] {
  if (!result.total) {
    return [`No customer in ${workspace.name} is marked past due — every account with an open invoice is inside its terms.`];
  }
  const worst = result.customers.filter((c) => (c.days_overdue ?? 0) > 0);
  return [
    `${countOf(result.total, 'customer')} ${result.total === 1 ? 'is' : 'are'} past due on the customer ledger:`,
    result.customers.slice(0, 8).map((c) => bullet(
      `${c.name} — ${c.outstanding_formatted} across ${countOf(c.open_invoices, 'open invoice')}`
      + `${c.days_overdue !== null ? `, the oldest ${c.days_overdue} days past due` : c.oldest_due_at ? `, the oldest due ${facts.day(c.oldest_due_at)}` : ''}`
      + `${c.past_due_subscriptions ? `, ${countOf(c.past_due_subscriptions, 'subscription')} in payment recovery` : ''}`,
    )).join('\n'),
    worst.length
      ? `${worst.length === 1 ? 'One of those is' : `${worst.length} of those are`} genuinely late rather than merely unpaid — the rest are open invoices inside their terms.`
      : 'None of those is past its due date yet; they are flagged from an earlier failure, not from an overdue bill.',
  ];
}

/** Accounts nobody has touched, quietest first, with what is sitting on them. */
function staleAccountBlocks(result: StaleAccountsResult, facts: Facts, workspace: WorkspaceProfile): string[] {
  if (!result.total) {
    return [`Every account in ${workspace.name} has been touched in the last ${result.threshold_days} days — nothing has gone quiet by that measure.`];
  }
  const exposed = result.accounts.filter((a) => a.open_pipeline > 0);
  return [
    `${countOf(result.total, 'account')} in ${workspace.name} ${result.total === 1 ? 'has' : 'have'} had no logged activity for more than ${result.threshold_days} days. The quietest:`,
    result.accounts.map((a) => bullet(
      `${a.name} — ${a.days_since_activity === null ? 'never touched' : `${a.days_since_activity} days since the last activity${a.last_activity_at ? ` (${facts.day(a.last_activity_at)})` : ''}`}`
      + `${a.owner ? `, owned by ${a.owner}` : ', unowned'}`
      + `${a.open_pipeline > 0 ? `, ${a.open_pipeline_formatted} of open pipeline on it` : ''}`,
    )).join('\n'),
    // "4 of those carry open pipeline — A, B and C" reads as a complete list of
    // four, and the fourth account is the one nobody then calls.
    exposed.length
      ? `${exposed.length} of those ${exposed.length === 1 ? 'carries' : 'carry'} open pipeline — ${listPhrase(exposed.map((a) => `${a.name} ${a.open_pipeline_formatted}`))} — which is what makes the silence expensive.`
      : `None of them carries open pipeline, so this is a coverage problem rather than a forecast one.`,
  ];
}

/**
 * The period a movement answer covers.
 *
 * A comparison named two periods and means the span between them; one named
 * period means that period; naming none means the whole report.
 */
function movementWindow(input: SynthesisInput): TimeWindow | null {
  const named = (input.windows ?? []).filter((w) => w.start > 0 && w.end > w.start);
  if (input.comparison) {
    const { a, b } = input.comparison;
    const [first, second] = a.start <= b.start ? [a, b] : [b, a];
    return { ...first, start: first.start, end: Math.max(a.end, b.end), label: `${first.label} to ${second.label}` };
  }
  return named[0] ?? null;
}

function revenueAnswer(
  steps: StepResult[], facts: Facts, workspace: WorkspaceProfile, who: string | null, ledger: Ledger,
  namedWindow: TimeWindow | null = null,
  question = '',
): string[] {
  const blocks: string[] = [];
  // The question named a word more than one meter answers to. Both were
  // measured, and the reader is told that before the two numbers arrive —
  // otherwise two figures in different units look like a contradiction.
  const meters = steps.filter(ok).map((s) => s.result).filter(isMeteredUsage)
    .map((v) => (v as MeteredUsageResult).meter.name);
  if (new Set(meters).size > 1) {
    blocks.push(`That wording matches ${listPhrase([...new Set(meters)])} equally well, so both are measured — they are different meters in different units and neither is a substitute for the other.`);
  }
  for (const step of steps) {
    if (!ok(step)) continue;
    const value = step.result;
    if (isMeteredUsage(value)) blocks.push(...meteredUsageBlocks(value as MeteredUsageResult, facts, workspace));
    else if (isStaleAccounts(value)) blocks.push(...staleAccountBlocks(value as StaleAccountsResult, facts, workspace));
    else if (isDelinquentCustomers(value)) blocks.push(...delinquentBlocks(value as DelinquentCustomersPayload, facts, workspace));
    else if (isMeterList(value)) blocks.push(...meterBlocks(value as MeterRow[], workspace));
    else if (isMeterUsage(value)) blocks.push(...usageBlocks(value as MeterUsage, facts, workspace, who));
    else if (isEntitlementSet(value)) blocks.push(...entitlementBlocks(value as EntitlementSetPayload, workspace, who));
    else if (isCreditBalance(value)) blocks.push(...creditBlocks(value as CreditBalancePayload, facts, workspace, who, BURN_ORDER_ASKED.test(question)));
    else if (isPriceQuote(value)) blocks.push(...quoteBlocks(value as PriceQuote, workspace));
    else if (isProductList(value)) blocks.push(...productBlocks(value as CatalogProduct[]));
    else if (isBurnOrder(value)) blocks.push(...burnOrderBlocks((value as CreditBurnOrder).order));
    else if (isCrmRecord(value)) blocks.push(...crmRecordBlocks(value as CrmRecordPayload, workspace));
    else if (isRecoveryQueue(value)) blocks.push(...recoveryBlocks(value as { total: number; campaigns: RecoveryCampaign[] }, facts, workspace));
    else if (isPipelineList(value)) blocks.push(...pipelineBlocks(value as PipelineRow[]));
    else if (isPropertyList(value)) blocks.push(...propertyBlocks(value as PropertyRow[], typeof step.args.object_type === 'string' ? step.args.object_type : null));
    else if (isRevenueMovement(value)) blocks.push(...movementBlocks(value as MovementPayload, facts, workspace, namedWindow));
    else if (isRevenueSummary(value)) blocks.push(...revenueSummaryBlocks(value as RevenueSummaryPayload, workspace));
    else if (isCollections(value)) blocks.push(...collectionsBlocks(value as CollectionsPayload, workspace));
    else continue;
    ledger.use(value);
  }
  return blocks;
}

interface BillingFound {
  subscriptions: { list: BillingSubscriptionList; args: Record<string, unknown> }[];
  invoices: { list: BillingInvoiceList; args: Record<string, unknown> }[];
  summaries: BillingCustomerSummary[];
  explanations: BillingInvoiceExplanation[];
  upcoming: BillingUpcomingInvoice[];
  /** Rows the ledger actually returned in this run. */
  rows: number;
}

function gatherBilling(steps: StepResult[]): BillingFound {
  const found: BillingFound = { subscriptions: [], invoices: [], summaries: [], explanations: [], upcoming: [], rows: 0 };
  for (const step of steps) {
    if (!ok(step)) continue;
    const value = step.result;
    if (isSubscriptionList(value)) {
      const list = value as BillingSubscriptionList;
      found.subscriptions.push({ list, args: step.args });
      found.rows += list.subscriptions.length;
    } else if (isInvoiceList(value)) {
      const list = value as BillingInvoiceList;
      found.invoices.push({ list, args: step.args });
      found.rows += list.invoices.length;
    } else if (isCustomerSummary(value)) {
      found.summaries.push(value as BillingCustomerSummary);
      found.rows += 1;
    } else if (isInvoiceExplanation(value)) {
      found.explanations.push(value as BillingInvoiceExplanation);
      found.rows += 1;
    } else if (isUpcomingInvoice(value)) {
      found.upcoming.push(value as BillingUpcomingInvoice);
      found.rows += 1;
    }
  }
  return found;
}

/** How the ledger was filtered, said out loud so the count can be trusted. */
function subscriptionScope(args: Record<string, unknown>): string {
  const status = typeof args.status === 'string' ? args.status : 'active_like';
  if (status === 'all') return 'on the books, whatever their status';
  if (status === 'active_like') return 'still running — everything not cancelled or expired';
  return `at status ${humanise(status).toLowerCase()}`;
}

function subscriptionBlocks(entry: { list: BillingSubscriptionList; args: Record<string, unknown> }, workspace: WorkspaceProfile): string[] {
  const { list, args } = entry;
  const shown = list.subscriptions;
  if (!list.total || !shown.length) {
    return [`No subscription in ${workspace.name} is ${subscriptionScope(args)}${args.customer ? ' for that account' : ''}.`];
  }
  // Same rule as the invoice list: a count scoped to one account has to say so,
  // or it reads as a statement about the whole book.
  const names = new Set(shown.map((row) => row.customer_name).filter((name): name is string => !!name));
  const account = args.customer && names.size === 1 ? [...names][0] : null;
  const blocks = [
    `${countOf(list.total, 'subscription')} ${list.total === 1 ? 'is' : 'are'} ${subscriptionScope(args)}`
    + `${account ? ` on ${possessive(account)} account` : ''}`
    + `${shown.length < list.total ? `. ${shown.length} of them:` : ':'}`,
  ];
  blocks.push(shown.map((row) => {
    const parts: string[] = [];
    if (row.status) parts.push(humanise(row.status));
    if (row.items?.length) parts.push(row.items.join(' + '));
    if (row.mrr_display) parts.push(`${row.mrr_display} a month`);
    if (row.current_period_end) parts.push(`${row.cancel_at_period_end ? 'ends' : 'renews'} ${row.current_period_end}`);
    return bullet(`${row.customer_name ?? row.id}${parts.length ? ` — ${parts.join(' · ')}` : ''}`);
  }).join('\n'));
  if (shown.length < list.total) {
    blocks.push(`${countOf(list.total - shown.length, 'other subscription')} sit behind those — name a status such as past due, or an account, and I will narrow it.`);
  }
  return blocks;
}

function invoiceBlocks(entry: { list: BillingInvoiceList; args: Record<string, unknown> }, workspace: WorkspaceProfile): string[] {
  const { list, args } = entry;
  const shown = list.invoices;
  const status = typeof args.status === 'string' ? args.status : null;
  // "2 invoices are in the book" is a claim about the whole ledger. When the
  // rows are one account's, the sentence has to say whose.
  const names = new Set(shown.map((row) => row.customer_name).filter((name): name is string => !!name));
  const account = args.customer && names.size === 1 ? [...names][0] : null;
  const scope = args.due_before ? `past ${list.total === 1 ? 'its' : 'their'} due date`
    : status === 'open_like' ? 'still open'
    : status && status !== 'all' ? `at status ${humanise(status).toLowerCase()}`
    : account ? `on ${possessive(account)} account` : 'in the book';
  if (!list.total || !shown.length) {
    return [`No invoice in ${workspace.name} is ${scope}${args.customer ? ' for that account' : ''}.`];
  }
  // The tool totals only the rows it returned, and only the open ones owe
  // anything. "10 of them carry €918.00, £1,560.00 and $5,560.00 still due"
  // was said over ten rows of which five were paid — the figure was right and
  // the sentence around it counted the wrong rows.
  const owing = shown.filter((row) => row.status !== 'paid' && row.status !== 'void' && row.status !== 'draft');
  const partial = shown.length < list.total;
  const due = list.outstanding_display && owing.length
    ? owing.length === shown.length
      ? `, carrying ${list.outstanding_display} still due`
      : `, of which ${owing.length} ${owing.length === 1 ? 'is' : 'are'} still open and ${owing.length === 1 ? 'carries' : 'carry'} ${list.outstanding_display}`
    : '';
  const blocks = [
    `${countOf(list.total, 'invoice')} ${list.total === 1 ? 'is' : 'are'} ${scope}.`
    + `${partial
      ? ` Here are the ${shown.length} most recent${due}`
      : due ? ` ${shown.length === 1 ? 'It is' : 'They are'}${due.replace(/^, carrying/, ' carrying').replace(/^, of which/, ', of which')}` : ''}:`,
  ];
  blocks.push(shown.map((row) => {
    const parts: string[] = [];
    if (row.customer_name) parts.push(row.customer_name);
    if (row.status) parts.push(humanise(row.status));
    if (row.status === 'paid' || !row.amount_due_display || row.amount_due_display === row.total_display) {
      if (row.total_display) parts.push(row.total_display);
    } else {
      parts.push(`${row.amount_due_display} still due of ${row.total_display}`);
    }
    if (row.due) parts.push(`due ${row.due}`);
    return bullet(`${row.number ?? row.id}${parts.length ? ` — ${parts.join(' · ')}` : ''}`);
  }).join('\n'));
  if (shown.length < list.total) {
    blocks.push(`${countOf(list.total - shown.length, 'other invoice')} sit behind those — name an account or a status and I will narrow it.`);
  }
  return blocks;
}

function explanationBlocks(invoice: BillingInvoiceExplanation): string[] {
  const blocks = [
    `Invoice ${invoice.number}${invoice.customer_name ? ` for ${invoice.customer_name}` : ''} — ${humanise(invoice.status).toLowerCase()}, covering ${invoice.covers}.`,
  ];
  if (invoice.lines.length) {
    blocks.push(invoice.lines.slice(0, 8).map((line) => {
      // The ledger repeats the description as the explanation on a line that
      // needs no explaining; saying it twice reads as a bug, because it is one.
      const bare = (text: string) => text.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').toLowerCase();
      const why = line.why && bare(line.why) !== bare(line.description) ? `: ${line.why}` : '';
      return bullet(`${line.description} — ${line.amount_display}${line.proration ? ' (proration)' : ''}${why}`);
    }).join('\n'));
  }
  const totals = [`subtotal ${invoice.subtotal_display}`];
  if (invoice.tax_display) totals.push(`tax ${invoice.tax_display}`);
  if (invoice.balance_applied_display) totals.push(`account balance ${invoice.balance_applied_display}`);
  blocks.push(`${listPhrase(totals)} — ${invoice.total_display} in total.`);
  // A bill whose lines do not sum to its total is the one thing a customer will
  // find, so it is said out loud rather than left for them to notice.
  if (invoice.adds_up === false) {
    blocks.push('The lines on this invoice do not add up to the total it states. Do not send it out before someone has looked at it.');
  }
  return blocks;
}

function upcomingBlocks(invoice: BillingUpcomingInvoice): string[] {
  const blocks = [`The next invoice is dated ${invoice.due} and covers ${invoice.covers}.`];
  if (invoice.lines.length) blocks.push(invoice.lines.slice(0, 8).map((line) => bullet(line)).join('\n'));
  const parts = [`subtotal ${invoice.subtotal_display}`];
  if (invoice.balance_applied_display) parts.push(`account balance ${invoice.balance_applied_display}`);
  blocks.push(`${listPhrase(parts)} — ${invoice.total_display} will be charged. Nothing has been billed yet; this is the bill as it stands.`);
  return blocks;
}

function summaryBlocks(summary: BillingCustomerSummary, facts: Facts, upcomingShown: boolean): string[] {
  const blocks: string[] = [];
  const commercial: string[] = [];
  if (summary.subscriptions.live) {
    commercial.push(summary.subscriptions.total > summary.subscriptions.live
      ? `${countOf(summary.subscriptions.live, 'live subscription')} of ${summary.subscriptions.total}`
      : countOf(summary.subscriptions.live, 'live subscription'));
  }
  if (summary.mrr) commercial.push(`${facts.money(summary.mrr)} a month, ${facts.money(summary.arr)} annualised`);
  if (summary.lifetime_value.periods_billed) {
    commercial.push(`${facts.money(summary.lifetime_value.amount)} billed across ${countOf(summary.lifetime_value.periods_billed, 'period')}`);
  }
  // Composed from the fields rather than from the ledger's own headline, so the
  // same two facts are not stated twice in two different roundings.
  blocks.push(commercial.length
    ? `${summary.customer.name} — ${listPhrase(commercial)}.`
    : `${summary.customer.name} — ${summary.headline}`);
  if (summary.balance.amount !== 0) blocks.push(summary.balance.description);
  if (summary.open_invoices.data.length) {
    blocks.push(`${countOf(summary.open_invoices.data.length, 'invoice')} still open, ${facts.money(summary.open_invoices.total)} outstanding${summary.open_invoices.oldest_due ? `, the oldest due ${facts.day(summary.open_invoices.oldest_due)}` : ''}.`);
  }
  // The preview tool says the same thing in more detail; saying it twice, with
  // two roundings of the same date, reads as two different bills.
  if (summary.next_invoice && !upcomingShown) {
    blocks.push(`Next invoice ${facts.day(summary.next_invoice.date)} for about ${facts.money(summary.next_invoice.estimated_total)} — ${summary.next_invoice.note}`);
  }
  if (summary.attention.length) {
    blocks.push(`Needs attention: ${listPhrase(summary.attention.map((line) => line.trim().replace(/\.$/, '')))}.`);
  }
  return blocks;
}

/** Everything the ledger returned in this run, as sentences. */
function billingAnswer(found: BillingFound, facts: Facts, workspace: WorkspaceProfile, ledger: Ledger): string[] {
  const blocks: string[] = [];
  for (const summary of found.summaries.slice(0, 2)) blocks.push(...summaryBlocks(ledger.use(summary), facts, found.upcoming.length > 0));
  for (const entry of found.subscriptions.slice(0, 2)) {
    ledger.use(entry.list);
    blocks.push(...subscriptionBlocks(entry, workspace));
  }
  for (const entry of found.invoices.slice(0, 2)) {
    ledger.use(entry.list);
    blocks.push(...invoiceBlocks(entry, workspace));
  }
  for (const invoice of found.explanations.slice(0, 2)) blocks.push(...explanationBlocks(ledger.use(invoice)));
  for (const invoice of found.upcoming.slice(0, 2)) blocks.push(...upcomingBlocks(ledger.use(invoice)));
  return blocks.filter(Boolean);
}

/**
 * How many rows every list-returning tool in this run came back with.
 *
 * The "nothing matched" sentence is gated on this rather than on one CRM
 * search, because a run that found 341 invoices has not found nothing.
 */
function rowsReturned(steps: StepResult[]): number {
  let rows = 0;
  for (const step of steps) {
    if (!ok(step)) continue;
    const value = step.result;
    if (isRecordList(value)) { rows += (value as RecordSearchResult).records.length; continue; }
    if (isSearch(value)) { rows += (value as WorkspaceSearchResult).matches.length; continue; }
    if (isAggregate(value)) { rows += (value as RecordAggregateResult).matched_records; continue; }
    if (isTimeline(value)) { rows += (value as { items: TimelineItem[] }).items.length; continue; }
    if (isMetric(value) || isProfile(value)) continue;
    if (isMeterUsage(value) || isEntitlementSet(value) || isCreditBalance(value) || isPriceQuote(value)) { rows += 1; continue; }
    if (Array.isArray(value)) { rows += value.length; continue; }
    if (value && typeof value === 'object') {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(inner)) rows += inner.length;
      }
    }
  }
  return rows;
}

/**
 * Whether the composer has a renderer for this payload shape at all.
 *
 * Exported because it is the contract a test can hold the engine to: every
 * result a plan produces is either a shape something above knows how to write
 * out, or a result the answer names as discarded. There is no third state where
 * a tool runs, succeeds, and the reader never hears about it.
 */
export function hasRenderer(value: unknown): boolean {
  return isRecordList(value) || isSearch(value) || isAggregate(value) || isMetric(value) || isProfile(value) || isTimeline(value)
    || isSubscriptionList(value) || isInvoiceList(value) || isCustomerSummary(value) || isInvoiceExplanation(value) || isUpcomingInvoice(value)
    || isRevenueShape(value);
}

/**
 * Citations are provenance, not a list of everything the resolver considered.
 * A record only earns one if the answer actually names it, or if it is one of
 * the rows a stated number was computed from. That is why a trigram near-miss
 * on another account never shows up under an answer about a different one.
 */
function citationsFrom(input: SynthesisInput, content: string): Citation[] {
  const out = new Map<string, Citation>();
  /** Rows a stated number was computed from — cited whether or not they are named. */
  const grounded = new Set<string>();
  const add = (id: string | null | undefined, label: string, type: string, isGrounded = false) => {
    if (!id) return;
    if (isGrounded) grounded.add(id);
    if (out.has(id)) return;
    out.set(id, { id, label, type });
  };
  for (const step of input.steps) {
    if (!ok(step)) continue;
    const value = step.result;
    if (isProfile(value)) {
      const profile = value as AccountProfileResult;
      add(profile.id, profile.name, profile.object_type, true);
      for (const deal of profile.open_deals.slice(0, 4)) add(deal.id, deal.name, 'deal');
      for (const contact of profile.contacts.slice(0, 3)) add(contact.id, contact.name, 'contact');
      for (const ticket of profile.open_tickets.slice(0, 3)) add(ticket.id, ticket.subject, 'ticket');
    } else if (isMetric(value)) {
      const metric = value as MetricToolResult;
      if (metric.subject) add(metric.subject.id, metric.subject.label, metric.subject.type, true);
      for (const row of metric.evidence.slice(0, 6)) add(row.id, row.label, row.type, true);
      for (const account of metric.top_accounts.slice(0, 3)) add(account.id, account.label, 'company', true);
    } else if (isSearch(value)) {
      for (const match of (value as WorkspaceSearchResult).matches.slice(0, 5)) add(match.id, match.label, match.type);
    } else if (isRecordList(value)) {
      const list = value as RecordSearchResult;
      for (const record of list.records.slice(0, 6)) add(record.id, record.name, list.object_type);
    } else if (isTimeline(value)) {
      for (const item of (value as { items: TimelineItem[] }).items.slice(0, 4)) add(item.id, item.title, item.kind);
    } else if (isAggregate(value)) {
      // "matched record ×4" identifies nothing. The rows carry their own names.
      const agg = value as RecordAggregateResult;
      for (const row of (agg.samples ?? []).slice(0, 4)) add(row.id, row.label, agg.object_type, true);
    } else if (isSubscriptionList(value)) {
      for (const row of (value as BillingSubscriptionList).subscriptions.slice(0, 8)) {
        add(row.id, row.customer_name ?? row.id, 'subscription', true);
      }
    } else if (isInvoiceList(value)) {
      for (const row of (value as BillingInvoiceList).invoices.slice(0, 8)) add(row.id, row.number ?? row.id, 'invoice', true);
    } else if (isInvoiceExplanation(value)) {
      const invoice = value as BillingInvoiceExplanation;
      if (typeof step.args.invoice === 'string') add(step.args.invoice, invoice.number, 'invoice', true);
    } else if (isCustomerSummary(value)) {
      const summary = value as BillingCustomerSummary;
      add(summary.customer.id ?? null, summary.customer.name, 'customer', true);
    }
  }
  if (input.subject) {
    const resolved = input.entities.find((e) => e.entity.id === input.subject!.id);
    if (resolved) add(resolved.entity.id, resolved.entity.label, resolved.entity.type, true);
  }
  // A write is about the record it touches, whether or not the answer names it.
  for (const step of input.steps) {
    if (!step.write) continue;
    const targets = [step.args.record_id, step.args.id, ...(Array.isArray(step.args.record_ids) ? step.args.record_ids : [])];
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      const entity = input.entities.find((e) => e.entity.id === target);
      add(target, entity?.entity.label ?? target, entity?.entity.type ?? 'record', true);
    }
  }
  return [...out.values()]
    .filter((citation) => grounded.has(citation.id) || content.includes(citation.label) || content.includes(citation.id))
    .slice(0, 12);
}

interface Gathered {
  metrics: MetricToolResult[];
  profiles: AccountProfileResult[];
  lists: RecordSearchResult[];
  aggregates: RecordAggregateResult[];
  searches: WorkspaceSearchResult[];
}

/**
 * The general answer: lead with the number, then name the records behind it.
 *
 * `metricStated` is set when the branch above already wrote the headline. It
 * used to be a fall-through, so a lookup that resolved a metric and no profile
 * printed the same three paragraphs twice, back to back.
 */
function overview(input: SynthesisInput, facts: Facts, found: Gathered, ledger: Ledger, metricStated = false): string[] {
  const blocks: string[] = [];
  if (found.metrics.length && !metricStated) {
    blocks.push(...metricSentence(found.metrics[0], input, facts, ledger));
    blocks.push(...metricBreakdown(found.metrics[0]));
  }
  if (found.profiles.length) blocks.push(...profileParagraph(found.profiles[0], facts, input.workspace, ledger, alreadyProfiled(input, found.profiles[0])));

  const deals = found.lists.find((l) => l.object_type === 'deal' && l.records.length);
  if (deals) {
    // "The largest of the 38 deals still open:" over five bullets counts one
    // row and shows five. A cut-off the reader wrote — "the 5 biggest" — has
    // to be the number in this sentence, or the sentence contradicts the list.
    //
    // And the sentence describes the query that ran, never the workspace: this
    // line used to assert "still open" over a search with no stage filter (77
    // deals, 39 of them closed) and to drop the pipeline the same run was
    // scoped to, so a Renewal-only list read as a claim about all 38 open
    // deals.
    const args = input.steps.find((step) => step.result === deals)?.args ?? {};
    const shown = Math.min(5, deals.records.length);
    const ranked = orderWord(args) ?? 'most recent';
    // "The 3 closing soonest:" — a phrase already says what it is over, and
    // "of them" after it reads as a slip.
    const order = ranked.includes(' ')
      ? `The ${shown === 1 ? 'one' : shown} ${ranked}:`
      : shown === 1 ? `The ${ranked} of them:` : `The ${shown} ${ranked} of them:`;
    const counted = found.metrics.some((m) => m.count === deals.total);
    blocks.push(counted ? order : `${listLead(deals, args, input)} ${order}`);
    blocks.push(...recordLines(deals, facts, input.workspace, ledger, 5));
  } else if (found.lists.length && found.lists[0].records.length) {
    blocks.push(...recordLines(found.lists[0], facts, input.workspace, ledger, 5));
  }

  for (const aggregate of found.aggregates) {
    if (!aggregate.groups.length) continue;
    ledger.use(aggregate);
    const rows = aggregate.groups.slice(0, 4).map((g) => `${g.label} ${g.value.toLocaleString(input.workspace.locale)}`).join(' · ');
    blocks.push(aggregate.object_type === 'ticket'
      ? `Support backlog: ${countOf(aggregate.matched_records, 'open ticket')} — ${rows}.`
      : `${aggregate.measure} across ${countOf(aggregate.matched_records, aggregate.object_type)}: ${rows}.`);
  }

  if (!blocks.length && found.searches.length && found.searches[0].matches.length) {
    ledger.use(found.searches[0]);
    blocks.push(...found.searches[0].matches.slice(0, 5).map((m) => bullet(`${m.label} (${humanise(m.type)})`)));
  }
  return blocks;
}

/* --------------------------- refusing to fake it -------------------------- */

/** What each ledger type is called in a sentence a person reads. */
const LEDGER_NOUN: Record<string, string> = {
  usage: 'metered usage',
  entitlement: 'entitlements',
  credit: 'credit balances',
  invoice: 'invoices',
  subscription: 'subscriptions',
  meter: 'meters',
  product: 'the price book',
};

const ledgerNoun = (type: string): string => LEDGER_NOUN[type] ?? `${type} records`;

/**
 * The capability the question asked for, and why this run would not fake it.
 *
 * This block leads the answer. Everything it replaces — a sales metric under a
 * usage question, a CRM search for rows the CRM has never held, an account card
 * where a ledger reading belongs — reads as an answer, and the reader stops at
 * the first sentence. So the first sentence is the refusal, and it carries the
 * one thing that would let the person ask again successfully.
 */
function blockedBlocks(entry: BlockedCapability, input: SynthesisInput): string[] {
  const noun = ledgerNoun(entry.objectType);
  const who = input.subject ? namedOrNull(input.subject.label) : null;
  const forWhom = who ? ` for ${who}` : '';
  // A period only belongs in the offer when the reading is over a period. An
  // entitlement is a state right now, and "over Q3 2026" would be a promise to
  // filter on something this capability does not take.
  const overPeriod = entry.objectType === 'usage' && input.window.label ? ` over ${input.window.label}` : '';
  const options = entry.options ?? [];
  const optionList = listPhrase(options.map((option) => option.label));

  if (entry.reason === 'no_capability') {
    return [
      entry.otherScope
        ? [
            `I have not answered that ${entry.scope === 'workspace' ? 'across the whole book' : 'for one account'}:`,
            `${noun} ${entry.otherScope.scope === 'account' ? 'is read one account at a time here' : 'is read for the workspace as a whole here'} —`,
            `\`${entry.otherScope.tool}\` ${entry.otherScope.scope === 'account' ? 'takes a customer, and the question names none. Name an account and I will read it there.' : 'reads it that way, so ask it about the workspace and I will run it.'}`,
          ].join(' ')
        : `I have not answered that: no module in ${input.workspace.name} publishes a capability that reads ${noun}, so there is nothing for me to run.`,
      `I have not searched the CRM for ${entry.objectType} records instead: those rows live in the ledger that owns them, and that search comes back with zero every time.`,
    ];
  }

  if (entry.reason === 'out_of_scope') {
    return [
      entry.tool
        ? `This run was scoped away from \`${entry.tool}\`, which is the only capability that reads ${noun}, so I measured nothing.`
        : `This run was scoped to ${input.scopedTools?.length ? listPhrase(input.scopedTools.map((t) => `\`${t}\``)) : 'no tools'}, and nothing on that list reads ${noun}, so I measured nothing.`,
      `Include the capability that does in \`tools\` and I will run it${forWhom}${overPeriod}.`,
    ];
  }

  const missing = listPhrase(entry.missing.map((name) => `\`${name}\``));
  if (entry.ambiguous && options.length > 1) {
    return [
      `"${entry.matched ?? input.question.trim()}" matches ${countOf(options.length, entry.missing[0] ?? 'record')} in ${input.workspace.name} and nothing else in the question separates them — ${optionList} measure different things, so I will not pick one for you:`,
      options.map((option) => bullet(`${option.label}${option.detail ? ` — ${option.detail}` : ''}`)).join('\n'),
      `Name the one you mean and I will read it${forWhom}${overPeriod}.`,
    ];
  }
  return [
    [
      `I have not answered that from ${noun}: \`${entry.tool}\` needs ${missing},`,
      `and nothing in the question or the records it resolved to gives me ${entry.missing.length === 1 ? 'one' : 'them'}.`,
    ].join(' '),
    options.length
      ? `${input.workspace.name} ${entry.missing[0] === 'meter' ? 'meters' : 'has'} ${optionList} — name one and I will read it${forWhom}${overPeriod}.`
      : `Name ${entry.missing.length === 1 ? 'it' : 'them'} and I will run it${forWhom}${overPeriod}.`,
    // The substitution is named so nobody has to wonder whether it happened.
    `I have not measured closed-won bookings or listed CRM records instead — that would be a different question with a different number, and it would read exactly like an answer.`,
  ];
}

/** Nothing came back — say what was searched and what to try instead. */
function emptyAnswer(input: SynthesisInput, facts: Facts): string {
  const failures = input.steps.filter((s) => !s.ok && s.error);
  const lines: string[] = [];
  if (input.entities.length) {
    lines.push(`I matched "${input.entities[0].mention}" to ${input.entities[0].entity.label}, but the question did not resolve to anything I can measure in ${input.workspace.name}.`);
  } else {
    lines.push('Nothing I hold answers that. I did not list records ordered by recency underneath it, because that would read as an answer to the question you asked and it is an answer to a different one.');
  }
  // A measure or an object type that resolved and then could not be used is
  // the most useful thing to say: it tells the reader exactly how close they got.
  if (input.metric) {
    lines.push(`"${input.metric.matched}" resolved to ${input.metric.metric.label}, which is a figure for the workspace — it does not pick out which records are behind it, and nothing here scores individual records on it.`);
  }
  if (failures.length) {
    lines.push(`What I tried: ${failures.map((f) => `${f.tool} (${f.error?.code})`).join(', ')}.`);
  }
  lines.push(
    'I can measure any metric in the catalogue over any period, for the workspace, one account or one rep;'
    + ' list any object type with real filters — a stage, an owner, a threshold, a date;'
    + ' read metered usage, credit balances, entitlements, invoices and the recovery queue from the ledger;'
    + ' and pull one account\u2019s profile and timeline.',
  );
  lines.push('Name what you want measured, listed or read — for example "which accounts have gone quiet?", "open deals over $500,000 owned by Priya", or "which customers are past due?".');
  void facts;
  return lines.join(' ');
}

/* ------------------------------ the composer ------------------------------ */

export function synthesise(input: SynthesisInput): SynthesisOutput {
  const facts = new Facts(input.workspace);
  const nameOf = (id: string): string | null =>
    input.entities.find((e) => e.entity.id === id)?.entity.label
    ?? input.workspace.people.find((p) => p.id === id)?.name
    ?? null;
  const metrics = resultsOf<MetricToolResult>(input.steps, 'business_metric', isMetric);
  const profiles = input.steps.filter((s) => ok(s) && isProfile(s.result)).map((s) => s.result as AccountProfileResult);
  const timelines = input.steps.filter((s) => ok(s) && isTimeline(s.result)).map((s) => s.result as { record: string; items: TimelineItem[] });
  const searches = input.steps.filter((s) => ok(s) && isSearch(s.result)).map((s) => s.result as WorkspaceSearchResult);
  const lists = input.steps.filter((s) => ok(s) && isRecordList(s.result)).map((s) => s.result as RecordSearchResult);
  const aggregates = input.steps.filter((s) => ok(s) && isAggregate(s.result)).map((s) => s.result as RecordAggregateResult);
  const ledger = new Ledger();
  const billing = gatherBilling(input.steps);
  const billingBlocks = billingAnswer(billing, facts, input.workspace, ledger);
  const revenueBlocks = revenueAnswer(
    input.steps, facts, input.workspace, input.subject ? namedOrNull(input.subject.label) : null, ledger,
    movementWindow(input), input.question,
  );
  // The nouns that make a question a ledger question rather than a CRM one.
  const ledgerLeads = (billingBlocks.length + revenueBlocks.length) > 0 && LEDGER_QUESTION.test(input.question);
  let ledgerLed = false;
  // Every row every list-returning tool came back with. "Nothing matched" is a
  // claim about the whole run, not about one CRM search inside it.
  const rows = rowsReturned(input.steps);
  const blocks: string[] = [];

  // The refusal comes first, always. A person reads the first sentence and
  // stops, so a confident paragraph about something else on top of it is the
  // same defect as not refusing at all.
  for (const entry of (input.blocked ?? []).slice(0, 2)) blocks.push(...blockedBlocks(entry, input));

  if (input.draft) {
    // The draft is written from the account and its timeline; `personalisation`
    // lists the facts it took, so those results reached the reader.
    ledger.useAll(profiles);
    ledger.useAll(timelines);
    const draft = input.draft;
    blocks.push(draft.channel === 'email'
      ? `Subject: ${draft.subject}\n\n${draft.body}`
      : `${draft.subject}\n\n${draft.body}`);
    if (draft.personalisation.length) {
      blocks.push(`Written from: ${draft.personalisation.join('; ')}.`);
    }
    if (draft.recipient?.email) blocks.push(`Ready to send to ${draft.recipient.name} <${draft.recipient.email}>.`);
    const drafted = blocks.join('\n\n');
    return { content: drafted, citations: citationsFrom(input, drafted), rendering: renderingOf(input, ledger) };
  }

  // A ranking question is answered by the ranking, whatever the classifier
  // called the sentence it arrived in — but only when the metric actually came
  // back grouped. A "ranking" of nothing next to a workspace total is a
  // sentence that contradicts itself, so that case takes the ordinary path.
  const rankable = input.ranking && !input.pendingApprovals.length
    ? metrics.filter((m) => m.groups.length || m.top_accounts.length).slice(-1)[0]
    : undefined;
  if (rankable) {
    ledger.use(rankable);
    const ranked = [...blocks, ...rankedAnswer(rankable, input)];
    const content = ranked.join('\n\n');
    return { content, citations: citationsFrom(input, content), rendering: renderingOf(input, ledger) };
  }

  switch (input.intent.intent) {
    case 'compare': {
      const periods = periodPair(metrics);
      if (periods) {
        const [a, b] = periods;
        // A snapshot metric was never measured over either period: both sides
        // were recomputed from today's rows, so they are the same number by
        // construction. Saying the business "held the same MRR in both periods"
        // is a historical claim nothing here computed, and it is the one thing
        // a reader would act on. The comparison is refused instead.
        if (a.snapshot || b.snapshot) {
          blocks.push([
            `${a.label} is a point-in-time figure: it is recomputed from the rows that stand right now, so it has no value "as at" a past period.`,
            `Both sides of that comparison would be the same number — today's — and calling that "no change" would be a claim about history I never measured.`,
            `${a.subject ? a.subject.label : input.workspace.name} is at ${a.formatted} today, from ${a.source}.`,
          ].join(' '));
          // What this workspace does not keep is a stamped value of the
          // snapshot per period. Saying it keeps "no history" is a claim about
          // the database that is false whenever a movement report exists, and
          // the reader acts on the first sentence.
          blocks.push([
            `The snapshot carries no stamped value for ${a.window.label} or ${b.window.label}, so I will not print one against the other.`,
            `For how it moved between them, ask for the movement — new business, expansion, contraction and churn, month by month.`,
            `For a level measured over a period, ask about invoiced, revenue or closed-won bookings.`,
          ].join(' '));
          break;
        }
        // Two books cannot be subtracted from each other, and the sum of three
        // currencies is not a figure in any of them.
        if (a.mixedCurrency || b.mixedCurrency) {
          blocks.push([
            `${a.subject ? a.subject.label : input.workspace.name} bills in more than one currency and there is no exchange-rate table here,`,
            `so ${a.label.toLowerCase()} is a book per currency and the two periods cannot be subtracted into one delta.`,
          ].join(' '));
          for (const metric of [a, b]) {
            blocks.push(bullet(`${metric.window.label}: ${metric.formatted}${metric.count ? ` from ${metric.source}` : ' — nothing recorded'}`));
          }
          blocks.push(`Ask for one currency at a time and I will give you the change in it.`);
          break;
        }
        // The first period the question named is the subject; the second is the
        // baseline it is measured against. Reading those two the other way round
        // is how an 81% collapse got reported as 435% growth: both the sign of
        // the delta and the denominator of the percentage follow this line.
        const delta = a.value - b.value;
        const percent = b.value === 0 ? null : (delta / Math.abs(b.value)) * 100;
        const who = a.subject ? a.subject.label : input.workspace.name;
        const deltaText = unitDelta(Math.abs(delta), a.unit, facts, input.workspace.locale, a.currency);
        const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'level';
        blocks.push(delta === 0
          // "invoiced the same invoiced in both periods" put the metric's label
          // where the noun belongs. The measure is already named by the verb.
          ? `${who} ${verb(a)} ${a.formatted} in ${a.window.label} and the same again in ${b.window.label} — ${a.label.toLowerCase()} was unchanged across the two.`
          : `${who} ${verb(a)} ${a.formatted} in ${a.window.label} and ${b.formatted} in ${b.window.label}`
            + ` — ${a.window.label} is ${direction} ${deltaText}${percent === null ? '' : ` (${formatSignedPercent(percent)})`} on ${b.window.label}.`);
        for (const metric of [a, b]) {
          blocks.push(bullet(`${metric.window.label}: ${metric.formatted}${metric.count ? ` from ${metric.source}` : ' — nothing recorded'}${metric.window.partial ? ' (period still running)' : ''}`));
        }
        const partial = [a, b].filter((m) => m.window.partial && !m.snapshot);
        if (partial.length === 1) {
          blocks.push(`${partial[0].window.label} is still running, so it is a period-to-date figure and the two periods are not yet like for like.`);
        }
        for (const metric of [a, b]) {
          if (metric.groups.length) blocks.push(`${metric.window.label} breakdown: ${metric.groups.slice(0, 6).map((g) => `${g.label} ${g.formatted}`).join(' · ')}.`);
        }
        blocks.push(...droppedPeriods(input, [a.window.label, b.window.label]));
        break;
      }
      // Two teammates is a comparison, and neither side is a catalogue metric:
      // `business_metric` takes no owner, so each rep is a shaped aggregate
      // over the rows they own. Without this the run computed both figures
      // correctly and printed "the question did not resolve to anything I can
      // measure" over the top of them.
      if (aggregates.length >= 2 && metrics.length < 2) {
        const sides = aggregates.slice(0, 2).map((agg) => {
          const step = input.steps.find((one) => one.result === agg);
          const owner = String((step?.args as Record<string, unknown> | undefined)?.owner_id ?? '');
          return { agg, who: input.workspace.people.find((p) => p.id === owner)?.name ?? input.workspace.name };
        });
        if (sides[0].who !== sides[1].who) {
          for (const side of sides) ledger.use(side.agg);
          const [lead, trail] = [...sides].sort((x, y) => y.agg.value - x.agg.value);
          const measure = input.metric?.metric.label.toLowerCase() ?? lead.agg.measure.toLowerCase();
          const gap = lead.agg.value - trail.agg.value;
          const percent = trail.agg.value !== 0 ? `, ${((gap / Math.abs(trail.agg.value)) * 100).toFixed(0)}% ahead` : '';
          blocks.push(gap === 0
            ? `${lead.who} and ${trail.who} are level on ${measure}, both at ${lead.agg.formatted}.`
            : `On ${measure}, ${lead.who} leads with ${lead.agg.formatted} against ${trail.who} at ${trail.agg.formatted} — a gap of ${facts.money(gap)}${percent}.`);
          for (const side of [lead, trail]) {
            blocks.push(bullet(`${side.who}: ${side.agg.formatted} across ${countOf(side.agg.matched_records, side.agg.object_type)}`));
          }
          break;
        }
      }
      if (metrics.length >= 2) {
        const [a, b] = metrics;
        const sideOf = (metric: MetricToolResult): string | null =>
          metric.subject ? namedOrNull(metric.subject.label) : input.workspace.name;
        // A side with no name is not a side. Printing its id in the sentence
        // where a company name goes is how a comparison stops being readable.
        if (!sideOf(a) || !sideOf(b)) {
          const nameless = [a, b].filter((m) => !sideOf(m)).map((m) => m.subject?.id ?? 'an unidentified record');
          blocks.push([
            `I will not put ${countOf(nameless.length, 'record')} in a comparison without a name for ${nameless.length === 1 ? 'it' : 'them'}.`,
            `One side of this resolved to ${listPhrase(nameless)}, which carries no display name in ${input.workspace.name}, so I have not written the sentence.`,
            `Name both accounts as they appear in the CRM and I will run it.`,
          ].join(' '));
          break;
        }
        const leader = a.value >= b.value ? a : b;
        const trailer = a.value >= b.value ? b : a;
        const gap = Math.abs(a.value - b.value);
        const gapText = unitDelta(gap, a.unit, facts, input.workspace.locale, a.currency);
        const percent = trailer.value !== 0 ? `, ${((gap / Math.abs(trailer.value)) * 100).toFixed(0)}% ahead` : '';
        const scope = a.snapshot ? 'right now' : labelIsPrepositional(a.window.label) ? a.window.label : `in ${a.window.label}`;
        blocks.push(gap === 0
          ? `${sideOf(leader)} and ${sideOf(trailer)} are level on ${a.label.toLowerCase()} ${scope}, both at ${leader.formatted}.`
          : `On ${a.label.toLowerCase()} ${scope}, ${sideOf(leader)} leads with ${leader.formatted} against ${sideOf(trailer)} at ${trailer.formatted} — a gap of ${gapText}${percent}.`);
        for (const metric of [leader, trailer]) {
          // "up on $0" is not what a flat line says. A zero delta is unchanged.
          const movement = metric.change
            ? metric.change.delta === 0
              ? `, unchanged on ${metric.change.previous_formatted} the period before`
              : `, ${metric.change.delta > 0 ? 'up' : 'down'} on ${metric.change.previous_formatted} the period before`
            : '';
          blocks.push(bullet(`${sideOf(metric)}: ${metric.formatted} from ${metric.source}${movement}`));
        }
      } else if (metrics.length === 1) {
        const metric = metrics[0];
        blocks.push(...metricSentence(metric, input, facts, ledger));
        blocks.push(...metricBreakdown(metric));
      }
      break;
    }

    case 'aggregate': {
      if (metrics.length) {
        const metric = metrics[metrics.length - 1];
        // A question can ask two things — "how many open deals do we have and
        // what are they worth" — and answering only the last one measured is
        // how the total went missing from an answer that computed it.
        for (const earlier of metrics.slice(0, -1)) {
          blocks.push(...metricSentence(earlier, input, facts, ledger));
        }
        blocks.push(...metricSentence(metric, input, facts, ledger));
        blocks.push(...metricBreakdown(metric));
        // A zero is only useful next to what the account does have.
        if (metric.count === 0 && profiles.length) {
          const profile = profiles[0];
          const context: string[] = [];
          if (profile.totals.lifetime_won) {
            const latest = profile.won_deals.filter((d) => d.closed).sort((a, b) => (b.closed ?? 0) - (a.closed ?? 0))[0];
            context.push(`${profile.totals.lifetime_won_formatted} closed-won all time across ${countOf(profile.won_deals.length, 'deal')}${latest?.closed ? `, most recently ${latest.name} on ${facts.day(latest.closed)}` : ''}`);
          }
          if (profile.totals.open_pipeline) context.push(`${profile.totals.open_pipeline_formatted} of open pipeline`);
          if (context.length) blocks.push(`For context, ${profile.name} has ${listPhrase(context)}.`);
        } else if (profiles.length && metric.subject) {
          blocks.push(...profileParagraph(profiles[0], facts, input.workspace, ledger, alreadyProfiled(input, profiles[0])).slice(0, 1));
        }
      } else if (aggregates.length) {
        blocks.push(...aggregateSentence(aggregates[0], input, ledger));
      }
      break;
    }

    case 'explain': {
      const metric = metrics[0];
      if (metric) {
        blocks.push(...metricSentence(metric, input, facts, ledger));
        for (const step of input.steps) {
          if (!ok(step) || !isAggregate(step.result)) continue;
          const agg = ledger.use(step.result as RecordAggregateResult);
          if (!agg.groups.length) continue;
          const groupBy = String(step.args.group_by ?? '');
          const conditions = (step.args.conditions as { property?: string; value?: unknown }[] | undefined) ?? [];
          const lost = conditions.some((c) => c.value === 'closed_lost');
          const rows = agg.groups.slice(0, 4).map((g) => `${g.label} ${facts.money(g.value)} (${countOf(g.count, 'deal')})`);
          blocks.push(lost
            ? `Losses in the period group by ${humanise(groupBy).toLowerCase()}: ${rows.join(' · ')}.`
            : `What closed, by ${humanise(groupBy).toLowerCase()}: ${rows.join(' · ')}.`);
        }
      }
      // "What happened on X recently" is answered by X's own history, and it
      // leads: the account card underneath is context for it.
      if (timelines.length && timelines[0].items.length) {
        blocks.push(input.subject ? `What has happened on ${input.subject.label}, most recent first:` : 'Most recent first:');
        blocks.push(...timelineLines(timelines[0], 8, facts, ledger));
      }
      if (profiles.length) blocks.push(...profileParagraph(profiles[0], facts, input.workspace, ledger, alreadyProfiled(input, profiles[0])));
      if (!metric && !profiles.length && !timelines.length && lists.length) blocks.push(...recordLines(lists[0], facts, input.workspace, ledger));
      break;
    }

    case 'lookup': {
      // A question about the ledger is answered by the ledger. The account card
      // is context for that number; printing it first buries the answer under
      // four paragraphs of firmographics nobody asked for.
      if (ledgerLeads) { blocks.push(...billingBlocks, ...revenueBlocks); ledgerLed = true; }
      // A lookup can still have a number in it — "what does X pay us each
      // month" is answered by the metric, then by the record it is about.
      const metricStated = metrics.length > 0 && !!input.metric;
      if (metricStated) blocks.push(...metricSentence(metrics[0], input, facts, ledger));
      if (profiles.length) {
        const profile = profiles[0];
        // The answer first, the profile underneath it as context. A reader
        // takes the first sentence, so the first sentence has to be the one
        // they asked for.
        const lead = leadAnswer(input.question, profile, facts);
        if (lead) { ledger.use(profile); blocks.push(lead); }
        // A question that named a type as well as an account is answered by the
        // rows of that type, not by the count of them inside a profile.
        const typed = lists.find((l) => l.records.length && l.object_type !== 'company');
        if (typed) {
          if (!lead) blocks.push(`${countOf(typed.total, typed.object_type)} on ${profile.name}:`);
          blocks.push(...recordLines(typed, facts, input.workspace, ledger, 6));
        }
        blocks.push(...profileParagraph(profile, facts, input.workspace, ledger, alreadyProfiled(input, profile)));
        if (!typed && profile.open_deals.length > 1) {
          blocks.push(...profile.open_deals.slice(0, 4).map((deal) =>
            bullet(`${deal.name} — ${deal.amount_formatted}, ${deal.stage.toLowerCase()}${deal.close_date ? `, closes ${facts.calendarDay(deal.close_date)}` : ''}${deal.owner ? `, ${deal.owner}` : ''}`)));
        }
      } else if (searches.length && searches[0].matches.length) {
        const search = ledger.use(searches[0]);
        blocks.push(`${countOf(search.matches.length, 'record')} in ${input.workspace.name} ${search.matches.length === 1 ? 'matches' : 'match'} that${search.ambiguous ? ' — the top two are close, so tell me which you mean' : ''}:`);
        blocks.push(...search.matches.slice(0, 6).map((match) =>
          bullet(`${match.label} (${humanise(match.type)})${match.sublabel ? ` — ${humanise(match.sublabel)}` : ''}`)));
      } else if (lists.length && (!metrics.length || isValueQuestion(input.question))) {
        for (const list of lists.slice(0, 2)) {
          if (!list.records.length) {
            const emptyArgs = input.steps.find((s) => s.result === list)?.args ?? {};
            const asked = (Array.isArray(emptyArgs.conditions) ? emptyArgs.conditions.length > 0 : false)
              || typeof emptyArgs.owner_id === 'string'
              || (typeof emptyArgs.date_property === 'string' && Number.isFinite(Number(emptyArgs.start)));
            // A filtered search that matched nothing *is* the answer: "no
            // Expansion deals have been lost". Skipping it because another step
            // returned rows left the reader with a pipeline glossary and no
            // mention of deals, losses or zero.
            if (CRM_LIST_TYPES.has(list.object_type) && asked) {
              blocks.push(listLead(list, emptyArgs, input));
              continue;
            }
            // The CRM has no such object type — but another tool in this run may
            // have the rows, and it answers rather than this sentence.
            if (rows > 0) continue;
            blocks.push(`No ${list.object_type} records match that.`);
            // A tool that was pointed at a named record and could not read it
            // is the actual answer, and it is more use than a generic nothing.
            for (const failure of input.steps.filter((s) => !s.ok && s.error)) {
              const named = Object.values(failure.args).find((v) => typeof v === 'string' && looksLikeId(v));
              if (!named) continue;
              blocks.push(`${failure.tool} could not read ${named} either: ${failure.error?.message}`);
              break;
            }
            continue;
          }
          const args = input.steps.find((s) => s.result === list)?.args ?? {};
          // "7 tickets match. The most recent:" followed by five bullets told a
          // reader about two rows it then gave them no way to reach. The list
          // now runs long enough to hold a normal result whole, and when it
          // genuinely cannot, the lead-in says which slice they are looking at.
          const limit = 8;
          const shown = Math.min(limit, list.records.length);
          // The adjective is read off the query that ran. Hardcoding "largest"
          // is how "the 3 smallest open deals" came back as the 3 smallest with
          // the word "largest" over them — the one word in the sentence a
          // reader uses to check the answer against their question.
          const ranked = orderWord(args) ?? 'most recent';
          const order = shown < list.total
            ? ranked.includes(' ') ? `The ${shown === 1 ? 'one' : shown} ${ranked}:`
              : shown === 1 ? `The ${ranked} of them:` : `The ${shown} ${ranked} of them:`
            : `The ${ranked}:`;
          // "Who owns the biggest open deal?" is answered by a name. It used to
          // come back as eight rows with the cut-off ignored and no sentence
          // naming Priya Raman anywhere in it — the reader had to read the
          // answer out of a table.
          const single = shown === 1 ? list.records[0] : null;
          if (single?.owner && OWNER_QUESTION.test(input.question)) {
            blocks.push(`${single.owner} owns it: ${single.name}.`);
          }
          // When a metric above already said how many rows there are and what
          // they are worth, repeating "38 deals match" underneath it is the
          // same fact twice with less in it.
          const covered = metricStated && metrics.some((m) => m.count === list.total);
          blocks.push(covered ? order : `${listLead(list, args, input)} ${order}`);
          blocks.push(...recordLines(list, facts, input.workspace, ledger, limit));
        }
      } else {
        blocks.push(...overview(input, facts, { metrics, profiles, lists, aggregates, searches }, ledger, metricStated));
      }
      break;
    }

    case 'summarise': {
      if (profiles.length) {
        const profile = profiles[0];
        blocks.push(`Where ${profile.name} stands today:`);
        blocks.push(...profileParagraph(profile, facts, input.workspace, ledger, alreadyProfiled(input, profile)));
        if (timelines.length && timelines[0].items.length) {
          blocks.push('Recent activity:');
          blocks.push(...timelineLines(timelines[0], 5, facts, ledger));
        }
      } else if (timelines.length && timelines[0].items.length) {
        // A record that is not an account is still a thing with a history, and
        // that history is the summary of it.
        blocks.push('What has happened on it, most recent first:');
        blocks.push(...timelineLines(timelines[0], 6, facts, ledger));
      } else {
        if (metrics.length) blocks.push(...metricSentence(metrics[0], input, facts, ledger));
        // A summary scoped to a rep is computed by `record_aggregate`, not by
        // the catalogue metric, and dropping its sentence left the summary with
        // a list of deals and no total over it.
        else if (aggregates.length) blocks.push(...aggregateSentence(aggregates[0], input, ledger));
        if (lists.length) {
          const listArgs = input.steps.find((step) => step.result === lists[0])?.args ?? {};
          const listOwner = typeof listArgs.owner_id === 'string'
            ? input.workspace.people.find((person) => person.id === listArgs.owner_id)
            : undefined;
          blocks.push(listOwner ? `${listOwner.name}'s biggest open deals:` : `Biggest open deals right now:`);
          blocks.push(...recordLines(lists[0], facts, input.workspace, ledger, 5));
        }
      }
      break;
    }

    case 'plan': {
      const profile = profiles[0];
      const actions: string[] = [];
      if (profile) {
        blocks.push(...profileParagraph(profile, facts, input.workspace, ledger, alreadyProfiled(input, profile)));
        if (profile.open_tickets.length) {
          actions.push(`Clear "${profile.open_tickets[0].subject}" before anything commercial — it is ${profile.open_tickets[0].priority.toLowerCase()} priority and open since ${facts.day(profile.open_tickets[0].created)}.`);
        }
        if (profile.open_deals.length) {
          const deal = profile.open_deals[0];
          actions.push(`Push ${deal.name} (${deal.amount_formatted}) out of ${deal.stage.toLowerCase()}${deal.close_date ? ` — the ${facts.calendarDay(deal.close_date)} close date is ${Math.round((deal.close_date - input.workspace.now) / DAY)} days away` : ''}.`);
        }
        if (profile.last_activity.days_ago !== null && profile.last_activity.days_ago !== undefined && profile.last_activity.days_ago > 21) {
          actions.push(`Re-engage: no activity for ${profile.last_activity.days_ago} days${profile.contacts[0] ? `, start with ${profile.contacts[0].name}` : ''}.`);
        }
        if (profile.properties.next_step) actions.push(`Close out the agreed next step: ${String(profile.properties.next_step)}.`);
        else if (profile.open_deals.length) actions.push('No next step is recorded on the account — set one so the deal has a forcing function.');
        if (profile.contacts.length && !profile.contacts.some((c) => c.role === 'Economic buyer')) {
          actions.push(`No economic buyer is mapped on the buying committee; ${profile.contacts[0].name} is the closest relationship to work through.`);
        }
      } else if (lists.length) {
        for (const record of lists[0].records.slice(0, 3)) {
          const amount = Number(record.properties.amount ?? 0);
          actions.push(`${record.name} — ${facts.money(amount)} at ${humanise(String(record.properties.deal_stage ?? 'unknown stage')).toLowerCase()}${record.owner ? `, ${record.owner}` : ''}. ${record.properties.next_step ? String(record.properties.next_step) : 'No next step recorded; set one.'}`);
        }
      }
      if (actions.length) {
        blocks.push('What I would do next:');
        blocks.push(actions.map((action, i) => `${i + 1}. ${action}`).join('\n'));
      }
      break;
    }

    case 'troubleshoot': {
      const tickets = lists.find((l) => l.object_type === 'ticket');
      if (tickets && tickets.records.length) {
        blocks.push(`${countOf(tickets.total, 'open ticket')}${input.subject ? ` on ${input.subject.label}` : ''}:`);
        blocks.push(...recordLines(tickets, facts, input.workspace, ledger, 5));
        const urgent = tickets.records.filter((t) => ['urgent', 'high'].includes(String(t.properties.priority ?? '')));
        if (urgent.length) blocks.push(`${countOf(urgent.length, 'ticket')} at high or urgent priority — start with "${urgent[0].properties.subject ?? urgent[0].name}".`);
      } else if (tickets) {
        blocks.push(`No open tickets${input.subject ? ` on ${input.subject.label}` : ''} — whatever is failing has not been logged yet.`);
      }
      if (timelines.length && timelines[0].items.length) {
        blocks.push('What happened around it:');
        blocks.push(...timelineLines(timelines[0], 4, facts, ledger));
      }
      if (profiles.length) {
        const profile = profiles[0];
        blocks.push(`Account context: ${profile.name}${profile.properties.support_tier ? `, ${humanise(String(profile.properties.support_tier)).toLowerCase()} support` : ''}${profile.owner ? `, owned by ${profile.owner}` : ''}.`);
      }
      break;
    }

    case 'act': {
      const written = input.steps.filter((s) => s.ok && s.write);
      if (input.pendingApprovals.length) {
        // Breeze shows a confirmation card before it writes; so does this, with
        // the extracted content rather than the sentence the user typed.
        const pending = input.pendingApprovals[0];
        blocks.push(`I prepared ${pending.tool} and stopped there — it changes the workspace, so it needs your approval first. Nothing has been written.`);
        blocks.push(describeWrite(pending.tool, pending.args, nameOf).join('\n'));
        // The decision is rendered directly under this answer, in the chat and
        // on the run page both. Sending a reader to a different screen for a
        // button that is two inches below the sentence is busywork.
        blocks.push(input.pendingApprovals.length > 1
          ? `Approve or decline ${countOf(input.pendingApprovals.length, 'pending write')} below and I will finish the job.`
          : 'Approve it below and I will write it; decline and nothing happens.');
      } else if (written.length) {
        // Only the leading word is lowercased. Lowercasing the whole phrase
        // turned "Rheinwerk Antriebstechnik" into "rheinwerk antriebstechnik".
        const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
        blocks.push(`Done — ${listPhrase(written.map((s) => lowerFirst(describeWrite(s.tool, s.args, nameOf)[0] ?? s.tool)))}.`);
        for (const step of written) blocks.push(describeWrite(step.tool, step.args, nameOf).join('\n'));
      } else {
        const failed = input.steps.filter((s) => !s.ok && s.write);
        blocks.push(failed.length
          ? `I changed nothing: ${failed.map((s) => `${s.tool} failed (${s.error?.code}) — ${s.error?.message}`).join('; ')}`
          : input.writeBlocked
            ? `I changed nothing. That reads as a request to ${humanise(input.writeBlocked.wanted).toLowerCase()}, but ${input.writeBlocked.reason}`
            : 'I changed nothing — the request did not resolve to a write I can prepare. Name the record and what should change, e.g. "move the Rheinwerk OEE deal to Negotiation" or "add a note to Rheinwerk saying the pilot slipped to October".');
        // A refusal is a refusal. Four paragraphs of firmographics underneath it
        // read as an answer to something, and the reader stops at them.
        if (profiles.length) ledger.use(profiles[0]);
      }
      break;
    }

    default:
      break;
  }

  // Rows the ledger returned belong in the answer whatever the classifier
  // called the sentence they arrived in.
  if (input.intent.intent !== 'act' && !ledgerLed) blocks.push(...billingBlocks, ...revenueBlocks);
  // The account card is pulled alongside a ledger reading so the number has
  // context; when the ledger answered, that context is one line, and dropping
  // it would leave a step that ran for nothing.
  for (const profile of profiles) {
    if (ledger.has(profile) || !blocks.length) continue;
    blocks.push(...profileParagraph(profile, facts, input.workspace, ledger, alreadyProfiled(input, profile)).slice(0, 1));
  }
  if (!blocks.length) blocks.push(...overview(input, facts, { metrics, profiles, lists, aggregates, searches }, ledger));

  // Nothing that ran is allowed to vanish without an account of it: whatever
  // the composers above did not consume is named — with the reason — on the
  // run's own record, so a capability that ran and told the reader nothing is
  // visible rather than a hole under a finished-looking answer.
  //
  // What it may never do is print the payload, or the tool's own name. A run
  // that ended "`business_metric` also returned: • Monthly recurring revenue —
  // 33" put an internal identifier and a bare row count in front of a reader
  // who asked about money. So a result nothing could phrase is recorded in
  // `analysis.results` with the reason it was dropped — and only named to the
  // reader when they asked for that capability by name, because then the
  // silence would be about their own question.
  for (const step of input.steps) {
    if (!ok(step) || ledger.has(step.result) || step.write || carriesNothing(step)) continue;
    if (!askedFor(step.tool, input.question)) continue;
    blocks.push(`I could not read anything back from ${humanise(step.tool.replace(/^[a-z_]+\./, '')).toLowerCase()}: ${discardReason(step)}. It is on this run's trace.`);
  }

  if (!blocks.length && input.scopedTools) {
    blocks.push(input.scopedTools.length
      ? `This run was scoped to ${listPhrase(input.scopedTools.map((t) => `\`${t}\``))}, and none of those can answer that. Nothing else ran — the allowlist is enforced on the plan, not just on what I was offered.`
      : 'This run was scoped to no tools at all, so I read nothing. Send a `tools` list with at least one capability, or omit it for the full read-only catalogue.');
  }
  if (!blocks.length) blocks.push(emptyAnswer(input, facts));

  // The account a follow-up was scoped to is stated, because the alternative is
  // a number about a different company that reads exactly like the right one.
  if (input.carriedSubject && blocks.length) {
    blocks.push(input.carriedSubject.pinned
      ? `Scoped to ${input.carriedSubject.label}, the record this conversation is pinned to. Name another account to move off it.`
      : `That question named no account, so I stayed on ${input.carriedSubject.label} from earlier in this conversation.`);
  }
  for (const step of input.skippedTools ?? []) {
    const one = step.missing.length === 1;
    blocks.push([
      `I did not run \`${step.tool}\`: it needs ${listPhrase(step.missing.map((m) => `\`${m}\``))},`,
      `and nothing in the question or the records it resolved to gives me ${one ? 'one' : 'them'}.`,
      `Name ${one ? 'it' : 'them'} and I will run it.`,
    ].join(' '));
  }

  if (input.pendingApprovals.length && input.intent.intent !== 'act') {
    blocks.push(`${countOf(input.pendingApprovals.length, 'step')} needs approval before it can run: ${input.pendingApprovals.map((p) => p.tool).join(', ')}. Nothing was written.`);
  }

  const content = brevity(input.question, blocks.filter(Boolean));
  return { content, citations: citationsFrom(input, content), rendering: renderingOf(input, ledger) };
}

/** Why a result that ran is not in the answer, in the words the answer uses. */
const discardReason = (step: StepResult): string => {
  if (isSearch(step.result)) return 'it matched records by name, and the answer came from the capabilities that hold the figures';
  if (hasRenderer(step.result)) return 'the answer above already says what it returned';
  return 'it carries no field I can name to you, and printing the raw payload would put primary keys and column names in front of you';
};

/**
 * A result with nothing in it to write out. An empty list is not a loss — the
 * reader learns nothing from being told that a search of nothing found nothing
 * — but a metric, a profile or a populated list that went unread is.
 */
const carriesNothing = (step: StepResult): boolean =>
  !isMetric(step.result) && !isProfile(step.result) && rowsReturned([step]) === 0;

/**
 * The account of what happened to every result, for the trace and for the
 * test that holds this file to the rule: rendered, empty, or named and
 * explained — never quietly dropped.
 */
function renderingOf(input: SynthesisInput, ledger: Ledger): ResultOutcome[] {
  return input.steps.filter(ok).map((step) => {
    if (ledger.has(step.result) || step.write) return { tool: step.tool, outcome: 'rendered' as const, why: null };
    if (carriesNothing(step)) return { tool: step.tool, outcome: 'empty' as const, why: 'it came back with no rows in it' };
    return { tool: step.tool, outcome: 'discarded' as const, why: discardReason(step) };
  });
}

/** "in one line" is an instruction about the answer, and it is worth obeying. */
const BREVITY = /\b(in\s+(?:one|a|a\s+single)\s+(?:line|sentence)|one[-\s]?liner|one\s+sentence|briefly|in\s+brief|tl;?dr|in\s+a\s+nutshell)\b/i;

export function brevity(question: string, blocks: string[]): string {
  const full = blocks.join('\n\n');
  if (!BREVITY.test(question) || !blocks.length) return full;
  // A heading is not a summary: "Where X stands today:" answers nothing.
  const lead = blocks.find((block) => !block.startsWith('•') && !block.trimEnd().endsWith(':')) ?? blocks[0];
  // One line means one sentence, not the first paragraph of five.
  const first = lead.split('\n')[0].match(/^.*?[.!?](?=\s|$)/)?.[0] ?? lead.split('\n')[0];
  return first.trim();
}

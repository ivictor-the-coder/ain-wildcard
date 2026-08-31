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
import { describeWindow } from './dates';
import type { MetricDetection, MetricSubject } from './metrics';
import type { AccountProfileResult, MetricToolResult, RecordSearchResult, TimelineItem, WorkspaceSearchResult, RecordAggregateResult } from './functions';
import type { ResolvedEntity } from './resolve';
import type { WindowPair } from './plan';
import type { DraftResult } from './draft';
import type { PendingApproval } from './runtime';
import { countOf, formatSignedPercent, humanise, listPhrase, sentenceJoin, truncate } from './text';

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
  /** The record carried in from the conversation when this turn named none. */
  carriedSubject?: { label: string; pinned: boolean } | null;
}

export interface SynthesisOutput {
  content: string;
  citations: Citation[];
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
    return formatMoney({ amount: Math.round(amount), currency: this.workspace.currency }, { locale: this.workspace.locale, trimZeroFraction: true });
  }
  day(ts: number): string { return formatDate(ts, { locale: this.workspace.locale, timeZone: this.workspace.timezone }); }
  ago(ts: number): string { return formatRelative(ts, this.workspace.now, this.workspace.locale); }
  days(ts: number): number { return Math.round((this.workspace.now - ts) / DAY); }
}

const bullet = (line: string) => `• ${line}`;

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
      ...Object.entries(properties).map(([k, v]) => `${humanise(k)} → ${truncate(String(v), 120)}`),
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
  switch (metric.metric) {
    case 'spend': return `${who} spent ${value} in ${period}`;
    case 'revenue': return `${who} collected ${value} in ${period}`;
    case 'invoiced': return hasSubject ? `${who} was invoiced ${value} in ${period}` : `${who} invoiced ${value} in ${period}`;
    case 'outstanding': return `${who} has ${value} outstanding`;
    case 'pipeline': return `${who} is carrying ${value} in open pipeline`;
    case 'weighted_pipeline': return `${who} has ${value} of weighted pipeline`;
    case 'closed_won': return `${who} booked ${value} in ${period}`;
    case 'closed_lost': return `${who} lost ${value} of business in ${period}`;
    case 'avg_deal_size': return `${who} averaged ${value} per closed-won deal in ${period}`;
    case 'sales_cycle': return `${who} took ${value} on average to close a deal in ${period}`;
    case 'win_rate': return `${who} closed ${value} of the deals it decided in ${period}`;
    case 'mrr': return `${who} has ${value} in monthly recurring revenue`;
    case 'arr': return `${who} has ${value} in annual recurring revenue`;
    case 'csat': return `Customer satisfaction in ${period} averaged ${value} out of 5`;
    case 'resolution_time': return `${who} took ${value} on average to resolve a ticket in ${period}`;
    default:
      return metric.snapshot
        ? `${who} has ${value} ${metric.label.toLowerCase()} right now`
        : `${who} has ${value} ${metric.label.toLowerCase()} in ${period}`;
  }
}

function metricSentence(metric: MetricToolResult, input: SynthesisInput, facts: Facts): string[] {
  const lines: string[] = [];
  const who = metric.subject ? metric.subject.label : input.workspace.name;
  const period = metric.window.label || describeWindow(input.window, input.workspace.locale);

  if (metric.count === 0 && metric.value === 0) {
    lines.push(`${who} has no ${metric.label.toLowerCase()} recorded for ${period} — the query matched no rows, so the honest answer is zero rather than a number.`);
  } else {
    // The supporting-row clause is dropped when it would just repeat the number.
    const redundant = metric.unit === 'count' && Math.round(metric.value) === metric.count;
    lines.push(`${headline(metric, who, period, !!metric.subject)}${redundant ? '' : `, from ${metric.source}`}.`);
  }

  if (metric.change && metric.count > 0) {
    const direction = metric.change.delta > 0 ? 'up' : metric.change.delta < 0 ? 'down' : 'flat';
    const deltaText = metric.unit === 'money' ? facts.money(Math.abs(metric.change.delta)) : Math.abs(metric.change.delta).toLocaleString(input.workspace.locale);
    lines.push(direction === 'flat'
      ? `That is level with the preceding period (${metric.change.previous_formatted}).`
      : `That is ${direction} ${deltaText}${metric.change.percent !== null ? ` (${formatSignedPercent(metric.change.percent)})` : ''} against ${metric.change.previous_formatted} in the period before.`);
  }
  if (metric.window.partial && !metric.snapshot) lines.push(`${period} is still running, so this is a period-to-date figure.`);
  if (metric.note) lines.push(metric.note);
  return lines;
}

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
  const grouped = metric.groups.length ? metric.groups : metric.top_accounts.map((a) => ({
    key: a.id, label: a.label, formatted: a.formatted, value: 0, count: 0,
  }));
  const rows = grouped.filter((row) => !looksLikeId(row.label));
  const period = metric.snapshot ? 'right now' : metric.window.label === 'all time' ? 'across all time' : `in ${metric.window.label}`;
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
  const asked = Number(input.question.match(/\btop\s+(\d{1,2})\b/i)?.[1] ?? 0);
  const shown = rows.slice(0, asked > 0 ? asked : 8);
  const [top, ...rest] = shown;
  const lines = [
    `${top.label} is the biggest by ${noun} ${period}, at ${top.formatted}${metric.value > 0 && metric.unit === 'money' ? ` of ${metric.formatted} across the workspace` : ''}.`,
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

function profileParagraph(profile: AccountProfileResult, facts: Facts, workspace: WorkspaceProfile): string[] {
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
      `${top.close_date ? ` with a ${facts.day(top.close_date)} close date` : ''}`,
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

function timelineLines(timeline: { record: string; items: TimelineItem[] }, limit: number, facts: Facts): string[] {
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

function recordLines(list: RecordSearchResult, facts: Facts, workspace: WorkspaceProfile, limit = 6): string[] {
  return list.records.slice(0, limit).map((record) => {
    const props = record.properties;
    const bits: string[] = [];
    if (props.amount !== undefined) bits.push(facts.money(Number(props.amount)));
    if (props.deal_stage) bits.push(humanise(String(props.deal_stage)));
    if (props.close_date) bits.push(`closes ${facts.day(Number(props.close_date))}`);
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
  const blocks = [
    `${countOf(list.total, 'subscription')} ${list.total === 1 ? 'is' : 'are'} ${subscriptionScope(args)}`
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
  const scope = args.due_before ? `past ${list.total === 1 ? 'its' : 'their'} due date`
    : status === 'open_like' ? 'still open'
    : status && status !== 'all' ? `at status ${humanise(status).toLowerCase()}`
    : 'in the book';
  if (!list.total || !shown.length) {
    return [`No invoice in ${workspace.name} is ${scope}${args.customer ? ' for that account' : ''}.`];
  }
  const blocks = [
    `${countOf(list.total, 'invoice')} ${list.total === 1 ? 'is' : 'are'} ${scope}`
    + `${shown.length < list.total ? `. ${shown.length} of them` : ''}`
    // The tool totals only the rows it returned, so the answer says which rows
    // that figure covers rather than implying it is the whole ledger's balance.
    + `${list.outstanding_display ? `${shown.length < list.total ? '' : ', which'} carr${shown.length === 1 ? 'ies' : 'y'} ${list.outstanding_display} still due` : ''}:`,
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
function billingAnswer(found: BillingFound, facts: Facts, workspace: WorkspaceProfile): string[] {
  const blocks: string[] = [];
  for (const summary of found.summaries.slice(0, 2)) blocks.push(...summaryBlocks(summary, facts, found.upcoming.length > 0));
  for (const entry of found.subscriptions.slice(0, 2)) blocks.push(...subscriptionBlocks(entry, workspace));
  for (const entry of found.invoices.slice(0, 2)) blocks.push(...invoiceBlocks(entry, workspace));
  for (const invoice of found.explanations.slice(0, 2)) blocks.push(...explanationBlocks(invoice));
  for (const invoice of found.upcoming.slice(0, 2)) blocks.push(...upcomingBlocks(invoice));
  return blocks;
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
 * A tool succeeded, nothing above knows how to read its shape, and the run
 * would otherwise answer "I found nothing". Saying what came back is worth more
 * than a template, and it is still only facts the tool returned.
 */
function otherResults(steps: StepResult[]): string[] {
  const blocks: string[] = [];
  for (const step of steps) {
    if (!ok(step) || blocks.length >= 4) continue;
    const value = step.result;
    if (isRecordList(value) || isSearch(value) || isAggregate(value) || isMetric(value) || isProfile(value) || isTimeline(value)) continue;
    if (isSubscriptionList(value) || isInvoiceList(value) || isCustomerSummary(value) || isInvoiceExplanation(value) || isUpcomingInvoice(value)) continue;
    const lines: string[] = [];
    const describe = (entry: unknown): string | null => {
      if (entry === null || entry === undefined) return null;
      if (typeof entry !== 'object') return String(entry);
      const row = entry as Record<string, unknown>;
      const parts: string[] = [];
      for (const [key, item] of Object.entries(row)) {
        if (parts.length >= 4 || item === null || item === undefined || typeof item === 'object') continue;
        parts.push(`${humanise(key)} ${item}`);
      }
      return parts.length ? parts.join(' · ') : null;
    };
    if (Array.isArray(value)) {
      if (!value.length) continue;
      for (const entry of value.slice(0, 5)) {
        const line = describe(entry);
        if (line) lines.push(bullet(line));
      }
    } else if (value && typeof value === 'object') {
      const line = describe(value);
      if (line) lines.push(bullet(line));
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(inner) || !inner.length || lines.length > 5) continue;
        for (const entry of inner.slice(0, 4)) {
          const row = describe(entry);
          if (row) lines.push(bullet(`${humanise(key)}: ${row}`));
        }
      }
    }
    if (!lines.length) continue;
    blocks.push(`\`${step.tool}\` returned:`);
    blocks.push(lines.join('\n'));
  }
  return blocks;
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
      for (const id of (value as RecordAggregateResult).sample_ids.slice(0, 4)) add(id, 'matched record', 'record', true);
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

/** The general answer: lead with the number, then name the records behind it. */
function overview(input: SynthesisInput, facts: Facts, found: Gathered): string[] {
  const blocks: string[] = [];
  if (found.metrics.length) {
    blocks.push(...metricSentence(found.metrics[0], input, facts));
    blocks.push(...metricBreakdown(found.metrics[0]));
  }
  if (found.profiles.length) blocks.push(...profileParagraph(found.profiles[0], facts, input.workspace));

  const deals = found.lists.find((l) => l.object_type === 'deal' && l.records.length);
  if (deals) {
    blocks.push(`The largest of the ${deals.total} deals still open:`);
    blocks.push(...recordLines(deals, facts, input.workspace, 5));
  } else if (found.lists.length && found.lists[0].records.length) {
    blocks.push(...recordLines(found.lists[0], facts, input.workspace, 5));
  }

  for (const aggregate of found.aggregates) {
    if (!aggregate.groups.length) continue;
    const rows = aggregate.groups.slice(0, 4).map((g) => `${g.label} ${g.value.toLocaleString(input.workspace.locale)}`).join(' · ');
    blocks.push(aggregate.object_type === 'ticket'
      ? `Support backlog: ${countOf(aggregate.matched_records, 'open ticket')} — ${rows}.`
      : `${aggregate.measure} across ${countOf(aggregate.matched_records, aggregate.object_type)}: ${rows}.`);
  }

  if (!blocks.length && found.searches.length && found.searches[0].matches.length) {
    blocks.push(...found.searches[0].matches.slice(0, 5).map((m) => bullet(`${m.label} (${humanise(m.type)})`)));
  }
  return blocks;
}

/** Nothing came back — say what was searched and what to try instead. */
function emptyAnswer(input: SynthesisInput, facts: Facts): string {
  const failures = input.steps.filter((s) => !s.ok && s.error);
  const lines: string[] = [];
  if (input.entities.length) {
    lines.push(`I matched "${input.entities[0].mention}" to ${input.entities[0].entity.label}, but the question did not resolve to anything I can measure in ${input.workspace.name}.`);
  } else {
    lines.push(`I could not match anything in ${input.workspace.name} to that question.`);
  }
  if (failures.length) {
    lines.push(`What I tried: ${failures.map((f) => `${f.tool} (${f.error?.code})`).join(', ')}.`);
  }
  lines.push('Try naming an account, a metric such as pipeline, bookings, open tickets or spend, and a period like "last quarter".');
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
  const billing = gatherBilling(input.steps);
  const billingBlocks = billingAnswer(billing, facts, input.workspace);
  // Every row every list-returning tool came back with. "Nothing matched" is a
  // claim about the whole run, not about one CRM search inside it.
  const rows = rowsReturned(input.steps);
  const blocks: string[] = [];

  if (input.draft) {
    const draft = input.draft;
    blocks.push(draft.channel === 'email'
      ? `Subject: ${draft.subject}\n\n${draft.body}`
      : `${draft.subject}\n\n${draft.body}`);
    if (draft.personalisation.length) {
      blocks.push(`Written from: ${draft.personalisation.join('; ')}.`);
    }
    if (draft.recipient?.email) blocks.push(`Ready to send to ${draft.recipient.name} <${draft.recipient.email}>.`);
    const drafted = blocks.join('\n\n');
    return { content: drafted, citations: citationsFrom(input, drafted) };
  }

  // A ranking question is answered by the ranking, whatever the classifier
  // called the sentence it arrived in — but only when the metric actually came
  // back grouped. A "ranking" of nothing next to a workspace total is a
  // sentence that contradicts itself, so that case takes the ordinary path.
  const rankable = input.ranking && !input.pendingApprovals.length
    ? metrics.filter((m) => m.groups.length || m.top_accounts.length).slice(-1)[0]
    : undefined;
  if (rankable) {
    const ranked = rankedAnswer(rankable, input);
    const content = ranked.join('\n\n');
    return { content, citations: citationsFrom(input, content) };
  }

  switch (input.intent.intent) {
    case 'compare': {
      const periods = periodPair(metrics);
      if (periods) {
        const [a, b] = periods;
        // The first period the question named is the subject; the second is the
        // baseline it is measured against. Reading those two the other way round
        // is how an 81% collapse got reported as 435% growth: both the sign of
        // the delta and the denominator of the percentage follow this line.
        const delta = a.value - b.value;
        const percent = b.value === 0 ? null : (delta / Math.abs(b.value)) * 100;
        const who = a.subject ? a.subject.label : input.workspace.name;
        const deltaText = a.unit === 'money'
          ? facts.money(Math.abs(delta))
          : Math.abs(Number(delta.toFixed(a.unit === 'percent' ? 1 : 0))).toLocaleString(input.workspace.locale);
        const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'level';
        blocks.push(delta === 0
          ? `${who} ${verb(a)} the same ${a.label.toLowerCase()} in both periods: ${a.formatted} in ${a.window.label} and in ${b.window.label}.`
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
        const gapText = a.unit === 'money' ? facts.money(gap) : gap.toLocaleString(input.workspace.locale);
        const percent = trailer.value !== 0 ? `, ${((gap / Math.abs(trailer.value)) * 100).toFixed(0)}% ahead` : '';
        const scope = a.snapshot ? 'right now' : `in ${a.window.label}`;
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
        blocks.push(...metricSentence(metric, input, facts));
        blocks.push(...metricBreakdown(metric));
      }
      break;
    }

    case 'aggregate': {
      if (metrics.length) {
        const metric = metrics[metrics.length - 1];
        blocks.push(...metricSentence(metric, input, facts));
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
          blocks.push(profileParagraph(profiles[0], facts, input.workspace)[0]);
        }
      } else if (aggregates.length) {
        const agg = aggregates[0];
        blocks.push(`${agg.measure} for ${agg.object_type} records: ${agg.formatted} across ${countOf(agg.matched_records, 'record')}.`);
        if (agg.groups.length) blocks.push(`Breakdown: ${agg.groups.slice(0, 8).map((g) => `${g.label} ${g.value.toLocaleString(input.workspace.locale)}`).join(' · ')}.`);
      }
      break;
    }

    case 'explain': {
      const metric = metrics[0];
      if (metric) {
        blocks.push(...metricSentence(metric, input, facts));
        for (const step of input.steps) {
          if (!ok(step) || !isAggregate(step.result)) continue;
          const agg = step.result as RecordAggregateResult;
          if (!agg.groups.length) continue;
          const groupBy = String(step.args.group_by ?? '');
          const conditions = (step.args.conditions as { property?: string; value?: unknown }[] | undefined) ?? [];
          const lost = conditions.some((c) => c.value === 'closed_lost');
          const rows = agg.groups.slice(0, 4).map((g) => `${g.label} ${facts.money(g.value)} (${countOf(g.count, 'deal')})`);
          blocks.push(lost
            ? `Losses in the period group by ${humanise(groupBy).toLowerCase()}: ${rows.join(' · ')}.`
            : `What did close splits by ${humanise(groupBy).toLowerCase()}: ${rows.join(' · ')}.`);
        }
      }
      if (profiles.length) blocks.push(...profileParagraph(profiles[0], facts, input.workspace));
      if (!metric && !profiles.length && lists.length) blocks.push(...recordLines(lists[0], facts, input.workspace));
      break;
    }

    case 'lookup': {
      // A lookup can still have a number in it — "what does X pay us each
      // month" is answered by the metric, then by the record it is about.
      if (metrics.length && input.metric) blocks.push(...metricSentence(metrics[0], input, facts));
      if (profiles.length) {
        blocks.push(...profileParagraph(profiles[0], facts, input.workspace));
        const profile = profiles[0];
        // A question that named a type as well as an account is answered by the
        // rows of that type, not by the count of them inside a profile.
        const typed = lists.find((l) => l.records.length && l.object_type !== 'company');
        if (typed) {
          blocks.push(`${countOf(typed.total, typed.object_type)} on ${profile.name}:`);
          blocks.push(...recordLines(typed, facts, input.workspace, 6));
        } else if (profile.open_deals.length > 1) {
          blocks.push(...profile.open_deals.slice(0, 4).map((deal) =>
            bullet(`${deal.name} — ${deal.amount_formatted}, ${deal.stage.toLowerCase()}${deal.close_date ? `, closes ${facts.day(deal.close_date)}` : ''}${deal.owner ? `, ${deal.owner}` : ''}`)));
        }
      } else if (searches.length && searches[0].matches.length) {
        const search = searches[0];
        blocks.push(`${countOf(search.matches.length, 'record')} in ${input.workspace.name} ${search.matches.length === 1 ? 'matches' : 'match'} that${search.ambiguous ? ' — the top two are close, so tell me which you mean' : ''}:`);
        blocks.push(...search.matches.slice(0, 6).map((match) =>
          bullet(`${match.label} (${humanise(match.type)})${match.sublabel ? ` — ${humanise(match.sublabel)}` : ''}`)));
      } else if (lists.length && !metrics.length) {
        for (const list of lists.slice(0, 2)) {
          if (!list.records.length) {
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
          const filtered = Array.isArray(args.conditions) || !!args.owner_id;
          const order = args.order_by === 'amount' ? 'The largest:' : 'The most recent:';
          blocks.push(filtered
            ? `${countOf(list.total, list.object_type)} ${list.total === 1 ? 'matches' : 'match'}. ${order}`
            : `${countOf(list.total, `${list.object_type} record`)} in the workspace. ${order}`);
          blocks.push(...recordLines(list, facts, input.workspace, 5));
        }
      } else {
        blocks.push(...overview(input, facts, { metrics, profiles, lists, aggregates, searches }));
      }
      break;
    }

    case 'summarise': {
      if (profiles.length) {
        const profile = profiles[0];
        blocks.push(`Where ${profile.name} stands today:`);
        blocks.push(...profileParagraph(profile, facts, input.workspace));
        if (timelines.length && timelines[0].items.length) {
          blocks.push('Recent activity:');
          blocks.push(...timelineLines(timelines[0], 5, facts));
        }
      } else {
        if (metrics.length) blocks.push(...metricSentence(metrics[0], input, facts));
        if (lists.length) {
          blocks.push(`Biggest open deals right now:`);
          blocks.push(...recordLines(lists[0], facts, input.workspace, 5));
        }
      }
      break;
    }

    case 'plan': {
      const profile = profiles[0];
      const actions: string[] = [];
      if (profile) {
        blocks.push(...profileParagraph(profile, facts, input.workspace));
        if (profile.open_tickets.length) {
          actions.push(`Clear "${profile.open_tickets[0].subject}" before anything commercial — it is ${profile.open_tickets[0].priority.toLowerCase()} priority and open since ${facts.day(profile.open_tickets[0].created)}.`);
        }
        if (profile.open_deals.length) {
          const deal = profile.open_deals[0];
          actions.push(`Push ${deal.name} (${deal.amount_formatted}) out of ${deal.stage.toLowerCase()}${deal.close_date ? ` — the ${facts.day(deal.close_date)} close date is ${Math.round((deal.close_date - input.workspace.now) / DAY)} days away` : ''}.`);
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
        blocks.push(...recordLines(tickets, facts, input.workspace, 5));
        const urgent = tickets.records.filter((t) => ['urgent', 'high'].includes(String(t.properties.priority ?? '')));
        if (urgent.length) blocks.push(`${countOf(urgent.length, 'ticket')} at high or urgent priority — start with "${urgent[0].properties.subject ?? urgent[0].name}".`);
      } else if (tickets) {
        blocks.push(`No open tickets${input.subject ? ` on ${input.subject.label}` : ''} — whatever is failing has not been logged yet.`);
      }
      if (timelines.length && timelines[0].items.length) {
        blocks.push('What happened around it:');
        blocks.push(...timelineLines(timelines[0], 4, facts));
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
        blocks.push(input.pendingApprovals.length > 1
          ? `Approve or edit ${countOf(input.pendingApprovals.length, 'pending write')} from the approvals queue and I will finish the job.`
          : 'Approve it from the approvals queue and I will write it; decline and nothing happens.');
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
        if (profiles.length) blocks.push(...profileParagraph(profiles[0], facts, input.workspace));
      }
      break;
    }

    default:
      break;
  }

  // Rows the ledger returned belong in the answer whatever the classifier
  // called the sentence they arrived in.
  if (billingBlocks.length && input.intent.intent !== 'act') blocks.push(...billingBlocks);
  if (!blocks.length) blocks.push(...overview(input, facts, { metrics, profiles, lists, aggregates, searches }));
  if (!blocks.length && rows > 0) blocks.push(...otherResults(input.steps));
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
    blocks.push(`I did not run \`${step.tool}\`: it needs ${listPhrase(step.missing.map((m) => `a ${m.replace(/_/g, ' ')}`))} and nothing in the question or the records it resolved to gives me one. Say it explicitly and I will run it.`);
  }

  if (input.pendingApprovals.length && input.intent.intent !== 'act') {
    blocks.push(`${countOf(input.pendingApprovals.length, 'step')} needs approval before it can run: ${input.pendingApprovals.map((p) => p.tool).join(', ')}. Nothing was written.`);
  }

  const content = brevity(input.question, blocks.filter(Boolean));
  return { content, citations: citationsFrom(input, content) };
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

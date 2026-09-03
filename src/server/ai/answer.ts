/**
 * How a template's result reads.
 *
 * Every sentence here is built from one tool result and states only the
 * figures that result holds for the question that was asked: the number, the
 * rows behind it, the period and scope it was measured at. There is no previous
 * period, no workspace total under a scoped figure, no note that restates a
 * different measure — a number that is not the answer to the exact question
 * does not get printed.
 */
import { formatMoney } from '../../shared/money';
import { DAY, formatDate } from '../../shared/time';
import type { WorkspaceProfile } from './grounding';
import type {
  AccountProfileResult, DelinquentCustomersResult, MeteredUsageResult, MetricToolResult, RecordAggregateResult,
  RecordSearchResult, StaleAccountsResult, TimelineItem,
} from './functions';
import type { DraftResult } from './draft';
import { humanise, listPhrase, plural, truncate } from './text';

export interface Citation { id: string; label: string; type: string }

/**
 * What a run computed, in a shape a schema field can be filled from without
 * re-reading the prose: one primary figure, its row count, and the rows.
 */
export interface Facts {
  value: number | null;
  formatted: string | null;
  unit: 'money' | 'count' | 'percent' | 'days' | 'hours' | 'score' | 'units' | null;
  currency: string | null;
  count: number | null;
  label: string | null;
  period: string | null;
  subject: string | null;
  subjectId: string | null;
  rows: { id: string; label: string }[];
  /** Set when there is no single figure — several currency books, or a ranking. */
  mixed: boolean;
}

export interface Rendered {
  content: string;
  citations: Citation[];
  facts: Facts;
}

export const NO_FACTS: Facts = {
  value: null, formatted: null, unit: null, currency: null, count: null, label: null, period: null, subject: null, subjectId: null, rows: [], mixed: false,
};

export const money = (amount: number, currency: string, workspace: WorkspaceProfile): string =>
  formatMoney({ amount: Math.round(amount), currency }, { locale: workspace.locale, trimZeroFraction: true });

export const dateOf = (ts: number, workspace: WorkspaceProfile, tz: string = 'UTC'): string =>
  formatDate(ts, { locale: workspace.locale, timeZone: tz });

const n = (value: number, locale: string): string => value.toLocaleString(locale);

/** "in Q2 2026", "in the last 30 days", "before March 2026", "all time". */
export function periodPhrase(label: string): string {
  if (/^(all time|this week|last week|next week|today|yesterday)$/.test(label)) return label;
  if (/^(after|before|since|through|until|till|up to|prior to|earlier than|later than|no later than|on or before|on or after|ahead of)\b/i.test(label)) return label;
  if (/^the (last|next) /.test(label)) return `in ${label}`;
  return `in ${label}`;
}

/* --------------------------------- lines --------------------------------- */

/** One row of a list, in the words the record's own fields use. */
export function recordLine(record: RecordSearchResult['records'][number], objectType: string, workspace: WorkspaceProfile): string {
  const props = record.properties;
  const detail: string[] = [];
  if (objectType === 'deal') {
    detail.push(money(Number(props.amount ?? 0), workspace.currency, workspace));
    if (props.deal_stage) detail.push(humanise(String(props.deal_stage)));
    if (props.close_date) detail.push(`closes ${dateOf(Number(props.close_date), workspace)}`);
  } else if (objectType === 'ticket') {
    if (props.priority) detail.push(`${humanise(String(props.priority))} priority`);
    if (props.status) detail.push(humanise(String(props.status)));
  } else if (objectType === 'contact') {
    if (props.job_title) detail.push(String(props.job_title));
    if (props.email) detail.push(String(props.email));
  } else if (objectType === 'company') {
    if (props.industry) detail.push(humanise(String(props.industry)));
    if (props.type) detail.push(humanise(String(props.type)));
  } else if (objectType === 'task') {
    if (props.status) detail.push(humanise(String(props.status)));
    if (props.due_at) detail.push(`due ${dateOf(Number(props.due_at), workspace, workspace.timezone)}`);
  } else if (props.occurred_at) {
    detail.push(dateOf(Number(props.occurred_at), workspace, workspace.timezone));
  }
  if (record.owner && objectType !== 'contact') detail.push(record.owner);
  return detail.length ? `${record.name} — ${detail.join(' · ')}` : record.name;
}

export const citationsOf = (rows: { id: string; name?: string; label?: string }[], type: string): Citation[] =>
  rows.map((row) => ({ id: row.id, label: row.name ?? row.label ?? row.id, type }));

/* -------------------------------- shapes --------------------------------- */

/** "There are 25 closed-won deals." */
export function renderCount(count: number, thing: string, scope: string, workspace: WorkspaceProfile, opts: { subject?: string | null; period?: string | null } = {}): Rendered {
  const [singular, pluralForm] = thing.split('|');
  const nounPhrase = count === 1 ? singular : (pluralForm ?? plural(2, singular));
  const content = count === 0
    ? `There are no ${pluralForm ?? plural(2, singular)}${scope ? ` ${scope}` : ''}.`
    : `There ${count === 1 ? 'is' : 'are'} ${n(count, workspace.locale)} ${nounPhrase}${scope ? ` ${scope}` : ''}.`;
  return {
    content,
    citations: [],
    facts: { ...NO_FACTS, value: count, formatted: String(count), unit: 'count', count, label: nounPhrase, period: opts.period ?? null, subject: opts.subject ?? null },
  };
}

/** A headline naming the set, then the rows, then how many were left out. */
export function renderList(
  result: RecordSearchResult, thing: string, scope: string, workspace: WorkspaceProfile,
  opts: { subject?: string | null; period?: string | null; line?: (row: RecordSearchResult['records'][number]) => string } = {},
): Rendered {
  const [singular, pluralForm] = thing.split('|');
  const total = result.total;
  const shown = result.records;
  const nounPhrase = total === 1 ? singular : (pluralForm ?? plural(2, singular));
  const line = opts.line ?? ((row) => recordLine(row, result.object_type, workspace));
  const head = total === 0
    ? `There are no ${pluralForm ?? plural(2, singular)}${scope ? ` ${scope}` : ''}.`
    : `${n(total, workspace.locale)} ${nounPhrase}${scope ? ` ${scope}` : ''}:`;
  const lines = shown.map((row) => `• ${line(row)}`);
  const rest = total - shown.length;
  const tail = rest > 0 ? `…and ${n(rest, workspace.locale)} more.` : '';
  return {
    content: [head, lines.join('\n'), tail].filter(Boolean).join('\n\n'),
    citations: citationsOf(shown, result.object_type),
    facts: { ...NO_FACTS, value: total, formatted: String(total), unit: 'count', count: total, label: nounPhrase, period: opts.period ?? null, subject: opts.subject ?? null, rows: shown.map((r) => ({ id: r.id, label: r.name })) },
  };
}

/** A count from `record_aggregate`, with the same sentence as any other count. */
export function renderAggregateCount(result: RecordAggregateResult, thing: string, scope: string, workspace: WorkspaceProfile, opts: { subject?: string | null; period?: string | null } = {}): Rendered {
  const rendered = renderCount(result.matched_records, thing, scope, workspace, opts);
  return { ...rendered, citations: result.samples.map((s) => ({ id: s.id, label: s.label, type: result.object_type })), facts: { ...rendered.facts, rows: result.samples } };
}

/** A sum or an average of one property. */
export function renderAggregateMeasure(result: RecordAggregateResult, measure: string, propertyLabel: string, isMoney: boolean, setPhrase: string, workspace: WorkspaceProfile): Rendered {
  const value = result.formatted;
  const rows = `${n(result.matched_records, workspace.locale)} ${setPhrase}`;
  const content = `The ${measure} ${propertyLabel.toLowerCase()} across ${rows} is ${value}.`;
  return {
    content,
    citations: result.samples.map((s) => ({ id: s.id, label: s.label, type: result.object_type })),
    facts: { ...NO_FACTS, value: result.value, formatted: value, unit: isMoney ? 'money' : 'count', currency: isMoney ? workspace.currency : null, count: result.matched_records, label: `${measure} ${propertyLabel}`, rows: result.samples },
  };
}

/** Count per group, largest first. */
export function renderGroupedCount(result: RecordAggregateResult, thing: string, dimension: string, workspace: WorkspaceProfile): Rendered {
  const [, pluralForm] = thing.split('|');
  const total = result.matched_records;
  const head = total === 0
    ? `There are no ${pluralForm} to break down by ${dimension}.`
    : `${n(total, workspace.locale)} ${pluralForm} by ${dimension}:`;
  const lines = result.groups.map((g) => `• ${g.label} — ${g.formatted}`);
  return {
    content: [head, lines.join('\n')].filter(Boolean).join('\n\n'),
    citations: [],
    facts: { ...NO_FACTS, value: total, formatted: String(total), unit: 'count', count: total, label: pluralForm, mixed: true, rows: result.groups.map((g) => ({ id: g.key, label: g.label })) },
  };
}

const unitOf = (result: MetricToolResult): Facts['unit'] => result.unit;

/** What one row behind a metric is called. */
const rowNoun = (result: MetricToolResult): string =>
  ({ invoices: 'invoice', subscriptions: 'subscription', deals: 'deal', tickets: 'ticket', activities: 'activity', records: 'account' } as Record<string, string>)[result.sourceKind] ?? 'row';

const capitalise = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * One metric figure. Several currency books are several sentences, never one
 * sum; a subject and a period are named in the sentence they scope.
 */
export function renderMetric(result: MetricToolResult, workspace: WorkspaceProfile, opts: { period?: string | null; subject?: string | null; scope?: string | null }): Rendered {
  const label = result.label;
  const subject = opts.subject ?? result.subject?.label ?? null;
  const period = result.snapshot ? null : (opts.period ?? result.window.label);
  const where = [opts.scope ?? result.scope?.label ?? '', period ? periodPhrase(period) : ''].filter(Boolean).join(' ');
  const rows = result.source;
  const citations: Citation[] = result.evidence.slice(0, 8);
  const prefix = subject ? `${subject}: ` : '';
  if (result.unit === 'money' && result.books.length > 1) {
    const noun = rowNoun(result);
    const books = result.books.map((b) => `${b.formatted} in ${b.currency.toUpperCase()} (${n(b.count, workspace.locale)} ${plural(b.count, noun)})`);
    const content = `${prefix}${label}${where ? ` ${where}` : ''} is held in ${result.books.length} currencies, and this platform keeps no exchange rates, so there is one figure per book: ${listPhrase(books)}. They are not added together.`;
    return { content, citations, facts: { ...NO_FACTS, unit: 'money', count: result.count, label, period, subject, mixed: true } };
  }
  if (result.count === 0 && ['win_rate', 'avg_deal_size', 'sales_cycle', 'resolution_time', 'csat', 'churn', 'net_revenue_retention', 'gross_revenue_retention'].includes(result.metric)) {
    const content = `${prefix}There is no ${label.toLowerCase()}${where ? ` ${where}` : ''}: nothing behind it to measure (${rows}).`;
    return { content, citations: [], facts: { ...NO_FACTS, unit: unitOf(result), count: 0, label, period, subject } };
  }
  // A counted measure is its own row count: "38 open deals", not "Deals is 38".
  // Unless the rows are not the figure — connected assets are summed across
  // the accounts that report them, and "23 accounts reporting telemetry" was
  // the whole answer to "how many connected assets do we have", with the
  // asset count nowhere in it.
  const counted = result.unit === 'count' && result.value === result.count;
  const source = period ? rows.replace(/\s+in the period$/, '') : rows;
  const content = counted
    ? `${prefix}${capitalise(source)}${where ? ` ${where}` : ''}.`
    : result.unit === 'money' && result.value === 0 && result.count === 0
      ? `${prefix}${label}${where ? ` ${where}` : ''} is ${result.formatted} — ${rows}.`
      : `${prefix}${label}${where ? ` ${where}` : ''} is ${result.formatted}, from ${rows}.`;
  return {
    content,
    citations,
    facts: { ...NO_FACTS, value: result.value, formatted: result.formatted, unit: unitOf(result), currency: result.currency, count: result.count, label, period, subject },
  };
}

/** A metric broken down by one dimension: the rows are the answer, not a total. */
export function renderBreakdown(result: MetricToolResult, dimension: string, workspace: WorkspaceProfile, opts: { period?: string | null }): Rendered {
  const period = result.snapshot ? null : (opts.period ?? result.window.label);
  const groups = result.groups.length ? result.groups : result.top_accounts.map((a) => ({ key: a.id, label: a.label, formatted: a.formatted, count: 0, value: 0, currency: a.currency }));
  if (!groups.length) {
    return {
      content: `${result.label}${period ? ` ${periodPhrase(period)}` : ''} does not break down by ${dimension} in this workspace: nothing behind the figure carries that grouping.`,
      citations: [],
      facts: { ...NO_FACTS, unit: unitOf(result), label: result.label, period, mixed: true },
    };
  }
  const isRate = result.unit === 'percent';
  const noun = rowNoun(result);
  const lines = groups.map((g) => `• ${g.label} — ${g.formatted}${g.count && !isRate && result.unit !== 'count' ? ` (${n(g.count, workspace.locale)} ${plural(g.count, noun)})` : ''}`);
  const head = `${result.label} by ${dimension}${period ? ` ${periodPhrase(period)}` : ''}${isRate ? ' — each row is its own rate, and the rows do not sum' : ''}:`;
  return {
    content: `${head}\n\n${lines.join('\n')}`,
    citations: result.evidence.slice(0, 8),
    facts: { ...NO_FACTS, unit: unitOf(result), label: result.label, period, mixed: true, rows: groups.map((g) => ({ id: g.key, label: g.label })) },
  };
}

/** Who is biggest by a measure, per currency book. */
export function renderRank(result: MetricToolResult, noun: string, direction: 'asc' | 'desc', limit: number, workspace: WorkspaceProfile, opts: { period?: string | null }): Rendered {
  const period = result.snapshot ? null : (opts.period ?? result.window.label);
  const rows = result.top_accounts.length
    ? result.top_accounts.map((a) => ({ id: a.id, label: a.label, formatted: a.formatted, currency: a.currency ?? workspace.currency }))
    : result.groups.map((g) => ({ id: g.key, label: g.label, formatted: g.formatted, currency: g.currency ?? workspace.currency }));
  if (!rows.length) {
    return {
      content: `No ${noun} has any ${result.label.toLowerCase()}${period ? ` ${periodPhrase(period)}` : ''}.`,
      citations: [],
      facts: { ...NO_FACTS, unit: unitOf(result), label: result.label, period, mixed: true },
    };
  }
  const books = new Map<string, typeof rows>();
  for (const row of rows) {
    const book = books.get(row.currency) ?? [];
    book.push(row);
    books.set(row.currency, book);
  }
  const ordered = [...books.entries()].sort((a, b) => Number(b[0] === workspace.currency) - Number(a[0] === workspace.currency) || a[0].localeCompare(b[0]));
  const word = direction === 'desc' ? 'biggest' : 'smallest';
  const sections: string[] = [];
  const cited: Citation[] = [];
  for (const [currency, book] of ordered) {
    const top = book.slice(0, limit);
    const lead = `${top[0].label} is the ${word} ${noun} by ${result.label.toLowerCase()}${period ? ` ${periodPhrase(period)}` : ''}${ordered.length > 1 ? ` in ${currency.toUpperCase()}` : ''}, at ${top[0].formatted}.`;
    const list = top.map((row, i) => `${i + 1}. ${row.label} — ${row.formatted}`).join('\n');
    const rest = book.length - top.length;
    sections.push([lead, list, rest > 0 ? `…and ${n(rest, workspace.locale)} more with ${result.label.toLowerCase()} in ${currency.toUpperCase()}.` : ''].filter(Boolean).join('\n\n'));
    cited.push(...top.map((row) => ({ id: row.id, label: row.label, type: row.id.startsWith('cus_') ? 'customer' : 'company' })));
  }
  return {
    content: sections.join('\n\n'),
    citations: cited,
    facts: { ...NO_FACTS, unit: unitOf(result), label: result.label, period, mixed: true, rows: rows.slice(0, limit).map((r) => ({ id: r.id, label: r.label })) },
  };
}

/** Two periods of one metric, side by side, with the change between them. */
export function renderCompare(a: MetricToolResult, b: MetricToolResult, workspace: WorkspaceProfile, labels: [string, string]): Rendered {
  const single = (r: MetricToolResult) => r.unit !== 'money' || r.books.length <= 1;
  const describe = (r: MetricToolResult) => (single(r)
    ? `${r.formatted} (${r.source})`
    : listPhrase(r.books.map((book) => `${book.formatted} in ${book.currency.toUpperCase()}`)));
  const head = `${a.label}: ${labels[0]} ${describe(a)}; ${labels[1]} ${describe(b)}.`;
  const comparable = single(a) && single(b) && (a.currency ?? '') === (b.currency ?? '');
  let change = '';
  if (comparable && a.count + b.count > 0) {
    const delta = b.value - a.value;
    const pct = a.value === 0 ? null : Math.round((delta / Math.abs(a.value)) * 1000) / 10;
    const shown = a.unit === 'money' ? money(Math.abs(delta), a.currency ?? workspace.currency, workspace) : `${Math.abs(Math.round(delta * 10) / 10)}${a.unit === 'percent' ? ' points' : ''}`;
    change = delta === 0
      ? `No change between the two.`
      : `${labels[1]} is ${delta > 0 ? 'up' : 'down'} ${shown}${pct === null ? '' : ` (${Math.abs(pct)}%)`} on ${labels[0]}.`;
  } else if (!comparable) {
    change = 'The two are in more than one currency, so there is no single change to state.';
  }
  return {
    content: [head, change].filter(Boolean).join(' '),
    citations: [...a.evidence.slice(0, 4), ...b.evidence.slice(0, 4)],
    facts: { ...NO_FACTS, unit: unitOf(a), label: a.label, mixed: true },
  };
}

/** The account panel, as a paragraph. */
export function renderProfile(profile: AccountProfileResult, workspace: WorkspaceProfile): Rendered {
  const facts: string[] = [];
  if (profile.headline) facts.push(profile.headline);
  facts.push(profile.owner ? `owned by ${profile.owner}` : 'no owner');
  const opens = profile.totals.open_pipeline;
  facts.push(profile.open_deals.length
    ? `${profile.totals.open_pipeline_formatted} of open pipeline across ${n(profile.open_deals.length, workspace.locale)} ${plural(profile.open_deals.length, 'deal')}`
    : 'no open deals');
  facts.push(profile.won_deals.length
    ? `${profile.totals.lifetime_won_formatted} won across ${n(profile.won_deals.length, workspace.locale)} ${plural(profile.won_deals.length, 'deal')}`
    : 'nothing won yet');
  facts.push(`${n(profile.totals.contacts, workspace.locale)} ${plural(profile.totals.contacts, 'contact')}`);
  facts.push(`${n(profile.totals.open_tickets, workspace.locale)} open ${plural(profile.totals.open_tickets, 'ticket')}`);
  const last = profile.last_activity.days_ago;
  facts.push(last === null ? 'no activity logged' : last === 0 ? 'last touched today' : `last touched ${n(last, workspace.locale)} ${plural(last, 'day')} ago`);
  const nextClose = profile.next_close_date ? ` The next close date is ${dateOf(profile.next_close_date, workspace)}.` : '';
  return {
    content: `${profile.name} — ${facts.join(' · ')}.${nextClose}`,
    citations: [{ id: profile.id, label: profile.name, type: profile.object_type }],
    facts: { ...NO_FACTS, value: opens, formatted: profile.totals.open_pipeline_formatted, unit: 'money', currency: workspace.currency, count: profile.open_deals.length, label: 'Open pipeline', subject: profile.name },
  };
}

/** What one meter recorded. */
export function renderUsage(result: MeteredUsageResult, workspace: WorkspaceProfile): Rendered {
  const scope = result.subject ? `${result.subject.label} ` : '';
  const who = result.scope === 'account'
    ? ''
    : ` across ${n(result.accounts, workspace.locale)} ${plural(result.accounts, 'account')}`;
  const verb = result.meter.aggregation === 'max' ? 'peaked at' : result.meter.aggregation === 'last' ? 'closed at' : 'recorded';
  const content = result.event_count === 0
    ? `${scope}${result.meter.name} recorded nothing ${periodPhrase(result.window.label)}.`
    : `${scope}${result.meter.name} ${verb} ${result.formatted} ${periodPhrase(result.window.label)}${who}.`;
  return {
    content,
    citations: result.by_account.slice(0, 5).map((a) => ({ id: a.id, label: a.label, type: 'customer' })),
    facts: { ...NO_FACTS, value: result.value, formatted: result.formatted, unit: 'units', count: result.accounts, label: result.meter.name, period: result.window.label, subject: result.subject?.label ?? null },
  };
}

export function renderQuote(result: { product: string | null; quantity: number; amount: number; amount_display: string; breakdown: string[]; warning: string | null }, unit: string, currency: string, workspace: WorkspaceProfile): Rendered {
  const qty = `${n(result.quantity, workspace.locale)} ${unit}`;
  const content = `${qty} would cost ${result.amount_display}${result.product ? ` on ${result.product}` : ''}.`;
  return {
    content,
    citations: [],
    facts: { ...NO_FACTS, value: result.amount, formatted: result.amount_display, unit: 'money', currency, count: result.quantity, label: 'Quoted price' },
  };
}

export function renderTimeline(record: string, items: TimelineItem[], workspace: WorkspaceProfile): Rendered {
  void workspace;
  if (!items.length) return { content: `Nothing has been logged on ${record} yet.`, citations: [], facts: { ...NO_FACTS, count: 0, subject: record } };
  const lines = items.map((item) => `• ${item.when} — ${humanise(item.kind)}: ${item.title}${item.actor ? ` (${item.actor})` : ''}`);
  return {
    content: `Recent activity on ${record}:\n\n${lines.join('\n')}`,
    citations: items.slice(0, 8).map((item) => ({ id: item.id, label: item.title, type: item.kind })),
    facts: { ...NO_FACTS, count: items.length, subject: record, rows: items.map((i) => ({ id: i.id, label: i.title })) },
  };
}

export function renderDraft(draft: DraftResult): Rendered {
  return {
    content: `Subject: ${draft.subject}\n\n${draft.body}`,
    citations: draft.recipient ? [{ id: draft.recipient.id, label: draft.recipient.name, type: 'contact' }] : [],
    facts: { ...NO_FACTS, label: `${humanise(draft.kind)} draft`, subject: draft.recipient?.name ?? null },
  };
}

export function renderDelinquent(result: DelinquentCustomersResult, workspace: WorkspaceProfile): Rendered {
  void workspace;
  if (!result.total) return { content: 'No customer is past due: every open invoice is inside its terms.', citations: [], facts: { ...NO_FACTS, unit: 'count', value: 0, formatted: '0', count: 0, label: 'past-due customers' } };
  const lines = result.customers.map((c) => `• ${c.name} — ${c.outstanding_formatted} across ${c.open_invoices} open ${plural(c.open_invoices, 'invoice')}${c.days_overdue ? `, oldest ${c.days_overdue} ${plural(c.days_overdue, 'day')} overdue` : ''}`);
  return {
    content: `${result.total} ${plural(result.total, 'customer is', 'customers are')} past due:\n\n${lines.join('\n')}`,
    citations: result.customers.map((c) => ({ id: c.id, label: c.name, type: 'customer' })),
    facts: { ...NO_FACTS, unit: 'count', value: result.total, formatted: String(result.total), count: result.total, label: 'past-due customers', rows: result.customers.map((c) => ({ id: c.id, label: c.name })) },
  };
}

export function renderStale(result: StaleAccountsResult, workspace: WorkspaceProfile): Rendered {
  if (!result.total) return { content: `Every account has been touched inside the last ${result.threshold_days} days.`, citations: [], facts: { ...NO_FACTS, unit: 'count', value: 0, formatted: '0', count: 0, label: 'quiet accounts' } };
  const lines = result.accounts.map((a) => `• ${a.name} — ${a.days_since_activity === null ? 'never touched' : `${n(a.days_since_activity, workspace.locale)} days quiet`}${a.open_pipeline ? `, ${a.open_pipeline_formatted} open` : ''}${a.owner ? ` · ${a.owner}` : ''}`);
  const rest = result.total - result.accounts.length;
  return {
    content: [`${result.total} ${plural(result.total, 'account has', 'accounts have')} had no activity for ${result.threshold_days} days or more:`, lines.join('\n'), rest > 0 ? `…and ${rest} more.` : ''].filter(Boolean).join('\n\n'),
    citations: result.accounts.map((a) => ({ id: a.id, label: a.name, type: 'company' })),
    facts: { ...NO_FACTS, unit: 'count', value: result.total, formatted: String(result.total), count: result.total, label: 'quiet accounts', rows: result.accounts.map((a) => ({ id: a.id, label: a.name })) },
  };
}

export interface SubscriptionRow { id: string; customer_name: string | null; status: string; status_detail?: string; items: string[]; mrr_display?: string; current_period_end?: string }

export function renderSubscriptions(rows: SubscriptionRow[], total: number, scope: string, workspace: WorkspaceProfile): Rendered {
  void workspace;
  if (!total) return { content: `There are no subscriptions ${scope}.`, citations: [], facts: { ...NO_FACTS, unit: 'count', value: 0, formatted: '0', count: 0, label: 'subscriptions' } };
  const lines = rows.map((s) => `• ${s.customer_name ?? s.id} — ${humanise(s.status)}${s.items.length ? ` · ${s.items.join(', ')}` : ''}`);
  const rest = total - rows.length;
  return {
    content: [`${total} ${plural(total, 'subscription is', 'subscriptions are')} ${scope}:`, lines.join('\n'), rest > 0 ? `…and ${rest} more.` : ''].filter(Boolean).join('\n\n'),
    citations: rows.map((s) => ({ id: s.id, label: s.customer_name ?? s.id, type: 'subscription' })),
    facts: { ...NO_FACTS, unit: 'count', value: total, formatted: String(total), count: total, label: 'subscriptions', rows: rows.map((s) => ({ id: s.id, label: s.customer_name ?? s.id })) },
  };
}

export interface InvoiceRow { id: string; number: string | null; customer_name?: string | null; status: string; total_display?: string; amount_due_display?: string; due?: string | null }

export function renderInvoices(rows: InvoiceRow[], total: number, scope: string): Rendered {
  if (!total) return { content: `There are no ${scope} invoices.`, citations: [], facts: { ...NO_FACTS, unit: 'count', value: 0, formatted: '0', count: 0, label: 'invoices' } };
  const lines = rows.map((i) => `• ${i.number ?? i.id}${i.customer_name ? ` — ${i.customer_name}` : ''}${i.amount_due_display ? ` · ${i.amount_due_display} due` : i.total_display ? ` · ${i.total_display}` : ''}${i.due ? ` · due ${i.due}` : ''}`);
  const rest = total - rows.length;
  return {
    content: [`${total} ${scope} ${plural(total, 'invoice')}:`, lines.join('\n'), rest > 0 ? `…and ${rest} more.` : ''].filter(Boolean).join('\n\n'),
    citations: rows.map((i) => ({ id: i.id, label: i.number ?? i.id, type: 'invoice' })),
    facts: { ...NO_FACTS, unit: 'count', value: total, formatted: String(total), count: total, label: `${scope} invoices`, rows: rows.map((i) => ({ id: i.id, label: i.number ?? i.id })) },
  };
}

export function renderPrices(product: { id: string; name: string; prices: { id: string; nickname: string | null; summary: string }[] }): Rendered {
  if (!product.prices.length) return { content: `${product.name} has no active price in the workspace currency.`, citations: [], facts: { ...NO_FACTS, count: 0, label: product.name } };
  const lines = product.prices.map((p) => `• ${p.nickname ?? p.id} — ${p.summary}`);
  return {
    content: `${product.name} is priced ${product.prices.length === 1 ? 'one way' : `${product.prices.length} ways`}:\n\n${lines.join('\n')}`,
    citations: [{ id: product.id, label: product.name, type: 'product' }],
    facts: { ...NO_FACTS, count: product.prices.length, label: product.name, rows: product.prices.map((p) => ({ id: p.id, label: p.nickname ?? p.id })) },
  };
}

/** A lookup of one field on one record. */
export function renderField(label: string, sentence: string, record: { id: string; label: string; type: string }): Rendered {
  return { content: sentence, citations: [record], facts: { ...NO_FACTS, label, subject: record.label } };
}

/* ------------------------------- refusal --------------------------------- */

/**
 * The refusal is the product. It never guesses; it hands the reader three
 * questions this workspace can answer, in words that name real records.
 */
export function renderRefusal(nearest: { example: string }[], reason: string | null): string {
  const lines = [`I can't answer that as asked.${reason ? ` ${reason}` : ''}`];
  if (nearest.length) {
    lines.push('Try one of these:');
    lines.push(nearest.map((t) => `• ${t.example}`).join('\n'));
  }
  return lines.join('\n\n');
}

export const daysAgo = (ts: number, now: number): number => Math.floor((now - ts) / DAY);
export { truncate };

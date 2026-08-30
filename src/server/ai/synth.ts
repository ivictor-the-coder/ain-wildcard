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
}

export interface Citation { id: string; label: string; type: string }

export interface SynthesisInput {
  question: string;
  intent: IntentResult;
  workspace: WorkspaceProfile;
  window: TimeWindow;
  subject: MetricSubject | null;
  entities: ResolvedEntity[];
  steps: StepResult[];
  metric: MetricDetection | null;
  draft: DraftResult | null;
  pendingApprovals: PendingApproval[];
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
const isRecordList = (value: unknown): boolean => !!value && typeof value === 'object' && 'records' in (value as object);
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

function citationsFrom(input: SynthesisInput): Citation[] {
  const out = new Map<string, Citation>();
  const add = (id: string | null | undefined, label: string, type: string) => {
    if (!id || out.has(id)) return;
    out.set(id, { id, label, type });
  };
  for (const step of input.steps) {
    if (!ok(step)) continue;
    const value = step.result;
    if (isProfile(value)) {
      const profile = value as AccountProfileResult;
      add(profile.id, profile.name, profile.object_type);
      for (const deal of profile.open_deals.slice(0, 4)) add(deal.id, deal.name, 'deal');
      for (const contact of profile.contacts.slice(0, 3)) add(contact.id, contact.name, 'contact');
      for (const ticket of profile.open_tickets.slice(0, 3)) add(ticket.id, ticket.subject, 'ticket');
    } else if (isMetric(value)) {
      const metric = value as MetricToolResult;
      if (metric.subject) add(metric.subject.id, metric.subject.label, metric.subject.type);
      for (const row of metric.evidence.slice(0, 6)) add(row.id, row.label, row.type);
      for (const account of metric.top_accounts.slice(0, 3)) add(account.id, account.label, 'company');
    } else if (isSearch(value)) {
      for (const match of (value as WorkspaceSearchResult).matches.slice(0, 5)) add(match.id, match.label, match.type);
    } else if (isRecordList(value)) {
      const list = value as RecordSearchResult;
      for (const record of list.records.slice(0, 6)) add(record.id, record.name, list.object_type);
    } else if (isTimeline(value)) {
      for (const item of (value as { items: TimelineItem[] }).items.slice(0, 4)) add(item.id, item.title, item.kind);
    } else if (isAggregate(value)) {
      for (const id of (value as RecordAggregateResult).sample_ids.slice(0, 4)) add(id, 'matched record', 'record');
    }
  }
  for (const entity of input.entities.slice(0, 3)) add(entity.entity.id, entity.entity.label, entity.entity.type);
  return [...out.values()].slice(0, 12);
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
  const metrics = resultsOf<MetricToolResult>(input.steps, 'business_metric', isMetric);
  const profiles = input.steps.filter((s) => ok(s) && isProfile(s.result)).map((s) => s.result as AccountProfileResult);
  const timelines = input.steps.filter((s) => ok(s) && isTimeline(s.result)).map((s) => s.result as { record: string; items: TimelineItem[] });
  const searches = input.steps.filter((s) => ok(s) && isSearch(s.result)).map((s) => s.result as WorkspaceSearchResult);
  const lists = input.steps.filter((s) => ok(s) && isRecordList(s.result)).map((s) => s.result as RecordSearchResult);
  const aggregates = input.steps.filter((s) => ok(s) && isAggregate(s.result)).map((s) => s.result as RecordAggregateResult);
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
    return { content: blocks.join('\n\n'), citations: citationsFrom(input) };
  }

  switch (input.intent.intent) {
    case 'compare': {
      if (metrics.length >= 2) {
        const [a, b] = metrics;
        const leader = a.value >= b.value ? a : b;
        const trailer = a.value >= b.value ? b : a;
        const gap = Math.abs(a.value - b.value);
        const gapText = a.unit === 'money' ? facts.money(gap) : gap.toLocaleString(input.workspace.locale);
        const percent = trailer.value !== 0 ? `, ${((gap / Math.abs(trailer.value)) * 100).toFixed(0)}% ahead` : '';
        const scope = a.snapshot ? 'right now' : `in ${a.window.label}`;
        blocks.push(gap === 0
          ? `${leader.subject?.label ?? input.workspace.name} and ${trailer.subject?.label ?? 'the other account'} are level on ${a.label.toLowerCase()} ${scope}, both at ${leader.formatted}.`
          : `On ${a.label.toLowerCase()} ${scope}, ${leader.subject?.label ?? input.workspace.name} leads with ${leader.formatted} against ${trailer.subject?.label ?? 'the other account'} at ${trailer.formatted} — a gap of ${gapText}${percent}.`);
        for (const metric of [leader, trailer]) {
          blocks.push(bullet(`${metric.subject?.label ?? input.workspace.name}: ${metric.formatted} from ${metric.source}${metric.change ? `, ${metric.change.delta >= 0 ? 'up' : 'down'} on ${metric.change.previous_formatted} the period before` : ''}`));
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
      if (profiles.length) {
        blocks.push(...profileParagraph(profiles[0], facts, input.workspace));
        const profile = profiles[0];
        if (profile.open_deals.length > 1) {
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
            blocks.push(`No ${list.object_type} records match that.`);
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
      if (input.pendingApprovals.length) {
        const pending = input.pendingApprovals[0];
        blocks.push(`I prepared ${pending.tool} and stopped: it writes to the workspace, so it needs your approval before it runs.`);
        blocks.push(`Arguments: ${Object.entries(pending.args).map(([k, v]) => `${k}=${truncate(String(v), 60)}`).join(', ')}.`);
        blocks.push('Approve it from the run detail and I will finish the job.');
      } else {
        const written = input.steps.filter((s) => s.ok && !s.tool.startsWith('record_') && !s.tool.startsWith('business_'));
        blocks.push(written.length
          ? `Done: ${written.map((s) => s.tool).join(', ')}.`
          : 'I did not change anything — the request did not resolve to a write tool I am allowed to run.');
        if (profiles.length) blocks.push(...profileParagraph(profiles[0], facts, input.workspace));
      }
      break;
    }

    default:
      break;
  }

  if (!blocks.length) blocks.push(...overview(input, facts, { metrics, profiles, lists, aggregates, searches }));
  if (!blocks.length) blocks.push(emptyAnswer(input, facts));

  if (input.pendingApprovals.length && input.intent.intent !== 'act') {
    blocks.push(`${countOf(input.pendingApprovals.length, 'step')} needs approval before it can run: ${input.pendingApprovals.map((p) => p.tool).join(', ')}.`);
  }

  return { content: blocks.filter(Boolean).join('\n\n'), citations: citationsFrom(input) };
}

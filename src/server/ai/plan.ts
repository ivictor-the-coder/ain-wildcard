/**
 * Tool planning.
 *
 * The engine has a canonical plan for each kind of task — the sequence a good
 * analyst would run — and a generic matcher that scores any other registered
 * tool against the question and tries to fill its arguments from what has
 * already been resolved. A tool whose required arguments cannot be filled is
 * never planned, so the runtime is never asked to run something that cannot
 * work.
 */
import type { AiToolDef } from '../kernel/ai';
import type { SchemaNode } from '../../shared/validate';
import type { TaskIntent } from './intent';
import type { ResolvedEntity } from './resolve';
import type { GroupBy, MetricDetection, MetricSubject, StageSets } from './metrics';
import type { TimeWindow } from './dates';
import type { WorkspaceProfile } from './grounding';
import { contentWords, normalise, stem, trigramSimilarity } from './text';

export type BuiltinTool =
  | 'workspace_search' | 'account_profile' | 'business_metric'
  | 'record_search' | 'record_aggregate' | 'record_timeline';

export const BUILTIN_TOOLS: BuiltinTool[] = [
  'workspace_search', 'account_profile', 'business_metric', 'record_search', 'record_aggregate', 'record_timeline',
];

export interface PlannedStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  builtin: BuiltinTool | null;
  relevance: number;
}

export interface PlanInput {
  question: string;
  /** Which deal stages count as open, won and lost in this workspace. */
  stages: StageSets;
  /** True when the question actually names something — an id, email, domain or proper noun. */
  namedSomething: boolean;
  intent: TaskIntent;
  window: TimeWindow;
  entities: ResolvedEntity[];
  subject: MetricSubject | null;
  metric: MetricDetection | null;
  groupBy: GroupBy;
  types: string[];
  tools: AiToolDef[];
  workspace: WorkspaceProfile;
  maxSteps: number;
}

const OPEN_TICKET_STATUSES = ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'];

export interface InferredCondition {
  property: string;
  op: 'eq' | 'in';
  value?: string;
  values?: string[];
}

/**
 * "Which tickets need attention" is not a request for every ticket ever filed.
 * Qualifiers in the question become real conditions, most specific first.
 */
export function inferConditions(question: string, objectType: string, stages: StageSets): InferredCondition[] {
  const text = normalise(question);
  const out: InferredCondition[] = [];
  const has = (re: RegExp) => re.test(text);

  if (objectType === 'ticket') {
    if (has(/\bescalated\b/)) out.push({ property: 'status', op: 'eq', value: 'escalated' });
    if (has(/\b(urgent|critical|p1|on fire)\b/)) out.push({ property: 'priority', op: 'in', values: ['urgent', 'high'] });
    if (has(/\bhigh priority\b/)) out.push({ property: 'priority', op: 'in', values: ['urgent', 'high'] });
    if (has(/\bclosed\b/)) out.push({ property: 'status', op: 'eq', value: 'closed' });
    if (has(/\b(open|unresolved|outstanding|attention|backlog|active|pending|waiting|stuck|broken|failing)\b/)) {
      out.push({ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES });
    }
  }
  if (objectType === 'deal') {
    for (const stage of ['negotiation', 'proposal', 'discovery', 'qualification']) {
      if (has(new RegExp(`\\b${stage}\\b`))) out.push({ property: 'deal_stage', op: 'eq', value: stage === 'proposal' ? 'proposal' : stage });
    }
    if (has(/\bwon\b/)) out.push({ property: 'deal_stage', op: 'in', values: stages.won });
    if (has(/\blost\b/)) out.push({ property: 'deal_stage', op: 'in', values: stages.lost });
    if (has(/\b(open|active|live|in flight|pipeline|slipping|stalled)\b/)) out.push({ property: 'deal_stage', op: 'in', values: stages.open });
  }
  if (objectType === 'company') {
    if (has(/\bcustomers?\b/)) out.push({ property: 'type', op: 'eq', value: 'customer' });
    else if (has(/\bprospects?\b/)) out.push({ property: 'type', op: 'eq', value: 'prospect' });
    else if (has(/\bpartners?\b/)) out.push({ property: 'type', op: 'eq', value: 'partner' });
    if (has(/\bkey accounts?\b/)) out.push({ property: 'is_key_account', op: 'eq', value: 'true' });
  }
  if (objectType === 'contact') {
    if (has(/\bchampions?\b/)) out.push({ property: 'buying_role', op: 'eq', value: 'champion' });
    else if (has(/\b(economic buyers?|decision makers?)\b/)) out.push({ property: 'buying_role', op: 'eq', value: 'economic_buyer' });
  }

  const seen = new Set<string>();
  return out.filter((condition) => {
    if (seen.has(condition.property)) return false;
    seen.add(condition.property);
    return true;
  });
}

const builtin = (tool: BuiltinTool, args: Record<string, unknown>, why: string, relevance = 1): PlannedStep =>
  ({ tool, args, why, builtin: tool, relevance });

/** The canonical sequence for the classified task. */
function canonicalPlan(input: PlanInput): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const { subject, window, metric, groupBy, intent, entities } = input;
  const comparisonSubjects = entities
    .filter((e) => ['company', 'contact', 'customer'].includes(e.entity.type))
    .slice(0, 3);

  const metricStep = (subjectId: string | undefined, label: string) =>
    builtin('business_metric', {
      metric: metric?.metric.id ?? 'closed_won',
      start: window.start,
      end: window.end,
      window_label: window.label,
      ...(subjectId ? { subject_id: subjectId } : {}),
      group_by: groupBy,
      compare: true,
    }, label);

  switch (intent) {
    case 'aggregate': {
      const namedType = input.types.find((t) => t !== 'activity' && t !== 'customer');
      if (!metric && namedType) {
        // "How many X" with no metric behind it is a count of X, not a guess.
        const conditions = inferConditions(input.question, namedType, input.stages);
        steps.push(builtin('record_aggregate', {
          object_type: namedType,
          measure: 'count',
          ...(conditions.length ? { conditions } : {}),
          ...(subject ? { associated_to: subject.id } : {}),
        }, `The question counts ${namedType} records${conditions.length ? ` qualified by ${conditions.map((c) => c.property).join(' and ')}` : ''}.`));
      } else {
        steps.push(metricStep(subject?.id, metric
          ? `"${metric.matched}" is the ${metric.metric.label} metric${subject ? ` for ${subject.label}` : ''} over ${window.label}.`
          : `No explicit metric in the question — reporting bookings for ${window.label}.`));
      }
      if (subject) steps.push(builtin('account_profile', { id: subject.id }, `Pull ${subject.label}'s record so the number has context.`, 0.8));
      break;
    }

    case 'compare':
      if (comparisonSubjects.length >= 2) {
        for (const candidate of comparisonSubjects.slice(0, 2)) {
          steps.push(metricStep(candidate.entity.id, `Compute ${metric?.metric.label ?? 'bookings'} for ${candidate.entity.label}.`));
        }
      } else {
        steps.push(metricStep(subject?.id, `Compute ${metric?.metric.label ?? 'bookings'} for ${window.label} and the period before it.`));
      }
      break;

    case 'explain':
      steps.push(metricStep(subject?.id, `Measure ${metric?.metric.label ?? 'the trend'} for ${window.label} against the previous period.`));
      steps.push(builtin('record_aggregate', {
        object_type: 'deal',
        measure: 'sum',
        property: 'amount',
        group_by: 'deal_type',
        conditions: [{ property: 'deal_stage', op: 'eq', value: 'closed_won' }],
        date_property: 'close_date',
        start: window.start,
        end: window.end,
      }, 'Split what did close by deal type — new business, expansion and renewal move for different reasons.', 0.9));
      steps.push(builtin('record_aggregate', {
        object_type: 'deal',
        measure: 'sum',
        property: 'amount',
        group_by: 'close_reason',
        conditions: [{ property: 'deal_stage', op: 'eq', value: 'closed_lost' }],
        date_property: 'close_date',
        start: window.start,
        end: window.end,
      }, 'Group losses by reason — the usual explanation for a drop.', 0.85));
      break;

    case 'lookup': {
      const person = entities.find((e) => e.entity.type === 'user');
      if (person && !subject) {
        steps.push(builtin('record_search', {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
          owner_id: person.entity.id,
          order_by: 'amount',
          limit: 8,
        }, `"${person.mention}" is ${person.entity.label}; show the open deals they own.`));
        steps.push(builtin('record_search', {
          object_type: 'ticket',
          conditions: [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
          owner_id: person.entity.id,
          limit: 5,
        }, `And the tickets assigned to ${person.entity.label}.`, 0.8));
        break;
      }
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `"${subject.label}" resolved to a record; load its full profile.`));
      } else if (input.namedSomething) {
        steps.push(builtin('workspace_search', { query: input.question, limit: 8 }, 'The question names something that did not resolve to one record — search the workspace first.'));
      }
      if (!subject && input.types.length) {
        const objectType = input.types[0] === 'activity' ? 'meeting' : input.types[0];
        const conditions = inferConditions(input.question, objectType, input.stages);
        steps.push(builtin('record_search', {
          object_type: objectType,
          ...(conditions.length ? { conditions } : {}),
          ...(objectType === 'deal' ? { order_by: 'amount' } : {}),
          limit: 10,
        }, conditions.length
          ? `The question asks for ${objectType} records qualified by ${conditions.map((c) => c.property).join(' and ')}.`
          : `The question names ${objectType} records; list the most recent ones.`, 0.7));
      }
      break;
    }

    case 'summarise':
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `Summarising ${subject.label} starts with the account record.`));
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 12 }, 'Read the timeline so the summary is about what actually happened.'));
      } else {
        steps.push(metricStep(undefined, `Summarise ${window.label} with the headline number first.`));
        steps.push(builtin('record_search', {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
          order_by: 'amount',
          limit: 8,
        }, 'List the largest open deals so the summary names names.', 0.9));
      }
      break;

    case 'plan':
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `Recommendations need the current state of ${subject.label}.`));
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 8 }, 'Check the recent history before proposing a next step.'));
      } else {
        steps.push(builtin('record_search', {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
          order_by: 'amount',
          limit: 10,
        }, 'Prioritise against the open pipeline, largest first.'));
        steps.push(metricStep(undefined, `Anchor the plan on ${metric?.metric.label ?? 'bookings'} for ${window.label}.`, ));
      }
      break;

    case 'troubleshoot':
      steps.push(builtin('record_search', {
        object_type: 'ticket',
        conditions: inferConditions(input.question, 'ticket', input.stages).length
          ? inferConditions(input.question, 'ticket', input.stages)
          : [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
        ...(subject ? { associated_to: subject.id } : {}),
        limit: 10,
      }, subject ? `Find the open tickets on ${subject.label}.` : 'Find the open tickets that match the problem.'));
      if (subject) {
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 10 }, 'Read what happened around the failure.'));
        steps.push(builtin('account_profile', { id: subject.id }, 'Check entitlement, support tier and open commercial context.', 0.8));
      }
      break;

    case 'draft':
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `Personalise the draft with real facts about ${subject.label}.`));
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 6 }, 'Reference the last real interaction, not a generic opener.'));
      } else if (input.namedSomething) {
        steps.push(builtin('workspace_search', { query: input.question, limit: 5 }, 'Find who the message is about before writing it.'));
      }
      break;

    case 'act':
      if (subject) steps.push(builtin('account_profile', { id: subject.id }, `Confirm the current state of ${subject.label} before changing anything.`));
      break;
  }

  // "How are we doing?" names nothing at all. Answer it with the state of the
  // business rather than with an apology.
  if (!steps.length) {
    steps.push(metricStep(undefined, `Nothing specific was named, so the answer opens with ${metric?.metric.label ?? 'bookings'} for ${window.label}.`));
    steps.push(builtin('record_search', {
      object_type: 'deal',
      conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
      order_by: 'amount',
      limit: 5,
    }, 'Name the biggest open deals so the picture is concrete.', 0.8));
    steps.push(builtin('record_aggregate', {
      object_type: 'ticket',
      measure: 'count',
      conditions: [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
      group_by: 'priority',
    }, 'Put the support backlog next to the revenue picture.', 0.7));
  }

  return steps;
}

/* ---------------------------- generic matching ---------------------------- */

const TYPE_HINTS: Record<string, string[]> = {
  company: ['company', 'account', 'organisation', 'organization'],
  contact: ['contact', 'person', 'people', 'lead'],
  deal: ['deal', 'opportunity', 'pipeline'],
  ticket: ['ticket', 'support', 'case'],
  invoice: ['invoice', 'billing', 'payment'],
  subscription: ['subscription', 'plan'],
  product: ['product', 'price', 'catalog', 'catalogue'],
};

/** How well a tool matches the question, 0–1. */
export function scoreTool(tool: AiToolDef, input: Pick<PlanInput, 'question' | 'intent' | 'types'>): number {
  const haystack = normalise(`${tool.name} ${tool.description} ${(tool.tags ?? []).join(' ')}`);
  const haystackStems = new Set(contentWords(haystack).map(stem));
  const questionStems = contentWords(input.question).map(stem);
  if (!questionStems.length) return 0;

  let hits = 0;
  for (const token of new Set(questionStems)) if (haystackStems.has(token)) hits++;
  let score = hits / Math.min(new Set(questionStems).size, 8);
  score = Math.min(score, 1) * 0.7 + trigramSimilarity(input.question, `${tool.name} ${tool.description.slice(0, 120)}`) * 0.3;

  for (const type of input.types) {
    for (const hint of TYPE_HINTS[type] ?? []) if (haystack.includes(hint)) { score += 0.12; break; }
  }
  if (!tool.readOnly) score += input.intent === 'act' ? 0.25 : -0.6;
  if (tool.requiresApproval && input.intent !== 'act') score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

interface FillContext {
  question: string;
  window: TimeWindow;
  entities: ResolvedEntity[];
  subject: MetricSubject | null;
  metric: MetricDetection | null;
  groupBy: GroupBy;
  types: string[];
}

const ID_FIELD = /(^|_)(id|ids|record_id|customer_id|company_id|account_id|contact_id|deal_id|subject_id|entity_id)$/;
const QUERY_FIELD = /^(q|query|search|text|term|question|prompt|message|body|content|input)$/;
const LIMIT_FIELD = /^(limit|max|count|top|size|per_page)$/;
const START_FIELD = /^(start|from|since|start_at|start_date|after|period_start)$/;
const END_FIELD = /^(end|to|until|end_at|end_date|before|period_end)$/;
const TYPE_FIELD = /^(object_type|type|entity_type|record_type|resource)$/;

function fillField(name: string, node: SchemaNode, context: FillContext): unknown {
  if (node.default !== undefined) return node.default;

  if (ID_FIELD.test(name)) {
    const wanted = name.replace(/_id$/, '');
    const match = context.entities.find((e) => e.entity.type === wanted) ?? context.entities[0];
    if (name.endsWith('ids')) return match ? [match.entity.id] : undefined;
    return match?.entity.id;
  }
  if (TYPE_FIELD.test(name)) {
    const named = context.types.find((t) => t !== 'activity');
    return named ?? context.entities[0]?.entity.type ?? 'company';
  }
  if (QUERY_FIELD.test(name)) return context.question;
  if (LIMIT_FIELD.test(name)) return node.type === 'integer' || node.type === 'number' ? Math.min(node.max ?? 10, 10) : undefined;
  if (START_FIELD.test(name)) return context.window.start;
  if (END_FIELD.test(name)) return context.window.end;
  if (name === 'metric' && context.metric) return context.metric.metric.id;
  if (name === 'group_by' || name === 'groupby') return context.groupBy === 'none' ? undefined : context.groupBy;
  if (/^(days|days_back|lookback|window_days)$/.test(name)) return Math.max(1, Math.round((context.window.end - context.window.start) / 86_400_000));

  if (node.enum?.length) {
    const text = normalise(context.question);
    const hit = node.enum.find((option) => text.includes(normalise(option)));
    if (hit) return hit;
  }
  if (node.type === 'boolean') return undefined;
  if (node.type === 'integer' || node.type === 'number') {
    const match = context.question.match(/\b(\d{1,6})\b/);
    return match ? Number(match[1]) : undefined;
  }
  if (node.type === 'string' && !node.optional) {
    // A required free-text field with no better source gets the question itself.
    return context.question;
  }
  return undefined;
}

export interface FilledArguments {
  args: Record<string, unknown>;
  missing: string[];
}

/** Fill a tool's arguments from the resolved context; report what is missing. */
export function fillArguments(tool: AiToolDef, context: FillContext): FilledArguments {
  const schema = tool.input.describe();
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  if (schema.type !== 'object' || !schema.fields) return { args, missing };
  for (const [name, node] of Object.entries(schema.fields)) {
    const value = fillField(name, node, context);
    if (value === undefined || value === null) {
      if (!node.optional) missing.push(name);
      continue;
    }
    args[name] = value;
  }
  return { args, missing };
}

/**
 * Build the ordered plan: the canonical steps for the intent, then any
 * registered tool that scores well enough and whose arguments can be filled.
 */
export function planSteps(input: PlanInput): PlannedStep[] {
  const steps = canonicalPlan(input);
  const planned = new Set(steps.map((s) => s.tool));
  const context: FillContext = {
    question: input.question,
    window: input.window,
    entities: input.entities,
    subject: input.subject,
    metric: input.metric,
    groupBy: input.groupBy,
    types: input.types,
  };

  const offIntent = (name: string) =>
    (name === 'compose_message' && input.intent !== 'draft') ||
    (name === 'schedule_followup' && input.intent !== 'act');

  const candidates = input.tools
    .filter((tool) => !planned.has(tool.name) && !BUILTIN_TOOLS.includes(tool.name as BuiltinTool) && !offIntent(tool.name))
    .map((tool) => ({ tool, relevance: scoreTool(tool, input) }))
    .filter((c) => c.relevance >= 0.42)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 4);

  for (const candidate of candidates) {
    if (steps.length >= input.maxSteps) break;
    // Once the canonical plan has real coverage, only a strong match earns a slot.
    if (steps.length >= 2 && candidate.relevance < 0.55) break;
    const { args, missing } = fillArguments(candidate.tool, context);
    if (missing.length) continue;
    steps.push({
      tool: candidate.tool.name,
      args,
      why: `"${candidate.tool.name}" matches the question (relevance ${candidate.relevance.toFixed(2)}): ${candidate.tool.description.split('.')[0]}.`,
      builtin: null,
      relevance: candidate.relevance,
    });
    planned.add(candidate.tool.name);
  }

  return steps.slice(0, input.maxSteps);
}

/**
 * The second pass. After the first wave of results the engine knows more —
 * a search that pinned down one record, an aggregate with an obvious follow-up
 * — so it may plan one more round inside the remaining budget.
 */
export function replan(input: PlanInput, executed: { tool: string; result: unknown }[], remaining: number): PlannedStep[] {
  if (remaining <= 0) return [];
  const done = new Set(executed.map((e) => e.tool));
  const steps: PlannedStep[] = [];

  const search = executed.find((e) => e.tool === 'workspace_search');
  if (search && !done.has('account_profile')) {
    const matches = (search.result as { matches?: { id: string; label: string; type: string; score: number }[] })?.matches ?? [];
    const best = matches.find((m) => ['company', 'contact', 'customer'].includes(m.type)) ?? matches[0];
    if (best && best.score >= 0.5) {
      steps.push(builtin('account_profile', { id: best.id }, `Search resolved "${best.label}"; load the record it points at.`, 0.9));
    }
  }

  const profile = executed.find((e) => e.tool === 'account_profile');
  if (profile && input.intent === 'aggregate' && input.metric && !done.has('business_metric')) {
    const record = profile.result as { id?: string; name?: string };
    if (record?.id) {
      steps.push(builtin('business_metric', {
        metric: input.metric.metric.id,
        start: input.window.start,
        end: input.window.end,
        window_label: input.window.label,
        subject_id: record.id,
        group_by: input.groupBy,
        compare: true,
      }, `Now that ${record.name} is identified, compute ${input.metric.metric.label} for it.`, 0.95));
    }
  }

  if ((input.intent === 'summarise' || input.intent === 'plan') && profile && !done.has('record_timeline')) {
    const record = profile.result as { id?: string; name?: string };
    if (record?.id) steps.push(builtin('record_timeline', { record_id: record.id, limit: 10 }, `Read ${record.name}'s recent history.`, 0.8));
  }

  return steps.slice(0, remaining);
}

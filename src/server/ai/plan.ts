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
import { resolveDueDate } from './dates';
import type { WorkspaceProfile } from './grounding';
import { capitalise, contentWords, normalise, stem, trigramSimilarity, truncate } from './text';

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

/** The two periods a comparison is actually about, both named in the answer. */
export interface WindowPair {
  a: TimeWindow;
  b: TimeWindow;
  /** How the second window was chosen — for the trace and the answer. */
  source: 'both_named' | 'year_over_year' | 'preceding_period';
}

export interface PlanInput {
  question: string;
  /** Which deal stages count as open, won and lost in this workspace. */
  stages: StageSets;
  /** True when the question actually names something — an id, email, domain or proper noun. */
  namedSomething: boolean;
  intent: TaskIntent;
  window: TimeWindow;
  /** Every period the question named, in the order it named them. */
  windows: TimeWindow[];
  /** Set for a comparison: exactly the two periods that will be measured. */
  comparison: WindowPair | null;
  entities: ResolvedEntity[];
  subject: MetricSubject | null;
  metric: MetricDetection | null;
  groupBy: GroupBy;
  types: string[];
  tools: AiToolDef[];
  workspace: WorkspaceProfile;
  maxSteps: number;
  /** Tool names this run is scoped to; `null` means the whole catalogue. */
  allowedTools: Set<string> | null;
  /** Who is asking — the default assignee for anything scheduled. */
  actorId: string | null;
  /** Picklist values for deal_stage, so "move it to Negotiation" writes a real stage. */
  dealStages: { value: string; label: string }[];
  /** Whether this run may change data at all. */
  allowWrites: boolean;
  /** True when the question asks who is biggest, not what the total is. */
  ranking: boolean;
}

/**
 * One account, once.
 *
 * A company and its billing customer are two rows with the same name, and the
 * resolver returns both. Pairing them produced a "comparison" of an account
 * against itself, labelled on one side with a raw `cus_` id, while the second
 * account the question actually named was pushed out of the pair entirely.
 * CRM records win because they are the ones with a display name.
 */
export function distinctAccounts(entities: ResolvedEntity[]): ResolvedEntity[] {
  const rank: Record<string, number> = { company: 0, contact: 1, customer: 2 };
  const best = new Map<string, ResolvedEntity>();
  for (const entity of entities) {
    const key = normalise(entity.entity.label);
    const held = best.get(key);
    if (!held) { best.set(key, entity); continue; }
    const better = (rank[entity.entity.type] ?? 3) < (rank[held.entity.type] ?? 3);
    if (better) best.set(key, entity);
  }
  return entities.filter((entity) => best.get(normalise(entity.entity.label)) === entity);
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

/* ------------------------------- write plans ------------------------------ */

/**
 * Turning an instruction into a write.
 *
 * The rule that matters: the *instruction wrapper never reaches the record*.
 * "Add a note to Rheinwerk saying the pilot is delayed" writes "The pilot is
 * delayed" — not the sentence the user typed at the copilot. Everything below
 * exists to strip the wrapper and keep only the content, and to refuse when the
 * content is not there rather than pasting the prompt into a customer's
 * timeline.
 */
export interface WriteAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  /** What the confirmation card shows, in plain English. */
  preview: string[];
}

export interface WriteBlocked {
  /** The write the phrasing asked for, which could not be prepared. */
  wanted: string;
  reason: string;
}

const TRAILING_TIME =
  /\s*(?:,\s*)?\b(?:next|this|by|on|before|due|in)\s+(?:the\s+)?(?:\d{1,3}\s+)?(?:day|days|week|weeks|month|months|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|morning|afternoon|eod|eow)\b.*$/i;

const CLOSERS = /\s*(?:please|thanks|thank you|asap|for me)\s*$/i;

/** Strip the command wrapper and the scheduling tail from an instruction. */
function contentOf(instruction: string, lead: RegExp): string | null {
  const match = instruction.match(lead);
  if (!match) return null;
  const rest = instruction.slice((match.index ?? 0) + match[0].length);
  const cleaned = rest.replace(TRAILING_TIME, '').replace(CLOSERS, '').replace(/[\s.]+$/, '').trim();
  return cleaned.length >= 3 ? cleaned : null;
}

/** The note body: quoted text wins, then the clause after "saying"/"that". */
export function noteBodyFrom(instruction: string): string | null {
  const quoted = instruction.match(/["“”']([^"“”']{6,2000})["“”']/);
  if (quoted) return quoted[1].trim();
  for (const lead of [
    /\b(?:saying|stating|that\s+says|which\s+says|to\s+say)\s+(?:that\s+)?/i,
    /\bnote\s*:\s*/i,
    /\bnote\s+that\s+/i,
    /\brecord(?:ing)?\s+that\s+/i,
    /\blog(?:ging)?\s+that\s+/i,
  ]) {
    const body = contentOf(instruction, lead);
    if (body) return capitalise(body).replace(/([^.!?])$/, '$1.');
  }
  return null;
}

/** A short, human subject line derived from the body — never the raw prompt. */
export function subjectFrom(body: string, max = 64): string {
  const first = body.split(/(?<=[.!?])\s+/)[0] ?? body;
  const trimmed = first.replace(/^(?:the|a|an)\s+/i, '').replace(/[.!?]+$/, '');
  if (trimmed.length <= max) return capitalise(trimmed);
  const cut = trimmed.slice(0, max);
  return capitalise(cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : max).trim());
}

/** "Create a task to call the plant manager next Tuesday" → "Call the plant manager". */
export function taskSubjectFrom(instruction: string): string | null {
  for (const lead of [
    /\b(?:task|to-?do|reminder|follow[-\s]?up)\s+(?:to|for|about|that|:)\s*/i,
    /\b(?:remind\s+me\s+to)\s*/i,
    /\b(?:create|add|log|make|set\s+up|open)\s+(?:a|an|the)\s+\w+\s+to\s+/i,
  ]) {
    const body = contentOf(instruction, lead);
    if (body) return capitalise(body);
  }
  return null;
}

/** "Move the Rheinwerk deal to Negotiation" → the stage's machine value. */
export function stageFrom(instruction: string, options: { value: string; label: string }[]): { value: string; label: string } | null {
  const text = normalise(instruction);
  const target = text.match(/\b(?:to|into|at|as)\s+([a-z0-9 ]{3,40})$/)?.[1] ?? text;
  let best: { value: string; label: string } | null = null;
  for (const option of options) {
    const label = normalise(option.label);
    const value = normalise(option.value);
    if (!label && !value) continue;
    if (new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(target)
      || new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(target)) {
      // Prefer the longest label so "closed won" beats "won".
      if (!best || label.length > normalise(best.label).length) best = option;
    }
  }
  return best;
}

const WRITE_SHAPES: { wanted: string; re: RegExp }[] = [
  { wanted: 'add_note', re: /\b(?:add|write|log|leave|put|record)\s+(?:a|an|the)?\s*note\b|\bnote\s+(?:that|on|against)\b|\blog\s+(?:that|a\s+call|an\s+update)\b/i },
  { wanted: 'create_record', re: /\b(?:create|add|open|make|set\s+up|raise|file)\s+(?:a|an|the)?\s*(task|to-?do|reminder|ticket|deal|contact|company|case)\b/i },
  { wanted: 'update_record', re: /\b(?:move|update|change|set|advance|push|mark|reassign|assign|edit)\b/i },
  { wanted: 'schedule_followup', re: /\b(?:schedule|book|diarise|set\s+up)\s+(?:a\s+)?(?:follow[-\s]?up|check[-\s]?in|call\s+back)\b|\bfollow\s+up\s+(?:with|on|in)\b|\bremind\s+me\b/i },
];

/**
 * Choose the one write this instruction asks for and fill it from resolved
 * records. Returns the action, or what was wanted and why it could not be
 * prepared — never a read tool dressed up as a write.
 */
export function planWrite(input: PlanInput): WriteAction | WriteBlocked | null {
  const question = input.question;
  const wanted = WRITE_SHAPES.find((shape) => shape.re.test(question))?.wanted ?? null;
  if (!wanted) return null;

  const target = input.entities.find((e) => ['company', 'contact', 'deal', 'ticket', 'customer'].includes(e.entity.type));
  const person = input.entities.find((e) => e.entity.type === 'user');
  const assignee = person?.entity.id
    ?? (target?.entity.ownerId && target.entity.ownerId.startsWith('usr_') ? target.entity.ownerId : null)
    ?? (input.actorId && input.actorId.startsWith('usr_') ? input.actorId : null);
  const available = (name: string) =>
    input.tools.some((tool) => tool.name === name) && (!input.allowedTools || input.allowedTools.has(name));

  const noRecord = (verb: string): WriteBlocked => ({
    wanted,
    reason: `${verb} needs a record to write to, and nothing in the request resolved to one.`,
  });
  const noTool = (): WriteBlocked => ({
    wanted,
    reason: input.allowWrites
      ? `no "${wanted}" tool is registered in this workspace, or this run was scoped away from it.`
      : `this run is read-only. Send \`allow_writes: true\` and I will prepare it for your approval.`,
  });

  if (wanted === 'add_note') {
    if (!available('add_note')) return noTool();
    if (!target) return noRecord('Writing a note');
    const body = noteBodyFrom(question);
    if (!body) {
      return {
        wanted,
        reason: 'the note has no content — say what the note should read, e.g. add a note to an account saying "the pilot slipped to October".',
      };
    }
    const subject = subjectFrom(body);
    return {
      tool: 'add_note',
      args: { record_ids: [target.entity.id], subject, body },
      why: `Write the note onto ${target.entity.label}; the instruction wrapper is stripped so the timeline reads as a note, not as a prompt.`,
      preview: [`On ${target.entity.label}`, `Subject: ${subject}`, body],
    };
  }

  if (wanted === 'create_record') {
    const kind = question.match(/\b(?:create|add|open|make|set\s+up|raise|file)\s+(?:a|an|the)?\s*(task|to-?do|reminder|ticket|deal|contact|company|case)\b/i)?.[1]?.toLowerCase() ?? 'task';
    const objectType = /task|to-?do|reminder/.test(kind) ? 'task' : kind === 'case' ? 'ticket' : kind;
    if (objectType !== 'task') {
      return { wanted, reason: `creating a ${objectType} needs its required properties spelled out; ask me to draft it and I will show you the fields first.` };
    }
    if (!available('create_record')) return noTool();
    const subject = taskSubjectFrom(question) ?? (target ? `Follow up with ${target.entity.label}` : null);
    if (!subject) return { wanted, reason: 'the task has no subject — say what the task is, e.g. "create a task to call the plant manager".' };
    const due = resolveDueDate(question, input.workspace.now);
    const properties: Record<string, unknown> = {
      subject: truncate(subject, 120),
      occurred_at: input.workspace.now,
      status: 'not_started',
      task_type: /\bcall\b/i.test(subject) ? 'call' : /\bemail\b/i.test(subject) ? 'email' : 'follow_up',
      priority: /\b(urgent|asap|critical)\b/i.test(question) ? 'high' : 'medium',
      ...(due ? { due_at: due.at } : {}),
      ...(assignee ? { owner_id: assignee } : {}),
    };
    return {
      tool: 'create_record',
      args: { object_type: 'task', properties, ...(target ? { associate_to: [target.entity.id] } : {}) },
      why: `Create the task the request describes${target ? ` on ${target.entity.label}` : ''}${due ? `, due ${due.label}` : ''}.`,
      preview: [
        `Task: ${truncate(subject, 120)}`,
        target ? `On ${target.entity.label}` : 'Not linked to a record',
        due ? `Due ${due.label}` : 'No due date given',
      ],
    };
  }

  if (wanted === 'update_record') {
    if (!available('update_record')) return noTool();
    const deal = input.entities.find((e) => e.entity.type === 'deal');
    const stage = stageFrom(question, input.dealStages);
    if (!stage || !/\b(stage|move|advance|push|to\s+negotiation|to\s+proposal|closed)\b/i.test(question)) {
      return { wanted, reason: 'I could not tell which property to set — name the property and the value, e.g. "move <deal> to Negotiation".' };
    }
    if (!deal) return noRecord('Changing a deal stage');
    return {
      tool: 'update_record',
      args: { object_type: 'deal', id: deal.entity.id, properties: { deal_stage: stage.value } },
      why: `Set ${deal.entity.label} to the ${stage.label} stage; probability and forecast category restamp from the pipeline.`,
      preview: [`${deal.entity.label}`, `deal_stage → ${stage.label} (${stage.value})`],
    };
  }

  if (!available('schedule_followup')) return noTool();
  if (!target) return noRecord('Scheduling a follow-up');
  const due = resolveDueDate(question, input.workspace.now);
  const inDays = due?.days ?? null;
  if (!inDays) {
    return { wanted, reason: 'no due date was given — say when, e.g. "in 5 days", "next Tuesday" or "on 2026-09-14".' };
  }
  const purpose = taskSubjectFrom(question)
    ?? contentOf(question, /\b(?:follow\s+up|follow[-\s]?up|check\s+in)\s+(?:with\s+[^,]+?)?\s*(?:about|on|to|re)\s+/i)
    ?? `Follow up with ${target.entity.label}`;
  return {
    tool: 'schedule_followup',
    args: {
      record_id: target.entity.id,
      in_days: inDays,
      note: truncate(purpose, 200),
      ...(assignee ? { assignee_id: assignee } : {}),
    },
    why: `Schedule the follow-up on ${target.entity.label} for ${due!.label}${assignee ? `, assigned to its owner` : ''}.`,
    preview: [
      `On ${target.entity.label}`,
      `Due ${due!.label} (${inDays} ${inDays === 1 ? 'day' : 'days'} from now)`,
      truncate(purpose, 200),
    ],
  };
}

export const isWriteBlocked = (value: WriteAction | WriteBlocked | null): value is WriteBlocked =>
  !!value && 'reason' in value;

/** The canonical sequence for the classified task. */
function canonicalPlan(input: PlanInput): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const { subject, window, metric, groupBy, intent, entities } = input;
  const comparisonSubjects = distinctAccounts(
    entities.filter((e) => ['company', 'contact', 'customer'].includes(e.entity.type)),
  ).slice(0, 3);

  const metricStep = (subjectId: string | undefined, label: string, over: TimeWindow = window, compare = true) =>
    builtin('business_metric', {
      metric: metric?.metric.id ?? 'closed_won',
      start: over.start,
      end: over.end,
      window_label: over.label,
      ...(subjectId ? { subject_id: subjectId } : {}),
      group_by: groupBy,
      compare,
    }, label);

  // "Which accounts booked the most in 2025?" is a metric question wearing a
  // question word. Whatever the classifier called it, it is answered by the
  // grouped metric and ranked — never by a listing of the object type ordered
  // by recency, which is a confident answer to a question nobody asked.
  if (input.ranking && groupBy !== 'none' && intent !== 'act' && intent !== 'draft' && !subject) {
    const ranked = builtin('business_metric', {
      metric: metric?.metric.id ?? 'closed_won',
      start: window.start,
      end: window.end,
      window_label: window.label,
      group_by: groupBy,
      compare: window.grain !== 'range' || window.start > 0,
    }, `The question asks which ${groupBy === 'account' ? 'accounts are' : `${groupBy} is`} biggest, so ${metric?.metric.label ?? 'closed-won bookings'} is computed for ${window.label} and grouped by ${groupBy} to rank them.`);
    return [ranked];
  }

  // "Explain invoice in_…" is a question about one bill. Measuring the
  // workspace's quarter, listing its open deals and counting its tickets
  // answers a different question and buries the one that was asked, so a record
  // named by id is left to the tools that can actually read it.
  const ledgerRecord = entities.find((e) => e.rule === 'id' && ['invoice', 'subscription', 'product'].includes(e.entity.type));

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
      } else if (input.comparison) {
        // Two periods were named, so two periods are measured. The delta the
        // answer quotes is between exactly the windows the question asked for.
        const { a, b } = input.comparison;
        steps.push(metricStep(subject?.id, `Measure ${metric?.metric.label ?? 'bookings'} over ${a.label} — the first period in the question.`, a, false));
        steps.push(metricStep(subject?.id, `Measure ${metric?.metric.label ?? 'bookings'} over ${b.label} — the second period, computed separately so the delta is between the two named periods.`, b, false));
      } else {
        steps.push(metricStep(subject?.id, `Compute ${metric?.metric.label ?? 'bookings'} for ${window.label} and the period before it.`));
      }
      break;

    case 'explain': {
      if (ledgerRecord && !subject) break;
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
    }

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
        // "What are their open tickets?" names a type as well as an account.
        // The profile mentions the count; only the list answers the question.
        const scopedType = input.types.find((t) => t !== 'activity' && t !== 'customer' && t !== 'company');
        if (scopedType) {
          const conditions = inferConditions(input.question, scopedType, input.stages);
          steps.push(builtin('record_search', {
            object_type: scopedType,
            ...(conditions.length ? { conditions } : {}),
            associated_to: subject.id,
            ...(scopedType === 'deal' ? { order_by: 'amount' } : {}),
            limit: 10,
          }, `The question asks for ${scopedType} records on ${subject.label}${conditions.length ? `, qualified by ${conditions.map((c) => c.property).join(' and ')}` : ''}.`, 0.9));
        }
      } else if (input.namedSomething && !input.types.length) {
        // With an object type in the question, a typed list beats a fuzzy
        // workspace search — "which deals are slipping" is about deals, not
        // about a note whose title happens to contain the word "slipping".
        steps.push(builtin('workspace_search', { query: input.question, limit: 8 }, 'The question names something that did not resolve to one record — search the workspace first.'));
      }
      if (!subject && input.types.length) {
        const objectType = input.types[0] === 'activity' ? 'meeting' : input.types[0];
        const conditions = inferConditions(input.question, objectType, input.stages);
        // "which deals are slipping this quarter" is about the deals due to
        // close in that quarter, not about every open deal on the book.
        const dated = objectType === 'deal' && input.windows.length > 0;
        steps.push(builtin('record_search', {
          object_type: objectType,
          ...(conditions.length ? { conditions } : {}),
          ...(objectType === 'deal' ? { order_by: 'amount' } : {}),
          ...(dated ? { date_property: 'close_date', start: window.start, end: window.end } : {}),
          limit: 10,
        }, [
          conditions.length
            ? `The question asks for ${objectType} records qualified by ${conditions.map((c) => c.property).join(' and ')}.`
            : `The question names ${objectType} records; list the most recent ones.`,
          dated ? `Scoped to deals closing in ${window.label}, the period the question named.` : '',
        ].filter(Boolean).join(' '), 0.7));
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

    case 'act': {
      const write = planWrite(input);
      if (write && !isWriteBlocked(write)) {
        steps.push({ tool: write.tool, args: write.args, why: write.why, builtin: null, relevance: 1 });
      } else if (subject) {
        // Nothing writable was resolved. Load the record so the answer can say
        // what it knows — and say plainly that it changed nothing.
        steps.push(builtin('account_profile', { id: subject.id }, `No write could be prepared, so this reads ${subject.label} rather than pretending to change it.`));
      }
      break;
    }
  }

  // "How are we doing?" names nothing at all. Answer it with the state of the
  // business rather than with an apology.
  //
  // An `act` request is the exception: when nothing writable could be prepared
  // the honest answer is that nothing changed, and reading the quarter's
  // bookings to fill the silence would spend the budget and hang citations for
  // records the answer never mentions off a sentence about a failed write.
  if (!steps.length && intent !== 'act' && !ledgerRecord) {
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
  ticket: ['ticket', 'case', 'escalation', 'helpdesk'],
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

  let onTopic = !input.types.length;
  for (const type of input.types) {
    for (const hint of TYPE_HINTS[type] ?? []) if (haystack.includes(hint)) { score += 0.12; onTopic = true; break; }
  }
  // "What are their open tickets?" is not a question about invoices, however
  // many of its words a billing tool happens to share. A tool that speaks about
  // none of the object types the question named starts from further back.
  if (!onTopic) score *= 0.6;
  // A write is never chosen because it *sounds* relevant. Writes come only from
  // `planWrite`, which has to extract real arguments before it will propose one.
  if (!tool.readOnly) return 0;
  return Math.max(0, Math.min(1, score));
}

interface FillContext {
  question: string;
  window: TimeWindow;
  /** The workspace clock — "overdue" means before now, not before the window. */
  now: number;
  entities: ResolvedEntity[];
  subject: MetricSubject | null;
  metric: MetricDetection | null;
  groupBy: GroupBy;
  types: string[];
  /** Read tools may fall back to the raw question; writes may never. */
  readOnly: boolean;
  /** Ids the first pass returned — how a second pass reaches a typed argument. */
  harvestedIds?: string[];
}

const ID_FIELD = /(^|_)(id|ids|record_id|customer_id|company_id|account_id|contact_id|deal_id|subject_id|entity_id)$/;
/** Fields whose value genuinely is the sentence the person typed. */
const QUERY_FIELD = /^(q|query|search|text|term|question|prompt|message|body|content|input|instruction)$/;
const LIMIT_FIELD = /^(limit|max|count|top|size|per_page)$/;
const START_FIELD = /^(start|from|since|start_at|start_date|after|period_start)$/;
const END_FIELD = /^(end|to|until|end_at|end_date|before|period_end)$/;
const TYPE_FIELD = /^(object_type|type|entity_type|record_type|resource)$/;
/** A parameter that names an account rather than describing one. */
const ACCOUNT_FIELD = /^(customer|customer_ref|account|client|subscriber)$/;
const DUE_FIELD = /^(due_before|overdue_before|due_by|before_date)$/;
const OVERDUE = /\b(overdue|past\s+due|late|owed|owing|outstanding|unpaid|arrears|not\s+paid)\b/i;

/**
 * An id of a stated kind, written in the question.
 *
 * `v.id('in')` publishes its prefix in the schema, so "Explain invoice
 * in_74A4fHpece5SDbwX" can hand `billing_explain_invoice` the id it contains
 * instead of the sentence that contains it — which is what the tool rejected.
 */
export const idPrefixOf = (node: SchemaNode): string | null =>
  node.format && node.format.startsWith('id:') ? node.format.slice(3) : null;

export function idOfKind(text: string, prefix: string): string | null {
  const match = text.match(new RegExp(`\\b${prefix}_[A-Za-z0-9][A-Za-z0-9_]{1,40}\\b`));
  return match ? match[0] : null;
}

/**
 * Words that select an enum member without spelling it. "Which invoices are
 * overdue" has to reach `status: open_like`, or the answer lists the whole book
 * and calls it the overdue ones.
 */
const ENUM_SYNONYMS: [string, RegExp][] = [
  ['past_due', /\b(past\s+due|overdue|dunning|failed\s+payment)\b/i],
  ['uncollectible', /\b(uncollectible|written\s+off|write[-\s]off)\b/i],
  ['open_like', /\b(open|overdue|past\s+due|outstanding|unpaid|owed|owing|due|not\s+paid)\b/i],
  ['active_like', /\b(active|live|running|current|still\s+on)\b/i],
  ['trialing', /\b(trial|trialing|trialling|in\s+trial)\b/i],
  ['canceled', /\b(cancell?ed|churned|ended)\b/i],
  ['paused', /\bpaused?\b/i],
  ['draft', /\bdrafts?\b/i],
  ['void', /\bvoid(ed)?\b/i],
  ['paid', /\b(paid|settled|collected)\b/i],
  ['all', /\b(all|every|any|whole\s+book)\b/i],
];

function enumFromQuestion(options: readonly string[], question: string): string | undefined {
  const text = normalise(question);
  // A member named outright wins over one inferred from a synonym.
  const named = options.find((option) => option.length > 3 && text.includes(normalise(option)));
  if (named) return named;
  for (const [option, pattern] of ENUM_SYNONYMS) {
    if (options.includes(option) && pattern.test(question)) return option;
  }
  return undefined;
}

function fillField(name: string, node: SchemaNode, context: FillContext): unknown {
  if (node.default !== undefined) return node.default;

  // A typed id is filled from an id of that type, or not at all. Handing a
  // `sub_`-shaped parameter a company id, or the sentence, is a call that can
  // only fail — and it failed invisibly, two lines under a confident answer.
  const prefix = idPrefixOf(node);
  if (prefix) {
    return idOfKind(context.question, prefix)
      ?? context.entities.find((e) => e.entity.id.startsWith(`${prefix}_`))?.entity.id
      ?? context.harvestedIds?.find((id) => id.startsWith(`${prefix}_`));
  }
  if (ACCOUNT_FIELD.test(name)) {
    return idOfKind(context.question, 'cus')
      ?? context.entities.find((e) => e.entity.type === 'customer')?.entity.id
      ?? context.harvestedIds?.find((id) => id.startsWith('cus_'));
  }
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
  if (DUE_FIELD.test(name)) return OVERDUE.test(context.question) ? context.now : undefined;
  if (START_FIELD.test(name)) return context.window.start;
  if (END_FIELD.test(name)) return context.window.end;
  if (name === 'metric' && context.metric) return context.metric.metric.id;
  if (name === 'group_by' || name === 'groupby') return context.groupBy === 'none' ? undefined : context.groupBy;
  if (/^(days|days_back|lookback|window_days)$/.test(name)) return Math.max(1, Math.round((context.window.end - context.window.start) / 86_400_000));

  if (node.enum?.length) return enumFromQuestion(node.enum, context.question);
  if (node.type === 'boolean') return undefined;
  if (node.type === 'integer' || node.type === 'number') {
    const match = context.question.match(/\b(\d{1,6})\b/);
    return match ? Number(match[1]) : undefined;
  }
  // Anything else required and free-text — a feature key, a price lookup key, a
  // meter — has no value that can be read out of the sentence. The step is
  // dropped rather than run with the prompt in the parameter: a tool call that
  // can only fail is worse than one that never happened, because it fails
  // quietly under an answer that looks finished.
  return undefined;
}

export interface FilledArguments {
  args: Record<string, unknown>;
  missing: string[];
}

/** Fill a tool's arguments from the resolved context; report what is missing. */
export function fillArguments(tool: AiToolDef, context: FillContext): FilledArguments {
  const schema = tool.input.describe();
  context = { ...context, readOnly: tool.readOnly };
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

/** A tool the question wanted and the question could not arm. */
export interface SkippedTool {
  tool: string;
  /** Parameters nothing in the question or the resolved records could fill. */
  missing: string[];
  relevance: number;
}

export interface PlanResult {
  steps: PlannedStep[];
  skipped: SkippedTool[];
}

/**
 * Build the ordered plan: the canonical steps for the intent, then any
 * registered tool that scores well enough and whose arguments can be filled.
 * A tool that matches but cannot be armed is reported rather than run with the
 * question in its parameters — a call that can only fail is worse than one that
 * never happened, because it fails quietly underneath a finished-looking answer.
 */
export function planTools(input: PlanInput): PlanResult {
  // A caller that scopes a run to two tools gets exactly those two. The
  // allowlist is applied to the canonical plan as well as to the generic
  // matcher, because the built-in capabilities are registered tools like any
  // other and an integrator scoping an agent means the whole run.
  const allowed = (name: string) => !input.allowedTools || input.allowedTools.has(name);
  const steps = canonicalPlan(input).filter((step) => allowed(step.tool));
  const planned = new Set(steps.map((s) => s.tool));
  const context: FillContext = {
    question: input.question,
    window: input.window,
    now: input.workspace.now,
    entities: input.entities,
    subject: input.subject,
    metric: input.metric,
    groupBy: input.groupBy,
    types: input.types,
    readOnly: true,
  };

  const offIntent = (name: string) =>
    (name === 'compose_message' && input.intent !== 'draft') ||
    (name === 'schedule_followup' && input.intent !== 'act');

  // Two tools that read the same rows are one tool. A registered search that
  // duplicates a capability already in the plan buys nothing and costs a step.
  const OVERLAPS: Record<string, string[]> = {
    search_records: ['record_search', 'workspace_search', 'record_aggregate'],
    get_record: ['account_profile', 'record_timeline'],
  };
  const duplicates = (name: string) => (OVERLAPS[name] ?? []).some((covered) => planned.has(covered));

  const candidates = input.tools
    .filter((tool) => tool.readOnly && allowed(tool.name) && !planned.has(tool.name)
      && !BUILTIN_TOOLS.includes(tool.name as BuiltinTool) && !offIntent(tool.name) && !duplicates(tool.name))
    .map((tool) => ({ tool, relevance: scoreTool(tool, input) }))
    .filter((c) => c.relevance >= 0.42)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 4);

  const skipped: SkippedTool[] = [];
  for (const candidate of candidates) {
    if (steps.length >= input.maxSteps) break;
    // Once the canonical plan has real coverage, only a strong match earns a slot.
    if (steps.length >= 2 && candidate.relevance < 0.55) break;
    const { args, missing } = fillArguments(candidate.tool, context);
    if (missing.length) {
      skipped.push({ tool: candidate.tool.name, missing, relevance: candidate.relevance });
      continue;
    }
    steps.push({
      tool: candidate.tool.name,
      args,
      why: `"${candidate.tool.name}" matches the question (relevance ${candidate.relevance.toFixed(2)}): ${candidate.tool.description.split('.')[0]}.`,
      builtin: null,
      relevance: candidate.relevance,
    });
    planned.add(candidate.tool.name);
  }

  return { steps: steps.slice(0, input.maxSteps), skipped };
}

export const planSteps = (input: PlanInput): PlannedStep[] => planTools(input).steps;

/** Every id a first pass returned, so a second pass can arm a typed parameter. */
export function harvestIds(results: unknown[]): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (found.size >= 40 || depth > 4) return;
    if (typeof value === 'string') {
      if (/^[a-z][a-z_]{1,14}_[A-Za-z0-9][A-Za-z0-9_]{1,40}$/.test(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 20)) walk(item, depth + 1); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
  };
  for (const result of results) walk(result, 0);
  return [...found];
}

/**
 * The second pass. After the first wave of results the engine knows more —
 * a search that pinned down one record, an aggregate with an obvious follow-up
 * — so it may plan one more round inside the remaining budget.
 */
export function replan(
  input: PlanInput,
  executed: { tool: string; result: unknown }[],
  remaining: number,
  skipped: SkippedTool[] = [],
): PlannedStep[] {
  if (remaining <= 0) return [];
  const done = new Set(executed.map((e) => e.tool));
  const steps: PlannedStep[] = [];

  // A tool the first pass could not arm gets one more chance against what the
  // first pass returned: "the upcoming invoice for Sakamoto Seiki" names no
  // `sub_` id, but the step that listed their subscriptions did.
  const harvested = harvestIds(executed.map((e) => e.result));
  if (harvested.length) {
    const context: FillContext = {
      question: input.question,
      window: input.window,
      now: input.workspace.now,
      entities: input.entities,
      subject: input.subject,
      metric: input.metric,
      groupBy: input.groupBy,
      types: input.types,
      readOnly: true,
      harvestedIds: harvested,
    };
    for (const candidate of skipped) {
      if (steps.length >= remaining || done.has(candidate.tool)) continue;
      if (input.allowedTools && !input.allowedTools.has(candidate.tool)) continue;
      const tool = input.tools.find((t) => t.name === candidate.tool);
      if (!tool || !tool.readOnly) continue;
      const { args, missing } = fillArguments(tool, context);
      if (missing.length) continue;
      steps.push({
        tool: tool.name,
        args,
        why: `The first pass returned the ${candidate.missing.join(' and ')} "${tool.name}" needed, so it can run now.`,
        builtin: null,
        relevance: candidate.relevance,
      });
      done.add(tool.name);
    }
  }

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

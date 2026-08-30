/**
 * The tools every AI surface in the platform can call.
 *
 * These wrap the engine's own capabilities so that agents, workflows and the
 * hosted provider reach the same code the built-in engine uses. Read-only tools
 * run freely; the one write tool here is gated behind an approval, which is the
 * behaviour every tool that changes a customer's world should have.
 */
import type { AiToolDef } from '../../kernel/ai';
import type { Ctx } from '../../kernel/context';
import v from '../../../shared/validate';
import { DAY } from '../../../shared/time';
import {
  accountProfile, businessMetric, recordAggregate, recordSearch, recordTimeline, workspaceSearch,
} from '../../ai/functions';
import { metricById, metricIds } from '../../ai/metrics';
import { composeDraft, DRAFT_KINDS, TONES, detectDraftKind, detectTone, type DraftKind, type Tone } from '../../ai/draft';
import { workspaceProfile } from '../../ai/grounding';
import type { Condition } from '../../ai/query';

const conditionInput = v.array(v.object({
  property: v.string({ min: 1, max: 60, description: 'Machine name of the property, e.g. deal_stage.' }),
  op: v.enum(['eq', 'neq', 'in', 'not_in', 'gte', 'gt', 'lte', 'lt', 'is_set', 'is_not_set', 'contains'] as const),
  value: v.optional(v.any()),
  values: v.optional(v.array(v.any(), { max: 40 })),
}), { max: 10 });

const GROUP_BY = ['time', 'owner', 'stage', 'industry', 'account', 'status', 'priority', 'source', 'none'] as const;

export function aiTools(ctx: Ctx): AiToolDef[] {
  return [
    {
      name: 'workspace_search',
      description:
        'Find the records a phrase is about across every object in the workspace — companies, contacts, deals, tickets, products, billing customers and teammates. ' +
        'Matches ids, email addresses, domains, exact names, prefixes, acronyms and misspellings, and returns each hit with the reason it matched. Use this first when a question names something you cannot resolve exactly.',
      readOnly: true,
      tags: ['ai', 'search'],
      input: v.object({
        query: v.string({ min: 1, max: 300, description: 'The name, email, domain, id or phrase to resolve.' }),
        types: v.optional(v.array(v.string({ max: 40 }), { max: 8 })),
        limit: v.optional(v.int({ min: 1, max: 25 })),
      }),
      run: (args: { query: string; types?: string[]; limit?: number }, _c, meta) => workspaceSearch(ctx, meta.orgId, args),
    },
    {
      name: 'account_profile',
      description:
        'The full picture of one account: firmographics, owner, buying committee, open and won deals with amounts and close dates, open tickets, lifetime value and how long since anyone touched it. ' +
        'Pass a company id, or a contact id to get the company behind it.',
      readOnly: true,
      tags: ['ai', 'crm'],
      input: v.object({ id: v.string({ min: 3, max: 80, description: 'Company or contact record id.' }) }),
      run: (args: { id: string }, _c, meta) => accountProfile(ctx, meta.orgId, args),
    },
    {
      name: 'business_metric',
      description:
        `Compute one of the platform's defined business metrics over a period, optionally for a single account, with an optional breakdown. ` +
        `Metrics: ${metricIds().join(', ')}. Money comes from the invoice ledger when one is installed and from closed-won deals otherwise, and the result always states which. ` +
        'The previous period is computed alongside so the answer can quote the change.',
      readOnly: true,
      tags: ['ai', 'analytics'],
      input: v.object({
        metric: v.string({ min: 2, max: 40, description: `One of: ${metricIds().join(', ')}.` }),
        start: v.optional(v.timestamp()),
        end: v.optional(v.timestamp()),
        window_label: v.optional(v.string({ max: 60 })),
        subject_id: v.optional(v.string({ max: 80, description: 'Company, contact or billing customer id to scope the metric to.' })),
        group_by: v.optional(v.enum(GROUP_BY)),
        compare: v.optional(v.boolean()),
      }),
      run: (args: Parameters<typeof businessMetric>[2], _c, meta) => businessMetric(ctx, meta.orgId, args),
    },
    {
      name: 'record_search',
      description:
        'List records of one object type with structured conditions — open deals over $100k, tickets escalated this week, companies in a region. ' +
        'Conditions use property machine names and the operators eq, neq, in, not_in, gt, gte, lt, lte, contains, is_set and is_not_set.',
      readOnly: true,
      tags: ['ai', 'crm'],
      input: v.object({
        object_type: v.string({ min: 2, max: 40, description: 'company, contact, deal, ticket, note, call, meeting, email or task.' }),
        conditions: v.optional(conditionInput),
        associated_to: v.optional(v.string({ max: 80, description: 'Only records linked to this record id.' })),
        owner_id: v.optional(v.string({ max: 80, description: 'Only records owned by this teammate.' })),
        date_property: v.optional(v.string({ max: 60 })),
        start: v.optional(v.timestamp()),
        end: v.optional(v.timestamp()),
        order_by: v.optional(v.string({ max: 60, description: 'Numeric or date property to sort by, highest first.' })),
        limit: v.optional(v.int({ min: 1, max: 50 })),
      }),
      run: (args: { object_type: string; conditions?: Condition[]; associated_to?: string; owner_id?: string; date_property?: string; start?: number; end?: number; order_by?: string; limit?: number }, _c, meta) =>
        recordSearch(ctx, meta.orgId, args),
    },
    {
      name: 'record_aggregate',
      description:
        'Count, sum or average any property of any object type, with an optional grouping and date window. Use this for questions the metric catalogue does not already name — "average CSAT by category", "sum of licensed assets by industry".',
      readOnly: true,
      tags: ['ai', 'analytics'],
      input: v.object({
        object_type: v.string({ min: 2, max: 40 }),
        measure: v.optional(v.enum(['count', 'sum', 'avg', 'min', 'max'] as const)),
        property: v.optional(v.string({ max: 60 })),
        conditions: v.optional(conditionInput),
        group_by: v.optional(v.string({ max: 60 })),
        date_property: v.optional(v.string({ max: 60 })),
        start: v.optional(v.timestamp()),
        end: v.optional(v.timestamp()),
        associated_to: v.optional(v.string({ max: 80 })),
      }),
      run: (args: Parameters<typeof recordAggregate>[2], _c, meta) => recordAggregate(ctx, meta.orgId, args),
    },
    {
      name: 'record_timeline',
      description:
        'The recent history of one record: calls, meetings, emails, notes, tasks and property changes, newest first, each with who did it and when. Use it before writing anything that claims to know what happened.',
      readOnly: true,
      tags: ['ai', 'crm'],
      input: v.object({
        record_id: v.string({ min: 3, max: 80 }),
        limit: v.optional(v.int({ min: 1, max: 50 })),
      }),
      run: (args: { record_id: string; limit?: number }, _c, meta) => recordTimeline(ctx, meta.orgId, args),
    },
    {
      name: 'compose_message',
      description:
        'Write an email, call summary, meeting notes, dunning notice, renewal note or deal summary personalised from the account\'s real records, in a chosen tone. ' +
        'Returns a subject and body plus the list of facts it used; it never sends anything.',
      readOnly: true,
      tags: ['ai', 'content'],
      input: v.object({
        instruction: v.string({ min: 3, max: 2000, description: 'What to write, in your own words.' }),
        record_id: v.optional(v.string({ max: 80, description: 'Company or contact the message is about.' })),
        contact_id: v.optional(v.string({ max: 80 })),
        kind: v.optional(v.enum(DRAFT_KINDS)),
        tone: v.optional(v.enum(TONES)),
      }),
      run: (args: { instruction: string; record_id?: string; contact_id?: string; kind?: DraftKind; tone?: Tone }, _c, meta) => {
        const workspace = workspaceProfile(ctx, meta.orgId);
        const profile = args.record_id ? accountProfile(ctx, meta.orgId, { id: args.record_id }) : null;
        const account = profile && !('error' in profile) ? profile : null;
        const timeline = account ? recordTimeline(ctx, meta.orgId, { record_id: account.id, limit: 8 }).items : [];
        const sender = workspace.people.find((p) => p.id === meta.actorId) ?? workspace.people[0] ?? null;
        return composeDraft({
          workspace,
          kind: args.kind ?? detectDraftKind(args.instruction),
          tone: args.tone ?? detectTone(args.instruction),
          instruction: args.instruction,
          account,
          contactId: args.contact_id ?? null,
          timeline,
          sender: sender ? { name: sender.name, title: sender.title, email: sender.email } : null,
        });
      },
    },
    {
      name: 'schedule_followup',
      description:
        'Schedule a follow-up on a record. At the chosen time the platform writes a note onto the record\'s timeline and raises an ai.followup.due event that workflows and notifications can pick up. ' +
        'This changes the workspace, so it needs a person to approve it.',
      readOnly: false,
      requiresApproval: true,
      tags: ['ai', 'crm'],
      input: v.object({
        record_id: v.string({ min: 3, max: 80, description: 'The record the follow-up is about.' }),
        in_days: v.int({ min: 1, max: 365, description: 'How many days from now the follow-up is due.' }),
        note: v.string({ min: 3, max: 1000, description: 'What the follow-up is for, in words a colleague would understand.' }),
        // A user id, not "whichever id was handy": a company id in an assignee
        // field is the kind of thing an approval card must never be able to show.
        assignee_id: v.optional(v.id('usr')),
      }),
      run: (args: { record_id: string; in_days: number; note: string; assignee_id?: string }, _c, meta) => {
        const runAt = ctx.now() + args.in_days * DAY;
        const idemKey = `ai.followup:${args.record_id}:${runAt}`;
        ctx.enqueue(meta.orgId, 'ai.followup', {
          recordId: args.record_id, note: args.note, assigneeId: args.assignee_id ?? meta.actorId ?? null, runId: meta.runId ?? null,
        }, { runAt, idemKey });
        ctx.emit(meta.orgId, 'ai.followup.scheduled', {
          record_id: args.record_id, due: runAt, note: args.note, run_id: meta.runId ?? null,
        }, { objectId: args.record_id, objectType: 'record', actorType: 'agent', actorId: meta.actorId ?? null });
        return { scheduled: true, record_id: args.record_id, due: runAt, note: args.note, idempotency_key: idemKey };
      },
    },
  ];
}

export const metricCatalogue = () => metricIds().map((id) => {
  const definition = metricById(id)!;
  return {
    id: definition.id,
    label: definition.label,
    unit: definition.unit,
    supports_account: definition.supportsSubject,
    snapshot: !!definition.snapshot,
    keywords: definition.keywords,
  };
});

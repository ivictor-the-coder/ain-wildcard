/**
 * Drafting.
 *
 * The difference between a useful draft and a useless one is whether it knows
 * anything. Every sentence below is assembled from a real record — the deal
 * that is actually open, the amount that is actually on it, the ticket that is
 * actually escalated, the day the last meeting actually happened — and any
 * sentence whose fact is missing is dropped rather than padded with filler.
 */
import { formatMoney } from '../../shared/money';
import { DAY, formatDate } from '../../shared/time';
import type { WorkspaceProfile } from './grounding';
import type { AccountProfileResult, TimelineItem } from './functions';
import { firstName, humanise, listPhrase, normalise, truncate } from './text';

export const DRAFT_KINDS = [
  'follow_up', 'intro', 'check_in', 'renewal', 'dunning', 'meeting_recap',
  'call_summary', 'meeting_notes', 'deal_summary', 'handover', 'escalation_update', 'win_back',
] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const TONES = ['direct', 'warm', 'formal', 'concise', 'consultative', 'urgent', 'apologetic'] as const;
export type Tone = (typeof TONES)[number];

export interface DraftSender {
  name: string;
  title: string | null;
  email: string | null;
}

/** One unpaid bill, in the words the recipient's own copy uses. */
export interface OutstandingInvoice {
  number: string;
  amount_due_formatted: string;
  due_at: number | null;
  days_overdue: number | null;
  status: string;
}

export interface DraftInput {
  workspace: WorkspaceProfile;
  kind: DraftKind;
  tone: Tone;
  instruction: string;
  account: AccountProfileResult | null;
  contactId?: string | null;
  timeline: TimelineItem[];
  sender: DraftSender | null;
  /**
   * The bills a dunning note is about.
   *
   * "Our records show an invoice on your account is still outstanding" names no
   * invoice, no amount and no date, so the recipient cannot act on it and the
   * sender has to look the numbers up and retype them. A chase with no number
   * in it is not a chase.
   */
  outstanding?: OutstandingInvoice[];
}

export interface DraftResult {
  channel: 'email' | 'note' | 'summary';
  kind: DraftKind;
  tone: Tone;
  subject: string;
  body: string;
  /** The specific facts used, so a reviewer can check them. */
  personalisation: string[];
  recipient: { id: string; name: string; email: string | null } | null;
}

const KIND_PATTERNS: [RegExp, DraftKind][] = [
  [/\b(dunning|past\s+due|overdue|payment\s+(?:failed|reminder)|unpaid|chase\s+.*invoice)\b/i, 'dunning'],
  [/\b(renewal|renew|contract\s+end|auto[-\s]?renew)\b/i, 'renewal'],
  [/\b(call\s+summary|summar(?:y|ise|ize)\s+the\s+call|recap\s+of\s+the\s+call)\b/i, 'call_summary'],
  [/\b(meeting\s+notes|notes\s+from\s+the\s+meeting)\b/i, 'meeting_notes'],
  [/\b(meeting\s+recap|recap\s+email|follow[-\s]?up\s+(?:to|after)\s+the\s+(?:meeting|call|qbr))\b/i, 'meeting_recap'],
  [/\b(deal\s+summary|deal\s+review|summar(?:y|ise|ize)\s+the\s+deal|handover)\b/i, 'deal_summary'],
  [/\b(intro(?:duction)?|first\s+touch|cold\s+(?:email|outreach)|prospecting)\b/i, 'intro'],
  [/\b(check[-\s]?in|touch\s+base|how\s+are\s+things)\b/i, 'check_in'],
  [/\b(escalat|incident\s+update|status\s+update\s+on\s+the\s+ticket)\b/i, 'escalation_update'],
  [/\b(win\s+back|winback|re[-\s]?engage|closed[-\s]?lost\s+follow)\b/i, 'win_back'],
  [/\b(hand\s?over|transition\s+the\s+account)\b/i, 'handover'],
];

export function detectDraftKind(text: string): DraftKind {
  for (const [pattern, kind] of KIND_PATTERNS) if (pattern.test(text)) return kind;
  return 'follow_up';
}

const TONE_PATTERNS: [RegExp, Tone][] = [
  [/\b(formal|professional|corporate|buttoned[-\s]?up)\b/i, 'formal'],
  [/\b(warm|friendly|personable|human)\b/i, 'warm'],
  [/\b(short|brief|concise|punchy|two\s+lines|tl;?dr)\b/i, 'concise'],
  [/\b(urgent|asap|escalate|firm|serious)\b/i, 'urgent'],
  [/\b(apolog(?:y|etic|ise|ize)|sorry|make\s+it\s+right)\b/i, 'apologetic'],
  [/\b(consultative|advisory|value[-\s]?led|insight)\b/i, 'consultative'],
  [/\b(direct|straight|no\s+fluff|blunt)\b/i, 'direct'],
];

export function detectTone(text: string): Tone {
  for (const [pattern, tone] of TONE_PATTERNS) if (pattern.test(text)) return tone;
  return 'direct';
}

const greeting = (tone: Tone, name: string): string => {
  const resolved = firstName(name);
  const first = resolved || 'there';
  switch (tone) {
    case 'formal': return `Dear ${name || 'Sir or Madam'},`;
    // With a name, dropping the "Hi" is the register an urgent note wants. With
    // none, the same branch opened the message "there," — which is not a
    // greeting in any register.
    case 'concise': return resolved ? `${first} —` : `Hi ${first},`;
    case 'urgent': return resolved ? `${first},` : `Hi ${first},`;
    case 'warm': return `Hi ${first},`;
    default: return `Hi ${first},`;
  }
};

const signOff = (tone: Tone, sender: DraftSender | null, workspace: WorkspaceProfile): string => {
  const name = sender?.name ?? workspace.name;
  const line = sender?.title ? `${name}\n${sender.title}, ${workspace.name}` : name;
  switch (tone) {
    case 'formal': return `Kind regards,\n${line}`;
    case 'warm': return `Thanks so much,\n${line}`;
    case 'concise': return `— ${name}`;
    case 'urgent': return `Thanks,\n${line}`;
    case 'apologetic': return `With apologies and thanks,\n${line}`;
    default: return `Thanks,\n${line}`;
  }
};

const money = (workspace: WorkspaceProfile, amount: number) =>
  formatMoney({ amount, currency: workspace.currency }, { locale: workspace.locale, trimZeroFraction: true });

const day = (workspace: WorkspaceProfile, ts: number) =>
  formatDate(ts, { locale: workspace.locale, timeZone: workspace.timezone });

/**
 * A date-only property — `close_date`, `renewal_date`.
 *
 * Stored as midnight UTC of the day a person picked, so it is read back in that
 * same zone. Formatting it in the workspace's zone would put "your agreement
 * renews on" a day before the renewal the record shows.
 */
const calendarDay = (workspace: WorkspaceProfile, ts: number) =>
  formatDate(ts, { locale: workspace.locale, timeZone: 'UTC' });

interface Facts {
  account: AccountProfileResult | null;
  contact: { id: string; name: string; email: string | null; title: string | null; role: string | null } | null;
  lastTouch: TimelineItem | null;
  topDeal: AccountProfileResult['open_deals'][number] | null;
  ticket: AccountProfileResult['open_tickets'][number] | null;
  used: string[];
}

/**
 * A timeline entry this composer wrote earlier.
 *
 * Logging a draft puts it on the record as an email activity, so the *next*
 * draft read it back as the last thing that happened and opened with
 * "Following up on our Thornbury Logistics — multi-site rollout — following up
 * (30 seconds ago)" — the message quoting its own predecessor's subject line.
 * A draft nobody sent is not a touch on the customer, so the openers skip it and
 * fall through to the agreed next step, which reads correctly.
 *
 * These are exactly the subject shapes the switch below composes.
 */
const COMPOSED_TAIL = [
  ' — next step', ' — following up', ' — checking in', ' — call summary', ' — meeting notes',
  ' — handover', ' — deal summary', ' — account summary', ' — recap and next steps',
  ' — support update', ' — worth another look?', ' — quick introduction', ' — payment outstanding',
];

export function composedHere(title: string): boolean {
  const t = title.trim().toLowerCase();
  return COMPOSED_TAIL.some((tail) => t.endsWith(tail))
    || /\s—\srenewal(\son\s.+)?$/.test(t)
    || /\s—\stelemetry on your .+ lines$/.test(t)
    || t.startsWith('recap — ')
    || t.startsWith('update — ');
}

function gather(input: DraftInput): Facts {
  const account = input.account;
  const contacts = account?.contacts ?? [];
  const contact = (input.contactId ? contacts.find((c) => c.id === input.contactId) : null)
    ?? contacts.find((c) => c.role === 'Champion')
    ?? contacts.find((c) => c.role === 'Economic buyer')
    ?? contacts[0]
    ?? null;
  const topDeal = account?.open_deals?.[0] ?? null;
  const ticket = account?.open_tickets?.[0] ?? null;
  const lastTouch = input.timeline.find(
    (item) => item.kind !== 'property_change' && !composedHere(item.title),
  ) ?? null;
  const used: string[] = [];
  if (account) used.push(`${account.name} — ${account.headline || account.object_type}`);
  if (contact) used.push(`${contact.name}${contact.title ? `, ${contact.title}` : ''}`);
  if (topDeal) used.push(`${topDeal.name} (${topDeal.amount_formatted}, ${topDeal.stage})`);
  if (ticket) used.push(`open ticket: ${ticket.subject}`);
  if (lastTouch) used.push(`last touch: ${lastTouch.title} (${lastTouch.when})`);
  return { account, contact: contact ? { ...contact, id: contact.id } : null, lastTouch, topDeal, ticket, used };
}

/** Compose the message. Missing facts remove sentences; they never invent them. */
export function composeDraft(input: DraftInput): DraftResult {
  const { workspace, tone, kind } = input;
  const facts = gather(input);
  const account = facts.account;
  const name = account?.name ?? 'your team';
  const paragraphs: string[] = [];
  let subject = '';

  const openerFromTouch = facts.lastTouch
    ? `Following up on ${facts.lastTouch.title.toLowerCase().startsWith('the') ? '' : 'our '}${facts.lastTouch.title} (${facts.lastTouch.when})`
    : `Following up on where we left things`;

  switch (kind) {
    case 'follow_up': {
      subject = facts.topDeal ? `${facts.topDeal.name} — next step` : `${name} — following up`;
      paragraphs.push(`${openerFromTouch}.`);
      if (facts.topDeal) {
        paragraphs.push(
          `We have ${facts.topDeal.name} sitting at ${facts.topDeal.stage.toLowerCase()} for ${facts.topDeal.amount_formatted}` +
          `${facts.topDeal.close_date ? `, closing ${calendarDay(workspace, facts.topDeal.close_date)}` : ''}. ` +
          `${tone === 'consultative' ? 'Before we go further I want to be sure the business case holds up on your side.' : 'I want to make sure nothing is blocked on us.'}`,
        );
      }
      if (account?.properties.next_step) paragraphs.push(`Last agreed next step was: ${String(account.properties.next_step)}.`);
      paragraphs.push(tone === 'concise'
        ? 'Are we still on for that, or has the timing moved?'
        : 'Could you let me know whether that still lines up on your side, or whether the timing has moved?');
      break;
    }
    case 'intro': {
      subject = account ? `${name} — telemetry on your ${humanise(String(account.properties.industry ?? 'production'))} lines` : `${workspace.name} — quick introduction`;
      paragraphs.push(`I work with ${humanise(String(account?.properties.industry ?? 'manufacturing'))} teams on machine telemetry, and ${name} came up because of ${account?.properties.plant_count ? `your ${account.properties.plant_count} production sites` : 'the scale of your automation footprint'}.`);
      if (account?.properties.connected_assets) {
        paragraphs.push(`Teams your size typically have ${Number(account.properties.connected_assets).toLocaleString('en-US')}-odd assets worth instrumenting; the ones that do it well cut unplanned downtime by double digits inside two quarters.`);
      }
      paragraphs.push('Worth 20 minutes to see whether the same thing applies to you?');
      break;
    }
    case 'check_in': {
      subject = `${name} — checking in`;
      paragraphs.push(account?.last_activity.days_ago !== null && account?.last_activity.days_ago !== undefined
        ? `It has been ${account.last_activity.days_ago} days since we last spoke, so I wanted to check in.`
        : 'Wanted to check in and see how things are going.');
      if (account?.totals.open_tickets) {
        paragraphs.push(`I can see ${account.totals.open_tickets} open ${account.totals.open_tickets === 1 ? 'ticket' : 'tickets'} on your account${facts.ticket ? `, including "${facts.ticket.subject}"` : ''} — I will chase those internally regardless.`);
      }
      paragraphs.push('Anything you want us to pick up this month?');
      break;
    }
    case 'renewal': {
      const renewal = account?.properties.renewal_date ? Number(account.properties.renewal_date) : null;
      subject = `${name} — renewal${renewal ? ` on ${calendarDay(workspace, renewal)}` : ''}`;
      const daysOut = renewal ? Math.round((renewal - workspace.now) / DAY) : null;
      paragraphs.push(renewal && daysOut !== null
        ? daysOut > 0
          ? `Your agreement renews on ${calendarDay(workspace, renewal)}, which is ${daysOut} ${daysOut === 1 ? 'day' : 'days'} out.`
          : daysOut === 0
            ? `Your agreement renews today, ${calendarDay(workspace, renewal)}.`
            : `Your renewal date on file was ${calendarDay(workspace, renewal)}, ${Math.abs(daysOut)} days ago, so the paperwork is overdue on our side.`
        : 'Your agreement is coming up for renewal.');
      if (account?.properties.connected_assets) {
        paragraphs.push(`You are currently running ${Number(account.properties.connected_assets).toLocaleString('en-US')} connected assets with us${account.totals.lifetime_won !== 0 ? `, ${account.totals.lifetime_won_formatted} of committed business to date` : ''}.`);
      }
      paragraphs.push(tone === 'consultative'
        ? 'I would like to walk through utilisation before we paper anything, so the renewal reflects what you actually use.'
        : 'Happy to keep the terms as they are — shall I send the paperwork through?');
      break;
    }
    case 'dunning': {
      const bills = input.outstanding ?? [];
      subject = bills.length === 1
        ? `Invoice ${bills[0].number} for ${name} — ${bills[0].amount_due_formatted} outstanding`
        : `Invoice for ${name} — payment outstanding`;
      const overdue = bills.filter((b) => (b.days_overdue ?? 0) > 0);
      paragraphs.push(bills.length
        ? [
            tone === 'apologetic' ? 'Apologies for the chase —' : '',
            bills.length === 1
              ? `invoice ${bills[0].number} for ${bills[0].amount_due_formatted} is still outstanding${bills[0].due_at ? `, due ${calendarDay(workspace, bills[0].due_at)}` : ''}${(bills[0].days_overdue ?? 0) > 0 ? ` — ${bills[0].days_overdue} days ago` : ''}.`
              : `${bills.length} invoices on your account are still outstanding.`,
          ].filter(Boolean).join(' ').replace(/^—\s*/, '').replace(/^(\w)/, (m) => (tone === 'apologetic' ? m : m.toUpperCase()))
        : tone === 'apologetic'
          ? 'Apologies for the chase — our records show an invoice on your account is still outstanding.'
          : 'Our records show an invoice on your account is still outstanding.');
      if (bills.length > 1) {
        paragraphs.push(bills.slice(0, 6).map((b) =>
          `• ${b.number} — ${b.amount_due_formatted}${b.due_at ? `, due ${calendarDay(workspace, b.due_at)}` : ''}${(b.days_overdue ?? 0) > 0 ? ` (${b.days_overdue} days past due)` : ''}`).join('\n'));
      }
      const many = bills.length > 1;
      paragraphs.push(many
        ? 'If those have already gone out, please ignore this note. If any of them is stuck in approvals, tell me who to talk to and I will take it from there.'
        : 'If it has already gone out, please ignore this note. If it is stuck in approvals, tell me who to talk to and I will take it from there.');
      paragraphs.push(tone === 'urgent' || overdue.length
        ? 'Service continues as normal for now, but I would rather resolve this before it reaches the automated suspension step.'
        : `You can settle ${many ? 'them' : 'it'} from the billing portal, or reply here and I will send ${many ? 'fresh copies' : 'a fresh copy'}.`);
      break;
    }
    case 'meeting_recap': {
      subject = facts.lastTouch ? `Recap — ${facts.lastTouch.title}` : `${name} — recap and next steps`;
      paragraphs.push(facts.lastTouch
        ? `Thanks for the time ${facts.lastTouch.when}. Here is what I took away.`
        : 'Thanks for the time today. Here is what I took away.');
      const bullets = input.timeline.filter((i) => i.kind !== 'property_change' && !composedHere(i.title)).slice(0, 3)
        .map((i) => `• ${i.title}${i.body ? ` — ${truncate(i.body, 120)}` : ''}`);
      if (bullets.length) paragraphs.push(bullets.join('\n'));
      if (facts.topDeal) paragraphs.push(`On commercials: ${facts.topDeal.name} is at ${facts.topDeal.amount_formatted}${facts.topDeal.close_date ? `, targeting ${calendarDay(workspace, facts.topDeal.close_date)}` : ''}.`);
      paragraphs.push('Shout if I have any of that wrong — otherwise I will pick up the actions on our side.');
      break;
    }
    case 'call_summary':
    case 'meeting_notes': {
      subject = `${name} — ${kind === 'call_summary' ? 'call summary' : 'meeting notes'}`;
      const items = input.timeline.filter((i) => i.kind === (kind === 'call_summary' ? 'call' : 'meeting')).slice(0, 3);
      const source = items.length ? items : input.timeline.filter((i) => !composedHere(i.title)).slice(0, 3);
      paragraphs.push(source.length
        ? source.map((i) => `${day(workspace, i.at)} — ${i.title}${i.body ? `\n${truncate(i.body, 400)}` : ''}`).join('\n\n')
        : `No ${kind === 'call_summary' ? 'calls' : 'meetings'} are logged against ${name} yet, so there is nothing to summarise.`);
      if (facts.topDeal) paragraphs.push(`Open commercial context: ${facts.topDeal.name}, ${facts.topDeal.amount_formatted}, ${facts.topDeal.stage.toLowerCase()}.`);
      break;
    }
    case 'deal_summary':
    case 'handover': {
      const deal = facts.topDeal;
      subject = deal ? `${deal.name} — ${kind === 'handover' ? 'handover' : 'deal summary'}` : `${name} — account summary`;
      paragraphs.push(account
        ? `${account.name}: ${account.headline}. Owned by ${account.owner ?? 'nobody — this account is unassigned'}.`
        : `${name}: no CRM record resolved, so this summary is thin by design.`);
      if (deal) {
        paragraphs.push(`Live deal: ${deal.name} at ${deal.amount_formatted}, ${deal.stage.toLowerCase()}${deal.close_date ? `, close date ${calendarDay(workspace, deal.close_date)}` : ''}.`);
      }
      if (account?.contacts.length) {
        paragraphs.push(`Buying committee: ${listPhrase(account.contacts.slice(0, 4).map((c) => `${c.name}${c.role ? ` (${c.role.toLowerCase()})` : ''}`))}.`);
      }
      if (account?.totals.open_tickets) paragraphs.push(`Support: ${account.totals.open_tickets} open ${account.totals.open_tickets === 1 ? 'ticket' : 'tickets'}${facts.ticket ? `, oldest is "${facts.ticket.subject}"` : ''}.`);
      if (account?.last_activity.days_ago !== null && account?.last_activity.days_ago !== undefined) {
        paragraphs.push(`Last activity was ${account.last_activity.days_ago} days ago${account.last_activity.summary ? `: ${account.last_activity.summary}` : ''}.`);
      }
      break;
    }
    case 'escalation_update': {
      subject = facts.ticket ? `Update — ${facts.ticket.subject}` : `${name} — support update`;
      paragraphs.push(facts.ticket
        ? `An update on ${facts.ticket.subject}, raised ${day(workspace, facts.ticket.created)} and currently ${facts.ticket.status.toLowerCase()} at ${facts.ticket.priority.toLowerCase()} priority.`
        : `An update on the issue you raised.`);
      // "Here is where it stands and what happens next." followed by nothing is
      // a heading for a paragraph that was never written. The last thing that
      // actually happened on the record is where it stands.
      // The last thing that happened ON THIS TICKET — not the last thing that
      // happened on the account, which is a different subject and reads as this
      // one's status. Nothing else on the timeline is about this escalation.
      const latest = facts.ticket
        ? input.timeline.find((i) => i.kind !== 'property_change' && !composedHere(i.title)
            && normalise(i.title).includes(normalise(facts.ticket!.subject)))
        : undefined;
      if (tone === 'apologetic') paragraphs.push('I am sorry this has taken as long as it has.');
      if (latest) {
        paragraphs.push(`Where it stands: ${latest.title}${latest.body ? ` — ${truncate(latest.body.replace(/\s+/g, ' ').trim(), 220)}` : ''} (${latest.when}).`);
      } else if (facts.ticket) {
        paragraphs.push(`Where it stands: the ticket is ${facts.ticket.status.toLowerCase().replace(/_/g, ' ')} at ${facts.ticket.priority.toLowerCase()} priority and nothing has been logged against it since it was raised, which is itself the thing I am chasing internally.`);
      }
      paragraphs.push('I will update you again as soon as the next step lands, whether or not it is resolved by then.');
      break;
    }
    case 'win_back': {
      subject = `${name} — worth another look?`;
      paragraphs.push(account?.won_deals.length
        ? `We worked together before — ${account.won_deals[0].name}${account.won_deals[0].closed ? ` closed ${day(workspace, account.won_deals[0].closed)}` : ''}.`
        : 'We spoke a while ago and the timing was not right.');
      paragraphs.push('A lot has changed on our side since then, most of it in the areas you pushed back on.');
      paragraphs.push('Worth a short call to see whether it lands differently now?');
      break;
    }
  }

  const isNote = kind === 'call_summary' || kind === 'meeting_notes' || kind === 'deal_summary' || kind === 'handover';
  const body = isNote
    ? paragraphs.join('\n\n')
    : [greeting(tone, facts.contact?.name ?? ''), '', paragraphs.join('\n\n'), '', signOff(tone, input.sender, workspace)].join('\n');

  return {
    channel: isNote ? (kind === 'deal_summary' || kind === 'handover' ? 'summary' : 'note') : 'email',
    kind,
    tone,
    subject,
    body,
    personalisation: facts.used,
    recipient: facts.contact ? { id: facts.contact.id, name: facts.contact.name, email: facts.contact.email } : null,
  };
}

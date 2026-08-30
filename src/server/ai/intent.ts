/**
 * Intent classification for the built-in engine.
 *
 * A scored keyword-and-pattern model, not a black box: every signal that fires
 * is reported with its weight and the words that triggered it, and every signal
 * inside a negation scope is inverted. That is what makes the classifier
 * testable ("don't draft anything, just give me the number" must not be a
 * drafting task) and what lets the trace explain the answer to a sceptical
 * operator.
 */

export const TASK_INTENTS = [
  'lookup', 'aggregate', 'compare', 'explain', 'draft', 'summarise', 'plan', 'act', 'troubleshoot',
] as const;

export type TaskIntent = (typeof TASK_INTENTS)[number];

export const INTENT_LABEL: Record<TaskIntent, string> = {
  lookup: 'Look up a record',
  aggregate: 'Compute a number',
  compare: 'Compare two things',
  explain: 'Explain a change',
  draft: 'Draft something to send',
  summarise: 'Summarise activity',
  plan: 'Recommend next steps',
  act: 'Change something',
  troubleshoot: 'Diagnose a problem',
};

export interface IntentSignal {
  id: string;
  intent: TaskIntent;
  weight: number;
  matched: string;
  at: number;
  negated: boolean;
  /** Weight actually applied after position boost and negation. */
  applied: number;
}

export interface IntentResult {
  intent: TaskIntent;
  confidence: number;
  scores: Record<TaskIntent, number>;
  runnerUp: TaskIntent | null;
  margin: number;
  signals: IntentSignal[];
  negations: { cue: string; at: number; scope: string }[];
  /** Other intents strong enough to shape the answer (e.g. explain + aggregate). */
  secondary: TaskIntent[];
}

interface SignalDef {
  id: string;
  intent: TaskIntent;
  weight: number;
  re: RegExp;
}

const S = (id: string, intent: TaskIntent, weight: number, re: RegExp): SignalDef => ({ id, intent, weight, re });

/**
 * Ordered by intent, and deliberately verbose: an ambiguous business question
 * should fire several weak signals rather than one lucky strong one.
 */
const SIGNALS: SignalDef[] = [
  // ------------------------------------------------------------ lookup
  S('lookup.wh', 'lookup', 2.4, /\b(who|which|whose)\b/i),
  S('lookup.find', 'lookup', 2.8, /\b(find|look\s?up|pull\s?up|show\s+me|bring\s+up|open\s+(?:the|this|that)|fetch|get\s+me|search\s+for)\b/i),
  S('lookup.detail', 'lookup', 2.0, /\b(details?|profile|record|info(?:rmation)?|contact\s+details|phone\s+number|email\s+address|address)\b/i),
  S('lookup.state', 'lookup', 1.6, /\b(status\s+of|state\s+of|where\s+(?:is|are|do\s+we\s+stand)|what'?s\s+the\s+status)\b/i),
  S('lookup.membership', 'lookup', 1.4, /\b(is|are)\s+\w+\s+(a\s+)?(customer|prospect|partner|churned)\b/i),
  S('lookup.about', 'lookup', 2.6, /\b(tell\s+me\s+about|what\s+do\s+(?:you|we)\s+know\s+about|who\s+is|what\s+is\s+(?:the\s+)?(?:deal|story)\s+with|give\s+me\s+the\s+background)\b/i),
  S('lookup.list', 'lookup', 1.8, /\b(list|show)\s+(?:me\s+)?(?:all\s+|the\s+|every\s+)?(accounts?|companies|contacts?|deals?|tickets?|invoices?|customers?|subscriptions?)\b/i),

  // --------------------------------------------------------- aggregate
  S('agg.howmuch', 'aggregate', 3.4, /\bhow\s+much\b/i),
  S('agg.howmany', 'aggregate', 3.2, /\bhow\s+many\b/i),
  S('agg.total', 'aggregate', 3.0, /\b(total|sum|aggregate|combined|altogether|in\s+total)\b/i),
  S('agg.stat', 'aggregate', 2.6, /\b(average|avg|median|mean|count|number\s+of|share\s+of|rate|per\s+cent|percentage|%)\b/i),
  S('agg.money', 'aggregate', 2.4, /\b(revenue|spend|spent|billed|billings?|invoiced|paid|payments?|arr|mrr|acv|tcv|bookings?|churn|pipeline|forecast|net\s+new)\b/i),
  S('agg.group', 'aggregate', 2.0, /\b(by\s+(?:month|quarter|year|rep|owner|stage|industry|region|product|customer|account)|per\s+(?:month|quarter|rep|account)|broken\s+down|breakdown|split\s+by|grouped\s+by)\b/i),
  S('agg.top', 'aggregate', 2.2, /\b(top|biggest|largest|highest|lowest|smallest|worst|best)\s+\d*\s*(accounts?|customers?|deals?|reps?|products?|companies)?\b/i),

  // ----------------------------------------------------------- compare
  S('cmp.versus', 'compare', 3.4, /\b(vs\.?|versus|compared?\s+(?:to|with|against)|against\s+last|relative\s+to)\b/i),
  S('cmp.verb', 'compare', 3.2, /\b(compare|comparison|side\s+by\s+side|benchmark\s+\w+\s+against)\b/i),
  S('cmp.diff', 'compare', 3.0, /\b(difference\s+between|gap\s+between|delta|how\s+does\s+\w+\s+compare)\b/i),
  S('cmp.period', 'compare', 2.4, /\b(year\s+over\s+year|yoy|quarter\s+over\s+quarter|qoq|month\s+over\s+month|mom|same\s+(?:period|quarter|month)\s+last\s+year)\b/i),
  S('cmp.than', 'compare', 1.6, /\b(more|less|fewer|better|worse|faster|slower|higher|lower)\s+than\b/i),

  // ----------------------------------------------------------- explain
  S('exp.why', 'explain', 3.6, /\bwhy\b/i),
  S('exp.cause', 'explain', 2.8, /\b(reason|cause|caused|driver|driving|because|root\s+cause|attributed?\s+to|explain|what\s+led\s+to)\b/i),
  S('exp.change', 'explain', 2.0, /\b(dropped?|fell|declined?|spiked?|surged?|jumped|slipped|stalled|flat(?:lined)?|slowed)\b/i),
  S('exp.happened', 'explain', 1.8, /\b(what\s+happened|how\s+come|what'?s\s+going\s+on|what\s+changed)\b/i),

  // ------------------------------------------------------------- draft
  S('draft.verb', 'draft', 3.6, /\b(draft(?:s|ed|ing)?|writ(?:e|es|ing)|compos(?:e|es|ed|ing)|rewrit(?:e|es|ing)|reword(?:s|ed|ing)?|ghostwrite)\b/i),
  S('draft.artifact', 'draft', 3.0, /\b(email|e-mail|message|note|reply|response|follow[-\s]?up|outreach|letter|dunning\s+(?:email|notice|letter)|reminder\s+email|sequence|subject\s+line|talk\s+track|call\s+script)\b/i),
  S('draft.tone', 'draft', 1.4, /\b(tone|friendly|formal|casual|warm|firm|polite|apologetic|concise|punchy)\b/i),
  S('draft.recap', 'draft', 2.0, /\b(call\s+summary|meeting\s+notes|call\s+notes|recap\s+email|deal\s+summary|handover\s+note)\b/i),

  // --------------------------------------------------------- summarise
  S('sum.verb', 'summarise', 3.4, /\b(summari[sz](?:e|es|ed|ing)|summary|recap|tl;?dr|brief\s+me|catch\s+me\s+up|digest|overview|walk\s+me\s+through|what\s+should\s+i\s+know)\b/i),
  S('sum.since', 'summarise', 1.8, /\b(what'?s\s+(?:new|happened)|since\s+(?:i\s+)?(?:last|my)\b|highlights|key\s+points|headlines)\b/i),
  S('sum.brief', 'summarise', 1.6, /\b(prep(?:are)?\s+me|before\s+(?:the|my)\s+(?:call|meeting|qbr|renewal)|pre[-\s]?read)\b/i),

  // -------------------------------------------------------------- plan
  S('plan.verb', 'plan', 3.2, /\b(plan|playbook|strategy|approach|game\s?plan|roadmap)\b/i),
  S('plan.advice', 'plan', 3.0, /\b(what\s+should\s+(?:i|we)|recommend|suggest|advice|advise|how\s+(?:do|should|can)\s+(?:i|we)|best\s+way\s+to|worth\s+doing)\b/i),
  S('plan.next', 'plan', 2.6, /\b(next\s+steps?|action\s+items?|to[-\s]?do|priorit(?:ise|ize|ies|y)|focus\s+on|where\s+to\s+start)\b/i),
  S('plan.risk', 'plan', 1.6, /\b(at\s+risk|save|rescue|turn\s+around|win\s+back|expand|upsell|renew)\b/i),

  // --------------------------------------------------------------- act
  S('act.create', 'act', 3.4, /\b(creat(?:e|es|ing)|add(?:s|ing)?|log(?:s|ged|ging)?|record\s+(?:a|the)|open\s+a\s+ticket|book\\s+(?:a|the)|schedul(?:e|es|ing)|set\s+up|enroll|start\s+a)\b/i),
  S('act.update', 'act', 3.4, /\b(updat(?:e|es|ing)|chang(?:e|es|ing)|edit(?:s|ing)?|set\s+the|mov(?:e|es|ing)|assign(?:s|ing)?|reassign|clos(?:e|ing)\s+(?:the|this)|mark(?:s|ing)?|archiv(?:e|es|ing)|delet(?:e|es|ing)|remov(?:e|es|ing)|merg(?:e|es|ing)|appl(?:y|ies|ying)|issue\s+a\s+(?:credit|refund)|void)\b/i),
  S('act.remind', 'act', 2.4, /\b(remind\s+me|follow\s+up\s+(?:in|on)\s+\d|snooze|chase|ping\s+me)\b/i),
  S('act.send', 'act', 2.0, /\b(send|deliver|dispatch|fire\s+off)\b/i),

  // ------------------------------------------------------ troubleshoot
  S('ts.problem', 'troubleshoot', 3.4, /\b(error|failing|failed|broken|bug|crash|outage|down|degraded|timeout|timed\s+out|stuck|blocked|not\s+working|doesn'?t\s+work|won'?t\s+\w+)\b/i),
  S('ts.support', 'troubleshoot', 2.4, /\b(ticket|incident|escalat(?:ed|ion)|sla\s+breach|complain(?:t|ing)|angry|frustrated|churn\s+risk)\b/i),
  S('ts.billing', 'troubleshoot', 2.2, /\b(payment\s+failed|declined|past\s+due|overdue|dunning|unpaid|chargeback|dispute|double\s+charged|wrong\s+amount)\b/i),
  S('ts.diagnose', 'troubleshoot', 2.0, /\b(diagnose|debug|investigate|look\s+into|troubleshoot|what'?s\s+wrong)\b/i),
];

const NEGATION_CUES = [
  "don't", 'do not', "doesn't", 'dont', 'not', 'no need to', 'never', 'without', 'skip',
  'instead of', 'rather than', 'other than', 'except', 'excluding', 'avoid', 'stop',
  "shouldn't", "isn't", "aren't", "won't", 'no longer',
];

/** A negation cue governs the words after it, up to the next clause boundary. */
function negationScopes(text: string): { cue: string; at: number; end: number; scope: string }[] {
  const lower = text.toLowerCase();
  const out: { cue: string; at: number; end: number; scope: string }[] = [];
  for (const cue of NEGATION_CUES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(cue, from);
      if (at === -1) break;
      const before = at === 0 ? ' ' : lower[at - 1];
      const after = lower[at + cue.length] ?? ' ';
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) { from = at + cue.length; continue; }
      const rest = lower.slice(at + cue.length);
      const boundary = rest.search(/[,;.!?—]|\bbut\b|\bjust\b|\binstead\b|\bhowever\b/);
      const span = boundary === -1 ? Math.min(rest.length, 64) : boundary;
      out.push({ cue, at, end: at + cue.length + span, scope: text.slice(at, at + cue.length + span).trim() });
      from = at + cue.length;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const emptyScores = (): Record<TaskIntent, number> =>
  Object.fromEntries(TASK_INTENTS.map((i) => [i, 0])) as Record<TaskIntent, number>;

export function classifyIntent(message: string, hint?: string): IntentResult {
  const text = String(message || '').slice(0, 4000);
  const scores = emptyScores();
  const signals: IntentSignal[] = [];
  const scopes = negationScopes(text);
  const length = Math.max(text.length, 1);

  for (const def of SIGNALS) {
    const match = text.match(def.re);
    if (!match || match.index === undefined) continue;
    const at = match.index;
    const negated = scopes.some((s) => at >= s.at && at < s.end);
    // A verb in the opening clause is the request; the same word later is context.
    const lead = at / length < 0.25 ? 1.2 : 1;
    const applied = negated ? -def.weight * 0.55 : def.weight * lead;
    scores[def.intent] += applied;
    signals.push({ id: def.id, intent: def.intent, weight: def.weight, matched: match[0], at, negated, applied: Number(applied.toFixed(2)) });
  }

  // A caller-supplied hint is evidence, never a command: signals can outvote it.
  if (hint) {
    const wanted = TASK_INTENTS.find((i) => i === hint.toLowerCase());
    if (wanted) {
      scores[wanted] += 2.5;
      signals.push({ id: 'hint.caller', intent: wanted, weight: 2.5, matched: hint, at: 0, negated: false, applied: 2.5 });
    }
  }

  // A question mark with no other strong signal is a lookup, not a command.
  if (/\?\s*$/.test(text.trim()) && Math.max(...Object.values(scores)) < 2) {
    scores.lookup += 1.5;
    signals.push({ id: 'lookup.question_mark', intent: 'lookup', weight: 1.5, matched: '?', at: text.length - 1, negated: false, applied: 1.5 });
  }

  const ranked = TASK_INTENTS
    .map((intent) => ({ intent, score: scores[intent] }))
    .sort((a, b) => b.score - a.score || TASK_INTENTS.indexOf(a.intent) - TASK_INTENTS.indexOf(b.intent));

  const top = ranked[0];
  const second = ranked[1];
  const intent: TaskIntent = top.score <= 0 ? 'lookup' : top.score === second.score && second.intent === 'lookup' ? 'lookup' : top.intent;
  const margin = Number((top.score - second.score).toFixed(2));
  const positive = ranked.filter((r) => r.score > 0).reduce((a, r) => a + r.score, 0) || 1;
  const share = Math.max(top.score, 0) / positive;
  const confidence = top.score <= 0
    ? 0.3
    : Math.min(0.99, Number((0.4 + 0.4 * share + 0.2 * Math.min(margin / 3, 1)).toFixed(3)));

  return {
    intent,
    confidence,
    scores,
    runnerUp: second.score > 0 && second.intent !== intent ? second.intent : null,
    margin,
    signals: signals.sort((a, b) => b.applied - a.applied),
    negations: scopes.map((s) => ({ cue: s.cue, at: s.at, scope: s.scope })),
    secondary: ranked.filter((r) => r.intent !== intent && r.score >= Math.max(2, top.score * 0.55)).map((r) => r.intent),
  };
}

/** Does this task need to change data? Drives the read-only tool filter. */
export const isWriteIntent = (intent: TaskIntent): boolean => intent === 'act';

/** A one-line explanation of the classification, for the reasoning trace. */
export function describeIntent(result: IntentResult): string {
  const fired = result.signals.filter((s) => !s.negated).slice(0, 3).map((s) => `${s.id} "${s.matched}" +${s.applied}`);
  const blocked = result.signals.filter((s) => s.negated).map((s) => `${s.id} "${s.matched}" negated`);
  const parts = [`Intent ${result.intent} (confidence ${(result.confidence * 100).toFixed(0)}%, margin ${result.margin})`];
  if (fired.length) parts.push(`signals: ${fired.join(', ')}`);
  if (blocked.length) parts.push(blocked.join(', '));
  if (result.runnerUp) parts.push(`runner-up ${result.runnerUp}`);
  return parts.join('; ');
}

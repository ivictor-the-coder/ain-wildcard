import { resolveWindows, resolveWindow, periodMentions } from '../src/server/ai/dates';
const now = Date.UTC(2026, 7, 30);
const qs = [
  'Compare Q1 2026 and Q2 2026 bookings',
  'Compare Q1 and Q2 bookings',
  'How much did we book in Q2 2026?',
  'bookings in Q3 2025',
  'how did we do last quarter',
  'in the last 30 days',
  'what happened today',
  'who owns this account',
  'Which deals may slip this quarter?',
  'Compare Q1 2026 and H2 2026 bookings',
  'How did bookings compare to the same period last year?',
  'revenue in March 2025',
  'What is our flurb rate this quarter?',
];
for (const q of qs) {
  console.log(JSON.stringify(q), '->', resolveWindows(q, now).map((w) => w.label), '| mentions', periodMentions(q).map((m) => m.text));
}
console.log('first:', resolveWindow('how did we do last quarter', now)?.label, resolveWindow('who owns this account', now));

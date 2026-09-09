# Ain — build contract for every module

**Ain** is an AI services platform that runs a business end to end. It must stand
next to **HubSpot's AI Customer Platform** (Smart CRM, Breeze agents, workflows,
inbox, reporting) and **Stripe Billing** (subscriptions, usage, credits,
invoicing, dunning, revenue reporting) and win a blind side-by-side comparison.

> Read this file completely before writing a line of code. It is the only
> coordination mechanism between ~30 parallel builders.

---

## 1. Non-negotiables

1. **Everything must actually work.** No stubs, no `TODO`, no placeholder copy,
   no hardcoded numbers pretending to be computed. Every screen reads real data
   from the API; every API route reads real data from SQLite.
2. **Typecheck and tests must pass**: `npm run typecheck && npm test`.
3. **Only touch files you own.** Your brief names your directories. Editing
   anything else will collide with another builder working at the same time.
   The two generated registries are written by `npm run gen` — never by hand.
4. **No new npm dependencies.** The toolchain is fixed: Node 22 (`node:sqlite`),
   React 18, Vite, TypeScript, Playwright. Everything else you build yourself.
5. **Density and craft.** Real product surfaces have empty states, loading
   states, error states, keyboard support, focus rings, hover affordances,
   optimistic updates, and copy written by someone who understands the domain.

## 2. Repository layout

```
src/shared/          money.ts  time.ts  ids.ts  errors.ts  validate.ts   (kernel, do not edit)
src/server/kernel/   db http events jobs clock logger context module ai services  (do not edit)
src/server/app.ts    boot, auth, idempotency, rate limiting               (do not edit)
src/server/modules/<name>/module.ts     ← a server module you may own
src/client/kernel/   api router session shell registry-types              (owned by the shell builder)
src/client/design/   the design system                                    (owned by the design builder)
src/client/modules/<name>/routes.tsx    ← a client feature you may own
tests/<name>.test.ts                    ← your tests
e2e/<name>.spec.ts                      ← your Playwright specs
```

Modules are discovered automatically: any `src/server/modules/*/module.ts` with a
default export and any `src/client/modules/*/routes.tsx` exporting `routes` is
picked up by `npm run gen`. Nothing is registered by hand.

## 3. Server module contract

```ts
import { defineModule } from '../../kernel/module';
import v from '../../../shared/validate';
import { list, created, noContent, type Req } from '../../kernel/http';
import type { Ctx } from '../../kernel/context';

export interface BillingService { /* what other modules may call */ }
declare module '../../kernel/services' {
  interface ServiceRegistry { billing: BillingService }
}

export default defineModule({
  name: 'billing',
  title: 'Subscriptions & invoicing',
  description: 'One sentence for the system map.',
  dependsOn: ['core', 'crm'],
  migrations: [{ id: 'billing.0001_init', sql: `CREATE TABLE ...` }],
  boot(ctx)   { ctx.provide('billing', service); ctx.jobs.handle('billing.renew', fn); },
  routes(r, ctx) { r.get('/v1/subscriptions', handler, { summary, tags, body, query }); },
  tools(ctx)  { return [ /* AiToolDef the copilot and agents can call */ ]; },
  seed(ctx, orgId) { /* demo data, runs in one transaction, in dependency order */ },
  on: { 'invoice.payment_failed': (event, ctx) => { /* react */ } },
});
```

### Rules
- **Migration ids are immutable and namespaced**: `<module>.NNNN_slug`. Never edit
  a shipped migration; add another one.
- **Every table carries `org_id`** and every query filters on it. No exceptions.
- **Time comes from `ctx.now()`**, never `Date.now()`. This is what makes the
  time machine (`POST /v1/time/advance`) replay a year of billing in one second.
- **Money is integer minor units** via `src/shared/money.ts`. Never floats.
  Proration, tiering and tax use the exact rational helpers (`ratMul`, `allocate`).
- **Ids** come from `newId('kind')` in `src/shared/ids.ts`; add a prefix there
  only if none fits (that file is append-only for you).
- **Mutations are transactional**: `ctx.atomic(() => { ... })` so events only
  publish if the write commits.
- **Emit events** for every meaningful change: `ctx.emit(orgId, 'invoice.paid', data,
  { objectId, objectType, previous })`. Workflows, webhooks, timelines and the
  audit log all read from this one stream.
- **Deferred work is a job**, never a `setTimeout`: `ctx.enqueue(orgId, 'billing.renew',
  payload, { runAt, idemKey })`.
- **Validate every input** with `v.object({...})` in the route's `body`/`query`
  meta. That drives runtime validation *and* the generated OpenAPI document.
- **Errors** use `src/shared/errors.ts` helpers so the client always gets
  `{ error: { type, code, message, param, doc_url, request_id } }`.
- **List endpoints** return `list(data, { hasMore, nextCursor, totalCount })`.
- **Object payloads carry `object: '<type>'`** and expanded relations where the UI
  needs them (`?expand=customer,items`).

## 4. Client module contract

```tsx
export const routes: RouteDef[] = [{ path: '/billing/subscriptions', element: Page, title: 'Subscriptions' }];
export const nav: NavItem[] = [{ id, label, to, group: 'revenue', order: 20, icon: Icon }];
export const commands: CommandDef[] = [...];   // command palette entries
export const widgets: WidgetDef[] = [...];     // home dashboard cards
export const settings: SettingsPage[] = [...]; // settings sub-pages
```

- Data comes from `useQuery`/`useMutation` in `src/client/kernel/api.ts`. After a
  mutation, `invalidate('/v1/subscriptions')` so lists refresh.
- **Only design-system components and tokens.** Import from `@/client/design`.
  Never a raw hex colour, never a raw pixel font size — use `var(--…)` tokens.
- Every list has: loading skeleton, empty state with a primary action, error
  state with retry, and a real toolbar (search, filters, sort, column control).
- Every mutation gives feedback (toast, inline validation on the offending
  `param`, optimistic update where it's safe).
- Full keyboard support: `Tab` order, `Esc` closes overlays, `Enter` submits,
  arrow keys move within grids and menus. Every icon-only control has a label.
- Both themes must look deliberate. Check light *and* dark before you finish.

### Do not re-implement what the kit already owns

Three modules once each owned a status vocabulary, an error panel and a loading
panel, and they drifted apart — the same word rendered as a different colour on
two screens. The kit owns them now. Import, never re-declare:

| The kit's | Use it for |
| --- | --- |
| `StatusPill`, `statusLabel`, `statusTone` | any status, state or lifecycle word |
| `SectionError` | a panel whose read failed, with the request and a retry |
| `useFormat` | money, dates, relative times, counts, plurals, lists |

A status word the kit does not know, or a panel shape it cannot make, is a
change **to the kit**, proposed with the exact edit — not a fourth local copy.
The same goes for a kit component that misbehaves: fix it there, and say which
module workarounds become removable.

## 5. Verification you must run before declaring done

```bash
npx tsc --noEmit                     # must be clean
npm test                             # must pass
npx tsx scripts/verify.ts            # boots in-process, smokes every GET, runs the time machine
```

**Do not run `npm run build`.** `dist/` is shared, so a build races every other
builder in the checkout. To see your work running, take a port and a database of
your own:

```bash
node scripts/preview.mjs --fresh --port 8901 --name your-name   # isolated build + server + db
node scripts/shoot.mjs --url http://127.0.0.1:8901 --routes /billing,/deals --themes light,dark --out .artifacts/your-name
```

Then **read the PNGs and look at them**. Playwright is installed (Chromium at
`/opt/pw-browsers`); put any driving script under `.artifacts/<your-name>/`,
never under `scripts/` or `src/`.

### Every fix ships a test that fails without it

A test that passes before and after your change proves nothing, and that has
happened here more than once. Revert your change, run the test, watch it fail,
restore it, watch it pass — and report both runs. Expected values are computed
from the database or from first principles inside the test, never pasted from
the output of the code under test. Pinning a formatted literal (`'$38,873.66'`)
pins the seed too, and the next legitimate seed change fails your test for a
reason that is not a defect.

### After a fix, hunt its mirror image

Twice here a fix has created its own reverse. When you have fixed something,
look for the same mistake in the reverse operation, the sibling call and the
undo path — refund against charge, credit against debit, attach against detach,
create against void.

## 5a. Never write a credential-shaped literal

GitHub push protection rejects the whole branch if any file contains a string
matching a real provider's key format. When you need to *show* a key — in the
style guide, the API reference, an example payload, a masked field — use a
prefix that belongs to us and reads as inert:

    ain_demo_key_not_a_real_credential      good
    sk_live_<24 more base62 characters>    blocks the push for everyone

Our own keys are minted at runtime as `sk_test_…`/`sk_live_…` from
`randomBytes`, which is fine — it is *literals in source* that get flagged.
Run `npx tsx scripts/verify.ts` before you finish; it fails on this.

## 6. House style

- TypeScript strict. No `any` in exported signatures. No `as unknown as`.
- Comments explain *why*, never *what*. Delete a comment that restates the code.
- Copy is specific and human: "No invoices yet — the first one is created when
  Northwind's trial converts on 14 May", not "No data available".
- Numbers are formatted through `formatMoney` / `formatDate` / `formatRelative`
  with the workspace's locale, currency and timezone.
- Names match the domain: `credit_grant`, `proration_behavior`, `dunning_step` —
  not `thing`, `data2`, `handleClick2`.

## 7. The demo workspace

Everything seeds into **Northwind Robotics** (`org_demo`), an industrial
automation company selling a usage-priced robotics telemetry platform. Six
teammates (Dana, Marcus, Priya, Sofia, Tom, Nina), ~40 customer companies,
multi-year history. Sign in with `dana@northwind.io` / `demo1234`, or one click
on "Use the demo workspace".

**One company, one identity.** The company on the CRM record, the customer on
the invoice, the account streaming into a meter and the record in an agent trace
are the same company. This rule has been broken twice and both times it surfaced
as a falsehood on screen: a meter attributed events to two accounts billing had
never created, so the copilot cited customers whose pages answered "No such
account", and a goodwill credit was granted to one of them. If a seed cannot
resolve an entry to a real customer, it must refuse to write the row rather than
invent an id.

**The demo keeps running.** A seed that writes history and schedules nothing
leaves a usage-priced company showing no usage the moment anyone advances the
clock. Deferred work is a row in `jobs`, so seeded activity that should continue
is a durable, re-enqueuing job — not a backfill that ends at the seed instant.
Check yours by advancing 45 days and looking at the screens that read it.

**A seat has a state.** A teammate is `invited` until they accept: `POST
/v1/users` creates the seat and returns a one-time invitation token, `POST
/v1/auth/accept` sets a password and activates it, and the token is refused the
second time. Anything that lists people shows that state.

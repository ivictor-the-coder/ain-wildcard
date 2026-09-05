# Ain

An AI services platform that runs a business end to end — CRM, conversations,
marketing, autonomous agents and workflow automation on one side; subscriptions,
usage metering, prepaid credits, invoicing, dunning and revenue reporting on the
other. The bar is HubSpot's AI Customer Platform and Stripe Billing.

## Working in this repo

**Read `docs/CONTRACTS.md` first.** It is the build contract: module shape,
ownership rules, house style, and the verification every change must pass.

```bash
npm run dev        # API on :8787 + Vite on :5173
npm run api        # API only (serves dist/client if built)
npm run build      # build the client
npm run typecheck  # tsc --noEmit
npm test           # node:test suites under tests/
npm run check      # typecheck + test

npx tsx scripts/verify.ts                        # boot in-process, smoke every GET, run the time machine
npx tsx scripts/verify.ts GET /v1/invoices       # call one route with a demo session
node scripts/preview.mjs --port 8801 --name x    # isolated build + server on its own port and DB
node scripts/shoot.mjs --url http://127.0.0.1:8801 --routes /,/billing --out .artifacts/shots
node scripts/progress.mjs                        # regenerate docs/progress.html
```

## Architecture in one screen

- **Modules auto-register.** `src/server/modules/<name>/module.ts` (default
  export) and `src/client/modules/<name>/routes.tsx` (exports `routes`, and
  optionally `nav`, `commands`, `widgets`, `settings`). `npm run gen` writes the
  registries; nothing is wired by hand, so parallel work never collides.
- **One event log.** `ctx.emit()` writes to `events`, which feeds webhooks,
  workflow triggers, record timelines and the audit trail.
- **Deferred work is a row.** `ctx.enqueue()` writes to `jobs` with a `run_at`.
  Nothing sleeps on a timer, so `POST /v1/time/advance` replays renewals,
  dunning, credit expiry and scheduled agent runs exactly as they would happen.
- **Time comes from `ctx.now()`**, money from `src/shared/money.ts` (integer
  minor units, BigInt rationals for proration and tiering).
- **Validation drives the API docs.** Route `body`/`query` validators from
  `src/shared/validate.ts` produce both runtime errors and `/api/openapi.json`.
- **Auth**: session cookie or `Authorization: Bearer sk_test_…`. Demo sign-in is
  `dana@northwind.io` / `demo1234`, or `POST /v1/auth/demo`.

The demo workspace is **Northwind Robotics**, an industrial automation company
selling a usage-priced telemetry platform. All seed data tells that one story.

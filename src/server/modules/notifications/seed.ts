import type { Ctx } from '../../kernel/context';
import { notificationsStore } from './store';

/**
 * Northwind's own delivery history.
 *
 * Two endpoints, because one healthy subscriber tells you nothing about what
 * happens when a subscriber dies. `hooks.northwind.io` is the ops team's live
 * billing bus and acknowledges everything; `hooks-legacy.northwind.io` is the
 * integration they replaced and never turned off, and it answers 410 Gone —
 * so the demo shows the retry ladder climbing, and then the endpoint taking
 * itself out of service with a reason an operator can act on. Both outcomes
 * are computed by the same delivery path the product uses; nothing here writes
 * an attempt row by hand.
 *
 * The deliveries are queued, not run. They are job rows with a `run_at` like
 * every other piece of deferred work in this platform, so the first drain of
 * the queue makes the first attempt and `POST /v1/time/advance` walks the rest
 * of the ladder exactly as a real day and a half would.
 */
export function seedNotifications(ctx: Ctx, orgId: string): void {
  const store = notificationsStore(ctx);

  // Provisioning the sender is what switches notices on. It happens here,
  // after every other module has seeded, so the years of finalised invoices
  // written above this line are history rather than 350 emails.
  store.ensureSettings(orgId);

  const live = store.createEndpoint(orgId, {
    url: 'https://hooks.northwind.io/ain/billing',
    description: 'Operations bus — feeds the on-call rota, the finance channel and the data warehouse.',
    enabled_events: ['invoice.*', 'subscription.*', 'dunning.*', 'credit.*', 'payment_intent.*'],
  });

  const legacy = store.createEndpoint(orgId, {
    url: 'https://hooks-legacy.northwind.io/ain',
    description: 'The first integration, replaced in March. Nobody turned it off.',
    enabled_events: ['invoice.*'],
  });

  // The demo transport answers the decommissioned host the way a
  // decommissioned host answers: gone, and not coming back. Rules live on the
  // recorded transport, so a deployment that installs a real one is unaffected.
  store.recordedHttp()?.respond('hooks-legacy.northwind.io', {
    status: 410,
    body: '{"error":"gone","detail":"This integration was retired in March."}',
  });

  // A delivery history, replayed from this workspace's own event log.
  //
  // The fan-out only ever sees an event as it is published, so everything the
  // seed wrote before this line reached no endpoint — a workspace that has
  // just registered its first subscriber would show two endpoints and nothing
  // to say about either. These are real events from this workspace, queued
  // through the same path the product uses. Nothing further is seeded: the
  // demo goes on producing deliveries because it goes on producing events, so
  // advancing the clock keeps both endpoints busy without a backfill.
  replay(ctx, orgId, live.id, 24);
  replay(ctx, orgId, legacy.id, 6);

  // Every bill still owed must have been sent to somebody, or the receivables
  // book is asking for money nobody was asked for. Accounts with no billing
  // address on file produce a suppressed record naming the account, which is
  // the fact the invoice screen should show instead of "sent".
  for (const invoice of ctx.svc.billing.invoices(orgId, { status: 'open', limit: 50 })) {
    store.sendInvoice(orgId, invoice.id, { kind: 'invoice.issued' });
  }
}

/** Queue the most recent events an endpoint subscribes to, newest first. */
function replay(ctx: Ctx, orgId: string, endpointId: string, count: number): void {
  const store = notificationsStore(ctx);
  const endpoint = store.endpoint(orgId, endpointId);
  if (!endpoint) return;
  // Asked of the log by type rather than by scanning a window of it: this
  // workspace seeds six hundred entitlement events after its last invoice, so
  // a "most recent 400" scan found almost nothing either endpoint wanted.
  for (const event of ctx.events.list(orgId, { types: endpoint.enabled_events, limit: count })) {
    store.queueDeliveryById(orgId, endpointId, event);
  }
}

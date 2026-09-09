/**
 * The three halves of payments, wired together once.
 *
 * `Gateway` needs dunning to hand a failed collection to, and dunning needs the
 * gateway to make its retries with. Rather than have each import the other,
 * both hold the façade — the same shape billing uses for its invoices and
 * credit notes — so there is exactly one object per context and one place that
 * knows how the pieces fit.
 */
import type { Ctx } from '../../kernel/context';
import { DunningEngine } from './dunning';
import { Gateway } from './gateway';
import { Methods } from './methods';

export class Payments {
  readonly methods: Methods;
  readonly gateway: Gateway;
  readonly dunning: DunningEngine;

  constructor(ctx: Ctx) {
    this.methods = new Methods(ctx);
    this.gateway = new Gateway(ctx, this);
    this.dunning = new DunningEngine(ctx, this);
  }
}

const stores = new WeakMap<Ctx, Payments>();

export function paymentsStore(ctx: Ctx): Payments {
  let found = stores.get(ctx);
  if (!found) { found = new Payments(ctx); stores.set(ctx, found); }
  return found;
}

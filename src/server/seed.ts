import type { Ctx } from './kernel/context';

/**
 * Demo seeding. Each module contributes its own slice; the kernel runs them in
 * dependency order inside a single transaction so the workspace is coherent —
 * the same companies appear in the CRM, on invoices and in the agent traces.
 */
export function seedDemo(ctx: Ctx, orgId: string): void {
  ctx.db.tx(() => {
    for (const m of ctx.modules) {
      try { m.seed?.(ctx, orgId); }
      catch (e) { throw new Error(`Seeding module "${m.name}" failed: ${(e as Error).message}`); }
    }
  });
}

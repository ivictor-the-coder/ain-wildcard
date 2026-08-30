/**
 * Cross-module service registry.
 *
 * A module publishes its service object once at boot (`ctx.provide('billing', impl)`)
 * and other modules consume it through `ctx.svc.billing`. Types are contributed by
 * declaration merging from each module, so no shared file ever needs editing:
 *
 *   declare module '@/server/kernel/services' {
 *     interface ServiceRegistry { billing: BillingService }
 *   }
 */
export interface ServiceRegistry {}

export type ServiceName = keyof ServiceRegistry & string;

import type { Migration } from './db';
import type { Router } from './http';
import type { AinEvent } from './events';
import type { AiToolDef } from './ai';
import type { Ctx } from './context';

export interface ModuleDef {
  /** Stable, lowercase, dot-free name — also the OpenAPI tag. */
  name: string;
  /** Human title shown in the platform's system map. */
  title?: string;
  description?: string;
  /** Modules that must boot before this one (service registry ordering). */
  dependsOn?: string[];
  migrations?: Migration[];
  /** Register services, event handlers and job handlers. Runs after migrations. */
  boot?(ctx: Ctx): void;
  /** Register HTTP routes. Runs after every module has booted. */
  routes?(router: Router<Ctx>, ctx: Ctx): void;
  /** Tools exposed to the AI layer. */
  tools?(ctx: Ctx): AiToolDef[];
  /** Demo data. Runs inside one transaction, in dependency order. */
  seed?(ctx: Ctx, orgId: string): void;
  /** Long-lived subscriptions declared declaratively (alternative to boot). */
  on?: Record<string, (event: AinEvent<any>, ctx: Ctx) => void>;
}

export const defineModule = (m: ModuleDef): ModuleDef => m;

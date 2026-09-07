import type { ReactNode } from 'react';
import { Badge } from './data';
import { Tooltip } from './overlays';
import { statusLabel, statusTone, taxIdStatusLabel, taxIdStatusTone } from './status-core';

export interface StatusPillProps {
  /** The wire value: `past_due`, `uncollectible`, `requires_payment_method`. */
  status: string;
  /** Why it is in that state, on hover — "3 attempts left", "Register said no". */
  title?: ReactNode;
  className?: string;
}

/**
 * A lifecycle status as the product agrees to show it: the label from the
 * one map, the tone from the one ramp, a dot, a pill. Three modules used to
 * carry their own copy of this, and a grant that was "Scheduled" in amber on
 * Credits was a neutral chip on the customer's page.
 */
export function StatusPill({ status, title, className }: StatusPillProps) {
  const pill = <Badge tone={statusTone(status)} dot pill className={className}>{statusLabel(status)}</Badge>;
  return title ? <Tooltip content={title}><span className="ain-statuspill">{pill}</span></Tooltip> : pill;
}

/**
 * A tax number's standing with its register, in the same shape as a lifecycle
 * pill so the two read as one product on the account page that shows both.
 */
export function TaxIdStatusPill({ status, title, className }: StatusPillProps) {
  const pill = <Badge tone={taxIdStatusTone(status)} dot pill className={className}>{taxIdStatusLabel(status)}</Badge>;
  return title ? <Tooltip content={title}><span className="ain-statuspill">{pill}</span></Tooltip> : pill;
}

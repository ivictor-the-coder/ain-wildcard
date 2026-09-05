/**
 * Where an object id on this surface leads.
 *
 * The audit trail names its target as `target_type` + `target_id` and the event
 * stream names its object the same way, and both used to print the pair in
 * monospace and stop. Stripe's event log and security history link every
 * object they mention; here the id is only useful if it opens the record it
 * describes. This is the one table of what each type is called and which screen
 * resolves it — so the trail, the stream and the job drawer all agree.
 */

/** How each type is named on screen. `api_key` is an API key, not an "Api key". */
export const TARGET_LABELS: Record<string, string> = {
  api_key: 'API key',
  user: 'Teammate',
  org: 'Workspace',
  organization: 'Workspace',
  tax_rate: 'Tax rate',
  feature: 'Feature',
  entitlement_override: 'Entitlement override',
  customer: 'Customer',
  invoice: 'Invoice',
  subscription: 'Subscription',
  subscription_schedule: 'Subscription schedule',
  payment_intent: 'Payment',
  payment_method: 'Payment method',
  charge: 'Charge',
  refund: 'Refund',
  dispute: 'Dispute',
  credit_grant: 'Credit grant',
  credit_note: 'Credit note',
  credit_settlement: 'Credit settlement',
  credit_billable_item: 'Credit line',
  dunning: 'Dunning sequence',
  meter: 'Meter',
  meter_event: 'Meter event',
  meter_event_batch: 'Meter event batch',
  meter_event_adjustment: 'Meter adjustment',
  meter_late_arrival: 'Late usage',
  meter_period_closure: 'Meter period',
  product: 'Product',
  price: 'Price',
  contact: 'Contact',
  company: 'Company',
  deal: 'Deal',
  ticket: 'Ticket',
  property: 'Property',
  object_type: 'Object type',
  pipeline: 'Pipeline',
  view: 'Saved view',
  record: 'Record',
  ai_run: 'Agent run',
  ai_approval: 'Approval',
  ai_thread: 'Copilot thread',
  job: 'Job',
  event: 'Event',
};

export function targetLabel(type: string | null | undefined): string {
  if (!type) return 'Object';
  const known = TARGET_LABELS[type];
  if (known) return known;
  const words = type.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Object';
}

/**
 * The screen that resolves one object, or null when the platform has none.
 *
 * Only routes that land *on the object* are listed. A link to a list page the
 * object is somewhere inside is not a resolution — it is a search the reader
 * has to finish — so a type with no record screen gets no link and its id is
 * shown as the plain fact it is.
 */
export function targetRoute(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  const safe = encodeURIComponent(id);
  switch (type) {
    case 'user': return `/settings/team?member=${safe}`;
    case 'api_key': return `/settings/api-keys?key=${safe}`;
    case 'org':
    case 'organization': return '/settings';
    case 'tax_rate': return `/settings/tax?rate=${safe}`;
    case 'feature': return `/settings/features?feature=${safe}`;
    case 'customer': return `/billing/customers/${safe}`;
    case 'invoice': return `/billing/invoices/${safe}`;
    case 'subscription': return `/billing/subscriptions/${safe}`;
    case 'meter': return `/revenue/usage/${safe}`;
    case 'contact': return `/contacts/${safe}`;
    case 'company': return `/companies/${safe}`;
    case 'deal': return `/deals/${safe}`;
    case 'ticket': return `/tickets/${safe}`;
    case 'ai_run': return `/copilot/runs/${safe}`;
    default: return null;
  }
}

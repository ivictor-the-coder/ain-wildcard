import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Object-id prefixes. Human-legible, greppable, Stripe-style. */
export const PREFIX = {
  org: 'org', user: 'usr', apikey: 'ak', session: 'sess', audit: 'aud',
  contact: 'con', company: 'cmp', deal: 'deal', ticket: 'tkt', note: 'note',
  object: 'obj', record: 'rec', property: 'prop', association: 'assoc',
  list: 'list', pipeline: 'pipe', stage: 'stg', activity: 'act', task: 'task',
  customer: 'cus', product: 'prod', price: 'price', sub: 'sub', subitem: 'si',
  schedule: 'sub_sched', phase: 'phase', invoice: 'in', invoiceitem: 'ii',
  lineitem: 'il', credit: 'cn', creditgrant: 'credgr', ledger: 'ledg',
  payment: 'pi', method: 'pm', charge: 'ch', refund: 're', dispute: 'dp',
  meter: 'mtr', event: 'evt', usage: 'mbe', coupon: 'coup', promo: 'promo',
  discount: 'di', taxrate: 'txr', taxid: 'txi', entitlement: 'ent', feature: 'feat',
  quote: 'qt', checkout: 'cs', portal: 'bps', webhook: 'we', endpoint: 'wh',
  delivery: 'whd', workflow: 'wf', run: 'wfr', step: 'wfs', enrollment: 'enr',
  agent: 'agt', agentrun: 'run', thread: 'thr', message: 'msg', tool: 'tool',
  campaign: 'camp', email: 'em', form: 'form', submission: 'sub_form',
  sequence: 'seq', report: 'rep', dashboard: 'dash', view: 'view',
  conversation: 'conv', inbox: 'ibx', file: 'file', notification: 'notif',
  job: 'job', clock: 'clock', score: 'score', segment: 'seg', import: 'imp',
  approval: 'appr', trace: 'trc', key: 'key', idem: 'idem', sla: 'sla',
} as const;

export type IdPrefix = (typeof PREFIX)[keyof typeof PREFIX];

export function randomId(prefix: string, size = 16): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const newId = (kind: keyof typeof PREFIX): string => randomId(PREFIX[kind]);
export const uuid = (): string => randomUUID();

/** Deterministic id generator for seeds and tests — stable across runs. */
export function seededIds(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  return (kind: keyof typeof PREFIX, size = 16): string => {
    let out = '';
    for (let i = 0; i < size; i++) out += ALPHABET[next() % ALPHABET.length];
    return `${PREFIX[kind]}_${out}`;
  };
}

/** Monotonic, sortable token for cursor pagination. */
export function cursorOf(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`).toString('base64url');
}
export function parseCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const [ts, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const createdAt = Number(ts);
    if (!Number.isFinite(createdAt) || rest.length === 0) return null;
    return { createdAt, id: rest.join(':') };
  } catch { return null; }
}

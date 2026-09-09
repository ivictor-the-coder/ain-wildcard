/**
 * A queued write, in the words a person approves it in.
 *
 * The card a human reads has to say "Rheinwerk Antriebstechnik", not
 * "cmp_nw_21": an id that resolves to nothing is a target that has changed since
 * the write was prepared, and saying so is the point of showing the card. The
 * ids stay in `pending_approvals[].args`, where a machine reads them.
 */
import { formatDate } from '../../shared/time';
import { humanise, truncate } from './text';

const ID_SHAPED = /^[a-z][a-z_]{1,12}_[A-Za-z0-9]{4,}$/;

const namedOrNull = (label: string | null | undefined): string | null =>
  label && !ID_SHAPED.test(label) ? label : null;

export function describeWrite(
  tool: string,
  args: Record<string, unknown>,
  nameOf: (id: string) => string | null = () => null,
): string[] {
  const named = (id: string) => namedOrNull(nameOf(id)) ?? 'a record I can no longer name';
  const value = (key: string) => (args[key] === undefined || args[key] === null ? '' : String(args[key]));
  if (tool === 'add_note') {
    const ids = Array.isArray(args.record_ids) ? (args.record_ids as unknown[]).map(String) : [];
    return [
      `Note on ${ids.map(named).join(', ') || 'no record'}`,
      value('subject') ? `Subject: ${value('subject')}` : '',
      value('body'),
    ].filter(Boolean);
  }
  if (tool === 'create_record') {
    const properties = (args.properties ?? {}) as Record<string, unknown>;
    const associate = Array.isArray(args.associate_to) ? (args.associate_to as unknown[]).map(String) : [];
    return [
      `New ${humanise(value('object_type')).toLowerCase()}`,
      ...Object.entries(properties)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${humanise(k)}: ${/(_at|_date)$/.test(k) && typeof v === 'number' ? formatDate(v, { timeZone: 'UTC' }) : truncate(String(v), 160)}`),
      associate.length ? `Linked to ${associate.map(named).join(', ')}` : '',
    ].filter(Boolean);
  }
  if (tool === 'update_record') {
    const properties = (args.properties ?? {}) as Record<string, unknown>;
    return [
      `${humanise(value('object_type'))} ${named(value('id'))}`,
      // "Close date → 1796115600000" is not something anybody can approve.
      ...Object.entries(properties).map(([k, v]) => `${humanise(k)} → ${/(_at|_date)$/.test(k) && typeof v === 'number'
        ? formatDate(v, { timeZone: 'UTC' })
        : truncate(String(v), 120)}`),
    ];
  }
  if (tool === 'schedule_followup') {
    return [
      `Follow-up on ${named(value('record_id'))}`,
      `Due in ${value('in_days')} ${value('in_days') === '1' ? 'day' : 'days'}`,
      value('assignee_id') ? `Assigned to ${named(value('assignee_id'))}` : 'Assigned to you',
      value('note'),
    ].filter(Boolean);
  }
  return Object.entries(args).map(([k, v]) => `${humanise(k)}: ${truncate(String(v), 120)}`);
}

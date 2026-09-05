/**
 * Where things live, and how a list's state rides in its address.
 *
 * Kept apart from the screens so a property row on the record page can link
 * to "the deals this rollup counts" without the record page importing the
 * list page that imports the dialogs that import the record page.
 */
import type { FilterNode, SortSpec } from './api';

/**
 * The five activity types Ain ships with, and the address each one answers at.
 *
 * A task queue and a call log are things people work all day; under
 * `/records/task` they crumbed as "Data model › Tasks" and the nav lit up the
 * schema editor. The shell's own link resolver tries `/<plural>/:id` before
 * anything else, so these are the addresses it already expected to find.
 */
export const ACTIVITY_PATHS: Readonly<Record<string, string>> = {
  note: '/notes', call: '/calls', meeting: '/meetings', email: '/emails', task: '/tasks',
};

/**
 * Where an object type's list lives. Deals belong to the pipeline module — the
 * board and its table are the one deal screen — so a deal link from a company
 * or a contact lands there, and `/records/deal` hands over to it. Anything
 * without an address of its own — a custom object defined this afternoon —
 * lives under the data model.
 */
export const listHref = (objectType: string): string =>
  objectType === 'contact' ? '/contacts'
    : objectType === 'company' ? '/companies'
      : objectType === 'deal' ? '/deals'
        : objectType === 'ticket' ? '/tickets'
          : ACTIVITY_PATHS[objectType] ?? `/records/${objectType}`;

export const recordHref = (objectType: string, id: string): string => `${listHref(objectType)}/${id}`;

/** True when `/records/<type>` is only an alias and the type has a home of its own. */
export const hasDedicatedAddress = (objectType: string): boolean => listHref(objectType) !== `/records/${objectType}`;

/* ------------------------------- url carriage ----------------------------- */

/**
 * "Look at this list" has to be a link. The search box, the filter tree and
 * the sort all ride in the query string beside `view`, so a reload, the back
 * button and a message to a teammate all land on the same rows — without
 * making anyone name and share a saved view for something they wanted to look
 * at for thirty seconds.
 */
export function encodeFilterParam(node: FilterNode | null | undefined): string {
  if (!node) return '';
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(node));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return '';
  }
}

/**
 * "The view's filter, deliberately turned off" is not the same state as "no
 * opinion", and only the second one should fall back to the view on reload.
 */
export const NONE = 'none';

export function decodeFilterParam(raw: string | undefined | null): FilterNode | null {
  if (!raw || raw === NONE) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as FilterNode) : null;
  } catch {
    // A hand-edited or truncated link should show the list, not an error page.
    return null;
  }
}

export const encodeSortParam = (sort: SortSpec[]): string =>
  sort.map((s) => `${s.property}:${s.direction ?? 'desc'}`).join(',');

export const decodeSortParam = (raw: string | undefined | null): SortSpec[] =>
  (!raw || raw === NONE ? '' : raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [property, direction] = part.split(':');
      return { property, direction: direction === 'asc' ? 'asc' : 'desc' } satisfies SortSpec;
    })
    .filter((s) => !!s.property);


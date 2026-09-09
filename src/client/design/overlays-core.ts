/** Pure matching for the command palette and the keyboard model behind `Menu`,
 *  kept out of the component file so they can be tuned and tested without a DOM. */
import { fold } from './table-core';

export interface CommandMatchable {
  title: string;
  subtitle?: string;
  keywords?: string[];
}

/**
 * Substring match across title, subtitle and keywords, ranked by where the
 * query hits: a title prefix beats a title substring beats a keyword. Shorter
 * titles win ties, so "Invoices" outranks "Invoice reminder settings".
 */
export function rankCommands<T extends CommandMatchable>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const scored: { entry: T; score: number }[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 100;
    else if (title.includes(q)) score = 70;
    else if ((entry.subtitle?.toLowerCase() ?? '').includes(q)) score = 45;
    else if ((entry.keywords ?? []).some((k) => k.toLowerCase().includes(q))) score = 40;
    if (score >= 0) scored.push({ entry, score: score - title.length * 0.01 });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

/* ---------------------------- menu keyboard ------------------------------ */

/**
 * A menu row reduced to what the keyboard cares about. The component keeps the
 * icons, shortcuts and React nodes; this file only ever sees text.
 */
export interface MenuNavItem {
  id: string;
  /** Plain text for typeahead — the label, or `searchText` when it is a node. */
  text: string;
  hasSubmenu?: boolean;
}

/** The letters typed so far and when the last one landed. */
export interface MenuTypeahead { query: string; at: number }

/** Longer than this between keystrokes and the buffer starts a new word. */
export const MENU_TYPEAHEAD_RESET_MS = 800;

export const emptyTypeahead = (): MenuTypeahead => ({ query: '', at: 0 });

export type MenuKeyAction =
  | { kind: 'ignore' }
  /** The highlight moved; `active` on the result says where to. */
  | { kind: 'move' }
  | { kind: 'select'; index: number }
  | { kind: 'open-submenu'; index: number }
  /** Fold a submenu back into its parent, or dismiss a root menu. */
  | { kind: 'close-submenu' }
  | { kind: 'close' };

export interface MenuKeyEvent { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

export interface MenuKeyInput {
  active: number;
  typeahead: MenuTypeahead;
  /** True inside a submenu, where ArrowLeft and Escape fold back one level. */
  nested?: boolean;
}

export interface MenuKeyResult {
  action: MenuKeyAction;
  active: number;
  typeahead: MenuTypeahead;
  /** True when the menu consumed the key, so the browser must not also act. */
  handled: boolean;
}

const wrap = (index: number, length: number): number => ((index % length) + length) % length;

/**
 * First item whose text starts with `query`, searching forward from `from` and
 * wrapping. Folded, so typing "kovac" finds "Nina Kovač" the way the table's
 * search does.
 */
export function menuTypeaheadIndex(items: MenuNavItem[], query: string, from: number): number {
  const q = fold(query.trim());
  if (!q || items.length === 0) return -1;
  for (let i = 0; i < items.length; i++) {
    const index = wrap(from + i, items.length);
    if (fold(items[index].text).startsWith(q)) return index;
  }
  return -1;
}

/**
 * The whole keyboard behaviour of a menu as one pure function: arrows, Home/End,
 * typeahead, Enter, submenus, Escape and Tab. Kept out of the component because
 * the bug worth never repeating was a wiring one — the handler sat on a
 * descendant of the element that actually held focus, so none of this ran — and
 * a test that drives the model beside a test that drives the DOM pins both ends.
 */
export function menuKeyAction(
  items: MenuNavItem[],
  input: MenuKeyInput,
  event: MenuKeyEvent,
  now: number,
): MenuKeyResult {
  const { key } = event;
  const { active, typeahead } = input;
  const keep = (action: MenuKeyAction = { kind: 'ignore' }, handled = false): MenuKeyResult =>
    ({ action, active, typeahead, handled });
  const moveTo = (index: number): MenuKeyResult =>
    ({ action: { kind: 'move' }, active: index, typeahead: emptyTypeahead(), handled: true });

  // Escape peels one layer; Tab leaves the menu entirely and hands focus back
  // to the trigger, so the next Tab continues from where the user already was.
  if (key === 'Escape') return { action: { kind: input.nested ? 'close-submenu' : 'close' }, active, typeahead: emptyTypeahead(), handled: true };
  if (key === 'Tab') return { action: { kind: 'close' }, active, typeahead: emptyTypeahead(), handled: true };
  if (items.length === 0) return keep();

  const typing = typeahead.query !== '' && now - typeahead.at <= MENU_TYPEAHEAD_RESET_MS;

  switch (key) {
    case 'ArrowDown': return moveTo(wrap(active + 1, items.length));
    case 'ArrowUp': return moveTo(wrap(active - 1, items.length));
    case 'Home': return moveTo(0);
    case 'End': return moveTo(items.length - 1);
    case 'ArrowRight': {
      const item = items[active];
      return item?.hasSubmenu
        ? { action: { kind: 'open-submenu', index: active }, active, typeahead: emptyTypeahead(), handled: true }
        : keep();
    }
    case 'ArrowLeft':
      return input.nested
        ? { action: { kind: 'close-submenu' }, active, typeahead: emptyTypeahead(), handled: true }
        : keep();
    case 'Enter':
    case ' ': {
      // Space belongs to the typeahead mid-word — "past due" is one item, not a
      // letter and an activation.
      if (key === ' ' && typing) break;
      const item = items[active];
      if (!item) return keep();
      return {
        action: item.hasSubmenu ? { kind: 'open-submenu', index: active } : { kind: 'select', index: active },
        active,
        typeahead: emptyTypeahead(),
        handled: true,
      };
    }
    default: break;
  }

  if (key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return keep();

  const query = typing ? typeahead.query + key : key;
  const next = { query, at: now };
  // One letter pressed over and over cycles the items starting with it; a
  // growing query keeps refining the item already under the highlight.
  const cycling = [...query].every((c) => fold(c) === fold(query[0]));
  const index = menuTypeaheadIndex(items, cycling ? query[0] : query, cycling ? active + 1 : active);
  return {
    action: index >= 0 ? { kind: 'move' } : { kind: 'ignore' },
    active: index >= 0 ? index : active,
    typeahead: next,
    handled: true,
  };
}

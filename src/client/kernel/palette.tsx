/**
 * The command palette — the surface an operator lives in.
 *
 * It ranks three things in one list: the static verbs the app registers (go to,
 * create, run), and — live from the API as you type — the records, customers,
 * invoices and products this installation actually holds. Ranking is fuzzy, so
 * "nsub" finds "New subscription" and "pemb" finds Pemberton Auto Systems.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRightIcon, IconButton, Icons, Kbd, Modal, Spinner, useLocalStorage } from '../design';
import { rankEntries, pushRecent, type Rankable } from './shell-core';
import { useGlobalSearch } from './platform';
import type { SearchSource } from './search-core';
import { renderIcon, type IconRef } from './icon';

export type PaletteVerb = 'Go to' | 'Create' | 'Run' | 'Open';

export interface PaletteEntry extends Rankable {
  group: string;
  verb?: PaletteVerb;
  icon?: IconRef;
  shortcut?: string;
  /** Right-aligned hint — the destination path, a count, a status. */
  aside?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Verbs the app registers: navigation, create actions, runnable operations. */
  entries: PaletteEntry[];
  /** Live record sources, already filtered to the modules that are installed. */
  sources: SearchSource[];
  onOpenSearch: (query: string) => void;
}

/**
 * With nothing typed there is no evidence to rank on, so the registered verbs
 * lead in this order. The moment something *is* typed the order comes from the
 * match instead: type a customer's name and the customer is the first row, not
 * the third verb that happens to contain those letters.
 */
const GROUP_RANK: Record<string, number> = { Recent: 0, 'Go to': 1, Create: 2, Run: 3 };
const groupRank = (group: string): number => GROUP_RANK[group] ?? 10;

export function CommandPalette({ open, onClose, entries, sources, onOpenSearch }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useLocalStorage<string[]>('ain.palette.recent', []);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useGlobalSearch(query, sources, { perSource: 4, limit: 24 });

  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query, search.hits.length]);

  const recordEntries = useMemo<PaletteEntry[]>(() => search.groups.flatMap((group) => group.hits.map((hit) => ({
    id: `hit.${hit.type}.${hit.id}`,
    title: hit.title,
    subtitle: hit.subtitle,
    keywords: [hit.id, hit.typeLabel],
    group: group.source.label,
    verb: 'Open' as const,
    icon: hit.icon,
    aside: hit.href ? undefined : 'No screen yet',
    run: () => { if (hit.href) onOpenSearch(hit.href); else onOpenSearch(`/search?q=${encodeURIComponent(hit.title)}`); },
  }))), [search.groups, onOpenSearch]);

  const ranked = useMemo(() => {
    const all = [...entries, ...recordEntries];
    const list = rankEntries(all, query, recents);
    if (query.trim()) return list;
    // With nothing typed, the recent verbs lead and the rest keep registry order.
    const recentSet = new Set(recents);
    return [
      ...list.filter((entry) => recentSet.has(entry.id)).map((entry) => ({ ...entry, group: 'Recent' })),
      ...entries.filter((entry) => !recentSet.has(entry.id)),
    ];
  }, [entries, recordEntries, query, recents]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteEntry[]>();
    for (const entry of ranked) {
      const arr = map.get(entry.group);
      if (arr) arr.push(entry);
      else map.set(entry.group, [entry]);
    }
    const list = [...map.entries()].map(([label, items]) => ({ label, items }));
    // `ranked` is already sorted by how well each entry matched, so insertion
    // order *is* order-by-best-match. Re-sorting by a fixed group rank is what
    // pinned "Run · Advance the clock by a week" above an exact company hit.
    if (query.trim()) return list;
    return list.sort((a, b) => groupRank(a.label) - groupRank(b.label));
  }, [ranked, query]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    const container = listRef.current;
    const el = container?.querySelector<HTMLElement>('[data-active="true"]');
    if (!container || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < container.scrollTop + 28) container.scrollTop = Math.max(0, top - 32);
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 8;
  }, [active, flat.length]);

  const run = (entry: PaletteEntry) => {
    setRecents(pushRecent(recents, entry.id));
    onClose();
    entry.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(0, flat.length - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = flat[active];
      if (entry) run(entry);
      else if (query.trim()) { onClose(); onOpenSearch(`/search?q=${encodeURIComponent(query.trim())}`); }
    }
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} size="lg" flush showClose={false} className="pal-modal">
      <div className="pal">
        <div className="pal__search">
          <Icons.search size={20} style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={inputRef}
            className="pal__input"
            value={query}
            autoFocus
            placeholder="Go to, create or run anything…"
            aria-label="Command palette"
            role="combobox"
            aria-expanded
            aria-controls="ain-palette-list"
            aria-activedescendant={flat[active] ? `pal-${flat[active].id}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {search.loading && <Spinner size={14} label="Searching records" />}
          {query && (
            <IconButton
              size="sm"
              label="Clear the palette"
              icon={<Icons.x size={14} />}
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            />
          )}
        </div>

        <div className="pal__list" id="ain-palette-list" role="listbox" aria-label="Commands and records" ref={listRef}>
          {!flat.length && (
            <div className="pal__empty">
              <div className="pal__emptytitle">
                {search.failures.length && !search.hits.length
                  ? 'No record source could be searched'
                  : query.trim() ? <>Nothing matches “{query.trim()}”</> : 'No commands are registered yet'}
              </div>
              <p className="pal__emptybody">
                {search.failures.length && !search.hits.length
                  ? <>{search.failures[0].error.body.message}{search.failures[0].error.body.request_id ? ` · ${search.failures[0].error.body.request_id}` : ''}</>
                  : query.trim()
                    ? <>Press <Kbd>↵</Kbd> to search every record, customer and product for it instead.</>
                    : 'Modules register their own commands as they are installed.'}
              </p>
            </div>
          )}
          {groups.map((group) => (
            <div className="pal__group" key={group.label}>
              <div className="pal__grouphead">
                <span>{group.label}</span>
                <span className="pal__groupcount">{group.items.length}</span>
              </div>
              {group.items.map((entry) => {
                const index = flat.indexOf(entry);
                return (
                  <div
                    key={entry.id}
                    id={`pal-${entry.id}`}
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    className={`pal__item${index === active ? ' is-active' : ''}`}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => run(entry)}
                  >
                    <span className="pal__icon">{renderIcon(entry.icon, 15) ?? <ArrowRightIcon size={14} />}</span>
                    <span className="pal__text">
                      <span className="pal__title u-truncate">
                        {entry.verb && <span className="pal__verb">{entry.verb} </span>}
                        {entry.title}
                      </span>
                      {entry.subtitle && <span className="pal__sub u-truncate">{entry.subtitle}</span>}
                    </span>
                    <span className="pal__aside">
                      {entry.aside && <span className="pal__note">{entry.aside}</span>}
                      {entry.shortcut && <Kbd combo={entry.shortcut} />}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="pal__foot">
          <span className="pal__hint"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="pal__hint"><Kbd>↵</Kbd> run</span>
          <span className="pal__hint"><Kbd combo="esc" /> close</span>
          <span style={{ marginInlineStart: 'auto' }}>
            {search.failures.length ? (
              <span className="pal__failed" role="status">
                {search.failures.length} of {search.failures.length + search.groups.length} record{' '}
                {search.failures.length + search.groups.length === 1 ? 'source' : 'sources'} could not be searched
                {search.failures[0].error.body.request_id ? ` · ${search.failures[0].error.body.request_id}` : ''}
              </span>
            ) : query.trim()
              ? `${flat.length} ${flat.length === 1 ? 'result' : 'results'}`
              : `${entries.length} commands · records searched live`}
          </span>
        </div>
      </div>
    </Modal>
  );
}

export function paletteHint(): ReactNode {
  return <Kbd combo="mod+k" />;
}

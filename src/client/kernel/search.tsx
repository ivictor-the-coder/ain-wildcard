/**
 * Global search — a result surface, not a dropdown.
 *
 * Every installed module contributes a source; the type filter is built from
 * whatever answered. Results are keyboard-navigable from the query field, so
 * `/` → type → ↓ → ↵ never leaves the keyboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Card, EmptyState, ErrorState, Icons, Kbd, Page, Pill, PillGroup, Skeleton, Spinner,
  Stack, iconByName,
} from '../design';
import { Link, useRouter, useSearchParam } from './router';
import { usePlatform, useSearchSources, useGlobalSearch } from './platform';
import type { SearchHit } from './search-core';

export function SearchPage() {
  const { navigate } = useRouter();
  const [query, setQuery] = useSearchParam('q');
  const [type, setType] = useSearchParam('type');
  const [draft, setDraft] = useState(query);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const platform = usePlatform(true);
  const sources = useSearchSources(platform);
  const search = useGlobalSearch(draft, sources, { perSource: 12, limit: 120, delay: 200 });

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => {
    const id = setTimeout(() => { if (draft !== query) setQuery(draft || undefined); }, 300);
    return () => clearTimeout(id);
  }, [draft, query, setQuery]);
  useEffect(() => { setActive(0); }, [draft, type]);

  const groups = useMemo(
    () => (type ? search.groups.filter((group) => group.source.id === type) : search.groups),
    [search.groups, type],
  );
  const shown = useMemo(() => groups.flatMap((group) => group.hits), [groups]);
  // A hit whose object type has no screen on this workspace is still a real
  // match and is still shown — but it is not something ↵ can open, so it stays
  // out of the arrow-key set rather than being highlighted and then ignored.
  const visible = useMemo(() => shown.filter((hit) => hit.href), [shown]);
  const unopenable = shown.length - visible.length;

  useEffect(() => { setActive((i) => (i < visible.length ? i : 0)); }, [visible.length]);

  const open = (hit: SearchHit) => { if (hit.href) navigate(hit.href); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (visible.length ? Math.min(visible.length - 1, i + 1) : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const hit = visible[active]; if (hit) open(hit); }
  };

  const total = search.groups.reduce((n, group) => n + group.hits.length, 0);

  const hint = visible.length
    ? <span className="gsearch__meta"><Kbd>↑</Kbd><Kbd>↓</Kbd> move <Kbd>↵</Kbd> open</span>
    : unopenable
      ? <span className="gsearch__meta">Nothing here can be opened — no installed module registers a screen for these records</span>
      : undefined;

  return (
    <Page
      title="Search"
      subtitle={
        sources.length
          ? `Across ${sources.map((source) => source.label.toLowerCase()).join(', ')}.`
          : 'No searchable module is installed on this workspace yet.'
      }
      breadcrumbs={undefined}
      actions={hint}
    >
      <div className="gsearch">
        <div className="gsearch__field">
          <Icons.search size={18} style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={inputRef}
            className="gsearch__input"
            value={draft}
            placeholder="Search companies, contacts, deals, customers and the price book…"
            aria-label="Search everything"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {search.loading && <Spinner size={15} label="Searching" />}
        </div>

        {sources.length > 0 && (
          <PillGroup label="Filter results by type">
            <Pill active={!type} onClick={() => setType(undefined)} count={total || undefined}>Everything</Pill>
            {search.groups.map((group) => (
              <Pill
                key={group.source.id}
                active={type === group.source.id}
                count={group.hits.length}
                icon={renderSourceIcon(group.source.icon)}
                onClick={() => setType(type === group.source.id ? undefined : group.source.id)}
              >
                {group.source.label}
              </Pill>
            ))}
          </PillGroup>
        )}

        {search.loading && !shown.length && (
          <Card padding="tight">
            <Stack gap={4}>
              {[0, 1, 2, 3].map((row) => <Skeleton key={row} height={38} />)}
            </Stack>
          </Card>
        )}

        {/* A source that failed is not a source with nothing in it. Naming the
            ones that could not answer is the difference between "no matches"
            and "we did not look". */}
        {search.failures.map((failure) => (
          <Card key={failure.source.id} padding="tight">
            <ErrorState
              title={`${failure.source.label} could not be searched`}
              message={failure.error.body.message}
              code={failure.error.body.code}
              requestId={failure.error.body.request_id ?? null}
              action={
                <Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={search.retry}>
                  Try again
                </Button>
              }
            />
          </Card>
        ))}

        {!search.loading && draft.trim().length < 2 && (
          <EmptyState
            title="Type at least two characters"
            body="Search matches names, domains, email addresses, account ids and product names across every module installed on this workspace."
          />
        )}

        {!search.loading && draft.trim().length >= 2 && !shown.length && !search.failures.length && (
          <EmptyState
            title={`Nothing matches “${draft.trim()}”`}
            body="Try a company domain, part of an email address, or an object id such as cmp_ or cus_."
          />
        )}

        {groups.map((group) => {
          const openable = group.hits.some((hit) => hit.href);
          const count = `${group.hits.length} ${group.hits.length === 1 ? 'match' : 'matches'}`;
          return (
            <Card
              key={group.source.id}
              title={group.source.label}
              description={openable ? count : `${count} · no module on this workspace registers a screen for ${group.source.label.toLowerCase()}, so these cannot be opened yet`}
              padding="tight"
            >
              <div>
                {group.hits.map((hit) => {
                  const index = visible.indexOf(hit);
                  const inner = (
                    <>
                      <span className="gsearch__icon">{renderSourceIcon(hit.icon, 16)}</span>
                      <span className="gsearch__text">
                        <span className="gsearch__title u-truncate">{hit.title}</span>
                        {hit.subtitle && <span className="gsearch__sub u-truncate">{hit.subtitle}</span>}
                      </span>
                      <span className="gsearch__meta">
                        {!hit.href && <span className="gsearch__note">No screen installed</span>}
                        <Badge size="sm">{hit.typeLabel}</Badge>
                        <span className="u-mono">{hit.id}</span>
                      </span>
                    </>
                  );
                  return hit.href ? (
                    <Link
                      key={hit.id}
                      to={hit.href}
                      className={`gsearch__hit${index === active ? ' is-active' : ''}`}
                      onPointerEnter={() => setActive(index)}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={hit.id} className="gsearch__hit is-unopenable" aria-disabled="true">
                      {inner}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}

function renderSourceIcon(name: string, size = 14) {
  const Icon = iconByName(name);
  return <Icon size={size} />;
}

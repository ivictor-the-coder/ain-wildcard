import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  NAV_GROUP_ORDER, TIME_JUMPS, activeNavItem, avatarSrc, crumbsFor, describeOffset, eventSubject,
  eventTitle, fillParams, firstRegistered, fuzzyScore, greetingFor, groupNav, humanizeSegment,
  isPathActive, jumpBindings, normalizePath, orderSetup, pushRecent, rankEntries,
  pluralType, recordRouteCandidates, routeSetFrom, scoreEntry, serves, setupProgress, shortcutSheet,
  type SetupStep,
} from '../src/client/kernel/shell-core';
import { buildSources, hitsFrom, mergeHits, prettyValue, type CrmObjectType, type SearchHit } from '../src/client/kernel/search-core';
import type { NavItem } from '../src/client/kernel/registry-types';
import { DAY } from '../src/shared/time';

const nav = (id: string, label: string, to: string, group: NavItem['group'], order = 0): NavItem =>
  ({ id, label, to, group, order, icon: 'dashboard' });

describe('navigation grouping', () => {
  const items = [
    nav('invoices', 'Invoices', '/invoices', 'revenue', 20),
    nav('home', 'Home', '/', 'workspace', 0),
    nav('contacts', 'Contacts', '/contacts', 'crm', 10),
    nav('subs', 'Subscriptions', '/subscriptions', 'revenue', 10),
  ];

  it('orders groups the way the product reads, not the way modules load', () => {
    assert.deepEqual(groupNav(items).map((s) => s.group), ['workspace', 'crm', 'revenue']);
  });

  it('sorts inside a group by the order each module declared', () => {
    const revenue = groupNav(items).find((s) => s.group === 'revenue')!;
    assert.deepEqual(revenue.items.map((i) => i.id), ['subs', 'invoices']);
  });

  it('every group in the registry type has a defined position', () => {
    assert.equal(new Set(NAV_GROUP_ORDER).size, NAV_GROUP_ORDER.length);
  });
});

describe('active destination', () => {
  const items = [nav('home', 'Home', '/', 'workspace'), nav('subs', 'Subscriptions', '/billing/subscriptions', 'revenue'), nav('billing', 'Billing', '/billing', 'revenue')];

  it('home only matches home — otherwise every page would look like the dashboard', () => {
    assert.equal(isPathActive('/billing', '/'), false);
    assert.equal(isPathActive('/', '/'), true);
  });

  it('a section stays active on its own detail pages', () => {
    assert.equal(isPathActive('/billing/subscriptions/sub_123', '/billing/subscriptions'), true);
  });

  it('does not treat a shared prefix as the same section', () => {
    assert.equal(isPathActive('/billingtools', '/billing'), false);
  });

  it('picks the deepest matching destination', () => {
    assert.equal(activeNavItem(items, '/billing/subscriptions/sub_1')?.id, 'subs');
    assert.equal(activeNavItem(items, '/billing')?.id, 'billing');
    assert.equal(activeNavItem(items, '/nowhere'), null);
  });

  it('ignores a trailing slash and a query string', () => {
    assert.equal(normalizePath('/billing/?tab=open'), '/billing');
  });
});

describe('breadcrumbs', () => {
  const resolve = (prefix: string) => ({ '/billing': 'Billing', '/billing/invoices': 'Invoices' } as Record<string, string>)[prefix] ?? null;

  it('reflects the real route, one crumb per segment', () => {
    const crumbs = crumbsFor('/billing/invoices/in_1A2b3C4d', resolve);
    assert.deepEqual(crumbs.map((c) => c.label), ['Home', 'Billing', 'Invoices', 'in_1A2b3C4d']);
  });

  it('leaves the last crumb unlinked and links the rest', () => {
    const crumbs = crumbsFor('/billing/invoices', resolve);
    assert.deepEqual(crumbs.map((c) => c.to), ['/', '/billing', undefined]);
  });

  it('is just the workspace at the root', () => {
    assert.deepEqual(crumbsFor('/', resolve), [{ label: 'Home' }]);
  });

  it('humanises an unknown segment but never mangles an object id', () => {
    assert.equal(humanizeSegment('credit-grants'), 'Credit grants');
    assert.equal(humanizeSegment('cus_41HQyVx5ej9CKy3F'), 'cus_41HQyVx5ej9CKy3F');
  });
});

describe('palette ranking', () => {
  const entries = [
    { id: 'a', title: 'Subscriptions', group: 'Go to' },
    { id: 'b', title: 'New subscription', group: 'Create' },
    { id: 'c', title: 'Invoice reminder settings', group: 'Go to', keywords: ['dunning'] },
    { id: 'd', title: 'Invoices', group: 'Go to' },
  ];

  it('matches a subsequence, not just a substring', () => {
    assert.equal(rankEntries(entries, 'nsub')[0].id, 'b');
  });

  it('prefers the shorter title when both start with the query', () => {
    assert.equal(rankEntries(entries, 'invoice')[0].id, 'd');
  });

  it('finds an entry through its keywords', () => {
    assert.deepEqual(rankEntries(entries, 'dunning').map((e) => e.id), ['c']);
  });

  it('drops entries the query cannot reach at all', () => {
    assert.deepEqual(rankEntries(entries, 'zzz'), []);
  });

  it('scores a prefix above a mid-word hit', () => {
    assert.ok(fuzzyScore('Invoices', 'inv') > fuzzyScore('Reinvoice', 'inv'));
  });

  it('scores a word-boundary hit above a buried one', () => {
    assert.ok(fuzzyScore('New subscription', 'sub') > fuzzyScore('Resubmission', 'sub'));
  });

  it('discounts a subtitle match below a title match', () => {
    const byTitle = scoreEntry({ id: '1', title: 'Dunning' }, 'dunning');
    const bySubtitle = scoreEntry({ id: '2', title: 'Retries', subtitle: 'Dunning' }, 'dunning');
    assert.ok(byTitle > bySubtitle);
  });

  it('floats recent commands with no query typed', () => {
    assert.equal(rankEntries(entries, '', ['c'])[0].id, 'c');
  });

  it('recency only breaks ties, it never beats a better match', () => {
    assert.equal(rankEntries(entries, 'new sub', ['d'])[0].id, 'b');
  });

  it('keeps the recent list de-duplicated, newest first and bounded', () => {
    let recents: string[] = [];
    for (const id of ['a', 'b', 'c', 'a']) recents = pushRecent(recents, id, 3);
    assert.deepEqual(recents, ['a', 'c', 'b']);
  });
});

describe('go-to key map', () => {
  const items = [
    nav('home', 'Home', '/', 'workspace'),
    nav('contacts', 'Contacts', '/contacts', 'crm'),
    nav('companies', 'Companies', '/companies', 'crm'),
    nav('goals', 'Goals', '/goals', 'insights'),
  ];

  it('gives every destination its own letter', () => {
    const keys = jumpBindings(items).map((b) => b.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('never hands out `g`, which starts the sequence', () => {
    assert.equal(jumpBindings(items).some((b) => b.key === 'g'), false);
    assert.equal(jumpBindings(items).find((b) => b.item.id === 'goals')?.key, 'a');
  });

  it('prefers the first letter of the label', () => {
    assert.equal(jumpBindings(items).find((b) => b.item.id === 'home')?.key, 'h');
    assert.equal(jumpBindings(items).find((b) => b.item.id === 'companies')?.key, 'o');
  });

  it('publishes every binding in the shortcut sheet', () => {
    const rows = shortcutSheet(jumpBindings(items)).flatMap((group) => group.rows);
    assert.ok(rows.some((row) => row.keys.join('+') === 'mod+k'));
    assert.equal(rows.filter((row) => row.keys[0] === 'g').length, items.length);
  });
});

describe('time machine presets', () => {
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);

  it('offers a day, a week, a billing cycle and a quarter', () => {
    assert.deepEqual(TIME_JUMPS.map((j) => j.id), ['day', 'week', 'cycle', 'quarter']);
  });

  it('moves a cycle by calendar month, not by 30 days', () => {
    const cycle = TIME_JUMPS.find((j) => j.id === 'cycle')!;
    assert.equal(new Date(cycle.at(now)).toISOString(), '2026-02-28T12:00:00.000Z');
  });

  it('every preset lands strictly in the future', () => {
    for (const jump of TIME_JUMPS) assert.ok(jump.at(now) > now, jump.id);
  });

  it('describes the offset the way the chip reads it', () => {
    assert.equal(describeOffset(3 * DAY), '3 days ahead of real time');
    assert.equal(describeOffset(-1 * DAY), '1 day behind real time');
    assert.equal(describeOffset(20_000), 'in step with real time');
  });
});

describe('route availability', () => {
  const map = {
    modules: [
      { routes: ['GET /v1/customers', 'POST /v1/customers'] },
      { routes: ['GET /v1/records/:type'] },
    ],
  };

  it('reads what the running server serves, method included', () => {
    const routes = routeSetFrom(map);
    assert.equal(serves(routes, 'get', '/v1/customers'), true);
    assert.equal(serves(routes, 'DELETE', '/v1/customers'), false);
    assert.equal(serves(routes, 'GET', '/v1/invoices'), false);
  });

  it('survives a map from a server that reports nothing', () => {
    assert.equal(routeSetFrom(undefined).size, 0);
  });

  it('only links a record to a screen some module registered', () => {
    const registered = ['/', '/companies', '/companies/:id'];
    assert.equal(firstRegistered(registered, recordRouteCandidates('company')), '/companies/:id');
    assert.equal(firstRegistered(registered, recordRouteCandidates('deal')), null);
  });

  it('pluralises the object type the way a route would be named', () => {
    assert.equal(pluralType('company'), 'companies');
    assert.equal(pluralType('deal'), 'deals');
    assert.equal(pluralType('address'), 'addresses');
  });

  it('fills the id into the pattern, escaped', () => {
    assert.equal(fillParams('/companies/:id', 'cmp nw/07'), '/companies/cmp%20nw%2F07');
  });
});

describe('search sources', () => {
  const objectTypes: CrmObjectType[] = [
    { name: 'company', label: 'Company', plural_label: 'Companies', icon: 'building', category: 'record', primary_property: 'name', secondary_property: 'domain' },
    { name: 'note', label: 'Note', plural_label: 'Notes', icon: 'note', category: 'activity', primary_property: 'body', secondary_property: null },
  ];
  const routes = new Set(['GET /v1/records/:type', 'GET /v1/customers']);
  const build = () => buildSources({ objectTypes, routes, registered: ['/companies/:id'] });

  it('offers a source only for a module that is installed', () => {
    assert.deepEqual(build().map((s) => s.id), ['company', 'customer']);
  });

  it('never offers a source whose route would 404', () => {
    assert.equal(build().some((s) => s.id === 'invoice'), false);
  });

  it('uses each route’s own free-text parameter', () => {
    assert.equal(build().find((s) => s.id === 'company')!.queryKey, 'q');
    assert.equal(build().find((s) => s.id === 'customer')!.queryKey, 'query');
  });

  it('skips activity types — nobody searches for "a note"', () => {
    assert.equal(build().some((s) => s.id === 'note'), false);
  });

  it('maps a record through the schema’s own primary and secondary property', () => {
    const source = build().find((s) => s.id === 'company')!;
    const hits = hitsFrom(source, [{
      id: 'cmp_nw_07',
      display_name: 'Pemberton Auto Systems',
      properties: { name: 'Pemberton Auto Systems', domain: 'pembertonauto.com' },
    }], 'pemb');
    assert.deepEqual(hits, [{
      id: 'cmp_nw_07',
      type: 'company',
      typeLabel: 'Company',
      title: 'Pemberton Auto Systems',
      subtitle: 'pembertonauto.com',
      href: '/companies/cmp_nw_07',
      icon: 'building',
    }]);
  });

  it('drops rows a route returned without honouring the query', () => {
    const source = build().find((s) => s.id === 'customer')!;
    const rows = [{ id: 'cus_1', name: 'Cobalt Line Automation' }, { id: 'cus_2', name: 'Puebla Autopartes' }];
    assert.deepEqual(hitsFrom(source, rows, 'cobalt').map((h) => h.id), ['cus_1']);
  });

  it('leaves a hit unlinked when no module has a screen for it', () => {
    const source = buildSources({ objectTypes, routes, registered: [] }).find((s) => s.id === 'company')!;
    assert.equal(hitsFrom(source, [{ id: 'cmp_1', display_name: 'Acme' }], '')[0].href, null);
  });

  it('reads a stored enum as a sentence and leaves everything else alone', () => {
    assert.equal(prettyValue('closed_won'), 'Closed won');
    assert.equal(prettyValue('pembertonauto.com'), 'pembertonauto.com');
    assert.equal(prettyValue('ap@cobaltline.com'), 'ap@cobaltline.com');
    assert.equal(prettyValue('VP of Revenue Operations'), 'VP of Revenue Operations');
  });

  it('interleaves sources so one big table cannot crowd out the rest', () => {
    const hit = (id: string): SearchHit => ({ id, type: 't', typeLabel: 'T', title: id, href: null, icon: 'x' });
    const merged = mergeHits([[hit('a1'), hit('a2'), hit('a3')], [hit('b1')], [hit('c1'), hit('c2')]], 5);
    assert.deepEqual(merged.map((h) => h.id), ['a1', 'b1', 'c1', 'a2', 'c2']);
  });
});

describe('event log copy', () => {
  it('turns a dotted event type into a sentence', () => {
    assert.equal(eventTitle('credit_grant.expired'), 'Credit grant expired');
    assert.equal(eventTitle('invoice.payment_failed'), 'Invoice payment failed');
  });

  it('keeps domain acronyms upper-case', () => {
    assert.equal(eventTitle('ai.run_completed'), 'AI run completed');
    assert.equal(eventTitle('api_key.revoked'), 'API key revoked');
  });

  it('digs the most human name out of a nested payload', () => {
    assert.equal(eventSubject({ grant: { name: 'Telemetry pack — trial prepay', balance: 0 } }), 'Telemetry pack — trial prepay');
    assert.equal(eventSubject({ customer: { email: 'ap@cobaltline.com' } }), 'ap@cobaltline.com');
  });

  it('says nothing rather than printing a blob', () => {
    assert.equal(eventSubject({ amount: 1200, currency: 'usd' }), null);
    assert.equal(eventSubject(null), null);
  });
});

describe('setup checklist', () => {
  const steps: SetupStep[] = [
    { id: 'a', label: 'A', detail: '', done: true },
    { id: 'b', label: 'B', detail: '', done: false },
    { id: 'c', label: 'C', detail: '', done: true },
  ];

  it('puts what is left to do first', () => {
    assert.deepEqual(orderSetup(steps).map((s) => s.id), ['b', 'a', 'c']);
  });

  it('reports progress as a fraction, and copes with an empty list', () => {
    assert.equal(setupProgress(steps), 2 / 3);
    assert.equal(setupProgress([]), 0);
  });
});

describe('workspace niceties', () => {
  it('greets by the workspace clock, not the browser clock', () => {
    const nineAmNewYork = Date.UTC(2026, 7, 31, 13, 0, 0);
    assert.equal(greetingFor(nineAmNewYork, 'America/New_York'), 'Good morning');
    assert.equal(greetingFor(nineAmNewYork, 'Asia/Tokyo'), 'Good evening');
  });

  it('only treats a real image address as an avatar image', () => {
    assert.equal(avatarSrc('color:#5B4BE1'), undefined);
    assert.equal(avatarSrc(null), undefined);
    assert.equal(avatarSrc('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
    assert.equal(avatarSrc('/uploads/a.png'), '/uploads/a.png');
  });
});

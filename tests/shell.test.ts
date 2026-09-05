import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  NAV_GROUP_ORDER, TIME_JUMPS, activeNavItem, avatarSrc, civilDayStart, crumbsFor, describeOffset, eventSubject,
  eventTitle, fillParams, firstRegistered, fuzzyScore, greetingFor, groupNav, humanizeSegment,
  isPathActive, jumpBindings, jumpDays, jumpTarget, navLabelIndex, normalizePath, orderSetup, pushRecent, rankEntries,
  pluralType, recordRouteCandidates, routeSetFrom, scoreEntry, serves, setupProgress, shortcutSheet, withCurrentLabel,
  type SetupStep,
} from '../src/client/kernel/shell-core';
import {
  buildSources, hitsFrom, mergeHits, prettyValue, typeaheadTargets,
  type CrmObjectType, type SearchHit, type SearchSource,
} from '../src/client/kernel/search-core';
import { creditOutstanding, type CreditPot } from '../src/client/modules/home/home-core';
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

/* ============================ dashboard tiles ============================= */

describe('prepaid credit tile', () => {
  const pot = (currency: string, amount: number, display: string, unit_pots = 0): CreditPot =>
    ({ currency, monetary_outstanding: amount, unit_pots, monetary_outstanding_display: display });

  // The exact payload GET /v1/credits/overview returns for the demo workspace:
  // pots sorted alphabetically, so the empty GBP pot sorts first.
  const northwind = [pot('gbp', 0, '£0.00', 1), pot('usd', 125000, '$1,250.00', 1)];

  it('shows the workspace currency, not whichever pot the server listed first', () => {
    const chosen = creditOutstanding(northwind, 'usd');
    assert.equal(chosen.pot?.currency, 'usd');
    assert.equal(chosen.pot?.monetary_outstanding_display, '$1,250.00');
    // The regression this replaced: outstanding[0] is the empty GBP pot.
    assert.equal(northwind[0].monetary_outstanding_display, '£0.00');
    assert.notEqual(chosen.pot, northwind[0]);
  });

  it('says nothing extra when the workspace currency is the only pot holding money', () => {
    assert.equal(creditOutstanding(northwind, 'usd').note, null);
    assert.deepEqual(creditOutstanding(northwind, 'usd').others, []);
  });

  it('counts unit grants across every currency, because money cannot express them', () => {
    assert.equal(creditOutstanding(northwind, 'usd').unitGrants, 2);
  });

  it('keeps the workspace currency even when another pot holds more', () => {
    const pots = [pot('eur', 900000, '€9,000.00'), pot('usd', 5000, '$50.00')];
    const chosen = creditOutstanding(pots, 'usd');
    assert.equal(chosen.pot?.currency, 'usd');
    assert.equal(chosen.isDefaultCurrency, true);
    assert.equal(chosen.note, 'plus €9,000.00 in EUR');
  });

  it('falls back to the largest pot when the workspace currency holds nothing, and says so', () => {
    const pots = [pot('eur', 9000, '€90.00'), pot('gbp', 41200, '£412.00'), pot('usd', 0, '$0.00')];
    const chosen = creditOutstanding(pots, 'usd');
    assert.equal(chosen.pot?.currency, 'gbp');
    assert.equal(chosen.isDefaultCurrency, false);
    assert.equal(chosen.note, 'shown in GBP — no USD credit is outstanding · plus €90.00 in EUR');
  });

  it('ranks pots in major units, so ¥100,000 outranks $5,000', () => {
    const pots = [pot('jpy', 100000, '¥100,000'), pot('usd', 500000, '$5,000.00')];
    assert.equal(creditOutstanding(pots, 'chf').pot?.currency, 'jpy');
  });

  it('names two other currencies and counts the rest', () => {
    const pots = [
      pot('usd', 100, '$1.00'), pot('gbp', 41200, '£412.00'),
      pot('eur', 9000, '€90.00'), pot('cad', 800, 'CA$8.00'), pot('aud', 700, 'A$7.00'),
    ];
    assert.equal(
      creditOutstanding(pots, 'usd').note,
      'plus £412.00 in GBP, €90.00 in EUR and 2 more currencies',
    );
    assert.equal(creditOutstanding(pots.slice(0, 4), 'usd').note?.endsWith('and 1 more currency'), true);
  });

  it('shows the workspace’s own zero when every pot is empty', () => {
    const chosen = creditOutstanding([pot('gbp', 0, '£0.00', 1), pot('usd', 0, '$0.00')], 'usd');
    assert.equal(chosen.pot?.currency, 'usd');
    assert.equal(chosen.isDefaultCurrency, true);
    assert.equal(chosen.note, null);
  });

  it('has no pot to show when the credits module returned none', () => {
    assert.deepEqual(creditOutstanding([], 'usd'), { pot: null, isDefaultCurrency: true, others: [], unitGrants: 0, note: null });
    assert.equal(creditOutstanding(undefined, 'usd').pot, null);
  });

  it('matches currencies by code, not by case or stray spacing', () => {
    const pots = [pot('GBP', 0, '£0.00'), pot(' usd ', 125000, '$1,250.00')];
    assert.equal(creditOutstanding(pots, 'USD').pot?.monetary_outstanding_display, '$1,250.00');
    assert.equal(creditOutstanding(pots, 'USD').isDefaultCurrency, true);
  });

  it('does not invent a workspace currency when the session has not loaded one', () => {
    const chosen = creditOutstanding([pot('gbp', 41200, '£412.00')], undefined);
    assert.equal(chosen.pot?.currency, 'gbp');
    assert.equal(chosen.isDefaultCurrency, true);
    assert.equal(chosen.note, null);
  });
});

/* ============================= search typeahead ============================ */

describe('top-bar typeahead', () => {
  const source = (id: string, label: string): SearchSource => ({
    id, label, singular: label, icon: 'building', requires: `GET /v1/${id}`, path: `/v1/${id}`,
    queryKey: 'q', detailPattern: null, map: (row) => ({ id: String(row.id), title: String(row.id) }),
  });
  const hit = (type: string, id: string, href: string | null): SearchHit =>
    ({ id, type, typeLabel: type, title: id, href, icon: 'building' });

  const groups = [
    { source: source('company', 'Companies'), hits: [hit('company', 'cmp_1', '/companies/cmp_1'), hit('company', 'cmp_2', null)] },
    { source: source('invoice', 'Invoices'), hits: [hit('invoice', 'in_9', '/invoices/in_9')] },
  ];

  it('puts every openable hit under the highlight, in painted order', () => {
    assert.deepEqual(
      typeaheadTargets(groups, 'north').slice(0, 2).map((t) => t.href),
      ['/companies/cmp_1', '/invoices/in_9'],
    );
  });

  it('never highlights a record no installed module can open', () => {
    assert.equal(typeaheadTargets(groups, 'north').some((t) => t.hit?.id === 'cmp_2'), false);
  });

  it('always ends on the full search page, so the four-per-source cap is never the whole answer', () => {
    const targets = typeaheadTargets(groups, 'north');
    assert.equal(targets.length, 3);
    assert.deepEqual(targets[2], { id: 'everything', href: '/search?q=north', hit: null });
  });

  it('escapes the query it hands to the results page', () => {
    assert.equal(typeaheadTargets([], 'a&b c').at(-1)!.href, '/search?q=a%26b%20c');
  });

  it('offers the results page even when nothing matched', () => {
    assert.deepEqual(typeaheadTargets([], 'zzz').map((t) => t.id), ['everything']);
  });

  it('has no page to offer when nothing was typed', () => {
    assert.deepEqual(typeaheadTargets(groups, '   ').map((t) => t.id), ['company:cmp_1', 'invoice:in_9']);
    assert.deepEqual(typeaheadTargets([], ''), []);
  });
});

/* ============================ one product, one seam ======================== */

describe('record screens name the crumb through the shell', () => {
  it('a child that shares its section’s path does not rename the section', () => {
    const copilot: NavItem = {
      ...nav('copilot', 'Copilot', '/copilot', 'automation'),
      children: [
        { id: 'threads', label: 'Conversations', to: '/copilot' },
        { id: 'runs', label: 'Runs & traces', to: '/copilot/runs' },
      ],
    };
    const index = navLabelIndex([copilot, nav('revenue', 'Revenue', '/revenue', 'insights')]);
    // The old shell wrote children after parents into one map, so `/copilot`
    // read "Conversations" and the trail for the runs screen lost "Copilot".
    assert.equal(index.get('/copilot'), 'Copilot');
    assert.equal(index.get('/copilot/runs'), 'Runs & traces');
    assert.equal(index.get('/revenue'), 'Revenue');
  });

  it('the record’s name replaces only the current crumb, and a blank name changes nothing', () => {
    const trail = crumbsFor('/deals/deal_nw_58', () => null);
    const named = withCurrentLabel(trail, 'Kaskade Pharma Group — pilot');
    assert.deepEqual(named.map((c) => c.label), ['Home', 'Deals', 'Kaskade Pharma Group — pilot']);
    assert.equal(named[1].to, '/deals', 'the parents stay links');
    assert.equal(named[2].to, undefined, 'you are already there');
    assert.deepEqual(withCurrentLabel(trail, '  '), trail);
    assert.deepEqual(withCurrentLabel(trail, null), trail);
    assert.deepEqual(withCurrentLabel([], 'x'), []);
  });
});

describe('time machine date picker', () => {
  const NY = 'America/New_York';
  const inNy = (ts: number) => new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);

  it('lands on the day that was picked, at the workspace’s own time of day', () => {
    const now = Date.UTC(2026, 8, 3, 15, 33); // Sep 3, 11:33 in New York
    const picked = Date.UTC(2026, 8, 4); // what the calendar hands back for "Sep 4"
    const target = jumpTarget(picked, now, NY);
    // Jumping to the raw midnight-UTC instant read "Sep 3" on the chip and
    // offered "Run 0 days of work" beside a picker showing Sep 4.
    assert.equal(inNy(target), '2026-09-04');
    assert.equal(target - now, DAY);
    assert.equal(jumpDays(target, now, NY), 1);
    assert.equal(jumpDays(jumpTarget(Date.UTC(2026, 8, 10), now, NY), now, NY), 7);
  });

  it('holds across the UTC midnight that New York evenings sit past', () => {
    const now = Date.UTC(2026, 8, 4, 2, 0); // still Sep 3, 10pm in New York
    assert.equal(inNy(now), '2026-09-03');
    // The civil-day marker is a UTC calendar day — the currency the picker deals in.
    assert.equal(new Date(civilDayStart(now, NY)).toISOString().slice(0, 10), '2026-09-03');
    const target = jumpTarget(Date.UTC(2026, 8, 5), now, NY);
    assert.equal(inNy(target), '2026-09-05');
    assert.equal(jumpDays(target, now, NY), 2);
  });
});

/**
 * Seams that were closed by hand are kept closed by reading the modules'
 * source. Every check below failed on the code it replaced.
 */
describe('the modules stay one product', () => {
  const root = join(process.cwd(), 'src', 'client');
  const modulesDir = join(root, 'modules');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|css)$/.test(name) ? [full] : [];
  });
  // The style guide renders the kit for its own sake; it is not a screen.
  const moduleFiles = walk(modulesDir).filter((file) => !file.includes(`${join('modules', 'design-lab')}`));
  const routeFiles = moduleFiles.filter((file) => file.endsWith('routes.tsx'));
  const source = (file: string) => readFileSync(file, 'utf8');
  const rel = (file: string) => file.slice(root.length + 1);

  it('no screen draws its own breadcrumb or reaches into the shell’s', () => {
    // Each record page used to solve the crumb on its own — a DOM patch, a
    // second trail inside the page, a slash-separated line. `useCurrentCrumb`
    // is the one way; anything else is the seam coming back.
    const offenders = moduleFiles.filter((file) => {
      const text = source(file);
      return /\bBreadcrumbs\b/.test(text) || /aria-label="Breadcrumb"/.test(text) || /\bbreadcrumbs=/.test(text);
    });
    assert.deepEqual(offenders.map(rel), []);
  });

  it('palette commands only use the three verbs the palette groups by', () => {
    // A command in a group called "Revenue" sat under a noun heading beside
    // "Go to", "Create" and "Run", and ranked by a rule the palette did not know.
    const bad: string[] = [];
    for (const file of routeFiles) {
      const block = /export const commands[\s\S]*?\n\];/.exec(source(file))?.[0] ?? '';
      for (const match of block.matchAll(/group:\s*'([^']+)'/g)) {
        if (!['Go to', 'Create', 'Run'].includes(match[1])) bad.push(`${rel(file)}: ${match[1]}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('no module registers a "Go to" command for a destination the nav already lists', () => {
    // The shell derives "Go to <label>" for every nav item and child, so a
    // module command for the same address put the destination in the palette
    // twice under two names — "Go to Deals" and "Deals", "Go to Tax" and "Tax".
    const destinations = new Set<string>();
    for (const file of routeFiles) {
      const block = /export const nav[\s\S]*?\n\];/.exec(source(file))?.[0] ?? '';
      for (const match of block.matchAll(/\bto:\s*'([^']+)'/g)) destinations.add(normalizePath(match[1]));
    }
    assert.ok(destinations.has('/deals') && destinations.has('/billing'), 'the nav was read');
    const duplicates: string[] = [];
    for (const file of routeFiles) {
      const block = /export const commands[\s\S]*?\n\];/.exec(source(file))?.[0] ?? '';
      const goTo = /group:\s*'Go to'[\s\S]*?run:\s*\(\s*\w+\s*\)\s*=>\s*\w+\(\s*['`]([^'`?]+)(\?[^'`]*)?['`]\s*\)/g;
      for (const match of block.matchAll(goTo)) {
        if (!match[2] && destinations.has(normalizePath(match[1]))) duplicates.push(`${rel(file)}: ${match[1]}`);
      }
    }
    assert.deepEqual(duplicates, []);
  });

  it('activity is marked read on the workspace clock, never the machine’s', () => {
    // Events are stamped on the workspace clock; after a jump forward, a
    // read-marker taken from `Date.now()` left every one of them unread.
    const shell = readFileSync(join(root, 'kernel', 'shell.tsx'), 'utf8');
    assert.doesNotMatch(shell, /setReadAt\(\s*Date\.now\(\)/);
  });

  it('every status pill the revenue screens draw comes from the one map', () => {
    // Revenue used to carry its own tone table, so a "Scheduled" grant was an
    // amber chip on Credits and a neutral pill on the customer's page.
    const revenueCommon = source(join(modulesDir, 'revenue', 'common.tsx'));
    assert.doesNotMatch(revenueCommon, /function StatusChip/);
    assert.match(revenueCommon, /StatusPill as StatusChip.*from '\.\.\/billing\/common'/);
  });
});

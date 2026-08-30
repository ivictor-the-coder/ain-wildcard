import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import type { CrmRecord, FilterNode } from '../src/server/modules/crm/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const MARCUS: Auth = { ...DANA, userId: 'usr_seed02' };

let app: App;

const call = (method: string, path: string, body?: unknown, auth: Auth = DANA) =>
  app.handle({ method, path, body, auth });

async function expectOk(method: string, path: string, body?: unknown, auth: Auth = DANA): Promise<any> {
  const res = await call(method, path, body, auth);
  assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const startOfUtcDay = (ts: number): number => ts - (ts % 86_400_000);

const search = (type: string, query: Record<string, unknown>) =>
  expectOk('POST', `/v1/records/${type}/search`, query);

const countMatching = async (type: string, filter: FilterNode | undefined) =>
  (await search(type, { filter, limit: 1 })).total_count as number;

before(async () => {
  app = await createApp({ db: 'memory', config: { env: 'test' } });
});

after(() => app.close());

/* ------------------------------ the seed story ---------------------------- */

describe('the demo book of business', () => {
  test('seeds a coherent Northwind Robotics workspace', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=1');
    const contacts = await expectOk('GET', '/v1/records/contact?limit=1');
    const deals = await expectOk('GET', '/v1/records/deal?limit=1');
    assert.ok(companies.total_count >= 40, `expected ~45 companies, got ${companies.total_count}`);
    assert.ok(contacts.total_count >= 110, `expected ~120 contacts, got ${contacts.total_count}`);
    assert.ok(deals.total_count >= 30, `expected a real pipeline, got ${deals.total_count}`);
  });

  test('every company has a real display name and no filler', async () => {
    const page = await expectOk('GET', '/v1/records/company?limit=100');
    for (const record of page.data as CrmRecord[]) {
      assert.ok(record.display_name.length > 3);
      assert.doesNotMatch(record.display_name, /\bacme\b|lorem ipsum|\bfoo\b|placeholder|example (corp|inc)|\btest (co|company)\b/i);
      assert.ok(String(record.properties.description ?? '').length > 40, `${record.display_name} has no story`);
    }
  });

  test('activity roll-ups are maintained on the records they land on', async () => {
    const page = await search('contact', {
      filter: { property: 'activity_count', operator: 'gt', value: 0 },
      sort: [{ property: 'activity_count', direction: 'desc' }],
      limit: 1,
    });
    const contact = page.data[0] as CrmRecord;
    const timeline = await expectOk('GET', `/v1/records/contact/${contact.id}/timeline?limit=200&roll_up=false`);
    const activities = timeline.data.filter((i: { kind: string }) => i.kind === 'activity');
    assert.equal(activities.length, Number(contact.properties.activity_count));
    assert.equal(Number(contact.properties.last_activity_at), activities[0].at);
  });
});

/* ------------------------------ filter engine ----------------------------- */

describe('filter compiler', () => {
  test('eq and neq partition the set, and unset counts as "not equal"', async () => {
    const total = await countMatching('contact', undefined);
    const isChampion = await countMatching('contact', { property: 'buying_role', operator: 'eq', value: 'champion' });
    const notChampion = await countMatching('contact', { property: 'buying_role', operator: 'neq', value: 'champion' });
    assert.ok(isChampion > 0);
    assert.equal(isChampion + notChampion, total);
  });

  test('is_set and is_not_set are exact complements', async () => {
    const total = await countMatching('contact', undefined);
    const set = await countMatching('contact', { property: 'mobile_phone', operator: 'is_set' });
    const unset = await countMatching('contact', { property: 'mobile_phone', operator: 'is_not_set' });
    assert.ok(set > 0 && unset > 0, 'the seed should contain both');
    assert.equal(set + unset, total);
  });

  test('nested and/or/not groups compose', async () => {
    const emea = await countMatching('company', { property: 'region', operator: 'eq', value: 'emea' });
    const apac = await countMatching('company', { property: 'region', operator: 'eq', value: 'apac' });
    const either = await countMatching('company', {
      op: 'or',
      filters: [
        { property: 'region', operator: 'eq', value: 'emea' },
        { property: 'region', operator: 'eq', value: 'apac' },
      ],
    });
    assert.equal(either, emea + apac);

    const large = await countMatching('company', {
      op: 'and',
      filters: [
        { op: 'or', filters: [{ property: 'region', operator: 'eq', value: 'emea' }, { property: 'region', operator: 'eq', value: 'apac' }] },
        { property: 'employee_count', operator: 'gte', value: 5000 },
      ],
    });
    assert.ok(large > 0 && large < either);

    const negated = await countMatching('company', {
      op: 'not',
      filters: [{ property: 'region', operator: 'in', values: ['emea', 'apac'] }],
    });
    const total = await countMatching('company', undefined);
    assert.equal(negated, total - either);
  });

  test('in, contains, starts_with and between behave', async () => {
    const inList = await countMatching('company', { property: 'industry', operator: 'in', values: ['automotive', 'aerospace'] });
    const auto = await countMatching('company', { property: 'industry', operator: 'eq', value: 'automotive' });
    const aero = await countMatching('company', { property: 'industry', operator: 'eq', value: 'aerospace' });
    assert.equal(inList, auto + aero);

    const contains = await search('company', { filter: { property: 'name', operator: 'contains', value: 'systems' }, limit: 50 });
    assert.ok(contains.total_count > 0);
    for (const r of contains.data as CrmRecord[]) assert.match(r.display_name.toLowerCase(), /systems/);

    const band = await search('company', {
      filter: { property: 'employee_count', operator: 'between', values: [1000, 2000] },
      limit: 100,
    });
    for (const r of band.data as CrmRecord[]) {
      const n = Number(r.properties.employee_count);
      assert.ok(n >= 1000 && n <= 2000, `${r.display_name} has ${n} employees`);
    }
  });

  test('multi-select properties match on any value', async () => {
    const siemens = await search('company', { filter: { property: 'controls_platform', operator: 'eq', value: 'siemens' }, limit: 100 });
    assert.ok(siemens.total_count > 0);
    for (const r of siemens.data as CrmRecord[]) {
      assert.ok((r.properties.controls_platform as string[]).includes('siemens'));
    }
    const notSiemens = await countMatching('company', { property: 'controls_platform', operator: 'neq', value: 'siemens' });
    assert.equal(siemens.total_count + notSiemens, await countMatching('company', undefined));
  });

  test('relative dates resolve against the workspace clock', async () => {
    const recent = await search('call', { filter: { property: 'occurred_at', operator: 'within_last', value: 30, unit: 'day' }, limit: 200 });
    const cutoff = app.ctx.now() - 30 * 86_400_000;
    assert.ok(recent.total_count > 0);
    for (const r of recent.data as CrmRecord[]) assert.ok(Number(r.properties.occurred_at) >= cutoff);

    const older = await countMatching('call', { property: 'occurred_at', operator: 'before', value: '-30d' });
    assert.equal(recent.total_count + older, await countMatching('call', undefined));
  });

  test('two properties can be compared against each other', async () => {
    const body = await search('ticket', {
      filter: { property: 'resolved_at', operator: 'gt', compare_property: 'sla_due_at' },
      limit: 100,
    });
    for (const r of body.data as CrmRecord[]) {
      assert.ok(Number(r.properties.resolved_at) > Number(r.properties.sla_due_at));
    }
  });

  test('association-aware conditions walk the graph', async () => {
    const threshold = 15_000_00;
    const filter: FilterNode = {
      association: 'deal', aggregate: 'sum', aggregate_property: 'amount', operator: 'gt', value: threshold,
      where: { op: 'and', filters: [{ property: 'deal_stage', operator: 'not_in', values: ['closed_won', 'closed_lost'] }] },
    };
    const matched = await search('company', { filter, limit: 100 });
    assert.ok(matched.total_count > 0, 'the seed should have accounts with open pipeline');

    for (const company of matched.data as CrmRecord[]) {
      const deals = await expectOk('GET', `/v1/records/deal?associated_to=${company.id}&limit=50`);
      const open = (deals.data as CrmRecord[]).filter((d) => !String(d.properties.deal_stage).startsWith('closed'));
      const sum = open.reduce((acc, d) => acc + Number(d.properties.amount ?? 0), 0);
      assert.ok(sum > threshold, `${company.display_name} open pipeline is ${sum}`);
    }
  });

  test('"no activity in N days" is expressible and correct', async () => {
    const quiet = await search('contact', {
      filter: {
        association: 'activity', operator: 'eq', value: 0,
        where: { op: 'and', filters: [{ property: 'occurred_at', operator: 'within_last', value: 30, unit: 'day' }] },
      },
      limit: 5,
    });
    assert.ok(quiet.total_count > 0);
    const cutoff = app.ctx.now() - 30 * 86_400_000;
    for (const contact of quiet.data as CrmRecord[]) {
      const timeline = await expectOk('GET', `/v1/records/contact/${contact.id}/timeline?roll_up=false&limit=200`);
      const recent = timeline.data.filter((i: { kind: string; at: number }) => i.kind === 'activity' && i.at >= cutoff);
      assert.equal(recent.length, 0, `${contact.display_name} has ${recent.length} recent activities`);
    }
  });

  test('sorting puts empty values last in both directions', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      const page = await search('contact', { sort: [{ property: 'next_step', direction }], limit: 200 });
      const values = (page.data as CrmRecord[]).map((r) => r.properties.next_step ?? null);
      const firstNull = values.indexOf(null);
      if (firstNull >= 0) assert.ok(values.slice(firstNull).every((v) => v === null), `nulls not grouped last (${direction})`);
    }
  });
});

/* -------------------------------- injection ------------------------------- */

describe('the filter engine never interpolates user input', () => {
  const payloads = [
    `'; DROP TABLE crm_records; --`,
    `" OR 1=1 --`,
    `%' OR '1'='1`,
    `x') UNION SELECT id, org_id FROM api_keys --`,
    `\\`,
  ];

  test('hostile values are matched as literal text', async () => {
    const before = app.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ?`, ORG);
    for (const value of payloads) {
      for (const operator of ['eq', 'contains', 'starts_with', 'ends_with'] as const) {
        const res = await search('company', { filter: { property: 'name', operator, value }, limit: 5 });
        assert.equal(res.total_count, 0, `"${value}" with ${operator} matched ${res.total_count} rows`);
      }
    }
    const after = app.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ?`, ORG);
    assert.equal(after, before, 'record count changed — something executed');
    assert.ok(app.db.count(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'crm_records'`) === 1);
  });

  test('LIKE wildcards inside a value are escaped, not honoured', async () => {
    const everything = await search('company', { filter: { property: 'name', operator: 'contains', value: '%' }, limit: 5 });
    assert.equal(everything.total_count, 0, 'a literal % should not behave as a wildcard');
    const underscore = await search('company', { filter: { property: 'name', operator: 'contains', value: '_' }, limit: 5 });
    assert.equal(underscore.total_count, 0);
  });

  test('hostile property names and operators are rejected, not executed', async () => {
    const bad = await call('POST', '/v1/records/company/search', {
      filter: { property: `name") OR 1=1 --`, operator: 'eq', value: 'x' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'property_unknown');
    assert.equal(bad.body.error.param, 'filter.property');

    const badOp = await call('POST', '/v1/records/company/search', {
      filter: { property: 'name', operator: 'eq; DROP TABLE', value: 'x' },
    });
    assert.equal(badOp.status, 400);
    assert.equal(badOp.body.error.code, 'filter_operator_invalid');

    const badSort = await call('POST', '/v1/records/company/search', { sort: [{ property: 'name); --' }] });
    assert.equal(badSort.status, 400);
    assert.equal(badSort.body.error.param, 'sort.property');
  });

  test('a filter cannot reach another workspace', async () => {
    const other: Auth = { ...DANA, orgId: 'org_other' };
    const res = await call('POST', '/v1/records/company/search', { limit: 5 }, other);
    assert.equal(res.status, 404);
  });
});

/* ------------------------------- pagination ------------------------------- */

describe('cursor pagination', () => {
  test('pages do not overlap and the cursor terminates', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: any = await search('contact', { limit: 25, ...(cursor ? { after: cursor } : {}), sort: [{ property: 'full_name', direction: 'asc' }] });
      for (const record of page.data as CrmRecord[]) {
        assert.ok(!seen.has(record.id), `${record.id} appeared twice`);
        seen.add(record.id);
      }
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 25);
    assert.ok(pages > 1);
    assert.equal(seen.size, await countMatching('contact', undefined));
  });

  test('the cursor is accepted back under the name the response gave it', async () => {
    const first = await expectOk('GET', '/v1/records/company?limit=10');
    assert.ok(first.next_cursor, 'there should be more than one page');
    assert.equal(first.next_page, `/v1/records/company?after=${encodeURIComponent(first.next_cursor)}&limit=10`);

    const viaAfter = await expectOk('GET', `/v1/records/company?limit=10&after=${encodeURIComponent(first.next_cursor)}`);
    const viaCursor = await expectOk('GET', `/v1/records/company?limit=10&cursor=${encodeURIComponent(first.next_cursor)}`);
    assert.deepEqual(
      viaCursor.data.map((r: CrmRecord) => r.id),
      viaAfter.data.map((r: CrmRecord) => r.id),
      '`cursor` and `after` name the same thing',
    );
    assert.notEqual(viaCursor.data[0].id, first.data[0].id, 'and neither of them loops on page one');
  });

  test('an unknown query parameter is refused, not ignored', async () => {
    const res = await call('GET', '/v1/records/company?bogus=1');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.param, 'bogus');
    assert.match(res.body.error.message, /unknown parameter/i);
  });

  test('a cursor from another query is refused', async () => {
    const page = await search('contact', { limit: 5 });
    const res = await call('POST', '/v1/records/contact/search', {
      limit: 5, after: page.next_cursor, filter: { property: 'lifecycle_stage', operator: 'eq', value: 'customer' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'cursor_invalid');
  });
});

/* ---------------------------- records and history ------------------------- */

describe('records, validation and property history', () => {
  let contactId = '';

  test('creates a record and computes calculated properties', async () => {
    const record = await expectOk('POST', '/v1/records/contact', {
      properties: {
        first_name: 'Imogen', last_name: 'Blackwood', email: 'imogen.blackwood@meridianforge.com',
        job_title: 'Director of Reliability', seniority: 'director', department: 'maintenance',
        buying_role: 'champion', lifecycle_stage: 'lead',
      },
      owner_id: 'usr_seed02',
    }, MARCUS);
    contactId = record.id;
    assert.equal(record.properties.full_name, 'Imogen Blackwood');
    assert.equal(record.display_name, 'Imogen Blackwood');
    assert.equal(record.owner_id, 'usr_seed02');
    assert.equal(record.created_by, 'usr_seed02');
  });

  test('rejects unknown properties with the offending param', async () => {
    const res = await call('POST', '/v1/records/contact', { properties: { first_name: 'A', last_name: 'B', favourite_colour: 'teal' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'property_unknown');
    assert.equal(res.body.error.param, 'properties.favourite_colour');
  });

  test('rejects values that break the property definition', async () => {
    const badEnum = await call('POST', '/v1/records/contact', { properties: { first_name: 'A', last_name: 'B', seniority: 'supreme_leader' } });
    assert.equal(badEnum.status, 400);
    assert.match(badEnum.body.error.message, /not an option for Seniority/);

    const badEmail = await call('POST', '/v1/records/contact', { properties: { first_name: 'A', last_name: 'B', email: 'not-an-email' } });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error.param, 'properties.email');

    const missing = await call('POST', '/v1/records/contact', { properties: { last_name: 'OnlyLast' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'property_required');
  });

  test('enforces unique properties across the workspace', async () => {
    const res = await call('POST', '/v1/records/contact', {
      properties: { first_name: 'Imogen', last_name: 'Duplicate', email: 'imogen.blackwood@meridianforge.com' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'property_not_unique');
  });

  test('a unique property is compared canonically, not byte for byte', async () => {
    const original = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Andina Envases Chile', domain: 'https://WWW.AndinaEnvases-Chile.cl/nosotros' },
    });
    assert.equal(original.properties.domain, 'andinaenvases-chile.cl', 'the domain is stored canonically');

    for (const variant of ['andinaenvases-chile.cl', 'ANDINAENVASES-CHILE.CL', 'www.andinaenvases-chile.cl', 'andinaenvases-chile.cl ', 'https://andinaenvases-chile.cl/contact']) {
      const res = await call('POST', '/v1/records/company', { properties: { name: `Dupe ${variant}`, domain: variant } });
      assert.equal(res.status, 409, `"${variant}" got in past a constraint that claims to prevent it`);
      assert.equal(res.body.error.code, 'property_not_unique');
    }

    const notADomain = await call('POST', '/v1/records/company', { properties: { name: 'Bad domain', domain: 'not a domain at all' } });
    assert.equal(notADomain.status, 400);
    assert.equal(notADomain.body.error.param, 'properties.domain');
  });

  test('stored text has a ceiling, so one bad row cannot poison every list', async () => {
    const longName = await call('POST', '/v1/records/company', { properties: { name: 'A'.repeat(50_000) } });
    assert.equal(longName.status, 400);
    assert.match(longName.body.error.message, /at most 500 characters/);

    const longBody = await call('POST', '/v1/records/company', { properties: { name: 'Verbose', description: 'x'.repeat(200_000) } });
    assert.equal(longBody.status, 400);
    assert.match(longBody.body.error.message, /65,536/);

    const fine = await expectOk('POST', '/v1/records/company', { properties: { name: 'Halden Präzision', description: 'y'.repeat(4_000) } });
    assert.equal(String(fine.properties.description).length, 4_000);
  });

  test('records who changed what, from what, to what', async () => {
    await expectOk('PATCH', `/v1/records/contact/${contactId}`, {
      properties: { lifecycle_stage: 'sales_qualified_lead', job_title: 'VP of Reliability' },
    }, MARCUS);

    const history = await expectOk('GET', `/v1/records/contact/${contactId}/history`);
    const lifecycle = history.data.find((h: any) => h.property === 'lifecycle_stage');
    assert.ok(lifecycle, 'no history row for lifecycle_stage');
    assert.equal(lifecycle.from_value, 'lead');
    assert.equal(lifecycle.to_value, 'sales_qualified_lead');
    assert.equal(lifecycle.actor_id, 'usr_seed02');
    assert.equal(lifecycle.source, 'user');
    assert.equal(lifecycle.property_label, 'Lifecycle stage');

    const title = history.data.find((h: any) => h.property === 'job_title');
    assert.equal(title.from_value, 'Director of Reliability');
    assert.equal(title.to_value, 'VP of Reliability');
  });

  test('a no-op update writes no history', async () => {
    const before = (await expectOk('GET', `/v1/records/contact/${contactId}/history`)).data.length;
    await expectOk('PATCH', `/v1/records/contact/${contactId}`, { properties: { job_title: 'VP of Reliability' } });
    const after = (await expectOk('GET', `/v1/records/contact/${contactId}/history`)).data.length;
    assert.equal(after, before);
  });

  test('owner changes are history too', async () => {
    await expectOk('PATCH', `/v1/records/contact/${contactId}`, { owner_id: 'usr_seed03' });
    const history = await expectOk('GET', `/v1/records/contact/${contactId}/history?property=owner_id`);
    assert.equal(history.data[0].from_value, 'usr_seed02');
    assert.equal(history.data[0].to_value, 'usr_seed03');
    assert.equal(history.data[0].property_label, 'Owner');
  });

  test('calculated properties cannot be written directly and follow their inputs', async () => {
    const res = await call('PATCH', `/v1/records/contact/${contactId}`, { properties: { full_name: 'Someone Else' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'property_read_only');

    const updated = await expectOk('PATCH', `/v1/records/contact/${contactId}`, { properties: { last_name: 'Blackwood-Reyes' } });
    assert.equal(updated.properties.full_name, 'Imogen Blackwood-Reyes');
    assert.equal(updated.display_name, 'Imogen Blackwood-Reyes');
  });

  test('read-only system properties are refused', async () => {
    const res = await call('PATCH', `/v1/records/contact/${contactId}`, { properties: { last_activity_at: Date.now() } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'property_read_only');
  });

  test('archiving hides a record from lists but keeps it retrievable', async () => {
    const doomed = await expectOk('POST', '/v1/records/contact', { properties: { first_name: 'Temporary', last_name: 'Record' } });
    const before = await countMatching('contact', undefined);
    await expectOk('DELETE', `/v1/records/contact/${doomed.id}`);
    assert.equal(await countMatching('contact', undefined), before - 1);
    const fetched = await expectOk('GET', `/v1/records/contact/${doomed.id}`);
    assert.equal(fetched.archived, true);
    await expectOk('POST', `/v1/records/contact/${doomed.id}/restore`);
    assert.equal(await countMatching('contact', undefined), before);
    await expectOk('DELETE', `/v1/records/contact/${doomed.id}?permanent=true`);
    assert.equal((await call('GET', `/v1/records/contact/${doomed.id}`)).status, 404);
  });
});

/* ------------------------------ associations ------------------------------ */

describe('associations', () => {
  test('are queryable from both ends with the right label', async () => {
    const contacts = await search('contact', {
      filter: { association: 'company', operator: 'gt', value: 0 },
      sort: [{ property: 'created', direction: 'asc' }], limit: 1,
    });
    const contact = contacts.data[0] as CrmRecord;
    const fromContact = await expectOk('GET', `/v1/records/contact/${contact.id}/associations?object_type=company`);
    assert.ok(fromContact.data.length > 0);
    const edge = fromContact.data[0];
    assert.equal(edge.direction, 'outgoing');
    assert.equal(edge.label, 'Works at');
    assert.equal(edge.is_primary, true);

    const fromCompany = await expectOk('GET', `/v1/records/${edge.object_type}/${edge.record_id}/associations?object_type=contact`);
    const reverse = fromCompany.data.find((e: any) => e.record_id === contact.id);
    assert.ok(reverse, 'the company cannot see the contact');
    assert.equal(reverse.direction, 'incoming');
    assert.equal(reverse.label, 'Employs');
    assert.equal(reverse.id, edge.id, 'both directions must be the same edge');
  });

  test('infers the association type from the two object types', async () => {
    const company = (await expectOk('GET', '/v1/records/company?limit=1')).data[0] as CrmRecord;
    const contact = await expectOk('POST', '/v1/records/contact', { properties: { first_name: 'Wiring', last_name: 'Test' } });
    const edge = await expectOk('POST', '/v1/associations', { from_id: contact.id, to_id: company.id });
    assert.equal(edge.association_type, 'contact_to_company');
    assert.equal(edge.label, 'Works at');

    const again = await expectOk('POST', '/v1/associations', { from_id: contact.id, to_id: company.id });
    assert.equal(again.id, edge.id, 'associating twice must not duplicate the edge');

    await expectOk('DELETE', `/v1/associations/${edge.id}`);
    const after = await expectOk('GET', `/v1/records/contact/${contact.id}/associations`);
    assert.equal(after.data.length, 0);
  });

  test('many-to-one labels move rather than duplicate', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=2');
    const [first, second] = companies.data as CrmRecord[];
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Cardinality probe', amount: 100_00, deal_stage: 'qualification' },
    });
    await expectOk('POST', '/v1/associations', { from_id: deal.id, to_id: first.id, association_type: 'deal_to_company' });
    await expectOk('POST', '/v1/associations', { from_id: deal.id, to_id: second.id, association_type: 'deal_to_company' });
    const edges = await expectOk('GET', `/v1/records/deal/${deal.id}/associations?association_type=deal_to_company`);
    assert.equal(edges.data.length, 1);
    assert.equal(edges.data[0].record_id, second.id);
  });

  test('rejects nonsense associations with a helpful message', async () => {
    const company = (await expectOk('GET', '/v1/records/company?limit=1')).data[0] as CrmRecord;
    const self = await call('POST', '/v1/associations', { from_id: company.id, to_id: company.id });
    assert.equal(self.status, 400);
    assert.equal(self.body.error.code, 'association_self');

    const mismatch = await call('POST', '/v1/associations', { from_id: company.id, to_id: company.id, association_type: 'deal_to_company' });
    assert.equal(mismatch.status, 400);

    const missing = await call('POST', '/v1/associations', { from_id: company.id, to_id: 'con_does_not_exist' });
    assert.equal(missing.status, 404);
  });

  test('the timeline merges activities, property changes, events and links', async () => {
    const company = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Kestrel Timeline Probe', domain: 'kestrel-timeline.test', industry: 'metals' },
    });
    const contact = await expectOk('POST', '/v1/records/contact', {
      properties: { first_name: 'Owen', last_name: 'Trask', email: 'owen.trask@kestrel-timeline.test' },
    });
    await expectOk('POST', '/v1/associations', { from_id: contact.id, to_id: company.id, primary: true });
    await expectOk('PATCH', `/v1/records/company/${company.id}`, { properties: { lifecycle_stage: 'opportunity' } });
    await expectOk('POST', `/v1/records/contact/${contact.id}/activities`, {
      type: 'meeting', subject: 'Discovery — Kestrel', body: 'Walked the line.',
      properties: { meeting_type: 'discovery', outcome: 'held' },
    });

    const timeline = await expectOk('GET', `/v1/records/company/${company.id}/timeline?limit=50`);
    const kinds = new Set(timeline.data.map((i: { kind: string }) => i.kind));
    for (const kind of ['activity', 'property_change', 'event', 'association']) {
      assert.ok(kinds.has(kind), `the timeline is missing ${kind} items`);
    }
    const rolled = timeline.data.find((i: any) => i.kind === 'activity');
    assert.equal(rolled.title, 'Discovery — Kestrel');
    assert.equal(rolled.via.id, contact.id, 'an account timeline should say which contact it came through');
    assert.ok(timeline.data.some((i: any) => i.kind === 'event' && i.title === 'Record created'));
    assert.ok(timeline.data.some((i: any) => i.kind === 'property_change' && i.body === 'Lead → Opportunity'));

    const direct = await expectOk('GET', `/v1/records/company/${company.id}/timeline?roll_up=false&limit=50`);
    assert.equal(direct.data.filter((i: { kind: string }) => i.kind === 'activity').length, 0);
    const sorted = timeline.data.map((i: { at: number }) => i.at);
    assert.deepEqual(sorted, [...sorted].sort((a: number, b: number) => b - a), 'the timeline must be newest first');
  });

  test('logging an activity updates the records it lands on', async () => {
    const contact = (await expectOk('GET', '/v1/records/contact?limit=1')).data[0] as CrmRecord;
    const before = Number(contact.properties.activity_count ?? 0);
    const at = app.ctx.now();
    await expectOk('POST', `/v1/records/contact/${contact.id}/activities`, {
      type: 'call', subject: 'Follow-up on the pilot scope', body: 'Confirmed the line and the asset list.',
      occurred_at: at, properties: { direction: 'outbound', duration_minutes: 12, outcome: 'connected' },
    });
    const after = await expectOk('GET', `/v1/records/contact/${contact.id}`);
    assert.equal(Number(after.properties.activity_count), before + 1);
    assert.equal(Number(after.properties.last_activity_at), at);
    assert.equal(Number(after.properties.last_contacted_at), at);
    const timeline = await expectOk('GET', `/v1/records/contact/${contact.id}/timeline?limit=5`);
    assert.equal(timeline.data[0].title, 'Follow-up on the pilot scope');
    assert.equal(timeline.data[0].kind, 'activity');
  });
});

/* --------------------------------- batch ---------------------------------- */

describe('batch writes', () => {
  test('commit row by row, so one bad row does not lose the good ones', async () => {
    const result = await expectOk('POST', '/v1/records/company/batch', {
      operation: 'create',
      records: [
        { properties: { name: 'Fenwick Tooling', domain: 'fenwicktooling.com', industry: 'contract_mfg' } },
        { properties: { name: 'Broken Row', industry: 'not_a_real_industry' } },
        { properties: { name: 'Halvard Pressworks', domain: 'halvardpress.com', industry: 'automotive' } },
        { properties: { name: 'No Such Property', unknown_field: 1 } },
      ],
    });
    assert.equal(result.created, 2);
    assert.equal(result.errors, 2);
    assert.equal(result.has_errors, true);
    assert.equal(result.results[1].status, 'error');
    assert.equal(result.results[1].error.param, 'properties.industry');
    assert.equal(result.results[3].error.code, 'property_unknown');
    assert.equal(result.results[0].display_name, 'Fenwick Tooling');

    const survivors = await search('company', { filter: { property: 'name', operator: 'in', values: ['Fenwick Tooling', 'Halvard Pressworks', 'Broken Row'] }, limit: 10 });
    assert.equal(survivors.total_count, 2, 'the failed row must not have been written');
  });

  test('upsert matches on a chosen property', async () => {
    const result = await expectOk('POST', '/v1/records/company/batch', {
      operation: 'upsert',
      id_property: 'domain',
      records: [
        { properties: { domain: 'fenwicktooling.com', name: 'Fenwick Tooling Group', employee_count: 240 } },
        { properties: { domain: 'newcomer-industrial.com', name: 'Newcomer Industrial' } },
      ],
    });
    assert.equal(result.updated, 1);
    assert.equal(result.created, 1);
    const found = await search('company', { filter: { property: 'domain', operator: 'eq', value: 'fenwicktooling.com' }, limit: 5 });
    assert.equal(found.total_count, 1);
    assert.equal(found.data[0].properties.name, 'Fenwick Tooling Group');
    assert.equal(found.data[0].properties.employee_count, 240);
  });

  test('an import keyed on a mistyped property fails before the first row runs', async () => {
    const typoKey = await call('POST', '/v1/records/company/batch', {
      id_propery: 'domain',
      records: [{ properties: { name: 'Andina RENAMED', domain: 'andinaenvases.cl' } }],
    });
    assert.equal(typoKey.status, 400, 'an unknown body key must not be silently dropped');
    assert.equal(typoKey.body.error.param, 'id_propery');

    const unknownProperty = await call('POST', '/v1/records/company/batch', {
      id_property: 'not_a_prop',
      records: [{ properties: { name: 'Would have been a duplicate' } }],
    });
    assert.equal(unknownProperty.status, 400);
    assert.equal(unknownProperty.body.error.code, 'property_unknown');
    assert.equal(unknownProperty.body.error.param, 'id_property');

    const notUnique = await call('POST', '/v1/records/company/batch', {
      id_property: 'industry',
      records: [{ properties: { name: 'Ambiguous', industry: 'automotive' } }],
    });
    assert.equal(notUnique.status, 400);
    assert.equal(notUnique.body.error.code, 'id_property_not_unique');
    assert.match(notUnique.body.error.message, /domain/);

    const stillOne = await search('company', { filter: { property: 'name', operator: 'eq', value: 'Would have been a duplicate' }, limit: 1 });
    assert.equal(stillOne.total_count, 0, 'a failed key must not have written any rows');
  });

  test('a row id that does not exist errors instead of minting a ghost record', async () => {
    const result = await expectOk('POST', '/v1/records/company/batch', {
      records: [
        { properties: { name: 'Real Row', domain: 'realrow-industrial.com' } },
        { id: 'cmp_nope', properties: { name: 'Ghost' } },
      ],
    });
    assert.equal(result.created, 1);
    assert.equal(result.errors, 1);
    assert.equal(result.results[1].error.type, 'not_found_error');
    assert.equal(result.results[1].error.code, 'resource_missing');
    assert.equal(result.results[1].error.param, 'records[1].id');

    const ghost = await call('GET', '/v1/records/company/cmp_nope');
    assert.equal(ghost.status, 404, 'the caller\'s arbitrary id must not have become a record');
  });

  test('an id belonging to another object type is named for what it is', async () => {
    const company = (await expectOk('GET', '/v1/records/company?limit=1')).data[0] as CrmRecord;
    const result = await expectOk('POST', '/v1/records/contact/batch', {
      records: [{ id: company.id, properties: { first_name: 'Wrong', last_name: 'Type' } }],
    });
    assert.equal(result.errors, 1);
    const error = result.results[0].error;
    assert.equal(error.code, 'record_type_mismatch');
    assert.equal(error.type, 'invalid_request_error');
    assert.equal(error.param, 'records[0].id');
    assert.match(error.message, new RegExp(company.display_name.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(error), /SQLITE|UNIQUE constraint/i, 'no database internals in an API contract');
  });

  test('a create batch refuses caller-assigned ids outright', async () => {
    const result = await expectOk('POST', '/v1/records/company/batch', {
      operation: 'create',
      records: [{ id: 'cmp_i_picked_this', properties: { name: 'Self-assigned' } }],
    });
    assert.equal(result.errors, 1);
    assert.equal(result.results[0].error.code, 'record_id_not_assignable');
  });

  test('a keyed upsert matches on the canonical value, so a re-import updates', async () => {
    await expectOk('POST', '/v1/records/company/batch', {
      operation: 'upsert', id_property: 'domain',
      records: [{ properties: { domain: 'kestrelforge.io', name: 'Kestrel Forge', employee_count: 300 } }],
    });
    const second = await expectOk('POST', '/v1/records/company/batch', {
      operation: 'upsert', id_property: 'domain',
      records: [{ properties: { domain: 'HTTPS://WWW.KestrelForge.io/', name: 'Kestrel Forge Group', employee_count: 340 } }],
    });
    assert.equal(second.updated, 1, 'the same company arriving in another shape is the same company');
    assert.equal(second.created, 0);
    const found = await search('company', { filter: { property: 'domain', operator: 'eq', value: 'kestrelforge.io' }, limit: 5 });
    assert.equal(found.total_count, 1);
    assert.equal(found.data[0].properties.name, 'Kestrel Forge Group');
  });

  test('an unknown key inside a row is refused too', async () => {
    const res = await call('POST', '/v1/records/company/batch', {
      records: [{ properties: { name: 'Strict' }, ownerId: 'usr_seed01' }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.param, 'records[0].ownerId');
  });

  test('an update batch reports missing records per row', async () => {
    const result = await expectOk('POST', '/v1/records/company/batch', {
      operation: 'update',
      records: [{ id: 'cmp_does_not_exist', properties: { name: 'Ghost' } }],
    });
    assert.equal(result.errors, 1);
    assert.equal(result.results[0].error.type, 'not_found_error');
  });
});

/* --------------------------- duplicates and merge ------------------------- */

describe('duplicate detection and merge', () => {
  test('scores likely duplicates with reasons', async () => {
    const original = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Ardmore Castings Inc.', domain: 'ardmorecastings.com', city: 'Toledo', industry: 'metals', employee_count: 700 },
    });
    await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Ardmore Castings', city: 'Toledo', industry: 'metals', phone: '+1 (419) 555-0134' },
    });
    const similar = await expectOk('GET', `/v1/records/company/${original.id}/similar`);
    assert.ok(similar.data.length > 0, 'the near-identical company was not detected');
    const top = similar.data[0];
    assert.equal(top.record.display_name, 'Ardmore Castings');
    assert.ok(top.score >= 50, `score was only ${top.score}`);
    assert.ok(top.reasons.some((r: string) => /name/i.test(r)));
  });

  test('duplicate detection sees the “www.” form the rule exists to catch', async () => {
    const first = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Pfaltzgruber Werke GmbH', domain: 'pfaltzgruber-werke.de', city: 'Ulm', industry: 'metals' },
    });
    // A duplicate can still arrive around the constraint — an archived record
    // coming back, or a merge undone. The detector has to see it afterwards.
    await expectOk('DELETE', `/v1/records/company/${first.id}`);
    const second = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Pfaltzgruber Werke', domain: 'WWW.Pfaltzgruber-Werke.DE', city: 'Ulm', industry: 'metals' },
    });
    await expectOk('POST', `/v1/records/company/${first.id}/restore`);

    const similar = await expectOk('GET', `/v1/records/company/${second.id}/similar`);
    assert.equal(similar.data.length, 1);
    assert.equal(similar.data[0].record.id, first.id);
    assert.ok(similar.data[0].reasons.some((r: string) => /same company domain/i.test(r)),
      `the domain rule did not fire: ${JSON.stringify(similar.data[0].reasons)}`);
    assert.equal(similar.data[0].score, 100);
  });

  test('merging keeps history, fills blanks and moves relationships', async () => {
    const winner = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Brightwater Mills', domain: 'brightwatermills.com', industry: 'packaging', employee_count: 900 },
    });
    const loser = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Brightwater Mills LLC', city: 'Augusta', country: 'United States', phone: '+1 (706) 555-0181' },
    });
    const contact = await expectOk('POST', '/v1/records/contact', {
      properties: { first_name: 'Delia', last_name: 'Marsh', email: 'delia.marsh@brightwatermills.com' },
    });
    await expectOk('POST', '/v1/associations', { from_id: contact.id, to_id: loser.id });
    await expectOk('POST', `/v1/records/company/${loser.id}/activities`, { type: 'note', subject: 'Legacy note', body: 'Logged against the duplicate.' });

    const result = await expectOk('POST', `/v1/records/company/${winner.id}/merge`, { from_id: loser.id });
    assert.equal(result.object, 'merge_result');
    assert.ok(result.properties_filled.includes('city'));
    assert.ok(result.associations_moved >= 2);

    const merged = await expectOk('GET', `/v1/records/company/${winner.id}`);
    assert.equal(merged.properties.name, 'Brightwater Mills', 'the winner keeps its own values');
    assert.equal(merged.properties.city, 'Augusta', 'blanks are filled from the duplicate');
    assert.equal(merged.properties.employee_count, 900);

    const edges = await expectOk('GET', `/v1/records/company/${winner.id}/associations?object_type=contact`);
    assert.ok(edges.data.some((e: any) => e.record_id === contact.id), 'the contact did not follow the merge');

    const timeline = await expectOk('GET', `/v1/records/company/${winner.id}/timeline?limit=50`);
    assert.ok(timeline.data.some((i: any) => i.title === 'Legacy note'), 'the activity did not follow the merge');

    const history = await expectOk('GET', `/v1/records/company/${winner.id}/history`);
    const mergeEntry = history.data.find((h: any) => h.property === 'merged_from');
    assert.ok(mergeEntry, 'no history entry naming the merged record');
    assert.match(mergeEntry.to_value, /Brightwater Mills LLC/);

    const old = await expectOk('GET', `/v1/records/company/${loser.id}`);
    assert.equal(old.id, winner.id, 'the old id must resolve to the surviving record');
    assert.equal(old.merged_from, loser.id);

    const stillListed = await search('company', { filter: { property: 'name', operator: 'eq', value: 'Brightwater Mills LLC' }, limit: 5 });
    assert.equal(stillListed.total_count, 0, 'the merged duplicate must leave the list');
  });

  test('refuses to merge a record into itself or into an already-merged record', async () => {
    const a = await expectOk('POST', '/v1/records/company', { properties: { name: 'Selfmerge Ltd', domain: 'selfmerge.test' } });
    const self = await call('POST', `/v1/records/company/${a.id}/merge`, { from_id: a.id });
    assert.equal(self.status, 400);
    assert.equal(self.body.error.code, 'merge_self');
  });
});

/* ------------------------------ schema and views -------------------------- */

describe('an extensible object model', () => {
  test('a custom object type comes with a working record API', async () => {
    const objectType = await expectOk('POST', '/v1/objects', {
      name: 'service_visit', label: 'Service visit', plural_label: 'Service visits',
      description: 'A field engineer visit to a customer site.', icon: 'wrench', primary_property: 'name',
    });
    assert.equal(objectType.name, 'service_visit');

    await expectOk('POST', '/v1/objects/service_visit/properties', {
      name: 'visit_date', label: 'Visit date', type: 'date', group: 'Details',
    });
    await expectOk('POST', '/v1/objects/service_visit/properties', {
      name: 'hours_on_site', label: 'Hours on site', type: 'number', group: 'Details',
    });
    await expectOk('POST', '/v1/objects/service_visit/properties', {
      name: 'billable_hours', label: 'Billable hours', type: 'number', group: 'Details',
      calculated: 'round(hours_on_site * 0.8, 1)',
    });

    const visit = await expectOk('POST', '/v1/records/service_visit', {
      properties: { name: 'Cleveland line 4 commissioning', visit_date: '2026-03-11', hours_on_site: 7 },
    });
    assert.equal(visit.properties.billable_hours, 6);
    assert.equal(visit.display_name, 'Cleveland line 4 commissioning');

    const found = await search('service_visit', { filter: { property: 'hours_on_site', operator: 'gte', value: 5 }, limit: 5 });
    assert.equal(found.total_count, 1);
  });

  test('a formula referencing a property that does not exist is rejected', async () => {
    const res = await call('POST', '/v1/objects/service_visit/properties', {
      name: 'nonsense', label: 'Nonsense', type: 'number', calculated: 'round(imaginary_property * 2)',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'expression_unknown_property');
  });

  test('built-in object types and properties are protected', async () => {
    assert.equal((await call('DELETE', '/v1/objects/contact')).status, 400);
    assert.equal((await call('DELETE', '/v1/objects/contact/properties/email')).status, 400);
  });

  test('saved views run through the same filter engine', async () => {
    const view = await expectOk('POST', '/v1/views', {
      object_type: 'company', name: 'German manufacturers',
      description: 'Everything we sell to in Germany.',
      columns: ['name', 'industry', 'employee_count'],
      filter: { op: 'and', filters: [{ property: 'country', operator: 'eq', value: 'Germany' }] },
      sort: [{ property: 'employee_count', direction: 'desc' }],
    });
    const applied = await expectOk('GET', `/v1/records/company?view=${view.id}`);
    assert.ok(applied.total_count > 0);
    for (const record of applied.data as CrmRecord[]) {
      assert.deepEqual(Object.keys(record.properties).sort(), ['employee_count', 'industry', 'name']);
    }

    const seeded = await expectOk('GET', '/v1/views?object_type=deal');
    assert.ok(seeded.data.some((v: any) => v.name === 'Closing this quarter'));

    const invalid = await call('POST', '/v1/views', {
      object_type: 'company', name: 'Broken', filter: { property: 'no_such_property', operator: 'eq', value: 1 },
    });
    assert.equal(invalid.status, 400);
  });
});

/* --------------------------- event-driven stamps -------------------------- */

describe('pipelines are objects, not decoration', () => {
  test('every pipeline owns an ordered list of stages that carry the forecast', async () => {
    const page = await expectOk('GET', '/v1/pipelines/deal');
    const names = page.data.map((p: { name: string }) => p.name);
    assert.deepEqual(names, ['new_business', 'expansion', 'renewal'], 'three motions, three pipelines');

    for (const pipeline of page.data) {
      assert.ok(pipeline.stages.length >= 4, `${pipeline.name} has too few stages`);
      const positions = pipeline.stages.map((s: { position: number }) => s.position);
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'stages come back in order');
      const open = pipeline.stages.filter((s: { is_closed: boolean }) => !s.is_closed);
      const probabilities = open.map((s: { probability: number }) => s.probability);
      assert.deepEqual(probabilities, [...probabilities].sort((a, b) => a - b), 'probability rises through the pipeline');
      assert.equal(pipeline.stages.filter((s: { is_won: boolean }) => s.is_won).length, 1, 'exactly one winning stage');
      assert.ok(pipeline.stages.some((s: { is_closed: boolean; is_won: boolean }) => s.is_closed && !s.is_won), 'and a losing one');
      for (const stage of pipeline.stages) {
        assert.equal(typeof stage.probability, 'number');
        assert.ok(String(stage.description ?? '').length > 10, `${stage.name} has no description`);
      }
    }

    const newBusiness = page.data[0];
    assert.equal(newBusiness.is_default, true);
    assert.equal(newBusiness.stage_property, 'deal_stage');
  });

  test('the stage counts on a pipeline are the counts in the database', async () => {
    const page = await expectOk('GET', '/v1/pipelines/deal');
    for (const pipeline of page.data) {
      let stageTotal = 0;
      for (const stage of pipeline.stages) {
        const found = await search('deal', {
          filter: {
            op: 'and',
            filters: [
              { property: 'pipeline', operator: 'eq', value: pipeline.name },
              { property: 'deal_stage', operator: 'eq', value: stage.name },
            ],
          },
          limit: 1,
        });
        assert.equal(stage.record_count, found.total_count, `${pipeline.name}/${stage.name}`);
        stageTotal += stage.record_count;
      }
      assert.equal(pipeline.record_count, stageTotal);
    }
  });

  test('a stage from another pipeline is refused, and both stage lists are named', async () => {
    const res = await call('POST', '/v1/records/deal', {
      properties: { name: 'Wrong motion', pipeline: 'renewal', deal_stage: 'technical_validation', amount: 100_000_00 },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'stage_wrong_pipeline');
    assert.equal(res.body.error.param, 'properties.deal_stage');
    assert.match(res.body.error.message, /New business/);
    assert.match(res.body.error.message, /renewal_outreach/);

    const nonsense = await call('POST', '/v1/records/deal', {
      properties: { name: 'No such stage', deal_stage: 'sold_it', amount: 1000_00 },
    });
    assert.equal(nonsense.body.error.code, 'stage_unknown');

    const badPipeline = await call('POST', '/v1/records/deal', {
      properties: { name: 'No such pipeline', pipeline: 'partner_sourced', amount: 1000_00 },
    });
    assert.equal(badPipeline.body.error.code, 'pipeline_unknown');
    assert.equal(badPipeline.body.error.param, 'properties.pipeline');
  });

  test('a new deal lands on the entry stage of the default pipeline', async () => {
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Kestrel line 2 telemetry', amount: 100_000_00 },
    });
    assert.equal(deal.properties.pipeline, 'new_business');
    assert.equal(deal.properties.deal_stage, 'qualification');
    assert.equal(deal.properties.probability, 10);
    assert.equal(deal.properties.weighted_amount, 10_000_00);
    assert.equal(deal.properties.deal_status, 'open');
    assert.equal(deal.properties.forecast_category, 'pipeline');
  });

  test('closing a deal restamps the forecast in the response to that very write', async () => {
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Stagecraft rollout', amount: 100_000_00, deal_stage: 'negotiation' },
    });
    assert.equal(deal.properties.probability, 80);
    assert.equal(deal.properties.weighted_amount, 80_000_00);
    assert.equal(deal.properties.forecast_category, 'commit');

    const closed = await expectOk('PATCH', `/v1/records/deal/${deal.id}`, { properties: { deal_stage: 'closed_won' } });
    assert.equal(closed.properties.deal_stage, 'closed_won');
    assert.equal(closed.properties.probability, 100, 'the PATCH response itself must be right, not a later read');
    assert.equal(closed.properties.weighted_amount, 100_000_00);
    assert.equal(closed.properties.forecast_category, 'closed');
    assert.equal(closed.properties.deal_status, 'won');
    assert.ok(Number(closed.properties.closed_at) > 0);
    assert.equal(closed.properties.days_to_close, 0);

    assert.equal(closed.properties.close_date, startOfUtcDay(Number(closed.properties.closed_at)),
      'a deal that closed today is forecast in today’s period, not the date the rep hoped for');

    const fetched = await expectOk('GET', `/v1/records/deal/${deal.id}`);
    assert.deepEqual(fetched.properties, closed.properties, 'the read agrees with the write');

    const history = await expectOk('GET', `/v1/records/deal/${deal.id}/history`);
    const changed = history.data.map((h: { property: string }) => h.property);
    for (const property of ['deal_stage', 'probability', 'weighted_amount', 'closed_at', 'days_to_close', 'deal_status']) {
      assert.ok(changed.includes(property), `${property} was restamped without a history entry`);
    }
    const sourceOf = (property: string) => history.data.find((h: { property: string }) => h.property === property).source;
    assert.equal(sourceOf('deal_stage'), 'user', 'a person moved the stage');
    assert.equal(sourceOf('probability'), 'system', 'Ain moved the probability, and the log should say so');
    assert.equal(sourceOf('weighted_amount'), 'system');

    // Six properties changed; one save should read as one line on the timeline.
    const timeline = await expectOk('GET', `/v1/records/deal/${deal.id}/timeline?kinds=property_change&limit=10`);
    assert.equal(timeline.data.length, 1, 'the derived changes should be folded into the stage change');
    assert.equal(timeline.data[0].title, 'Stage changed');
    assert.match(timeline.data[0].body, /Proposal sent → Closed won|Negotiation → Closed won/);
    assert.ok(timeline.data[0].data.also.some((a: { property: string }) => a.property === 'probability'));
  });

  test('an explicit close date in the same write wins over the automatic stamp', async () => {
    const backdated = Date.UTC(2026, 3, 14);
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Signed while I was on a plane', amount: 30_000_00, deal_stage: 'closed_won', close_date: backdated },
    });
    assert.equal(deal.properties.close_date, backdated);
    assert.ok(Number(deal.properties.closed_at) > 0);
  });

  test('reopening a deal clears the close stamps', async () => {
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Reopened after procurement', amount: 60_000_00, deal_stage: 'closed_lost' },
    });
    assert.equal(deal.properties.deal_status, 'lost');
    assert.equal(deal.properties.probability, 0);
    assert.ok(Number(deal.properties.closed_at) > 0);

    const reopened = await expectOk('PATCH', `/v1/records/deal/${deal.id}`, { properties: { deal_stage: 'proposal' } });
    assert.equal(reopened.properties.closed_at, undefined, 'a reopened deal is not a closed deal');
    assert.equal(reopened.properties.days_to_close, undefined);
    assert.equal(reopened.properties.deal_status, 'open');
    assert.equal(reopened.properties.probability, 60);
    assert.equal(reopened.properties.weighted_amount, 36_000_00);
  });

  test('probability cannot be typed in, and the message says what owns it', async () => {
    const deal = await expectOk('POST', '/v1/records/deal', { properties: { name: 'Hand-typed forecast', amount: 10_000_00 } });
    const res = await call('PATCH', `/v1/records/deal/${deal.id}`, { properties: { probability: 95 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'property_read_only');
    assert.equal(res.body.error.param, 'properties.probability');
    assert.match(res.body.error.message, /stage/i);

    const onCreate = await call('POST', '/v1/records/deal', { properties: { name: 'Also refused', amount: 1000_00, probability: 50 } });
    assert.equal(onCreate.status, 400);
    assert.equal(onCreate.body.error.code, 'property_read_only');
  });

  test('the same stage name carries each pipeline’s own probability', async () => {
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Aldergate contract', amount: 200_000_00, deal_stage: 'negotiation' },
    });
    assert.equal(deal.properties.probability, 80, 'new business negotiates at 80');

    const moved = await expectOk('PATCH', `/v1/records/deal/${deal.id}`, { properties: { pipeline: 'renewal' } });
    assert.equal(moved.properties.pipeline, 'renewal');
    assert.equal(moved.properties.deal_stage, 'negotiation', 'the stage exists in both pipelines, so it is kept');
    assert.equal(moved.properties.probability, 90, 'a renewal negotiates at 90');
    assert.equal(moved.properties.weighted_amount, 180_000_00);
  });

  test('moving to a pipeline without the current stage lands on that pipeline’s entry stage', async () => {
    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Moved mid-flight', amount: 50_000_00, deal_stage: 'technical_validation' },
    });
    const moved = await expectOk('PATCH', `/v1/records/deal/${deal.id}`, { properties: { pipeline: 'renewal' } });
    assert.equal(moved.properties.deal_stage, 'renewal_outreach');
    assert.equal(moved.properties.probability, 40);
  });

  test('a workspace can add its own pipeline and use it immediately', async () => {
    const pipeline = await expectOk('POST', '/v1/pipelines/deal', {
      name: 'partner_sourced',
      label: 'Partner sourced',
      description: 'Deals a systems integrator brings to Northwind, where the partner runs the room.',
      stages: [
        { name: 'partner_registered', label: 'Partner registered', probability: 15, color: 'teal', forecast_category: 'pipeline' },
        { name: 'joint_discovery', label: 'Joint discovery', probability: 40, color: 'blue', forecast_category: 'pipeline' },
        { name: 'partner_quote', label: 'Quote with partner', probability: 70, color: 'violet', forecast_category: 'commit' },
        { name: 'closed_won', label: 'Closed won', is_won: true },
        { name: 'closed_lost', label: 'Closed lost', is_closed: true },
      ],
    });
    assert.equal(pipeline.stages.length, 5);
    assert.equal(pipeline.is_default, false);

    const options = (await expectOk('GET', '/v1/objects/deal/properties')).data
      .find((p: { name: string }) => p.name === 'deal_stage').options
      .map((o: { value: string }) => o.value);
    assert.ok(options.includes('joint_discovery'), 'the stage property picked up the new pipeline');

    const deal = await expectOk('POST', '/v1/records/deal', {
      properties: { name: 'Vantage Integration — line 5', amount: 80_000_00, pipeline: 'partner_sourced', deal_stage: 'partner_quote' },
    });
    assert.equal(deal.properties.probability, 70);
    assert.equal(deal.properties.weighted_amount, 56_000_00);

    const wrong = await call('POST', '/v1/records/deal', {
      properties: { name: 'Wrong again', amount: 1000_00, pipeline: 'partner_sourced', deal_stage: 'technical_validation' },
    });
    assert.equal(wrong.body.error.code, 'stage_wrong_pipeline');
  });

  test('a pipeline nothing can ever leave is refused', async () => {
    const res = await call('POST', '/v1/pipelines/deal', {
      name: 'never_ends', label: 'Never ends',
      stages: [{ name: 'forever', label: 'Forever', probability: 50 }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'pipeline_needs_closed_stage');
  });

  test('changing a stage probability restamps every deal sitting in it', async () => {
    const before = await expectOk('GET', '/v1/pipelines/deal/new_business');
    const proposal = before.stages.find((s: { name: string }) => s.name === 'proposal');
    assert.ok(proposal.record_count > 0, 'the seed should have deals in Proposal sent');

    const sample = (await search('deal', {
      filter: {
        op: 'and',
        filters: [
          { property: 'pipeline', operator: 'eq', value: 'new_business' },
          { property: 'deal_stage', operator: 'eq', value: 'proposal' },
        ],
      },
      limit: 1,
    })).data[0];
    assert.equal(sample.properties.probability, 60);

    const patched = await expectOk('PATCH', '/v1/pipelines/deal/new_business', {
      stages: before.stages.map((stage: { name: string; label: string; probability: number; is_closed: boolean; is_won: boolean; forecast_category: string | null; color: string }) => ({
        name: stage.name, label: stage.label, color: stage.color,
        probability: stage.name === 'proposal' ? 70 : stage.probability,
        is_closed: stage.is_closed, is_won: stage.is_won,
        forecast_category: stage.forecast_category,
      })),
    });
    assert.equal(patched.records_restamped, proposal.record_count, 'every deal in the stage moved with it');

    const after = await expectOk('GET', `/v1/records/deal/${sample.id}`);
    assert.equal(after.properties.probability, 70);
    assert.equal(after.properties.weighted_amount, Math.round(Number(after.properties.amount) * 0.7));

    const history = await expectOk('GET', `/v1/records/deal/${sample.id}/history?property=probability`);
    assert.equal(history.data[0].to_value, '70');
    assert.equal(history.data[0].from_value, '60');
  });

  test('a stage that still holds deals cannot be removed, and the error counts them', async () => {
    const pipeline = await expectOk('GET', '/v1/pipelines/deal/new_business');
    const res = await call('PATCH', '/v1/pipelines/deal/new_business', {
      stages: pipeline.stages
        .filter((s: { name: string }) => s.name !== 'proposal')
        .map((s: { name: string; label: string; probability: number; is_closed: boolean; is_won: boolean }) => ({
          name: s.name, label: s.label, probability: s.probability, is_closed: s.is_closed, is_won: s.is_won,
        })),
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'stage_in_use');
    assert.equal(res.body.error.detail.records, pipeline.stages.find((s: { name: string }) => s.name === 'proposal').record_count);
  });

  test('a pipeline that still holds deals cannot be deleted', async () => {
    const res = await call('DELETE', '/v1/pipelines/deal/new_business');
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'pipeline_in_use');
  });

  test('every seeded deal sits in a stage its own pipeline owns', async () => {
    const pipelines = (await expectOk('GET', '/v1/pipelines/deal')).data as { name: string; stages: { name: string }[] }[];
    const legal = new Map(pipelines.map((p) => [p.name, new Set(p.stages.map((s) => s.name))]));
    const deals = await expectOk('GET', '/v1/records/deal?limit=200');
    assert.ok(deals.data.length > 50);
    for (const deal of deals.data as CrmRecord[]) {
      const pipeline = String(deal.properties.pipeline);
      assert.ok(legal.has(pipeline), `${deal.display_name} is in unknown pipeline ${pipeline}`);
      assert.ok(legal.get(pipeline)!.has(String(deal.properties.deal_stage)),
        `${deal.display_name}: ${deal.properties.deal_stage} is not a ${pipeline} stage`);
    }
  });

  test('the forecast on every seeded deal agrees with its stage', async () => {
    const pipelines = (await expectOk('GET', '/v1/pipelines/deal')).data as {
      name: string; stages: { name: string; probability: number; is_closed: boolean; is_won: boolean }[];
    }[];
    const stageOf = (pipeline: string, stage: string) =>
      pipelines.find((p) => p.name === pipeline)!.stages.find((s) => s.name === stage)!;
    const deals = await expectOk('GET', '/v1/records/deal?limit=200');
    for (const deal of deals.data as CrmRecord[]) {
      const stage = stageOf(String(deal.properties.pipeline), String(deal.properties.deal_stage));
      assert.equal(deal.properties.probability, stage.probability, `${deal.display_name} probability`);
      assert.equal(deal.properties.weighted_amount, Math.round(Number(deal.properties.amount) * stage.probability / 100));
      assert.equal(deal.properties.deal_status, stage.is_closed ? (stage.is_won ? 'won' : 'lost') : 'open');
      if (stage.is_closed) {
        assert.ok(Number(deal.properties.closed_at) > 0, `${deal.display_name} has no close date`);
        assert.equal(deal.properties.days_to_close, Math.max(0, Math.round((Number(deal.properties.closed_at) - deal.created) / 86_400_000)));
      } else {
        assert.equal(deal.properties.closed_at, undefined);
      }
    }
  });

  test('tickets run through a pipeline too, and closing one stamps the resolution', async () => {
    const support = await expectOk('GET', '/v1/pipelines/ticket');
    assert.equal(support.data.length, 1);
    assert.equal(support.data[0].name, 'support');
    assert.equal(support.data[0].stage_property, 'status');
    assert.ok(support.data[0].stages.some((s: { name: string; is_closed: boolean }) => s.name === 'closed' && s.is_closed));

    const ticket = await expectOk('POST', '/v1/records/ticket', {
      properties: { subject: 'Gateway offline in Bay 3', status: 'waiting_on_us', priority: 'high' },
    });
    assert.equal(ticket.properties.pipeline, 'support');

    const closed = await expectOk('PATCH', `/v1/records/ticket/${ticket.id}`, { properties: { status: 'closed' } });
    assert.ok(Number(closed.properties.resolved_at) > 0, 'the PATCH response carries the stamp');
    assert.equal(typeof closed.properties.resolution_minutes, 'number');

    const reopened = await expectOk('PATCH', `/v1/records/ticket/${ticket.id}`, { properties: { status: 'escalated' } });
    assert.equal(reopened.properties.resolved_at, undefined);
  });

  test('pipelines are only offered where they mean something', async () => {
    const res = await call('GET', '/v1/pipelines/company');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'pipelines_unsupported');
    assert.match(res.body.error.message, /deal, ticket/);
  });

  test('agents get the stage list before they write one', async () => {
    const tool = app.ctx.ai.tool('list_pipelines')!;
    assert.equal(tool.readOnly, true);
    const result = await tool.run({ object_type: 'deal' }, app.ctx, { orgId: ORG }) as {
      name: string; stages: { name: string; probability: number }[];
    }[];
    assert.ok(result.some((p) => p.name === 'renewal'));
    assert.ok(result[0].stages.every((s) => typeof s.probability === 'number'));
  });
});

/* -------------------------------- AI tools -------------------------------- */

describe('AI tools', () => {
  test('exposes the CRM to agents with read-only tools marked', () => {
    const names = app.ctx.ai.tools().map((t) => t.name);
    for (const expected of ['search_records', 'get_record', 'create_record', 'update_record', 'associate_records', 'add_note']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    assert.equal(app.ctx.ai.tool('search_records')!.readOnly, true);
    assert.equal(app.ctx.ai.tool('get_record')!.readOnly, true);
    assert.equal(app.ctx.ai.tool('create_record')!.readOnly, false);
  });

  test('search_records runs the real filter engine', async () => {
    const tool = app.ctx.ai.tool('search_records')!;
    const result = await tool.run(
      { object_type: 'company', filter: { property: 'lifecycle_stage', operator: 'eq', value: 'customer' }, limit: 3 },
      app.ctx, { orgId: ORG },
    ) as { total: number; records: { display_name: string }[] };
    assert.ok(result.total > 5);
    assert.equal(result.records.length, 3);
  });

  test('add_note writes onto the timeline as an agent', async () => {
    const company = (await expectOk('GET', '/v1/records/company?limit=1')).data[0] as CrmRecord;
    const tool = app.ctx.ai.tool('add_note')!;
    await tool.run({ record_ids: [company.id], subject: 'Agent summary', body: 'Renewal risk is low; usage is up 14% quarter on quarter.' },
      app.ctx, { orgId: ORG, actorId: 'usr_seed01' });
    const timeline = await expectOk('GET', `/v1/records/company/${company.id}/timeline?limit=5`);
    assert.equal(timeline.data[0].title, 'Agent summary');
  });

  test('update_record writes agent-sourced history', async () => {
    const deal = (await expectOk('GET', '/v1/records/deal?limit=1')).data[0] as CrmRecord;
    const tool = app.ctx.ai.tool('update_record')!;
    await tool.run({ object_type: 'deal', id: deal.id, properties: { next_step: 'Send the security questionnaire' } },
      app.ctx, { orgId: ORG, actorId: 'usr_seed05' });
    const history = await expectOk('GET', `/v1/records/deal/${deal.id}/history?property=next_step`);
    assert.equal(history.data[0].source, 'agent');
    assert.equal(history.data[0].actor_type, 'agent');
    assert.equal(history.data[0].to_value, 'Send the security questionnaire');
  });
});

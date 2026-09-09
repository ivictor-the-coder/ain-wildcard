/**
 * The CRM screens' own logic: what a merge will do before it is done, what a
 * CSV row becomes on the way in, and how the data model names things.
 *
 * Every function here is pure and runs without a browser. Each case hands the
 * code the records and properties exactly as the API returns them and checks
 * the plan, the payload or the sentence against those alone — the way the
 * screen has to, since the server's own merge count includes stamps the
 * survivor overwrites a moment later.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssociationSummary, CrmRecord, CrmSchema, PropertyDef, ViewDef, WorkspaceUser } from '../src/client/modules/crm/api';
import { changedProperties, describeMergeResult, duplicateReason, planMerge, primaryCompany } from '../src/client/modules/crm/merge';
import { parseCsv } from '../src/client/modules/crm/csv';
import {
  autoMapColumns, blamedLabel, buildImportRows, coerceImportValue, outcomesFrom, requiredForCreate,
} from '../src/client/modules/crm/import-rows';
import { associationTypeName } from '../src/client/modules/crm/naming';
import { onCivilDay, slaState, wallClockIn, zonedDay, zonedDayStart } from '../src/client/modules/crm/time';
import { civilDay } from '../src/shared/time';
import { describeAssociationCondition, farObjectType, identityWhere, referencedRecordIds } from '../src/client/modules/crm/filter-words';
import { ACTIVITY_PATHS, hasDedicatedAddress, listHref, recordHref } from '../src/client/modules/crm/links';
import {
  canMarkPrimary, directActivityIds, groupAssociations, linkableObjectTypes, listBootPhase, loggedOnTargets,
  mergeCellCompact, reachedThrough, showsAssociationLabel, staleViewParam, timeInStage, viaFor, visibleViews,
  withFreshView,
} from '../src/client/modules/crm/record-model';

const property = (over: Partial<PropertyDef> & { name: string; type: PropertyDef['type'] }): PropertyDef => ({
  object_type: 'ticket', id: `prop_${over.name}`, label: over.name.replace(/_/g, ' '), description: null,
  group: 'Ticket', options: [], reference_type: null, required: false, unique: false, read_only: false,
  system: false, hidden: false, default_value: null, calculated: null, rollup: null, currency: null, position: 0,
  ...over,
});

const edge = (over: Partial<AssociationSummary> & { record_id: string; object_type: string }): AssociationSummary => ({
  id: `as_${over.record_id}`, association_type: `ticket_to_${over.object_type}`, label: 'Account',
  direction: 'outgoing', display_name: over.record_id, is_primary: false, created: 0, ...over,
});

const record = (over: Partial<CrmRecord> & { id: string }): CrmRecord => ({
  object: 'record', object_type: 'ticket', properties: {}, display_name: over.id, owner_id: null,
  source: 'import', archived: false, merged_into: null, created: 0, updated: 0, created_by: null, updated_by: null,
  associations: [], ...over,
});

/* ---------------------------------- merge --------------------------------- */

describe('the merge preview', () => {
  const properties = [
    property({ name: 'subject', type: 'string' }),
    property({ name: 'status', type: 'enum' }),
    property({ name: 'affected_line', type: 'string' }),
    property({ name: 'satisfaction_score', type: 'number' }),
    property({ name: 'resolved_at', type: 'datetime', read_only: true }),
    property({ name: 'resolution_minutes', type: 'number', read_only: true }),
    property({ name: 'open_deal_value', type: 'currency', rollup: { association: 'deal', aggregate: 'sum', property: 'amount' } }),
    property({ name: 'tags', type: 'multi_enum' }),
    property({ name: 'last_activity_at', type: 'datetime' }),
  ];

  const winner = record({
    id: 'tkt_w',
    properties: { subject: 'Dashboard loads slowly', status: 'new', affected_line: 'Weld cell 12', tags: ['a'], last_activity_at: 100 },
    associations: [
      edge({ record_id: 'cmp_sakamoto', object_type: 'company', display_name: 'Sakamoto Seiki', is_primary: true }),
      edge({ record_id: 'con_kenji', object_type: 'contact', display_name: 'Kenji Watanabe', label: 'Requested by' }),
    ],
  });
  const loser = record({
    id: 'tkt_l',
    properties: {
      subject: 'Dashboard loads slowly', status: 'closed', affected_line: 'Press shop A', satisfaction_score: 3,
      resolved_at: 5000, resolution_minutes: 3499, open_deal_value: 900, tags: ['a', 'b'], last_activity_at: 200,
    },
    associations: [
      edge({ record_id: 'cmp_portage', object_type: 'company', display_name: 'Portage CPG Brands', is_primary: true }),
      edge({ record_id: 'con_kenji', object_type: 'contact', display_name: 'Kenji Watanabe', label: 'Requested by' }),
      edge({ record_id: 'tkt_w', object_type: 'ticket', display_name: 'the winner', label: 'Related' }),
    ],
  });

  it('names what fills, what the survivor keeps, and what the platform will not copy', () => {
    const plan = planMerge(winner, loser, properties);
    const by = Object.fromEntries(plan.rows.map((row) => [row.property.name, row]));
    // Identical values are not a decision, and rollups are never copied.
    assert.equal(by.subject, undefined);
    assert.equal(by.open_deal_value, undefined);
    assert.equal(by.satisfaction_score.outcome, 'filled');
    assert.equal(by.satisfaction_score.result, 3);
    assert.equal(by.status.outcome, 'kept');
    assert.equal(by.status.result, 'new');
    assert.equal(by.affected_line.outcome, 'kept');
    // The critic's finding: the server lists these as filled and then
    // re-derives them from the survivor. The preview says so up front.
    assert.equal(by.resolved_at.outcome, 'locked');
    assert.equal(by.resolution_minutes.outcome, 'locked');
    assert.equal(by.tags.outcome, 'combined');
    assert.deepEqual(by.tags.result, ['a', 'b']);
    assert.equal(by.last_activity_at.outcome, 'newest');
    assert.equal(by.last_activity_at.result, 200);
  });

  it('lists the associations that move and flags the ones already there', () => {
    const plan = planMerge(winner, loser, properties);
    const statuses = Object.fromEntries(plan.moves.map((move) => [move.edge.record_id, move.status]));
    assert.equal(statuses.cmp_portage, 'moves');
    assert.equal(statuses.con_kenji, 'already_linked');
    assert.equal(statuses.tkt_w, 'self');
  });

  it('raises the conflict when the two records belong to different companies', () => {
    const plan = planMerge(winner, loser, properties);
    assert.ok(plan.companyConflict);
    assert.equal(plan.companyConflict?.winner.display_name, 'Sakamoto Seiki');
    assert.equal(plan.companyConflict?.loser.display_name, 'Portage CPG Brands');

    const sameAccount = record({ ...loser, associations: [edge({ record_id: 'cmp_sakamoto', object_type: 'company', is_primary: true })] });
    assert.equal(planMerge(winner, sameAccount, properties).companyConflict, null);
    assert.equal(primaryCompany(record({ id: 'c', object_type: 'company' })), null);
  });

  it('describes the outcome from the record that came back, not from the server’s count', () => {
    const before = winner;
    const after = record({ ...winner, properties: { ...winner.properties, satisfaction_score: 3 } });
    assert.deepEqual(changedProperties(before, after), ['satisfaction_score']);
    // Three "filled" by the API, one actually written: the sentence says one.
    assert.equal(describeMergeResult(before, after, 2), '1 property changed and 2 associations moved across. The old id still resolves here.');
    assert.equal(describeMergeResult(before, before, 0), 'No property changed and no associations moved. The old id still resolves here.');
  });

  it('words the duplicate reason for the object type', () => {
    assert.equal(duplicateReason('Name matches once legal suffixes are ignored', 'ticket', 'Subject'), 'Same subject');
    assert.equal(duplicateReason('Name is 67% the same', 'contact', 'Full name'), 'Full name is 67% the same');
    assert.equal(duplicateReason('Name matches once legal suffixes are ignored', 'company', 'Name'), 'Name matches once legal suffixes are ignored');
    assert.equal(duplicateReason('Identical email address', 'contact', 'Full name'), 'Identical email address');
  });
});

/* --------------------------------- import --------------------------------- */

describe('the CSV import', () => {
  const users: WorkspaceUser[] = [
    { id: 'usr_dana', name: 'Dana Whitfield', email: 'dana@northwind.io', title: null, role: 'owner', avatar_url: null, status: 'active' },
    { id: 'usr_marcus', name: 'Marcus Ilori', email: 'marcus@northwind.io', title: null, role: 'member', avatar_url: null, status: 'active' },
  ];
  const ctx = { users, currency: 'usd' };
  const properties = [
    property({ name: 'first_name', type: 'string', label: 'First name', object_type: 'contact' }),
    property({ name: 'last_name', type: 'string', label: 'Last name', object_type: 'contact' }),
    property({ name: 'email', type: 'email', label: 'Email', unique: true, object_type: 'contact' }),
    property({ name: 'lifecycle_stage', type: 'enum', label: 'Lifecycle stage', options: [{ value: 'lead', label: 'Lead' }, { value: 'customer', label: 'Customer' }] }),
    property({ name: 'annual_revenue', type: 'currency', label: 'Annual revenue' }),
    property({ name: 'employee_count', type: 'number', label: 'Employees' }),
    property({ name: 'is_partner', type: 'bool', label: 'Partner' }),
    property({ name: 'renewal_date', type: 'date', label: 'Renewal date' }),
    property({ name: 'regions', type: 'multi_enum', label: 'Regions', options: [{ value: 'emea', label: 'EMEA' }, { value: 'apac', label: 'APAC' }] }),
    property({ name: 'last_activity_at', type: 'datetime', label: 'Last activity', read_only: true }),
    property({ name: 'open_deals', type: 'number', label: 'Open deals', rollup: { association: 'deal', aggregate: 'count' } }),
  ];

  it('reads the CSV the export writes, quotes and all', () => {
    const rows = parseCsv('﻿id,Name,Notes\r\ncon_1,"Nakamura-Reid, Corinne","Said ""yes"" on\nthe call"\r\n,,\r\n\'=SUM(A1),x,y\r\n');
    assert.deepEqual(rows, [
      ['id', 'Name', 'Notes'],
      ['con_1', 'Nakamura-Reid, Corinne', 'Said "yes" on\nthe call'],
      ['=SUM(A1)', 'x', 'y'],
    ]);
  });

  it('maps headers by label, by internal name, and never onto a derived property', () => {
    const mapping = autoMapColumns(['id', 'First name', 'last_name', 'E-MAIL', 'Owner', 'Last activity', 'Open deals', 'Fax'], properties);
    assert.deepEqual(mapping, ['id', 'first_name', 'last_name', 'email', 'owner_id', null, null, null]);
    // The same property twice: the second column is left unmapped rather than
    // silently overwriting the first.
    assert.deepEqual(autoMapColumns(['Email', 'email'], properties), ['email', null]);
  });

  it('turns cells into the values the API stores for each type', () => {
    const by = (name: string) => properties.find((p) => p.name === name)!;
    assert.deepEqual(coerceImportValue(by('annual_revenue'), '1,250.50', ctx), { ok: true, value: 125050 });
    assert.deepEqual(coerceImportValue(by('employee_count'), '2 200', ctx), { ok: true, value: 2200 });
    assert.deepEqual(coerceImportValue(by('is_partner'), 'Yes', ctx), { ok: true, value: true });
    assert.deepEqual(coerceImportValue(by('renewal_date'), '2026-05-14', ctx), { ok: true, value: Date.UTC(2026, 4, 14) });
    assert.deepEqual(coerceImportValue(by('lifecycle_stage'), 'Customer', ctx), { ok: true, value: 'customer' });
    assert.deepEqual(coerceImportValue(by('regions'), 'EMEA; apac', ctx), { ok: true, value: ['emea', 'apac'] });
    assert.deepEqual(coerceImportValue(by('first_name'), '  Ingrid ', ctx), { ok: true, value: 'Ingrid' });
    assert.deepEqual(coerceImportValue(by('first_name'), '', ctx), { ok: true, value: undefined });
    assert.equal(coerceImportValue(by('lifecycle_stage'), 'Prospect', ctx).ok, false);
    assert.equal(coerceImportValue(by('renewal_date'), 'next tuesday', ctx).ok, false);
    assert.equal(coerceImportValue(by('employee_count'), 'many', ctx).ok, false);
  });

  it('holds back a row with an unreadable cell and reports which cell', () => {
    const headers = ['First name', 'Last name', 'Email', 'Owner', 'Employees'];
    const rows = [
      ['Ingrid', 'Halvorsen', 'ingrid@nordhavn.example', 'Marcus Ilori', '120'],
      ['Piet', 'de Vries', 'piet@example.com', 'Nobody Here', ''],
      ['', '', '', '', ''],
      ['Aiko', 'Sato', 'aiko@example.com', 'dana@northwind.io', 'lots'],
    ];
    const built = buildImportRows(rows, headers, autoMapColumns(headers, properties), properties, ctx);
    assert.equal(built.records.length, 1);
    assert.deepEqual(built.records[0], {
      row: 1, owner_id: 'usr_marcus',
      properties: { first_name: 'Ingrid', last_name: 'Halvorsen', email: 'ingrid@nordhavn.example', employee_count: 120 },
    });
    assert.equal(built.skipped, 1);
    assert.deepEqual(built.problems.map((p) => [p.row, p.column]), [[2, 'Owner'], [4, 'Employees']]);
  });

  it('re-keys the server’s per-row answer to the file’s row numbers and names the blamed property', () => {
    const sent = [{ row: 3, properties: {} }, { row: 7, properties: {} }];
    const outcomes = outcomesFrom(sent, {
      object: 'batch_result', created: 1, updated: 0, errors: 1, has_errors: true,
      results: [
        { index: 0, status: 'created', id: 'con_9', display_name: 'Ingrid Halvorsen' },
        { index: 1, status: 'error', error: { message: 'Email is taken', param: 'records[1].properties.email' } },
      ],
    }, properties);
    assert.deepEqual(outcomes, [
      { row: 3, status: 'created', id: 'con_9', display_name: 'Ingrid Halvorsen' },
      { row: 7, status: 'refused', blamed: 'Email', message: 'Email is taken' },
    ]);
    assert.equal(blamedLabel('records[0].id', properties), 'Record id');
    assert.equal(blamedLabel(undefined, properties), undefined);
  });
});

/* ------------------------------- data model ------------------------------- */

describe('association type naming', () => {
  it('derives the internal name from the label and steps around a taken one', () => {
    assert.equal(associationTypeName('company', 'company', 'Partner of', []), 'company_partner_of');
    assert.equal(associationTypeName('company', 'company', 'Partner of', ['company_partner_of']), 'company_partner_of_2');
    assert.equal(associationTypeName('company', 'company', 'Partner of', ['company_partner_of', 'company_partner_of_2']), 'company_partner_of_3');
    assert.equal(associationTypeName('site', 'company', '', []), 'site_to_company');
    assert.equal(associationTypeName('site', 'company', '', ['site_to_company']), 'site_to_company_2');
  });
});

/* ------------------------------ service level ----------------------------- */

describe('the SLA reading', () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 8, 5, 12);
  it('reads a due stamp as a state, not a bare time', () => {
    assert.deepEqual(slaState(now - 9 * 24 * HOUR - HOUR, now, false), { state: 'overdue', ms: 9 * 24 * HOUR + HOUR });
    assert.deepEqual(slaState(now + 3 * HOUR, now, false), { state: 'due_soon', ms: 3 * HOUR });
    assert.deepEqual(slaState(now + 3 * 24 * HOUR, now, false), { state: 'due', ms: 3 * 24 * HOUR });
    // A closed ticket's target is history, whichever side of now it sits.
    assert.deepEqual(slaState(now - HOUR, now, true), { state: 'closed', ms: HOUR });
  });
});

/* ------------------------------ record model ------------------------------ */


const view = (over: Partial<ViewDef> & { id: string }): ViewDef => ({
  object: 'view', object_type: 'contact', name: over.id, description: null, columns: [], filter: null, sort: [],
  shared: true, owner_id: null, is_default: false, system: false, position: 0, ...over,
});

describe('the activity record page', () => {
  const carmen = edge({ record_id: 'con_nw_143', object_type: 'contact', display_name: 'Carmen Escamilla', label: 'Logged on', association_type: 'activity_to_record', created: 2 });
  const andina = edge({ record_id: 'cmp_nw_45', object_type: 'company', display_name: 'Andina Envases', label: 'Logged on', association_type: 'activity_to_record', created: 1, is_primary: true });
  const employer = edge({ record_id: 'cmp_nw_45', object_type: 'company', display_name: 'Andina Envases', label: 'Employs', association_type: 'contact_to_company' });
  const note = edge({ record_id: 'note_1', object_type: 'note', display_name: 'Technical environment', label: 'Logged on', association_type: 'activity_to_record' });

  it('shows the records a note was logged on, and hides those same edges on the record itself', () => {
    // On the note: its two "Logged on" edges are the whole rail.
    const onNote = groupAssociations([carmen, andina], true);
    assert.deepEqual([...onNote.keys()], ['contact', 'company']);
    assert.equal(onNote.get('contact')?.[0].display_name, 'Carmen Escamilla');
    // On Carmen: the note is her timeline, not her rail; her employer stays.
    const onCarmen = groupAssociations([employer, note], false);
    assert.deepEqual([...onCarmen.keys()], ['company']);
    assert.equal(onCarmen.get('company')?.[0].label, 'Employs');
  });

  it('names the record an activity was logged from first', () => {
    assert.deepEqual(loggedOnTargets([carmen, andina, employer]).map((e) => e.display_name), ['Andina Envases', 'Carmen Escamilla']);
    assert.equal(canMarkPrimary(carmen), false);
    assert.equal(canMarkPrimary(employer), true);
  });

  it('drops the roll-up’s "via" on an activity the record holds directly', () => {
    const direct = directActivityIds([employer, note]);
    const via = { id: 'cmp_nw_45', object_type: 'company', display_name: 'Andina Envases' };
    assert.equal(viaFor({ record_id: 'note_1', via }, direct), null);
    assert.deepEqual(viaFor({ record_id: 'note_other', via }, direct), via);
  });

  it('keeps a label badge only when it says more than the heading', () => {
    assert.equal(showsAssociationLabel({ label: 'Deals' }, 'Deals'), false);
    assert.equal(showsAssociationLabel({ label: 'Employs' }, 'Contacts'), true);
    assert.equal(showsAssociationLabel({ label: 'Logged on' }, 'Contacts', 'Logged on'), false);
    assert.equal(showsAssociationLabel({ label: '' }, 'Contacts'), false);
  });

  it('compares stamps in the merge preview as dates, not as moods', () => {
    assert.equal(mergeCellCompact({ type: 'datetime' }), false);
    assert.equal(mergeCellCompact({ type: 'date' }), false);
    assert.equal(mergeCellCompact({ type: 'string' }), true);
  });

  it('describes a merged-in visit without an id in the sentence', () => {
    const reached = reachedThrough({ merged_from: 'cmp_0alTrQ2BgMpz60' });
    assert.ok(reached);
    assert.doesNotMatch(reached.text, /cmp_/);
    assert.equal(reached.id, 'cmp_0alTrQ2BgMpz60');
    assert.equal(reachedThrough({ merged_from: undefined }), null);
  });

  it('reads time in status off the current spell', () => {
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
    assert.equal(timeInStage({ days_in_stage: 9, stage_label: 'Escalated', is_current: true }, plural), '9 days in Escalated');
    assert.equal(timeInStage({ days_in_stage: 0, stage_label: 'New', is_current: true }, plural), 'Less than a day in New');
  });
});

describe('addresses for activity queues', () => {
  it('gives every activity type a home of its own, and the generic route hands over', () => {
    for (const [type, path] of Object.entries(ACTIVITY_PATHS)) {
      assert.equal(listHref(type), path);
      assert.equal(recordHref(type, 'x_1'), `${path}/x_1`);
      assert.equal(hasDedicatedAddress(type), true);
    }
    assert.equal(listHref('task'), '/tasks');
    assert.equal(listHref('site'), '/records/site');
    assert.equal(hasDedicatedAddress('site'), false);
    assert.equal(hasDedicatedAddress('ticket'), true);
  });
});

describe('saved views on the list', () => {
  const me = 'usr_seed01';
  const views = [
    view({ id: 'v_all', system: true }),
    view({ id: 'v_mine', shared: false, owner_id: me }),
    view({ id: 'v_sofia', shared: false, owner_id: 'usr_seed04', name: 'Sofia private' }),
    view({ id: 'v_team', shared: true, owner_id: 'usr_seed04' }),
  ];

  it('keeps a teammate’s unshared view out of the bar, and my own in it', () => {
    assert.deepEqual(visibleViews(views, me).map((v) => v.id), ['v_all', 'v_mine', 'v_team']);
    assert.deepEqual(visibleViews(views, 'usr_seed04').map((v) => v.id), ['v_all', 'v_sofia', 'v_team']);
  });

  it('treats a ?view= that is not in the bar as stale once the views have loaded', () => {
    const mine = visibleViews(views, me);
    assert.equal(staleViewParam('v_sofia', mine, true), true);
    assert.equal(staleViewParam('v_deleted', mine, true), true);
    assert.equal(staleViewParam('v_mine', mine, true), false);
    assert.equal(staleViewParam('', mine, true), false);
    assert.equal(staleViewParam('v_deleted', mine, false), false);
  });
});

describe('the list before its grid', () => {
  it('treats an unknown slug as a missing object, whatever the properties call said', () => {
    assert.equal(listBootPhase({ schemaLoaded: true, typeKnown: false, schemaError: false, propertiesError: true }), 'missing_type');
    assert.equal(listBootPhase({ schemaLoaded: true, typeKnown: false, schemaError: false, propertiesError: false }), 'missing_type');
    assert.equal(listBootPhase({ schemaLoaded: true, typeKnown: true, schemaError: false, propertiesError: true }), 'error');
    assert.equal(listBootPhase({ schemaLoaded: false, typeKnown: false, schemaError: true, propertiesError: false }), 'error');
    assert.equal(listBootPhase({ schemaLoaded: false, typeKnown: false, schemaError: false, propertiesError: false }), 'loading');
    assert.equal(listBootPhase({ schemaLoaded: true, typeKnown: true, schemaError: false, propertiesError: false }), 'ready');
  });
});

describe('the data model cards', () => {
  it('pluralise their counts like everything else on the product', () => {
    const source = readFileSync(join(process.cwd(), 'src/client/modules/crm/admin.tsx'), 'utf8');
    assert.doesNotMatch(source, /record_count \?\? 0\)\} records/);
    assert.doesNotMatch(source, /property_count \?\? 0\)\} properties/);
    assert.match(source, /f\.plural\(type\.record_count \?\? 0, 'record'\)/);
    assert.match(source, /f\.plural\(type\.property_count \?\? 0, 'property'\)/);
  });
});

/* ------------------------------- filter words ----------------------------- */


describe('the filter chip', () => {
  const words = { plural: 'companies', singular: 'company' };
  const names = new Map([['cmp_nw_07', 'Pemberton Auto Systems']]);
  const pinned = { association: 'company', where: { property: 'id', operator: 'eq' as const, value: 'cmp_nw_07' }, operator: 'gt' as const, value: 0 };
  const describeWhere = () => 'Status is Open';
  const measured = (name: string) => name[0].toUpperCase() + name.slice(1);

  it('names the record an association condition is pinned to instead of counting it', () => {
    assert.equal(describeAssociationCondition(pinned, words, names, describeWhere, measured), 'linked to company Pemberton Auto Systems');
    // The name may not have arrived yet; the id is still the truth.
    assert.equal(describeAssociationCondition(pinned, words, undefined, describeWhere, measured), 'linked to company cmp_nw_07');
    // "at least one" is the only threshold that goes without saying.
    assert.equal(
      describeAssociationCondition({ ...pinned, operator: 'gt', value: 2 }, words, names, describeWhere, measured),
      'number of companies linked to company Pemberton Auto Systems is greater than 2',
    );
  });

  it('keeps a general sub-filter in the sentence', () => {
    const open = { association: 'deal', where: { property: 'status', operator: 'eq' as const, value: 'open' }, operator: 'gt' as const, value: 0 };
    assert.equal(describeAssociationCondition(open, { plural: 'deals', singular: 'deal' }, names, describeWhere, measured), 'number of deals where Status is Open is greater than 0');
    const sum = { ...open, aggregate: 'sum' as const, aggregate_property: 'amount', operator: 'gte' as const, value: 7500000 };
    assert.equal(describeAssociationCondition(sum, { plural: 'deals', singular: 'deal' }, names, describeWhere, measured), 'sum of Amount across deals where Status is Open is at least 7500000');
  });

  it('reads the pinned id off the tree, through a one-child group, and no further', () => {
    assert.equal(identityWhere({ op: 'and', filters: [{ property: 'id', operator: 'eq', value: 'cmp_1' }] }), 'cmp_1');
    assert.equal(identityWhere({ property: 'name', operator: 'eq', value: 'cmp_1' }), null);
    assert.equal(identityWhere({ property: 'id', operator: 'in', values: ['cmp_1'] }), null);
    assert.deepEqual(
      referencedRecordIds({ op: 'and', filters: [pinned, { property: 'lifecycle_stage', operator: 'eq', value: 'lead' }] }),
      [{ association: 'company', id: 'cmp_nw_07' }],
    );
  });

  it('finds the far side of an association from the list it narrows', () => {
    const schema = {
      object_types: [{ name: 'contact' }, { name: 'company' }],
      association_types: [
        { name: 'contact_to_company', from_object: 'contact', to_object: 'company' },
        { name: 'activity_to_record', from_object: '*', to_object: '*' },
      ],
    } as unknown as CrmSchema;
    assert.equal(farObjectType('company', 'contact', schema), 'company');
    assert.equal(farObjectType('contact_to_company', 'contact', schema), 'company');
    assert.equal(farObjectType('contact_to_company', 'company', schema), 'contact');
    assert.equal(farObjectType('activity_to_record', 'contact', schema), null);
    assert.equal(farObjectType('company', 'contact', undefined), null);
  });
});

/* ------------------------- the four defects of this pass ------------------ */

describe('a view the moment it is saved', () => {
  const me = 'usr_seed01';
  const cached = [
    view({ id: 'v_all', name: 'All contacts', system: true, position: 0 }),
    view({ id: 'v_sql', name: 'Sales qualified leads', position: 10 }),
  ];

  it('is in the bar before its refetch lands, so nothing calls it unavailable', () => {
    // What `POST /v1/views` hands back. The cached list behind the bar still
    // predates it — invalidation keeps the stale answer on screen — and the
    // list used to agree with the cache: no tab, "That view is not available",
    // `?view=` stripped, and the filter that had just been saved discarded.
    const saved = view({ id: 'v_new', name: 'Carmen only', position: 20, owner_id: me, shared: false });
    const bar = visibleViews(withFreshView(cached, saved), me);
    assert.deepEqual(bar.map((v) => v.id), ['v_all', 'v_sql', 'v_new']);
    assert.equal(staleViewParam('v_new', bar, true), false);
    // Without the fresh copy the guard fires, which is the defect.
    assert.equal(staleViewParam('v_new', visibleViews(cached, me), true), true);
  });

  it('replaces the cached copy of a view it updated rather than listing it twice', () => {
    const resorted = view({ id: 'v_sql', name: 'Sales qualified leads', position: 10, sort: [{ property: 'created', direction: 'asc' }] });
    const bar = withFreshView(cached, resorted);
    assert.equal(bar.length, cached.length);
    assert.deepEqual(bar.find((v) => v.id === 'v_sql')?.sort, resorted.sort);
  });

  it('leaves the bar exactly as it is when there is no fresh view', () => {
    assert.equal(withFreshView(cached, null), cached);
    // A teammate's private view is still not mine to see, freshly saved or not.
    const theirs = view({ id: 'v_theirs', shared: false, owner_id: 'usr_seed04' });
    assert.deepEqual(visibleViews(withFreshView(cached, theirs), me).map((v) => v.id), ['v_all', 'v_sql']);
  });
});

describe('the day a datetime picker means', () => {
  // The workspace is on New York time, so UTC midnight is 8pm the day before.
  const zone = 'America/New_York';
  const sep18 = Date.UTC(2026, 8, 18);

  it('turns the calendar’s day stamp into an instant on that day where the business is', () => {
    const start = zonedDayStart(sep18, zone);
    assert.equal(zonedDay(start, zone), '2026-09-18');
    // The defect: the stamp itself is the 17th in New York.
    assert.equal(zonedDay(sep18, zone), '2026-09-17');
    // And it round-trips: what the picker is handed back is the day picked.
    assert.equal(civilDay(start, zone), sep18);
  });

  it('keeps the time of day a stamp already had when it is re-dated', () => {
    const dueAt5pm = zonedDayStart(Date.UTC(2026, 8, 14), zone) + 17 * 3_600_000;
    const moved = onCivilDay(sep18, zone, dueAt5pm);
    assert.equal(zonedDay(moved, zone), '2026-09-18');
    assert.deepEqual(wallClockIn(moved, zone), { year: 2026, month: 9, day: 18, hour: 17, minute: 0, second: 0 });
    // Nothing behind it lands at the start of the day, not at UTC midnight.
    assert.equal(onCivilDay(sep18, zone, null), zonedDayStart(sep18, zone));
  });

  it('crosses a daylight-saving boundary without moving the wall clock', () => {
    // 1 Nov 2026 is the fall-back Sunday in New York.
    const before = zonedDayStart(Date.UTC(2026, 9, 30), zone) + 9 * 3_600_000;
    const after = onCivilDay(Date.UTC(2026, 10, 2), zone, before);
    assert.deepEqual(wallClockIn(after, zone), { year: 2026, month: 11, day: 2, hour: 9, minute: 0, second: 0 });
  });

  it('answers about Greenwich for a zone it does not know rather than throwing', () => {
    assert.equal(zonedDayStart(sep18, 'Mars/Olympus_Mons'), sep18);
  });
});

describe('what the link dialog may offer', () => {
  const types = [
    { name: 'contact', category: 'record' as const },
    { name: 'company', category: 'record' as const },
    { name: 'deal', category: 'record' as const },
    { name: 'ticket', category: 'record' as const },
    { name: 'note', category: 'activity' as const },
  ];
  // The workspace's own association types, as `/v1/crm/schema` lists them.
  const assoc = [
    { from_object: 'contact', to_object: 'company' },
    { from_object: 'contact', to_object: 'contact' },
    { from_object: 'deal', to_object: 'company' },
    { from_object: 'deal', to_object: 'contact' },
    { from_object: 'ticket', to_object: 'company' },
    { from_object: 'ticket', to_object: 'contact' },
    { from_object: 'ticket', to_object: 'deal' },
    { from_object: 'company', to_object: 'company' },
    { from_object: '*', to_object: '*' },
  ];
  const records = types.filter((t) => t.category === 'record');

  it('leaves out a type no association type reaches, in either direction', () => {
    // Nothing connects a ticket to a ticket, or a deal to a deal. Offered, the
    // link was filed under the wildcard label — 201, "shows on both sides",
    // visible on neither, removable from nowhere.
    assert.deepEqual(linkableObjectTypes('ticket', false, records, assoc).map((t) => t.name), ['contact', 'company', 'deal']);
    assert.deepEqual(linkableObjectTypes('deal', false, records, assoc).map((t) => t.name), ['contact', 'company', 'ticket']);
    // A type that does connect to itself stays: company↔company is a real one.
    assert.deepEqual(linkableObjectTypes('company', false, records, assoc).map((t) => t.name), ['contact', 'company', 'deal', 'ticket']);
    assert.deepEqual(linkableObjectTypes('contact', false, records, assoc).map((t) => t.name), ['contact', 'company', 'deal', 'ticket']);
  });

  it('still offers every record type from an activity, which is what the wildcard is for', () => {
    assert.deepEqual(linkableObjectTypes('note', true, records, assoc).map((t) => t.name), ['contact', 'company', 'deal', 'ticket']);
    // And an activity is a legitimate target from a record for the same reason.
    assert.deepEqual(linkableObjectTypes('ticket', false, types, assoc).map((t) => t.name), ['contact', 'company', 'deal', 'note']);
  });

  it('offers nothing at all for an object the data model connects to nothing', () => {
    const site = { name: 'site', category: 'record' as const };
    assert.deepEqual(linkableObjectTypes('site', false, [...records, site], assoc), []);
  });

  it('shows a stranded wildcard link between two records so it can be undone', () => {
    const stray = edge({
      record_id: 'tkt_nw_29', object_type: 'ticket', display_name: 'Onboarding',
      label: 'Logged on', association_type: 'activity_to_record',
    });
    const logged = edge({
      record_id: 'note_9', object_type: 'note', display_name: 'Site survey',
      label: 'Logged on', association_type: 'activity_to_record',
    });
    const isActivityType = (name: string) => name === 'note';
    // On a ticket page: the note stays in the timeline where it belongs, the
    // stranded ticket link surfaces in the rail where it can be removed.
    const rail = groupAssociations([stray, logged], false, isActivityType);
    assert.deepEqual([...rail.keys()], ['ticket']);
    // Without the predicate the old behaviour stands: both are hidden.
    assert.equal(groupAssociations([stray, logged], false).size, 0);
  });
});

describe('the import’s Check step', () => {
  const users: WorkspaceUser[] = [
    { id: 'usr_dana', name: 'Dana Whitfield', email: 'dana@northwind.io', title: null, role: 'owner', avatar_url: null, status: 'active' },
  ];
  const ctx = { users, currency: 'usd' };
  // Contacts as Ain ships them: a first and last name are required, email unique.
  const properties = [
    property({ name: 'first_name', type: 'string', label: 'First name', object_type: 'contact', required: true }),
    property({ name: 'last_name', type: 'string', label: 'Last name', object_type: 'contact', required: true }),
    property({ name: 'email', type: 'email', label: 'Email', unique: true, object_type: 'contact' }),
    property({ name: 'job_title', type: 'string', label: 'Job title', object_type: 'contact' }),
    property({ name: 'lifecycle_stage', type: 'enum', label: 'Lifecycle stage', object_type: 'contact', required: true, default_value: 'lead', options: [{ value: 'lead', label: 'Lead' }] }),
  ];
  const headers = ['Email', 'Job title'];
  const rows = [
    ['ingrid@nordhavn.example', 'Plant manager'],
    ['piet@example.com', 'QA lead'],
  ];
  const mapping = autoMapColumns(headers, properties);

  it('counts only the properties the API will actually insist on', () => {
    // A required property with a default is filled by the server, not by the file.
    assert.deepEqual(requiredForCreate(properties).map((p) => p.name), ['first_name', 'last_name']);
  });

  it('holds back a row that certainly cannot be created, instead of promising it', () => {
    const built = buildImportRows(rows, headers, mapping, properties, ctx, { operation: 'create' });
    // The defect: two rows counted as ready, then refused one at a time.
    assert.equal(built.records.length, 0);
    assert.deepEqual(built.missingRequired.map((p) => p.label), ['First name', 'Last name']);
    assert.deepEqual(
      built.problems.filter((p) => p.row === 1).map((p) => p.column),
      ['First name', 'Last name'],
    );
    assert.match(built.problems[0].message, /cannot be created without it/);
  });

  it('still sends a keyed upsert, and says out loud that it can only update', () => {
    const built = buildImportRows(rows, headers, mapping, properties, ctx, { operation: 'upsert', keyProperty: 'email' });
    // A job-title sync keyed on email is a legitimate import; it just cannot
    // create the contacts it does not find, and the count says so.
    assert.equal(built.records.length, 2);
    assert.equal(built.conditional, 2);
    assert.equal(built.problems.length, 0);
  });

  it('names the empty cell when the column is there but the row is blank', () => {
    const full = ['First name', 'Last name', 'Email'];
    const built = buildImportRows(
      [['Ingrid', 'Halvorsen', 'ingrid@nordhavn.example'], ['', 'de Vries', 'piet@example.com']],
      full, autoMapColumns(full, properties), properties, ctx, { operation: 'create' },
    );
    assert.deepEqual(built.records.map((r) => r.row), [1]);
    assert.deepEqual(built.missingRequired, []);
    assert.deepEqual(built.problems.map((p) => [p.row, p.column]), [[2, 'First name']]);
    assert.match(built.problems[0].message, /is empty on this row/);
  });

  it('refuses a row that brings an id to a create, which Ain never accepts', () => {
    const withId = ['id', 'First name', 'Last name'];
    const built = buildImportRows(
      [['con_nw_01', 'Ingrid', 'Halvorsen']],
      withId, autoMapColumns(withId, properties), properties, ctx, { operation: 'create' },
    );
    assert.equal(built.records.length, 0);
    assert.deepEqual(built.problems.map((p) => p.column), ['id']);
    assert.match(built.problems[0].message, /Ain assigns record ids/);
    // The same row under upsert is the re-import it looks like.
    const upsert = buildImportRows(
      [['con_nw_01', 'Ingrid', 'Halvorsen']],
      withId, autoMapColumns(withId, properties), properties, ctx, { operation: 'upsert' },
    );
    assert.equal(upsert.records.length, 1);
    assert.equal(upsert.problems.length, 0);
  });
});

describe('re-dating an instant across a daylight-saving jump', () => {
  const zone = 'America/New_York';
  it('keeps the wall clock, not a count of milliseconds since midnight', () => {
    // 8 March 2026 is the spring-forward Sunday in New York: that civil day is
    // 23 hours long, so 09:00 on it is only eight hours after its midnight.
    const onShortDay = zonedDayStart(Date.UTC(2026, 2, 8), zone) + 8 * 3_600_000;
    assert.deepEqual(wallClockIn(onShortDay, zone), { year: 2026, month: 3, day: 8, hour: 9, minute: 0, second: 0 });
    const moved = onCivilDay(Date.UTC(2026, 2, 12), zone, onShortDay);
    assert.deepEqual(wallClockIn(moved, zone), { year: 2026, month: 3, day: 12, hour: 9, minute: 0, second: 0 });
  });
});

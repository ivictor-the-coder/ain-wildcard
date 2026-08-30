import type { Ctx } from '../../kernel/context';
import { DAY, HOUR, MINUTE, startOfDay } from '../../../shared/time';
import { BUILTIN_ASSOCIATIONS, BUILTIN_OBJECT_TYPES, BUILTIN_PIPELINES, BUILTIN_VIEWS } from './builtin';
import { COMPANIES, NAME_POOLS, ROLES, type CompanySeed } from './seed-data';
import type { Crm } from './store';
import type { CrmRecord } from './types';

/** Deterministic PRNG so the demo workspace is byte-identical on every boot. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAM = ['usr_seed01', 'usr_seed02', 'usr_seed03', 'usr_seed04', 'usr_seed05', 'usr_seed06'];
const TEAM_NAMES = ['Dana Whitfield', 'Marcus Ilori', 'Priya Raman', 'Sofia Alvarez', 'Tom Becker', 'Nina Kowalski'];
const SALES = [1, 2, 0];
const SUCCESS = [3, 4];

/* ---------------------------- schema installation ------------------------- */

export function installBuiltins(ctx: Ctx, crm: Crm, orgId: string): void {
  const now = ctx.now();
  for (const seed of BUILTIN_OBJECT_TYPES) {
    if (crm.objectTypeOrNull(orgId, seed.name)) continue;
    ctx.db.insert('crm_object_types', {
      org_id: orgId, name: seed.name, id: `obj_${seed.name}`, label: seed.label,
      plural_label: seed.plural_label, description: seed.description, icon: seed.icon, color: seed.color,
      primary_property: seed.primary_property, secondary_property: seed.secondary_property ?? null,
      searchable: JSON.stringify(seed.searchable), category: seed.category ?? 'record',
      system: 1, position: seed.position, created: now, updated: now,
    });
  }
  for (const seed of BUILTIN_OBJECT_TYPES) {
    for (const prop of seed.properties) {
      if (crm.propertyOrNull(orgId, seed.name, prop.name)) continue;
      ctx.db.insert('crm_properties', {
        org_id: orgId, object_type: seed.name, name: prop.name, id: `prop_${seed.name}_${prop.name}`,
        label: prop.label, description: prop.description ?? null, type: prop.type,
        group_name: prop.group ?? 'Other', options: JSON.stringify(prop.options ?? []),
        reference_type: prop.reference_type ?? null,
        required: prop.required ? 1 : 0, unique_value: prop.unique ? 1 : 0,
        read_only: prop.read_only || prop.calculated ? 1 : 0, system: 1, hidden: prop.hidden ? 1 : 0,
        default_value: prop.default_value === undefined || prop.default_value === null ? null : JSON.stringify(prop.default_value),
        validation: JSON.stringify(prop.validation ?? {}), calculated: prop.calculated ?? null,
        currency: prop.currency ?? null, normalize: prop.normalize ?? 'none',
        position: prop.position ?? 500, created: now, updated: now,
      });
    }
  }
  for (const assoc of BUILTIN_ASSOCIATIONS) {
    const exists = ctx.db.get(`SELECT name FROM crm_association_types WHERE org_id = ? AND name = ?`, orgId, assoc.name);
    if (exists) continue;
    ctx.db.insert('crm_association_types', {
      org_id: orgId, name: assoc.name, id: `assoc_${assoc.name}`, from_object: assoc.from_object,
      to_object: assoc.to_object, label: assoc.label, inverse_label: assoc.inverse_label,
      cardinality: assoc.cardinality, system: 1, created: now,
    });
  }
  crm.reloadSchema();
  crm.pipelines.install(orgId, BUILTIN_PIPELINES);

  const viewCount = ctx.db.count(`SELECT COUNT(*) FROM crm_views WHERE org_id = ?`, orgId);
  if (viewCount === 0) {
    for (const view of BUILTIN_VIEWS) {
      crm.createView(orgId, { ...view, system: true, shared: true }, { emit: false });
    }
  }
}

/* -------------------------------- the story ------------------------------- */

/**
 * Seeded records carry stable, greppable ids — `cmp_nw_01`, `con_nw_014`,
 * `deal_nw_07`, `tkt_nw_03` — so other modules can point at the same accounts
 * the CRM shows and the demo stays coherent across a reseed. Look accounts up
 * by domain (`crm.findBy(orgId, 'company', 'domain', 'meridianforge.com')`)
 * rather than hard-coding an index.
 */

interface ContactRow {
  record: CrmRecord;
  company: CompanySeed;
  companyId: string;
  role: (typeof ROLES)[number];
  ownerIdx: number;
}

export function seedCrm(ctx: Ctx, crm: Crm, orgId: string): void {
  installBuiltins(ctx, crm, orgId);
  const now = ctx.now();
  const random = rng(0x4e57_10bd);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
  const write = { emit: false as const, history: false as const, source: 'import' as const };

  /* ------------------------------- companies ----------------------------- */

  const companyIds = new Map<string, string>();
  COMPANIES.forEach((seed, i) => {
    const created = now - seed.createdDaysAgo * DAY;
    const id = `cmp_nw_${String(i + 1).padStart(2, '0')}`;
    const isCustomer = seed.lifecycle === 'customer';
    const becameCustomer = isCustomer ? startOfDay(created + between(20, 90) * DAY) : null;
    crm.create(orgId, 'company', {
      name: seed.name,
      domain: seed.domain,
      website: `https://www.${seed.domain}`,
      description: seed.description,
      industry: seed.industry,
      type: seed.type,
      lifecycle_stage: seed.lifecycle,
      employee_count: seed.employees,
      annual_revenue: seed.revenue * 100,
      founded_year: seed.founded,
      plant_count: seed.plants,
      connected_assets: isCustomer || seed.type === 'partner' || seed.type === 'reseller' ? seed.assets : Math.round(seed.assets * 0.15),
      automation_maturity: seed.maturity,
      controls_platform: seed.platforms,
      support_tier: seed.tier,
      is_key_account: seed.key,
      became_customer_at: becameCustomer,
      renewal_date: becameCustomer ? startOfDay(becameCustomer + 365 * DAY) : null,
      lead_source: seed.source,
      lead_source_detail: seed.sourceDetail,
      street: seed.street,
      city: seed.city,
      state: seed.state,
      postal_code: seed.postal,
      country: seed.country,
      region: seed.region,
      phone: phoneFor(seed.country, random),
      linkedin_url: `https://www.linkedin.com/company/${seed.slug}`,
    }, { ...write, id, createdAt: created, ownerId: TEAM[seed.owner], actorId: TEAM[seed.owner] });
    companyIds.set(seed.slug, id);
  });

  // Two corporate structures, so the association graph is not a flat star.
  crm.associate(orgId, { fromId: companyIds.get('lakeshore')!, toId: companyIds.get('ironwood')!, associationType: 'company_to_company' }, { emit: false });
  crm.associate(orgId, { fromId: companyIds.get('cobaltline')!, toId: companyIds.get('sableworks')!, associationType: 'company_to_company' }, { emit: false });

  /* -------------------------------- contacts ----------------------------- */

  const contacts: ContactRow[] = [];
  const usedEmails = new Set<string>();
  // Two people with the same name in one book of business is what a real CRM
  // looks like after a bad import, not what it should look like on day one.
  const usedNames = new Set<string>();
  let contactSeq = 0;

  for (const seed of COMPANIES) {
    const companyId = companyIds.get(seed.slug)!;
    const created = now - seed.createdDaysAgo * DAY;
    const count = seed.key ? between(4, 5) : seed.lifecycle === 'customer' || seed.lifecycle === 'opportunity' ? between(2, 4) : between(1, 3);
    const roleOffset = between(0, ROLES.length - 1);

    for (let n = 0; n < count; n++) {
      const role = ROLES[(roleOffset + n * 3) % ROLES.length];
      const pool = NAME_POOLS[seed.names];
      let first = pool.first[(contactSeq * 7 + n * 3) % pool.first.length];
      let last = pool.last[(contactSeq * 5 + n * 2 + seed.slug.length) % pool.last.length];
      for (let attempt = 1; usedNames.has(`${first} ${last}`) && attempt <= pool.first.length * pool.last.length; attempt++) {
        last = pool.last[(contactSeq * 5 + n * 2 + seed.slug.length + attempt) % pool.last.length];
        first = pool.first[(contactSeq * 7 + n * 3 + Math.floor(attempt / pool.last.length)) % pool.first.length];
      }
      usedNames.add(`${first} ${last}`);
      let email = `${ascii(first)}.${ascii(last)}@${seed.domain}`;
      if (usedEmails.has(email)) email = `${ascii(first)}.${ascii(last)}${n + 1}@${seed.domain}`;
      usedEmails.add(email);
      contactSeq++;

      const id = `con_nw_${String(contactSeq).padStart(3, '0')}`;
      const contactCreated = created + between(0, 12) * DAY;
      const ownerIdx = n === 0 ? seed.owner : pick(seed.lifecycle === 'customer' ? SUCCESS : SALES);
      const lifecycle = seed.lifecycle === 'customer' && n < 2 ? 'customer'
        : seed.lifecycle === 'customer' ? 'subscriber'
        : seed.lifecycle;

      const record = crm.create(orgId, 'contact', {
        first_name: first,
        last_name: last,
        email,
        phone: phoneFor(seed.country, random),
        mobile_phone: random() > 0.55 ? phoneFor(seed.country, random) : null,
        job_title: role.title,
        seniority: role.seniority,
        department: role.department,
        buying_role: role.buyingRole,
        lifecycle_stage: lifecycle,
        lead_status: leadStatusFor(seed.lifecycle, n, random),
        lead_source: seed.source,
        lead_source_detail: seed.sourceDetail,
        city: seed.city,
        state: seed.state,
        country: seed.country,
        region: seed.region,
        timezone: timezoneFor(seed.country),
        linkedin_url: `https://www.linkedin.com/in/${ascii(first)}-${ascii(last)}-${seed.slug.slice(0, 4)}`,
        preferred_channel: pick(['email', 'email', 'phone', 'linkedin', 'in_person']),
        email_opt_in: random() > 0.28,
        next_step: n === 0 ? nextStepFor(seed.lifecycle, random) : null,
      }, { ...write, id, createdAt: contactCreated, ownerId: TEAM[ownerIdx], actorId: TEAM[ownerIdx] });

      crm.associate(orgId, { fromId: id, toId: companyId, associationType: 'contact_to_company', primary: true }, { emit: false, createdAt: contactCreated, actorId: TEAM[ownerIdx] });
      contacts.push({ record, company: seed, companyId, role, ownerIdx });
    }
  }

  // Reporting lines inside the two largest buying committees.
  const committee = contacts.filter((c) => c.company.slug === 'pemberton');
  if (committee.length > 2) {
    for (const member of committee.slice(1)) {
      crm.associate(orgId, { fromId: member.record.id, toId: committee[0].record.id, associationType: 'contact_to_contact' }, { emit: false });
    }
  }

  /* --------------------------------- deals ------------------------------- */

  const DEAL_SCOPES = [
    'plant-wide telemetry rollout', 'pilot expansion to 3 lines', 'enterprise agreement',
    'connected asset expansion', 'renewal + asset uplift', 'line 3 instrumentation',
    'predictive maintenance programme', 'multi-site rollout', 'OEE programme phase 2',
  ];
  // Each motion has its own stages, so a renewal never sits in a new-business
  // stage. The probabilities live on the stages themselves, in the pipeline.
  const EXPANSION_SCOPES = [
    'connected asset expansion', 'second plant rollout', 'OEE programme phase 2',
    'packaging line uplift', 'predictive maintenance add-on',
  ];
  const OPEN_STAGES: Record<string, string[]> = {
    new_business: ['qualification', 'discovery', 'technical_validation', 'proposal', 'negotiation'],
    expansion: ['qualification', 'discovery', 'proposal', 'negotiation'],
    renewal: ['renewal_outreach', 'usage_review', 'commercial_terms', 'negotiation'],
  };

  const deals: { id: string; companySlug: string; created: number; pipeline: string; stage: string; amount: number }[] = [];
  let dealSeq = 0;

  for (const seed of COMPANIES) {
    if (seed.lifecycle === 'lead' || seed.lifecycle === 'marketing_qualified_lead') continue;
    const companyId = companyIds.get(seed.slug)!;
    const dealCount = seed.key ? 2 : seed.lifecycle === 'customer' ? (seed.type === 'former_customer' ? 1 : between(1, 2)) : 1;

    for (let n = 0; n < dealCount; n++) {
      dealSeq++;
      const id = `deal_nw_${String(dealSeq).padStart(2, '0')}`;
      const created = now - Math.round(seed.createdDaysAgo * (0.8 - n * 0.35)) * DAY;
      // A customer's second deal is either the renewal of what they bought or
      // an expansion onto another line — the two motions Northwind actually
      // runs alongside new business, and the reason there are three pipelines.
      const followOn = n === 1 && seed.lifecycle === 'customer';
      const isRenewal = followOn && dealSeq % 2 === 1;
      const isExpansion = followOn && !isRenewal;
      const won = seed.lifecycle === 'customer' && n === 0;
      const lost = seed.type === 'former_customer';
      const pipeline = isRenewal ? 'renewal' : isExpansion ? 'expansion' : 'new_business';
      const stage = lost ? 'closed_lost' : won ? 'closed_won' : pick(OPEN_STAGES[pipeline]);
      const assets = Math.max(24, Math.round(seed.assets * (won ? 1 : followOn ? 1.25 : 0.55)));
      const perAsset = seed.tier === 'mission_critical' ? 540 : seed.tier === 'premium' ? 460 : 380;
      const amount = Math.round(assets * perAsset) * 100;
      const closeDate = stage === 'closed_won' || stage === 'closed_lost'
        ? startOfDay(created + between(45, 160) * DAY)
        : startOfDay(now + between(-12, 95) * DAY);

      crm.create(orgId, 'deal', {
        name: `${seed.name} — ${isRenewal ? 'renewal + asset uplift' : isExpansion ? pick(EXPANSION_SCOPES) : pick(DEAL_SCOPES)}`,
        pipeline,
        deal_stage: stage,
        amount,
        close_date: closeDate,
        deal_type: isRenewal ? 'renewal' : isExpansion ? 'expansion' : won ? 'pilot_conversion' : 'new_business',
        licensed_assets: assets,
        contract_term_months: pick([12, 12, 24, 36]),
        lead_source: seed.source,
        competitor: pick(['none', 'none', 'sight_machine', 'tulip', 'litmus', 'cognite', 'in_house', 'samsara']),
        next_step: stage.startsWith('closed') ? null : nextStepForStage(stage),
        close_reason: stage === 'closed_won' ? pick(['product_fit', 'time_to_value', 'exec_sponsor'])
          : stage === 'closed_lost' ? pick(['price', 'budget_cut', 'no_decision', 'competitor', 'product_gap']) : null,
        close_notes: stage === 'closed_lost'
          ? LOST_NOTES.budget_cut
          : stage === 'closed_won' ? `Signed on a ${assets}-asset commitment after a six-week pilot on the ${pick(['weld', 'assembly', 'packaging', 'machining'])} line.` : null,
        closed_at: stage.startsWith('closed') ? closeDate + 15 * HOUR : null,
      }, { ...write, id, createdAt: created, ownerId: TEAM[SALES[dealSeq % SALES.length]], actorId: TEAM[SALES[dealSeq % SALES.length]] });

      crm.associate(orgId, { fromId: id, toId: companyId, associationType: 'deal_to_company', primary: true }, { emit: false, createdAt: created });
      for (const contact of contacts.filter((c) => c.company.slug === seed.slug).slice(0, 3)) {
        crm.associate(orgId, { fromId: id, toId: contact.record.id, associationType: 'deal_to_contact' }, { emit: false, createdAt: created });
      }
      deals.push({ id, companySlug: seed.slug, created, pipeline, stage, amount });
    }

    // Nobody wins everything. Historical losses make the win rate believable
    // and give the forecast reports something honest to measure against.
    if (['customer', 'opportunity', 'sales_qualified_lead'].includes(seed.lifecycle) && random() > 0.6) {
      dealSeq++;
      const id = `deal_nw_${String(dealSeq).padStart(2, '0')}`;
      const created = now - Math.round(seed.createdDaysAgo * 0.95) * DAY;
      const closeDate = startOfDay(created + between(40, 130) * DAY);
      const assets = Math.max(18, Math.round(seed.assets * 0.3));
      const reason = pick(['price', 'budget_cut', 'no_decision', 'competitor', 'product_gap', 'champion_left']);
      crm.create(orgId, 'deal', {
        name: `${seed.name} — ${pick(['first pilot attempt', 'line 2 monitoring', 'edge analytics pilot'])}`,
        pipeline: 'new_business',
        deal_stage: 'closed_lost',
        amount: assets * 380 * 100,
        close_date: closeDate,
        deal_type: 'new_business',
        licensed_assets: assets,
        contract_term_months: 12,
        lead_source: seed.source,
        competitor: reason === 'competitor' ? pick(['sight_machine', 'tulip', 'litmus', 'cognite']) : 'none',
        close_reason: reason,
        close_notes: LOST_NOTES[reason],
        closed_at: closeDate + 16 * HOUR,
      }, { ...write, id, createdAt: created, ownerId: TEAM[SALES[dealSeq % SALES.length]], actorId: TEAM[SALES[dealSeq % SALES.length]] });
      crm.associate(orgId, { fromId: id, toId: companyId, associationType: 'deal_to_company', primary: true }, { emit: false, createdAt: created });
      deals.push({ id, companySlug: seed.slug, created, pipeline: 'new_business', stage: 'closed_lost', amount: assets * 380 * 100 });
    }
  }

  /* -------------------------------- tickets ------------------------------ */

  const TICKETS: [string, string, string, string, string][] = [
    ['Edge agent offline on Line 4 after firmware update', 'connectivity', 'telemetry_agent', 'high', 'Agent 4.2.1 stopped publishing after the PLC firmware was updated on Saturday. Three cells are dark and the shift supervisor is escalating.'],
    ['Cycle-time metric reads 0 for the weld cell', 'data_gap', 'cloud_ingest', 'medium', 'The weld cell reports cycle counts but cycle time comes through as zero. Suspect the tag mapping changed when the cell was re-commissioned.'],
    ['Historian backfill missing 14 hours', 'data_gap', 'cloud_ingest', 'high', 'Network maintenance on Tuesday night dropped the tunnel. Buffered data does not appear to have flushed once the link came back.'],
    ['SSO group mapping not applying to new engineers', 'integration', 'api', 'medium', 'Six new controls engineers were added to the Okta group but land in the platform without the Engineering role.'],
    ['Alert storm from vibration thresholds', 'alerts', 'alerts', 'urgent', 'Every spindle above 8k RPM is firing a vibration alert since the threshold change. Maintenance has muted the channel, which is worse.'],
    ['Request: export OEE by shift to our data lake', 'feature_request', 'api', 'low', 'They want a scheduled parquet export by shift, not per-minute records, so their Snowflake bill stays sane.'],
    ['Invoice shows 620 assets, we decommissioned 40', 'billing', 'api', 'medium', 'Forty presses were retired in March. The asset count on the invoice has not moved and finance is holding payment.'],
    ['Mobile app not showing the packaging plant', 'integration', 'mobile', 'low', 'Plant manager cannot see the Green Bay site on mobile, only on desktop. Permissions look identical.'],
    ['Onboarding: 18 new cells to bring online before the audit', 'onboarding', 'telemetry_agent', 'high', 'They need the new cells streaming before the customer audit on the 26th. Needs a coordinated cutover plan.'],
    ['Security review: outbound firewall rules for OT segment', 'security', 'telemetry_agent', 'high', 'OT security wants the exact egress ranges and a justification for each before they open the segment.'],
    ['Dashboard loads slowly with 900 assets selected', 'data_gap', 'dashboards', 'medium', 'Selecting the whole plant takes 20+ seconds to render. Filtering to one line is fine.'],
    ['Gateway hardware RMA for the Osaka plant', 'hardware', 'telemetry_agent', 'medium', 'Gateway 3 has failed twice in six weeks. Requesting replacement hardware and a root-cause note.'],
    ['Duplicate assets after the plant re-numbering', 'data_gap', 'cloud_ingest', 'medium', 'Asset IDs were re-numbered during the shutdown. We now have both old and new IDs reporting.'],
    ['Alert routing to the wrong maintenance rota', 'alerts', 'alerts', 'medium', 'Night-shift alerts are going to the day-shift rota. Escalation policy needs to follow the shift calendar.'],
    ['API rate limit hit during nightly sync', 'integration', 'api', 'medium', 'Their nightly ERP sync pulls 40k records and trips the rate limit around 02:30.'],
    ['Please add Spanish to the operator view', 'feature_request', 'dashboards', 'low', 'Line operators in Puebla need the operator view in Spanish; supervisors are fine in English.'],
  ];

  let ticketSeq = 0;
  const ticketCustomers = COMPANIES.filter((c) => c.lifecycle === 'customer' || c.key);
  for (const seed of ticketCustomers) {
    const ticketCount = seed.tier === 'mission_critical' ? 2 : random() > 0.45 ? 1 : 0;
    for (let n = 0; n < ticketCount; n++) {
      ticketSeq++;
      const [subject, category, area, priority, content] = TICKETS[(ticketSeq * 3 + n) % TICKETS.length];
      const id = `tkt_nw_${String(ticketSeq).padStart(2, '0')}`;
      const resolved = random() > 0.32;
      const created = resolved
        ? now - between(18, 210) * DAY - between(0, 20) * HOUR
        : now - between(0, 9) * DAY - between(0, 20) * HOUR;
      const firstResponse = created + between(6, 180) * MINUTE;
      const resolvedAt = resolved ? firstResponse + between(40, 4200) * MINUTE : null;
      const status = resolved ? 'closed' : pick(['new', 'waiting_on_us', 'waiting_on_customer', 'escalated']);
      const owner = TEAM[SUCCESS[ticketSeq % SUCCESS.length]];

      crm.create(orgId, 'ticket', {
        subject: `${subject}`,
        content,
        status,
        priority,
        category,
        product_area: area,
        source_channel: pick(['email', 'email', 'portal', 'chat', 'phone']),
        affected_line: pick(['Line 4 — packaging', 'Weld cell 12', 'Press shop A', 'Assembly line 2', 'Kiln 1', 'SMT line 7', 'Filling line 3']),
        sla_due_at: created + (priority === 'urgent' ? 4 : priority === 'high' ? 8 : 24) * HOUR,
        first_response_at: firstResponse,
        resolved_at: resolvedAt,
        resolution_minutes: resolvedAt ? Math.round((resolvedAt - created) / MINUTE) : null,
        satisfaction_score: resolvedAt ? pick([5, 5, 4, 4, 3]) : null,
      }, { ...write, id, createdAt: created, ownerId: owner, actorId: owner });

      crm.associate(orgId, { fromId: id, toId: companyIds.get(seed.slug)!, associationType: 'ticket_to_company', primary: true }, { emit: false, createdAt: created });
      const requester = contacts.find((c) => c.company.slug === seed.slug);
      if (requester) crm.associate(orgId, { fromId: id, toId: requester.record.id, associationType: 'ticket_to_contact' }, { emit: false, createdAt: created });
    }
  }

  /* ------------------------------- activities ---------------------------- */

  let activitySeq = 0;
  const logActivity = (
    type: string, props: Record<string, unknown>, at: number, ownerIdx: number, links: string[],
  ): void => {
    activitySeq++;
    const id = `${type === 'meeting' ? 'meet' : type}_nw_${String(activitySeq).padStart(4, '0')}`;
    crm.create(orgId, type, { ...props, occurred_at: at }, { ...write, id, createdAt: at, ownerId: TEAM[ownerIdx], actorId: TEAM[ownerIdx] });
    for (const link of links) crm.associate(orgId, { fromId: id, toId: link, associationType: 'activity_to_record' }, { emit: false, createdAt: at });
  };

  for (const contact of contacts) {
    const companyId = contact.companyId;
    const seed = contact.company;
    const owner = contact.ownerIdx;
    const ownerName = TEAM_NAMES[owner];
    const firstName = String(contact.record.properties.first_name ?? '');
    const start = contact.record.created;
    const span = Math.max(14 * DAY, now - start - 2 * DAY);
    const isPrimary = contact.role.buyingRole === 'champion' || contact.role.buyingRole === 'economic_buyer';
    const count = isPrimary ? between(5, 9) : between(2, 5);
    const dealForCompany = deals.find((d) => d.companySlug === seed.slug);
    const usedTemplates = new Set<object>();

    for (let n = 0; n < count; n++) {
      const at = start + Math.round((span * (n + 1)) / (count + 1)) + between(9, 17) * HOUR + between(0, 59) * MINUTE;
      if (at >= now) break;
      const links = [contact.record.id, companyId, ...(dealForCompany && n % 3 === 0 ? [dealForCompany.id] : [])];
      const roll = random();

      if (roll < 0.38) {
        const template = choose(EMAILS, seed.lifecycle, activitySeq + n, usedTemplates);
        logActivity('email', {
          subject: template.subject(seed, firstName),
          body: template.body(seed, firstName, ownerName),
          direction: n % 3 === 1 ? 'inbound' : 'outbound',
          from_email: n % 3 === 1 ? String(contact.record.properties.email) : `${ownerName.split(' ')[0].toLowerCase()}@northwind.io`,
          to_email: n % 3 === 1 ? `${ownerName.split(' ')[0].toLowerCase()}@northwind.io` : String(contact.record.properties.email),
          status: pick(['delivered', 'opened', 'opened', 'clicked', 'replied', 'sent']),
        }, at, owner, links);
      } else if (roll < 0.63) {
        const template = choose(CALLS, seed.lifecycle, activitySeq + n, usedTemplates);
        const outcome = pick(['connected', 'connected', 'connected', 'left_voicemail', 'no_answer']);
        logActivity('call', {
          subject: template.subject(seed, firstName),
          body: outcome === 'connected' ? template.body(seed, firstName, ownerName) : `No answer. Left a short voicemail referencing the ${pick(['uptime benchmark', 'pilot results', 'asset count', 'renewal date'])} and followed up by email.`,
          direction: 'outbound',
          duration_minutes: outcome === 'connected' ? between(8, 47) : 1,
          outcome,
        }, at, owner, links);
      } else if (roll < 0.78) {
        const template = choose(MEETINGS, seed.lifecycle, activitySeq + n, usedTemplates);
        const duration = between(30, 90);
        logActivity('meeting', {
          subject: template.subject(seed, firstName),
          body: template.body(seed, firstName, ownerName),
          start_at: at,
          end_at: at + duration * MINUTE,
          location: pick([`${seed.city} plant — conference room`, 'Google Meet', 'Zoom', 'Microsoft Teams', `${seed.city} — on site`]),
          meeting_type: template.type,
          outcome: random() > 0.12 ? 'held' : pick(['rescheduled', 'no_show']),
          attendee_count: between(2, 8),
        }, at, owner, links);
      } else if (roll < 0.92) {
        const template = choose(NOTES, seed.lifecycle, activitySeq + n, usedTemplates);
        logActivity('note', {
          subject: template.subject(seed, firstName),
          body: template.body(seed, firstName, ownerName),
          pinned: n === 0 && isPrimary,
        }, at, owner, links);
      } else {
        const template = choose(TASKS, seed.lifecycle, activitySeq + n, usedTemplates);
        const due = at + between(1, 12) * DAY;
        const done = due < now && random() > 0.35;
        logActivity('task', {
          subject: template.subject(seed, firstName),
          body: template.body(seed, firstName, ownerName),
          status: done ? 'completed' : due < now ? pick(['in_progress', 'not_started', 'waiting']) : 'not_started',
          due_at: due,
          completed_at: done ? due - between(1, 40) * HOUR : null,
          priority: pick(['medium', 'medium', 'high', 'low', 'urgent']),
          task_type: template.taskType,
        }, at, owner, links);
      }
    }
  }

  /* ---------------------------- property history ------------------------- */

  const LIFECYCLE_PATH = ['lead', 'marketing_qualified_lead', 'sales_qualified_lead', 'opportunity', 'customer'];
  COMPANIES.forEach((seed, i) => {
    const id = `cmp_nw_${String(i + 1).padStart(2, '0')}`;
    const created = now - seed.createdDaysAgo * DAY;
    const targetIndex = LIFECYCLE_PATH.indexOf(seed.lifecycle);
    if (targetIndex <= 0) return;
    const stepSpan = Math.max(3 * DAY, Math.floor((now - created) * 0.7 / targetIndex));
    for (let step = 1; step <= targetIndex; step++) {
      crm.recordHistory(orgId, 'company', id, 'lifecycle_stage', LIFECYCLE_PATH[step - 1], LIFECYCLE_PATH[step],
        created + step * stepSpan + between(2, 9) * HOUR,
        { actorId: TEAM[seed.owner], actorType: 'user', source: step === targetIndex && seed.lifecycle === 'customer' ? 'workflow' : 'user' });
    }
  });

  for (const deal of deals) {
    const path = OPEN_STAGES[deal.pipeline];
    const closed = deal.stage === 'closed_won' || deal.stage === 'closed_lost';
    const target = closed ? path.length : path.indexOf(deal.stage);
    const span = Math.max(2 * DAY, Math.floor((now - deal.created) * 0.75 / Math.max(1, target)));
    const seedRow = COMPANIES.find((c) => c.slug === deal.companySlug)!;
    let enteredCurrentStage = deal.created;
    for (let step = 1; step <= target; step++) {
      const to = step === path.length ? deal.stage : path[step];
      const at = deal.created + step * span + between(1, 8) * HOUR;
      crm.recordHistory(orgId, 'deal', deal.id, 'deal_stage', path[step - 1], to, at,
        { actorId: TEAM[seedRow.owner], actorType: 'user', source: 'user' });
      enteredCurrentStage = at;
    }
    // The stamp has to agree with the trail, or "days in stage" says every
    // deal arrived the day it was created and the funnel report is fiction.
    crm.setSystemProperties(orgId, deal.id, { stage_entered_at: enteredCurrentStage });
    if (deal.stage === 'negotiation' || deal.stage === 'proposal') {
      const original = Math.round(deal.amount * 1.18);
      crm.recordHistory(orgId, 'deal', deal.id, 'amount', original, deal.amount,
        now - between(5, 40) * DAY, { actorId: TEAM[seedRow.owner], actorType: 'user', source: 'user' });
    }
  }

  // Last-modified should read as the last time anything happened on the record,
  // not the moment the seed inserted it.
  ctx.db.run(
    `UPDATE crm_records SET updated = MAX(updated, COALESCE(
       (SELECT v.value_date FROM crm_record_values v WHERE v.record_id = crm_records.id AND v.property = 'last_activity_at'), 0))
      WHERE org_id = ?`, orgId);

  ctx.log.info('crm.seeded', {
    companies: COMPANIES.length,
    contacts: contacts.length,
    deals: deals.length,
    tickets: ticketSeq,
    activities: activitySeq,
  });
}

/* -------------------------------- templates ------------------------------- */

interface Template {
  /** Lifecycle stages this piece of correspondence would plausibly belong to. */
  stages: string[];
  subject: (c: CompanySeed, name: string) => string;
  body: (c: CompanySeed, name: string, owner: string) => string;
}

const EMAILS: Template[] = [
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead'], subject: (c) => `Uptime benchmark for ${c.industry.replace(/_/g, ' ')} plants`, body: (c, n, o) => `Hi ${n},\n\nThe benchmark I mentioned is attached. The median plant in your segment loses 11.4% of available runtime to unplanned stops; the top quartile is under 5%. With ${c.assets} assets across ${c.plants} sites, every point of that is roughly $180k a year.\n\nWorth 20 minutes to walk through where your lines sit?\n\n${o}` },
  { stages: ['sales_qualified_lead', 'opportunity'], subject: (c, n) => `Re: telemetry pilot at ${c.city}`, body: (c, n, o) => `${n},\n\nConfirming what we agreed: we instrument twelve assets on one line, no PLC changes, read-only OPC UA. Two weeks to first dashboard, four weeks to a defensible number on unplanned downtime.\n\nI have pencilled in your controls team for the kick-off. Anything from OT security we should get ahead of?\n\n${o}` },
  { stages: ['sales_qualified_lead', 'opportunity'], subject: () => 'Questions from our OT security review', body: (c, n, o) => `Hi ${o.split(' ')[0]},\n\nSecurity came back with three questions before we can open the segment: outbound destinations and ports, whether the agent ever accepts inbound connections, and how certificates are rotated.\n\nCan you send something I can forward verbatim? They will not take a marketing PDF.\n\nThanks,\n${n}` },
  { stages: ['opportunity'], subject: (c) => `Proposal — ${c.name}`, body: (c, n, o) => `Hi ${n},\n\nProposal attached. It covers ${Math.round(c.assets * 0.55)} assets in year one with headroom to add the second site without renegotiating, and the usage line is capped so a busy quarter cannot surprise your budget.\n\nHappy to walk your procurement team through the commercial terms directly.\n\n${o}` },
  { stages: ['opportunity', 'customer'], subject: () => 'Downtime numbers from last month', body: (c, n, o) => `${o.split(' ')[0]},\n\nPulled the numbers you asked for. Line 4 accounted for 62% of unplanned stops last month, mostly infeed jams under 6 minutes — exactly the kind that never get logged manually.\n\nThat is the argument I will take to my VP. Send me something on ROI I can put in front of finance.\n\n${n}` },
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead', 'opportunity', 'customer', 'other'], subject: (c) => `Following up after ${c.city}`, body: (c, n, o) => `Hi ${n},\n\nGood to walk the ${c.city} floor with you. Two things stood out: the ${platformLabel(c.platforms[0])} cells have the tag structure we need already, and your maintenance planner is doing by hand what the alerting would do automatically.\n\nI will send a scoped plan for the first line by Thursday.\n\n${o}` },
  { stages: ['customer'], subject: () => 'Renewal timing and asset count', body: (c, n, o) => `Hi ${n},\n\nYour term renews in eight weeks. You are running ${c.assets} connected assets against a ${Math.round(c.assets * 0.85)} commitment, so I would rather right-size the contract than have you pay overage every month.\n\nCan we get 30 minutes with finance before the end of the month?\n\n${o}` },
  { stages: ['lead', 'marketing_qualified_lead'], subject: () => 'Intro from the integrator', body: (c, n, o) => `Hi ${n},\n\nYour integrator suggested we speak — they deploy our telemetry with every cobot cell they commission, and mentioned you are adding two cells this quarter.\n\nIf it is useful I can show you what their other customers see in the first thirty days.\n\n${o}` },
  { stages: ['opportunity'], subject: (c) => `Data from the ${c.city} pilot — week 2`, body: (c, n, o) => `${n},\n\nTwo weeks in: 41 unplanned stops captured, 78% of them under four minutes, and a clear pattern on the second shift that nobody had visibility into before.\n\nI have put the shift comparison at the top of your dashboard. Worth showing your COO before the steering meeting.\n\n${o}` },
  { stages: ['sales_qualified_lead', 'opportunity'], subject: () => 'Re: budget cycle', body: (c, n, o) => `Hi ${o.split(' ')[0]},\n\nOur capital cycle closes in November, so anything above $150k has to be in the plan by mid-October. Operating spend is easier — that comes out of the plant budget and I can approve up to $90k myself.\n\nStructure it that way and this gets much simpler.\n\n${n}` },
  { stages: ['opportunity', 'customer'], subject: (c) => `${c.name} — kickoff scheduling`, body: (c, n, o) => `Hi ${n},\n\nOnboarding slot confirmed for the week of the 14th. We will need one network contact, one controls contact, and about two hours of their time in total. Nothing else.\n\nI will send the pre-flight checklist tomorrow.\n\n${o}` },
  { stages: ['customer'], subject: () => 'Quick question on alert thresholds', body: (c, n, o) => `${o.split(' ')[0]},\n\nMy team turned on vibration alerts and got 200 notifications in a day. Before they mute the whole channel — is there a sensible way to baseline per asset class rather than one global threshold?\n\n${n}` },
];

const CALLS: Template[] = [
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead'], subject: (c, n) => `Discovery call with ${n}`, body: (c, n, o) => `Walked through the current state. ${c.plants} sites, ${c.assets} candidate assets, ${c.platforms.map(platformLabel).join(' and ')} on the floor. No historian on the newer cells; maintenance schedules are calendar-based, not condition-based.\n\nPain is concentrated on unplanned stops during the second shift. ${n} owns the uptime number and is measured on it quarterly. Budget sits with the VP of Operations.\n\nNext: scope a single-line pilot and get the controls engineer on the technical call.` },
  { stages: ['sales_qualified_lead', 'opportunity'], subject: () => 'Technical qualification — controls stack', body: (c, n, o) => `Confirmed OPC UA is available on the ${platformLabel(c.platforms[0])} cells and the tags are named consistently. Older cells will need a protocol converter, which they already own for three of them.\n\n${n} is comfortable with read-only access. The blocker is OT security sign-off, not the technology.` },
  { stages: ['opportunity'], subject: () => 'Pilot results review', body: (c, n, o) => `Reviewed the first four weeks. Captured 41 unplanned stops totalling 6.2 hours; 78% were micro-stops nobody was logging. ${n} was visibly surprised by the second-shift pattern.\n\nAgreed to present to the operations leadership team in two weeks. ${o} to prepare the before/after view.` },
  { stages: ['opportunity'], subject: () => 'Commercial discussion', body: (c, n, o) => `Talked pricing. Per-asset per-month lands well because it scales with their rollout rather than requiring a big upfront number. Procurement will want a cap on the usage line — noted, we can do an annual ceiling.\n\nThey are comparing against building on their existing historian, which their own team estimates at nine months.` },
  { stages: ['customer'], subject: () => 'Check-in on the rollout', body: (c, n, o) => `Rollout is on track for the ${c.city} site. Two gateways to install next week, then the second line comes online.\n\n${n} raised that the night-shift rota is not getting the alerts — logged a ticket for the alert routing.` },
  { stages: ['customer'], subject: () => 'Renewal conversation', body: (c, n, o) => `Renewal is in eight weeks. They are over their committed asset count, which ${n} sees as proof it is working rather than a problem.\n\nAppetite to expand to the second site if we hold the per-asset rate. Finance wants a three-year option priced.` },
  { stages: ['lead', 'marketing_qualified_lead'], subject: (c, n) => `Cold call — ${n}`, body: (c, n, o) => `Reached ${n} on the second attempt. They are mid-way through an MES evaluation and see telemetry as adjacent rather than competing. Open to a conversation after their selection completes in six weeks.\n\nAsked for the uptime benchmark in the meantime. Task set to follow up.` },
  { stages: ['customer'], subject: () => 'Escalation call after the outage', body: (c, n, o) => `Called ${n} directly after the ingest gap. Explained the root cause honestly — buffered data did not flush when the tunnel came back — and that the fix ships next week.\n\nThey were fine with the answer, less fine that they found it before we did. Committed to proactive notification on ingest gaps over 30 minutes.` },
  { stages: ['opportunity'], subject: () => 'Executive briefing prep', body: (c, n, o) => `Prepped ${n} for the briefing with their COO. Landed on three slides: unplanned downtime trend, cost per stop, and the rollout plan by site.\n\n${n} will present; ${o} will attend to answer technical questions only. Deliberately not our pitch deck.` },
  { stages: ['opportunity'], subject: () => 'Procurement — terms and security', body: (c, n, o) => `Procurement wants the DPA, the SOC 2 report and a two-year price hold. All three are fine. They also asked about exit — data export in an open format is in the contract already.\n\nNo commercial obstacles remaining. Signature is a scheduling problem now.` },
];

interface MeetingTemplate extends Template { type: string }

const MEETINGS: MeetingTemplate[] = [
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead'], type: 'discovery', subject: (c) => `Discovery — ${c.name}`, body: (c, n) => `Attendees: ${n} plus the maintenance manager and one controls engineer.\n\nCurrent state: ${c.plants} plants, calendar-based maintenance, no unified view of stop reasons. They track OEE in a spreadsheet that one person updates weekly.\n\nAgreed success criteria for a pilot: capture every stop over 30 seconds on one line, and attribute it to a cause without an operator typing anything.` },
  { stages: ['marketing_qualified_lead', 'sales_qualified_lead', 'opportunity'], type: 'demo', subject: () => 'Platform demo', body: (c, n) => `Demoed against a plant that looks like theirs. The moment that landed was the stop-reason waterfall — ${n} immediately asked whether it could be split by shift, which it can.\n\nQuestions were all practical: agent footprint, network egress, what happens when the link drops. No feature objections.` },
  { stages: ['sales_qualified_lead', 'opportunity'], type: 'technical_deep_dive', subject: () => 'Technical deep dive with controls and IT', body: (c, n) => `Two hours with the controls team and OT security. Covered agent architecture, certificate rotation, the read-only guarantee and the exact egress ranges.\n\nSecurity's only remaining ask is a signed statement that the agent never accepts inbound connections. Sending it this week.` },
  { stages: ['opportunity'], type: 'pilot_review', subject: () => 'Pilot review — week 6', body: (c, n) => `Six-week pilot results reviewed with ${n} and the plant manager.\n\n41 unplanned stops captured, 6.2 hours of lost runtime, 78% micro-stops. Extrapolated across ${c.plants} sites that is roughly $2.1m a year of recoverable runtime.\n\nDecision: proceed to a line-by-line rollout starting with the highest-volume line.` },
  { stages: ['customer'], type: 'qbr', subject: (c) => `Quarterly business review — ${c.name}`, body: (c, n) => `Reviewed the quarter: ${c.assets} assets connected, 94.2% agent uptime, mean time to detect down from 42 minutes to under 3.\n\nOpen items: alert routing by shift, and the data-lake export they have asked about twice. Both now on the roadmap conversation for next quarter.\n\n${n} confirmed the renewal will not be competitive if the export lands.` },
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead', 'opportunity', 'customer', 'other'], type: 'onsite', subject: (c) => `On-site visit — ${c.city} plant`, body: (c, n) => `Walked the floor with ${n}. Saw the actual failure mode on the infeed conveyor — a jam that operators clear in 90 seconds and never log, twenty times a shift.\n\nThat is the number that sells this. Photographed the line layout for the rollout plan (with permission).` },
  { stages: ['opportunity'], type: 'executive_briefing', subject: () => 'Executive briefing', body: (c, n) => `Forty minutes with the COO and CFO. Framed entirely in recoverable runtime and cost per stop, not features.\n\nCFO asked one question: what happens to the bill if we double the asset count. Answered with the annual ceiling. That was the meeting.` },
  { stages: ['sales_qualified_lead', 'opportunity'], type: 'demo', subject: () => 'Follow-up demo for the wider team', body: (c, n) => `Second demo for eleven people including three plant managers who had not seen it. ${n} ran half of it themselves, which is the best possible sign.\n\nOne plant manager pushed back on alert volume; showed per-asset baselining and that settled it.` },
];

const NOTES: Template[] = [
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead', 'opportunity', 'customer', 'other'], subject: () => 'Account plan', body: (c, n, o) => `Entry point is ${n} on the engineering side; the economic buyer is the VP of Operations, who we have met once.\n\nCompelling event is the ${pickStatic(['annual shutdown', 'customer audit', 'capital planning cycle', 'rate ramp'], c.slug)} — after that the window closes for two quarters.\n\nRisk: their internal platform team has built dashboards before and will argue they can do this. Counter is time-to-value, not capability.` },
  { stages: ['sales_qualified_lead', 'opportunity'], subject: () => 'Competitive intelligence', body: (c) => `They are also looking at ${pickStatic(['Sight Machine', 'Tulip', 'Litmus Edge', 'an in-house build on their historian'], c.domain)}.\n\nStrength there is the existing relationship; weakness is deployment time — nine months on their own estimate versus four weeks for a pilot with us. Lead with time-to-first-insight.` },
  { stages: ['sales_qualified_lead', 'opportunity'], subject: () => 'Org and buying process', body: (c, n) => `Buying committee is larger than it looks. ${n} champions, the maintenance manager is the day-to-day user, OT security holds a hard veto, and procurement will run a formal comparison over $100k.\n\nKeep the first phase under the plant manager's own approval threshold and the process shortens by a quarter.` },
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead', 'opportunity', 'customer', 'other'], subject: () => 'Technical environment', body: (c) => `${c.platforms.map(platformLabel).join(', ')} on the floor across ${c.plants} sites. OPC UA available on newer cells; older equipment needs converters, three of which they already own.\n\nNetwork is properly segmented, which is good news for the security conversation and bad news for the timeline.` },
  { stages: ['customer'], subject: () => 'Renewal risk note', body: (c, n) => `Watch this one. Their sponsor changed in the last quarter and the new ${n ? 'director' : 'lead'} has not seen the original business case.\n\nAction: rebuild the value story with current data before the renewal conversation, not during it.` },
  { stages: ['other'], subject: () => 'Post-mortem', body: (c) => `Lost on timing, not product. Their owner froze all software spend three weeks before signature; our champion fought for it and lost.\n\nRelationship intact. Revisit after their fiscal year closes — the champion asked us to.` },
  { stages: ['customer'], subject: () => 'Voice of the customer', body: (c, n) => `${n}, unprompted: "the thing I did not expect is that maintenance now argues with data instead of with each other."\n\nWorth using in the case study if they will let us. Asked; they will check with communications.` },
  { stages: ['customer'], subject: () => 'Expansion signal', body: (c) => `Their second site has started asking questions in the shared Slack channel without us prompting. That is normally six to eight weeks ahead of a formal expansion request.\n\nAction: get ahead of it with a scoped proposal for the second site.` },
];

interface TaskTemplate extends Template { taskType: string }

const TASKS: TaskTemplate[] = [
  { stages: ['sales_qualified_lead', 'opportunity'], taskType: 'follow_up', subject: () => 'Send the OT security statement', body: (c, n) => `Security needs the signed statement on inbound connections before they will open the segment. ${n} is blocked on it.` },
  { stages: ['sales_qualified_lead', 'opportunity'], taskType: 'call', subject: (c, n) => `Call ${n} about the pilot scope`, body: () => 'Confirm which line, how many assets, and who from controls is assigned. Nothing moves until the line is chosen.' },
  { stages: ['opportunity'], taskType: 'email', subject: () => 'Send the ROI model', body: (c) => `Finance wants the model with their own numbers: ${c.assets} assets, ${c.plants} sites, their labour rate.` },
  { stages: ['customer'], taskType: 'follow_up', subject: () => 'Prepare the QBR deck', body: (c) => `Pull uptime, mean time to detect and asset growth for the quarter. Three slides maximum — last time we brought nine and used two.` },
  { stages: ['customer'], taskType: 'todo', subject: () => 'Right-size the contract before renewal', body: (c) => `They are running over the committed asset count. Model the renewal at ${Math.round(c.assets * 1.15)} assets and take it to finance before it becomes an overage argument.` },
  { stages: ['lead', 'marketing_qualified_lead', 'sales_qualified_lead', 'opportunity', 'customer', 'other'], taskType: 'call', subject: () => 'Debrief with the integrator', body: () => 'They saw the account before we did. Find out what the plant manager told them about the timeline.' },
];

/* --------------------------------- helpers -------------------------------- */

/** Pick a template that fits where the account actually is in its lifecycle. */
function choose<T extends { stages: string[] }>(list: T[], lifecycle: string, seq: number, used: Set<object>): T {
  const eligible = list.filter((t) => t.stages.includes(lifecycle));
  const pool = eligible.length ? eligible : list;
  const fresh = pool.filter((t) => !used.has(t));
  const from = fresh.length ? fresh : pool;
  const chosen = from[Math.abs(seq) % from.length];
  used.add(chosen);
  return chosen;
}

function pickStatic<T>(list: T[], key: string): T {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return list[hash % list.length];
}

function ascii(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

const DIAL_CODES: Record<string, [string, string]> = {
  'United States': ['+1', 'us'], Canada: ['+1', 'us'], Germany: ['+49', 'eu'], Sweden: ['+46', 'eu'],
  France: ['+33', 'eu'], Netherlands: ['+31', 'eu'], Ireland: ['+353', 'eu'], Italy: ['+39', 'eu'],
  Denmark: ['+45', 'eu'], Spain: ['+34', 'eu'], 'United Kingdom': ['+44', 'eu'], Poland: ['+48', 'eu'],
  Switzerland: ['+41', 'eu'], 'Türkiye': ['+90', 'eu'], Japan: ['+81', 'apac'], 'South Korea': ['+82', 'apac'],
  Australia: ['+61', 'apac'], Malaysia: ['+60', 'apac'], India: ['+91', 'apac'], China: ['+86', 'apac'],
  Argentina: ['+54', 'latam'], Brazil: ['+55', 'latam'], Mexico: ['+52', 'latam'], Chile: ['+56', 'latam'],
  Colombia: ['+57', 'latam'],
};

function phoneFor(country: string, random: () => number): string {
  const [code] = DIAL_CODES[country] ?? ['+1', 'us'];
  const four = () => String(1000 + Math.floor(random() * 8999));
  const three = () => String(200 + Math.floor(random() * 799));
  return code === '+1' ? `${code} (${three()}) 555-${four()}` : `${code} ${three()} 555${four()}`;
}

const TIMEZONES: Record<string, string> = {
  'United States': 'America/Chicago', Canada: 'America/Toronto', Germany: 'Europe/Berlin',
  Sweden: 'Europe/Stockholm', France: 'Europe/Paris', Netherlands: 'Europe/Amsterdam',
  Ireland: 'Europe/Dublin', Italy: 'Europe/Rome', Denmark: 'Europe/Copenhagen', Spain: 'Europe/Madrid',
  'United Kingdom': 'Europe/London', Poland: 'Europe/Warsaw', Switzerland: 'Europe/Zurich',
  'Türkiye': 'Europe/Istanbul', Japan: 'Asia/Tokyo', 'South Korea': 'Asia/Seoul',
  Australia: 'Australia/Perth', Malaysia: 'Asia/Kuala_Lumpur', India: 'Asia/Kolkata', China: 'Asia/Shanghai',
  Argentina: 'America/Argentina/Buenos_Aires', Brazil: 'America/Sao_Paulo', Mexico: 'America/Mexico_City',
  Chile: 'America/Santiago', Colombia: 'America/Bogota',
};
const timezoneFor = (country: string): string => TIMEZONES[country] ?? 'UTC';

function leadStatusFor(lifecycle: string, index: number, random: () => number): string {
  if (lifecycle === 'customer') return 'connected';
  if (lifecycle === 'opportunity') return index === 0 ? 'in_progress' : 'connected';
  if (lifecycle === 'sales_qualified_lead') return random() > 0.5 ? 'in_progress' : 'open';
  if (lifecycle === 'marketing_qualified_lead') return random() > 0.5 ? 'open' : 'new';
  if (lifecycle === 'other') return 'unqualified';
  return random() > 0.7 ? 'nurturing' : 'new';
}

function nextStepFor(lifecycle: string, random: () => number): string {
  const options: Record<string, string[]> = {
    customer: ['Schedule the quarterly business review', 'Confirm asset count before renewal', 'Introduce the second site'],
    opportunity: ['Get OT security sign-off', 'Present pilot results to the operations leadership team', 'Send the proposal to procurement'],
    sales_qualified_lead: ['Scope the single-line pilot', 'Get the controls engineer on a technical call', 'Send the uptime benchmark'],
    marketing_qualified_lead: ['Qualify budget and timeline', 'Book a discovery call'],
    lead: ['Attempt a first call', 'Send the industry benchmark'],
    other: ['Revisit after their fiscal year closes'],
  };
  const list = options[lifecycle] ?? options.lead;
  return list[Math.floor(random() * list.length)];
}

const PLATFORM_LABELS: Record<string, string> = {
  siemens: 'Siemens TIA', rockwell: 'Rockwell FactoryTalk', beckhoff: 'Beckhoff TwinCAT',
  mitsubishi: 'Mitsubishi', omron: 'Omron', fanuc: 'FANUC', abb: 'ABB', kuka: 'KUKA',
  universal_robots: 'Universal Robots',
};
const platformLabel = (value: string): string => PLATFORM_LABELS[value] ?? value;

const LOST_NOTES: Record<string, string> = {
  price: 'Came down to per-asset price at scale. They took an in-house build for the remaining 400 assets and kept us on the pilot line only.',
  budget_cut: 'Private-equity owner froze all software spend three weeks before signature. Champion fought for it and lost. Revisit after their fiscal year closes.',
  no_decision: 'Sponsor moved to a different plant and nobody picked it up. Two follow-ups went unanswered; parking until there is a named owner again.',
  competitor: 'Chose the incumbent historian vendor. Their existing enterprise agreement made the marginal cost look like zero, which we could not beat on paper.',
  product_gap: 'Needed batch genealogy tied to the telemetry stream, which we do not do yet. They were explicit that they would revisit when we ship it.',
  champion_left: 'Champion left for a competitor six weeks before close. The replacement restarted the evaluation from scratch and chose to defer.',
};

const STAGE_NEXT_STEPS: Record<string, string> = {
  qualification: 'Confirm budget owner and compelling event',
  discovery: 'Scope the pilot line and asset list',
  technical_validation: 'Close out the OT security review',
  proposal: 'Walk procurement through the commercial terms',
  negotiation: 'Agree the usage ceiling and get signature',
};
const nextStepForStage = (stage: string): string => STAGE_NEXT_STEPS[stage] ?? 'Confirm next steps';


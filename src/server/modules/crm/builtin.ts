import type {
  AssociationTypeDef, FilterNode, ObjectTypeDef, PipelineBinding, PropertyDef, PropertyOption,
  PropertyType, SortSpec,
} from './types';

/**
 * The object model Ain ships with. Everything here is ordinary data — a
 * workspace can add properties, add object types, or hide these — but this is
 * the vocabulary an industrial-automation revenue team recognises on day one.
 */

type PropertySeed = Omit<Partial<PropertyDef>, 'name' | 'label' | 'type'> & {
  name: string;
  label: string;
  type: PropertyType;
};

export interface ObjectTypeSeed {
  name: string;
  label: string;
  plural_label: string;
  description: string;
  icon: string;
  color: string;
  primary_property: string;
  secondary_property?: string;
  searchable: string[];
  category?: 'record' | 'activity';
  position: number;
  properties: PropertySeed[];
}

const opts = (...pairs: [string, string, string?][]): PropertyOption[] =>
  pairs.map(([value, label, color], i) => ({ value, label, color: color ?? 'gray', position: i }));

const LIFECYCLE = opts(
  ['subscriber', 'Subscriber', 'gray'],
  ['lead', 'Lead', 'blue'],
  ['marketing_qualified_lead', 'Marketing qualified lead', 'indigo'],
  ['sales_qualified_lead', 'Sales qualified lead', 'violet'],
  ['opportunity', 'Opportunity', 'amber'],
  ['customer', 'Customer', 'green'],
  ['evangelist', 'Evangelist', 'teal'],
  ['other', 'Other', 'gray'],
);

const LEAD_SOURCE = opts(
  ['trade_show', 'Trade show', 'orange'],
  ['inbound_content', 'Inbound content', 'blue'],
  ['outbound_sequence', 'Outbound sequence', 'violet'],
  ['partner_referral', 'Partner referral', 'teal'],
  ['customer_referral', 'Customer referral', 'green'],
  ['webinar', 'Webinar', 'indigo'],
  ['paid_search', 'Paid search', 'amber'],
  ['field_event', 'Field event', 'pink'],
  ['expansion', 'Existing customer expansion', 'green'],
);

const REGION = opts(
  ['north_america', 'North America', 'blue'],
  ['emea', 'EMEA', 'violet'],
  ['apac', 'APAC', 'teal'],
  ['latam', 'LATAM', 'amber'],
);

const INDUSTRY = opts(
  ['automotive', 'Automotive', 'blue'],
  ['aerospace', 'Aerospace & defence', 'indigo'],
  ['food_beverage', 'Food & beverage', 'green'],
  ['pharma', 'Pharmaceuticals', 'teal'],
  ['semiconductors', 'Semiconductors', 'violet'],
  ['metals', 'Metals & mining', 'gray'],
  ['cpg', 'Consumer packaged goods', 'pink'],
  ['chemicals', 'Chemicals', 'amber'],
  ['energy', 'Energy & utilities', 'orange'],
  ['logistics', 'Logistics & warehousing', 'blue'],
  ['building_products', 'Building products', 'gray'],
  ['medical_devices', 'Medical devices', 'teal'],
  ['packaging', 'Plastics & packaging', 'violet'],
  ['contract_mfg', 'Contract manufacturing', 'indigo'],
);

const OBJECT_SEEDS: ObjectTypeSeed[] = [
  {
    name: 'contact',
    label: 'Contact',
    plural_label: 'Contacts',
    description: 'A person Northwind sells to, supports or partners with.',
    icon: 'user',
    color: 'blue',
    primary_property: 'full_name',
    secondary_property: 'job_title',
    searchable: ['full_name', 'email', 'job_title', 'phone', 'city'],
    position: 10,
    properties: [
      { name: 'first_name', label: 'First name', type: 'string', group: 'Contact information', required: true, position: 1 },
      { name: 'last_name', label: 'Last name', type: 'string', group: 'Contact information', required: true, position: 2 },
      { name: 'full_name', label: 'Full name', type: 'computed', group: 'Contact information', calculated: 'trim(concat(first_name, " ", last_name))', read_only: true, position: 0, description: 'Kept in step with the first and last name on every save.' },
      { name: 'email', label: 'Email', type: 'email', group: 'Contact information', unique: true, position: 3 },
      { name: 'phone', label: 'Phone', type: 'phone', group: 'Contact information', position: 4 },
      { name: 'mobile_phone', label: 'Mobile', type: 'phone', group: 'Contact information', position: 5 },
      { name: 'job_title', label: 'Job title', type: 'string', group: 'Contact information', position: 6 },
      { name: 'seniority', label: 'Seniority', type: 'enum', group: 'Contact information', position: 7, options: opts(['c_level', 'C-level', 'violet'], ['vp', 'VP', 'indigo'], ['director', 'Director', 'blue'], ['manager', 'Manager', 'teal'], ['individual_contributor', 'Individual contributor', 'gray']) },
      { name: 'department', label: 'Department', type: 'enum', group: 'Contact information', position: 8, options: opts(['engineering', 'Engineering', 'blue'], ['operations', 'Operations', 'teal'], ['maintenance', 'Maintenance & reliability', 'amber'], ['it', 'IT / OT', 'violet'], ['quality', 'Quality', 'green'], ['procurement', 'Procurement', 'orange'], ['executive', 'Executive', 'indigo'], ['finance', 'Finance', 'gray'], ['safety', 'Health & safety', 'pink']) },
      { name: 'buying_role', label: 'Buying role', type: 'enum', group: 'Sales', position: 9, description: 'Where this person sits in the buying committee.', options: opts(['economic_buyer', 'Economic buyer', 'violet'], ['champion', 'Champion', 'green'], ['technical_evaluator', 'Technical evaluator', 'blue'], ['end_user', 'End user', 'teal'], ['influencer', 'Influencer', 'amber'], ['blocker', 'Blocker', 'red']) },
      { name: 'lifecycle_stage', label: 'Lifecycle stage', type: 'enum', group: 'Sales', position: 10, options: LIFECYCLE, default_value: 'lead' },
      { name: 'lead_status', label: 'Lead status', type: 'enum', group: 'Sales', position: 11, options: opts(['new', 'New', 'blue'], ['open', 'Open', 'indigo'], ['in_progress', 'In progress', 'violet'], ['connected', 'Connected', 'teal'], ['nurturing', 'Nurturing', 'amber'], ['unqualified', 'Unqualified', 'gray'], ['bad_timing', 'Bad timing', 'orange']) },
      { name: 'lead_source', label: 'Original source', type: 'enum', group: 'Sales', position: 13, options: LEAD_SOURCE },
      { name: 'lead_source_detail', label: 'Source detail', type: 'string', group: 'Sales', position: 13 },
      { name: 'city', label: 'City', type: 'string', group: 'Location', position: 20 },
      { name: 'state', label: 'State / region', type: 'string', group: 'Location', position: 21 },
      { name: 'country', label: 'Country', type: 'string', group: 'Location', position: 22 },
      { name: 'region', label: 'Sales region', type: 'enum', group: 'Location', position: 23, options: REGION },
      { name: 'timezone', label: 'Time zone', type: 'string', group: 'Location', position: 24 },
      { name: 'linkedin_url', label: 'LinkedIn', type: 'url', group: 'Contact information', position: 25 },
      { name: 'preferred_channel', label: 'Preferred channel', type: 'enum', group: 'Engagement', position: 30, options: opts(['email', 'Email', 'blue'], ['phone', 'Phone', 'teal'], ['linkedin', 'LinkedIn', 'indigo'], ['in_person', 'In person', 'amber']) },
      { name: 'email_opt_in', label: 'Marketing consent', type: 'bool', group: 'Engagement', position: 31, description: 'Explicit consent to receive marketing email. Sequences refuse to send without it.' },
      { name: 'last_activity_at', label: 'Last activity', type: 'datetime', group: 'Engagement', position: 32, read_only: true, description: 'Set automatically whenever an activity is logged against this contact.' },
      { name: 'last_contacted_at', label: 'Last contacted', type: 'datetime', group: 'Engagement', position: 33, read_only: true },
      { name: 'first_contacted_at', label: 'First contacted', type: 'datetime', group: 'Engagement', position: 34, read_only: true },
      { name: 'activity_count', label: 'Activities logged', type: 'number', group: 'Engagement', position: 35, read_only: true, default_value: 0 },
      { name: 'next_step', label: 'Next step', type: 'string', group: 'Sales', position: 36 },
    ],
  },
  {
    name: 'company',
    label: 'Company',
    plural_label: 'Companies',
    description: 'An account — the manufacturer, integrator or distributor Northwind sells telemetry to.',
    icon: 'building',
    color: 'violet',
    primary_property: 'name',
    secondary_property: 'domain',
    searchable: ['name', 'domain', 'city', 'country', 'description'],
    position: 20,
    properties: [
      { name: 'name', label: 'Company name', type: 'string', group: 'Company information', required: true, position: 1 },
      { name: 'domain', label: 'Company domain', type: 'string', group: 'Company information', unique: true, normalize: 'domain', position: 2, description: 'The primary web domain, stored canonically — no scheme, no “www.”, lowercased. This is the dedupe key and the match key for inbound email.' },
      { name: 'website', label: 'Website', type: 'url', group: 'Company information', position: 3 },
      { name: 'description', label: 'About', type: 'text', group: 'Company information', position: 4 },
      { name: 'industry', label: 'Industry', type: 'enum', group: 'Company information', position: 5, options: INDUSTRY },
      { name: 'type', label: 'Relationship', type: 'enum', group: 'Company information', position: 6, options: opts(['prospect', 'Prospect', 'blue'], ['customer', 'Customer', 'green'], ['partner', 'Partner', 'teal'], ['reseller', 'Reseller', 'indigo'], ['vendor', 'Vendor', 'gray'], ['former_customer', 'Former customer', 'orange']) },
      { name: 'lifecycle_stage', label: 'Lifecycle stage', type: 'enum', group: 'Company information', position: 7, options: LIFECYCLE, default_value: 'lead' },
      { name: 'employee_count', label: 'Employees', type: 'number', group: 'Firmographics', position: 10, validation: { min: 1, max: 5_000_000 } },
      { name: 'annual_revenue', label: 'Annual revenue', type: 'currency', group: 'Firmographics', position: 11, currency: 'usd', description: 'Stored in cents, like every money value in Ain.' },
      { name: 'size_tier', label: 'Size tier', type: 'computed', group: 'Firmographics', position: 12, read_only: true, calculated: 'if(employee_count >= 10000, "Global enterprise", if(employee_count >= 2000, "Enterprise", if(employee_count >= 400, "Mid-market", "SMB")))' },
      { name: 'founded_year', label: 'Founded', type: 'number', group: 'Firmographics', position: 13, validation: { min: 1600, max: 2100 } },
      { name: 'plant_count', label: 'Production sites', type: 'number', group: 'Operations', position: 14 },
      { name: 'connected_assets', label: 'Connected assets', type: 'number', group: 'Operations', position: 15, description: 'Robots, CNC cells and PLCs streaming telemetry to Northwind.' },
      { name: 'automation_maturity', label: 'Automation maturity', type: 'enum', group: 'Operations', position: 16, options: opts(['pilot', 'Pilot cell', 'gray'], ['single_line', 'Single line', 'blue'], ['multi_line', 'Multi-line', 'indigo'], ['plant_wide', 'Plant-wide', 'violet'], ['enterprise', 'Enterprise-wide', 'green']) },
      { name: 'controls_platform', label: 'Controls platform', type: 'multi_enum', group: 'Operations', position: 17, options: opts(['siemens', 'Siemens TIA', 'teal'], ['rockwell', 'Rockwell FactoryTalk', 'red'], ['beckhoff', 'Beckhoff TwinCAT', 'blue'], ['mitsubishi', 'Mitsubishi', 'gray'], ['omron', 'Omron', 'indigo'], ['fanuc', 'FANUC', 'amber'], ['abb', 'ABB', 'orange'], ['kuka', 'KUKA', 'orange'], ['universal_robots', 'Universal Robots', 'violet']) },
      { name: 'support_tier', label: 'Support tier', type: 'enum', group: 'Customer', position: 18, options: opts(['standard', 'Standard', 'gray'], ['premium', 'Premium', 'blue'], ['mission_critical', 'Mission critical', 'violet']) },
      { name: 'is_key_account', label: 'Key account', type: 'bool', group: 'Customer', position: 19 },
      { name: 'became_customer_at', label: 'Became a customer', type: 'date', group: 'Customer', position: 20 },
      { name: 'renewal_date', label: 'Renewal date', type: 'date', group: 'Customer', position: 21 },
      { name: 'lead_source', label: 'Original source', type: 'enum', group: 'Sales', position: 22, options: LEAD_SOURCE },
      { name: 'lead_source_detail', label: 'Source detail', type: 'string', group: 'Sales', position: 23 },
      { name: 'street', label: 'Street', type: 'string', group: 'Location', position: 30 },
      { name: 'city', label: 'City', type: 'string', group: 'Location', position: 31 },
      { name: 'state', label: 'State / region', type: 'string', group: 'Location', position: 32 },
      { name: 'postal_code', label: 'Postal code', type: 'string', group: 'Location', position: 33 },
      { name: 'country', label: 'Country', type: 'string', group: 'Location', position: 34 },
      { name: 'region', label: 'Sales region', type: 'enum', group: 'Location', position: 35, options: REGION },
      { name: 'phone', label: 'Phone', type: 'phone', group: 'Company information', position: 36 },
      { name: 'linkedin_url', label: 'LinkedIn', type: 'url', group: 'Company information', position: 37 },
      { name: 'last_activity_at', label: 'Last activity', type: 'datetime', group: 'Engagement', position: 40, read_only: true },
      { name: 'activity_count', label: 'Activities logged', type: 'number', group: 'Engagement', position: 41, read_only: true, default_value: 0 },
      {
        name: 'open_deal_count', label: 'Open deals', type: 'number', group: 'Pipeline', position: 50, read_only: true,
        description: 'How many deals on this account are still open. Maintained whenever a deal is saved, linked, unlinked or archived.',
        rollup: { association: 'deal', aggregate: 'count', filter: { property: 'deal_status', operator: 'eq', value: 'open' } },
      },
      {
        name: 'total_open_deal_value', label: 'Total open deal value', type: 'currency', currency: 'usd',
        group: 'Pipeline', position: 51, read_only: true,
        description: 'The sum of every open deal on this account, in cents. This is what an account list is ranked by — sort, filter, put it in a view column or read it from a formula.',
        rollup: { association: 'deal', aggregate: 'sum', property: 'amount', filter: { property: 'deal_status', operator: 'eq', value: 'open' } },
      },
      {
        name: 'associated_contact_count', label: 'Associated contacts', type: 'number', group: 'Pipeline', position: 52, read_only: true,
        description: 'People linked to this account. An account with pipeline and one contact is a single-threaded deal.',
        rollup: { association: 'contact', aggregate: 'count' },
      },
    ],
  },
  {
    name: 'deal',
    label: 'Deal',
    plural_label: 'Deals',
    description: 'A revenue opportunity moving through a pipeline.',
    icon: 'trending-up',
    color: 'green',
    primary_property: 'name',
    secondary_property: 'deal_stage',
    searchable: ['name', 'next_step', 'close_notes'],
    position: 30,
    properties: [
      { name: 'name', label: 'Deal name', type: 'string', group: 'Deal information', required: true, position: 1 },
      { name: 'pipeline', label: 'Pipeline', type: 'enum', group: 'Deal information', position: 2, validation: { allow_other: true }, default_value: 'new_business', description: 'Which sales motion this deal runs through. The pipeline decides which stages are legal.', options: [] },
      { name: 'deal_stage', label: 'Stage', type: 'enum', group: 'Deal information', position: 3, validation: { allow_other: true }, default_value: 'qualification', description: 'Validated against the stages of this deal’s own pipeline. Moving stage restamps the probability, forecast category and close date.', options: [] },
      { name: 'amount', label: 'Amount', type: 'currency', group: 'Deal information', position: 4, currency: 'usd', required: true },
      { name: 'probability', label: 'Probability', type: 'number', group: 'Forecast', position: 5, read_only: true, validation: { min: 0, max: 100 }, description: 'Owned by the stage. Edit the stage’s probability on the pipeline to change it for every deal sitting there.' },
      { name: 'weighted_amount', label: 'Weighted amount', type: 'currency', group: 'Forecast', position: 6, currency: 'usd', read_only: true, calculated: 'round(amount * probability / 100)' },
      { name: 'close_date', label: 'Close date', type: 'date', group: 'Deal information', position: 7 },
      { name: 'forecast_category', label: 'Forecast category', type: 'enum', group: 'Forecast', position: 8, read_only: true, description: 'Derived from the stage — pipeline, best case, commit or closed.', options: opts(['pipeline', 'Pipeline', 'gray'], ['best_case', 'Best case', 'blue'], ['commit', 'Commit', 'violet'], ['closed', 'Closed', 'green'], ['omitted', 'Omitted', 'orange']) },
      { name: 'deal_status', label: 'Status', type: 'enum', group: 'Forecast', position: 9, read_only: true, description: 'Open, won or lost — read from the stage, so “is this deal still live?” never depends on parsing a stage name.', options: opts(['open', 'Open', 'blue'], ['won', 'Won', 'green'], ['lost', 'Lost', 'red']) },
      { name: 'deal_type', label: 'Deal type', type: 'enum', group: 'Deal information', position: 10, options: opts(['new_business', 'New business', 'blue'], ['expansion', 'Expansion', 'violet'], ['renewal', 'Renewal', 'teal'], ['pilot_conversion', 'Pilot conversion', 'amber']) },
      { name: 'licensed_assets', label: 'Licensed assets', type: 'number', group: 'Deal information', position: 11, description: 'Number of machines the contract covers — the basis for usage pricing.' },
      { name: 'contract_term_months', label: 'Term (months)', type: 'number', group: 'Deal information', position: 12, validation: { min: 1, max: 120 } },
      { name: 'lead_source', label: 'Original source', type: 'enum', group: 'Sales', position: 12, options: LEAD_SOURCE },
      { name: 'competitor', label: 'Competitor', type: 'enum', group: 'Sales', position: 14, options: opts(['none', 'None identified', 'gray'], ['sight_machine', 'Sight Machine', 'blue'], ['tulip', 'Tulip', 'violet'], ['litmus', 'Litmus Edge', 'teal'], ['cognite', 'Cognite', 'indigo'], ['samsara', 'Samsara Industrial', 'amber'], ['in_house', 'In-house build', 'orange']) },
      { name: 'next_step', label: 'Next step', type: 'string', group: 'Sales', position: 15 },
      { name: 'close_reason', label: 'Close reason', type: 'enum', group: 'Outcome', position: 16, options: opts(['product_fit', 'Product fit', 'green'], ['time_to_value', 'Fast time to value', 'green'], ['exec_sponsor', 'Executive sponsor', 'green'], ['price', 'Price', 'red'], ['budget_cut', 'Budget cut', 'red'], ['no_decision', 'No decision', 'gray'], ['competitor', 'Lost to competitor', 'orange'], ['product_gap', 'Product gap', 'amber'], ['champion_left', 'Champion left', 'orange'], ['timing', 'Bad timing', 'gray']) },
      { name: 'close_notes', label: 'Close notes', type: 'text', group: 'Outcome', position: 17 },
      { name: 'closed_at', label: 'Closed on', type: 'datetime', group: 'Outcome', position: 18, read_only: true, description: 'Stamped the moment the deal reaches a closed stage, and cleared again if it reopens.' },
      { name: 'days_to_close', label: 'Days to close', type: 'number', group: 'Outcome', position: 19, read_only: true, description: 'Calendar days from creation to the close stamp.' },
      { name: 'stage_entered_at', label: 'Entered stage', type: 'datetime', group: 'Deal information', position: 20, read_only: true, description: 'When this deal arrived in the stage it is in now. Filter on it to find deals that have stopped moving; the stage-history and velocity reports read the rest from the audit trail.' },
    ],
  },
  {
    name: 'ticket',
    label: 'Ticket',
    plural_label: 'Tickets',
    description: 'A customer support request against the telemetry platform.',
    icon: 'life-buoy',
    color: 'amber',
    primary_property: 'subject',
    secondary_property: 'status',
    searchable: ['subject', 'content', 'affected_line'],
    position: 40,
    properties: [
      { name: 'subject', label: 'Subject', type: 'string', group: 'Ticket', required: true, position: 1 },
      { name: 'content', label: 'Description', type: 'text', group: 'Ticket', position: 2 },
      { name: 'pipeline', label: 'Pipeline', type: 'enum', group: 'Ticket', position: 3, validation: { allow_other: true }, default_value: 'support', description: 'Which service process this ticket runs through. The pipeline decides which statuses are legal.', options: [] },
      { name: 'status', label: 'Status', type: 'enum', group: 'Ticket', position: 4, validation: { allow_other: true }, default_value: 'new', description: 'Validated against the statuses of this ticket’s own pipeline. Reaching a closed status stamps the resolution time.', options: [] },
      { name: 'priority', label: 'Priority', type: 'enum', group: 'Ticket', position: 5, default_value: 'medium', options: opts(['low', 'Low', 'gray'], ['medium', 'Medium', 'blue'], ['high', 'High', 'amber'], ['urgent', 'Urgent', 'red']) },
      { name: 'category', label: 'Category', type: 'enum', group: 'Ticket', position: 6, options: opts(['connectivity', 'Edge connectivity', 'blue'], ['data_gap', 'Missing data', 'violet'], ['integration', 'Integration', 'indigo'], ['billing', 'Billing', 'green'], ['onboarding', 'Onboarding', 'teal'], ['hardware', 'Hardware', 'amber'], ['alerts', 'Alerting', 'orange'], ['feature_request', 'Feature request', 'pink'], ['security', 'Security & compliance', 'red']) },
      { name: 'product_area', label: 'Product area', type: 'enum', group: 'Ticket', position: 7, options: opts(['telemetry_agent', 'Telemetry agent', 'blue'], ['cloud_ingest', 'Cloud ingest', 'violet'], ['dashboards', 'Dashboards', 'teal'], ['alerts', 'Alerting', 'amber'], ['api', 'Public API', 'indigo'], ['mobile', 'Mobile app', 'pink']) },
      { name: 'source_channel', label: 'Channel', type: 'enum', group: 'Ticket', position: 8, options: opts(['email', 'Email', 'blue'], ['chat', 'Chat', 'teal'], ['phone', 'Phone', 'violet'], ['portal', 'Portal', 'indigo'], ['agent', 'AI agent', 'green']) },
      { name: 'affected_line', label: 'Affected line or cell', type: 'string', group: 'Ticket', position: 9 },
      { name: 'sla_due_at', label: 'SLA due', type: 'datetime', group: 'Service level', position: 10 },
      { name: 'first_response_at', label: 'First response', type: 'datetime', group: 'Service level', position: 11 },
      { name: 'resolved_at', label: 'Resolved', type: 'datetime', group: 'Service level', position: 12, read_only: true, description: 'Stamped when the ticket reaches a closed status, and cleared if it is reopened.' },
      { name: 'resolution_minutes', label: 'Time to resolution (min)', type: 'number', group: 'Service level', position: 13, read_only: true },
      { name: 'satisfaction_score', label: 'CSAT', type: 'number', group: 'Service level', position: 14, validation: { min: 1, max: 5 } },
      { name: 'stage_entered_at', label: 'Entered status', type: 'datetime', group: 'Service level', position: 15, read_only: true, description: 'When this ticket arrived at the status it is in now — what “waiting on us for three days” is measured from.' },
    ],
  },
];

const ACTIVITY_BASE: PropertySeed[] = [
  { name: 'subject', label: 'Subject', type: 'string', group: 'Activity', position: 1 },
  { name: 'body', label: 'Body', type: 'text', group: 'Activity', position: 2 },
  { name: 'occurred_at', label: 'Occurred at', type: 'datetime', group: 'Activity', position: 3, required: true },
];

const ACTIVITY_SEEDS: ObjectTypeSeed[] = [
  {
    name: 'note', label: 'Note', plural_label: 'Notes', icon: 'sticky-note', color: 'gray',
    description: 'A written note on the timeline of any record.',
    primary_property: 'subject', searchable: ['subject', 'body'], category: 'activity', position: 50,
    properties: [
      ...ACTIVITY_BASE,
      { name: 'pinned', label: 'Pinned', type: 'bool', group: 'Activity', position: 4 },
    ],
  },
  {
    name: 'call', label: 'Call', plural_label: 'Calls', icon: 'phone', color: 'teal',
    description: 'A logged phone call, with outcome and duration.',
    primary_property: 'subject', searchable: ['subject', 'body'], category: 'activity', position: 51,
    properties: [
      ...ACTIVITY_BASE,
      { name: 'direction', label: 'Direction', type: 'enum', group: 'Call', position: 4, options: opts(['outbound', 'Outbound', 'blue'], ['inbound', 'Inbound', 'teal']) },
      { name: 'duration_minutes', label: 'Duration (min)', type: 'number', group: 'Call', position: 5 },
      { name: 'outcome', label: 'Outcome', type: 'enum', group: 'Call', position: 6, options: opts(['connected', 'Connected', 'green'], ['left_voicemail', 'Left voicemail', 'amber'], ['no_answer', 'No answer', 'gray'], ['busy', 'Busy', 'gray'], ['wrong_number', 'Wrong number', 'red'], ['rescheduled', 'Rescheduled', 'blue']) },
    ],
  },
  {
    name: 'meeting', label: 'Meeting', plural_label: 'Meetings', icon: 'calendar', color: 'violet',
    description: 'A scheduled meeting, demo or on-site visit.',
    primary_property: 'subject', searchable: ['subject', 'body', 'location'], category: 'activity', position: 52,
    properties: [
      ...ACTIVITY_BASE,
      { name: 'start_at', label: 'Starts', type: 'datetime', group: 'Meeting', position: 4 },
      { name: 'end_at', label: 'Ends', type: 'datetime', group: 'Meeting', position: 5 },
      { name: 'location', label: 'Location', type: 'string', group: 'Meeting', position: 6 },
      { name: 'meeting_type', label: 'Meeting type', type: 'enum', group: 'Meeting', position: 7, options: opts(['discovery', 'Discovery', 'blue'], ['demo', 'Demo', 'violet'], ['technical_deep_dive', 'Technical deep dive', 'indigo'], ['pilot_review', 'Pilot review', 'teal'], ['qbr', 'Quarterly business review', 'green'], ['onsite', 'On-site visit', 'amber'], ['executive_briefing', 'Executive briefing', 'pink']) },
      { name: 'outcome', label: 'Outcome', type: 'enum', group: 'Meeting', position: 8, options: opts(['held', 'Held', 'green'], ['no_show', 'No show', 'red'], ['rescheduled', 'Rescheduled', 'amber'], ['cancelled', 'Cancelled', 'gray']) },
      { name: 'attendee_count', label: 'Attendees', type: 'number', group: 'Meeting', position: 9 },
    ],
  },
  {
    name: 'email', label: 'Email', plural_label: 'Emails', icon: 'mail', color: 'blue',
    description: 'An email sent to or received from a contact.',
    primary_property: 'subject', searchable: ['subject', 'body', 'to_email', 'from_email'], category: 'activity', position: 53,
    properties: [
      ...ACTIVITY_BASE,
      { name: 'direction', label: 'Direction', type: 'enum', group: 'Email', position: 4, options: opts(['outbound', 'Outbound', 'blue'], ['inbound', 'Inbound', 'teal']) },
      { name: 'from_email', label: 'From', type: 'email', group: 'Email', position: 5 },
      { name: 'to_email', label: 'To', type: 'email', group: 'Email', position: 6 },
      { name: 'status', label: 'Status', type: 'enum', group: 'Email', position: 7, options: opts(['sent', 'Sent', 'gray'], ['delivered', 'Delivered', 'blue'], ['opened', 'Opened', 'indigo'], ['clicked', 'Clicked', 'violet'], ['replied', 'Replied', 'green'], ['bounced', 'Bounced', 'red']) },
      { name: 'thread_id', label: 'Thread', type: 'string', group: 'Email', position: 8, hidden: true },
    ],
  },
  {
    name: 'task', label: 'Task', plural_label: 'Tasks', icon: 'check-square', color: 'orange',
    description: 'Something a teammate has to do, with a due date.',
    primary_property: 'subject', searchable: ['subject', 'body'], category: 'activity', position: 54,
    properties: [
      ...ACTIVITY_BASE,
      { name: 'status', label: 'Status', type: 'enum', group: 'Task', position: 4, default_value: 'not_started', options: opts(['not_started', 'Not started', 'gray'], ['in_progress', 'In progress', 'blue'], ['waiting', 'Waiting', 'amber'], ['completed', 'Completed', 'green'], ['deferred', 'Deferred', 'gray']) },
      { name: 'due_at', label: 'Due', type: 'datetime', group: 'Task', position: 5 },
      { name: 'completed_at', label: 'Completed', type: 'datetime', group: 'Task', position: 6 },
      { name: 'priority', label: 'Priority', type: 'enum', group: 'Task', position: 7, default_value: 'medium', options: opts(['low', 'Low', 'gray'], ['medium', 'Medium', 'blue'], ['high', 'High', 'amber'], ['urgent', 'Urgent', 'red']) },
      { name: 'task_type', label: 'Type', type: 'enum', group: 'Task', position: 8, options: opts(['todo', 'To-do', 'gray'], ['call', 'Call', 'teal'], ['email', 'Email', 'blue'], ['follow_up', 'Follow-up', 'violet']) },
    ],
  },
];

export const BUILTIN_OBJECT_TYPES: ObjectTypeSeed[] = [...OBJECT_SEEDS, ...ACTIVITY_SEEDS];

export const ACTIVITY_TYPES = ACTIVITY_SEEDS.map((s) => s.name);

export interface AssociationSeed extends Omit<AssociationTypeDef, 'org_id' | 'id' | 'created' | 'system'> {}

export const BUILTIN_ASSOCIATIONS: AssociationSeed[] = [
  { name: 'contact_to_company', from_object: 'contact', to_object: 'company', label: 'Works at', inverse_label: 'Employs', cardinality: 'many_to_many' },
  { name: 'contact_to_contact', from_object: 'contact', to_object: 'contact', label: 'Reports to', inverse_label: 'Direct report', cardinality: 'many_to_one' },
  { name: 'deal_to_company', from_object: 'deal', to_object: 'company', label: 'Account', inverse_label: 'Deals', cardinality: 'many_to_one' },
  { name: 'deal_to_contact', from_object: 'deal', to_object: 'contact', label: 'Buying committee', inverse_label: 'Deals', cardinality: 'many_to_many' },
  { name: 'ticket_to_company', from_object: 'ticket', to_object: 'company', label: 'Account', inverse_label: 'Tickets', cardinality: 'many_to_one' },
  { name: 'ticket_to_contact', from_object: 'ticket', to_object: 'contact', label: 'Requested by', inverse_label: 'Tickets', cardinality: 'many_to_many' },
  { name: 'ticket_to_deal', from_object: 'ticket', to_object: 'deal', label: 'Blocks deal', inverse_label: 'Blocking tickets', cardinality: 'many_to_many' },
  { name: 'company_to_company', from_object: 'company', to_object: 'company', label: 'Parent company', inverse_label: 'Subsidiary', cardinality: 'many_to_one' },
  { name: 'activity_to_record', from_object: '*', to_object: '*', label: 'Logged on', inverse_label: 'Activity', cardinality: 'many_to_many' },
];

/* -------------------------------- pipelines ------------------------------- */

/**
 * How each pipelined object type is wired up. Everything a stage owns is listed
 * here, which is what lets the write path refuse a hand-typed probability with
 * a message that points at the stage instead of silently disagreeing with it.
 */
export const PIPELINE_BINDINGS: PipelineBinding[] = [
  {
    object_type: 'deal',
    noun: 'sales pipeline',
    pipeline_property: 'pipeline',
    stage_property: 'deal_stage',
    amount_property: 'amount',
    derived: {
      probability: 'probability',
      forecast_category: 'forecast_category',
      status: 'deal_status',
      closed_at: 'closed_at',
      days_to_close: 'days_to_close',
      expected_close_date: 'close_date',
      stage_entered_at: 'stage_entered_at',
    },
  },
  {
    object_type: 'ticket',
    noun: 'support pipeline',
    pipeline_property: 'pipeline',
    stage_property: 'status',
    derived: {
      closed_at: 'resolved_at',
      minutes_to_close: 'resolution_minutes',
      stage_entered_at: 'stage_entered_at',
    },
  },
];

export interface StageSeed {
  name: string;
  label: string;
  description?: string;
  probability?: number;
  is_closed?: boolean;
  is_won?: boolean;
  forecast_category?: string;
  color?: string;
}

export interface PipelineSeed {
  object_type: string;
  name: string;
  label: string;
  description: string;
  is_default?: boolean;
  position: number;
  stages: StageSeed[];
}

const WON = (label: string, description: string): StageSeed =>
  ({ name: 'closed_won', label, description, is_closed: true, is_won: true, forecast_category: 'closed', color: 'green' });
const LOST = (label: string, description: string): StageSeed =>
  ({ name: 'closed_lost', label, description, is_closed: true, forecast_category: 'closed', color: 'red' });

/**
 * Three motions, three genuinely different processes. New business qualifies a
 * plant it has never sold into; expansion starts from a customer already
 * streaming telemetry, so it skips technical validation and converts far more
 * often; a renewal is a value conversation on a contract that already exists.
 * Same stage name in two pipelines is fine — the probability is the stage's,
 * not the name's.
 */
export const BUILTIN_PIPELINES: PipelineSeed[] = [
  {
    object_type: 'deal', name: 'new_business', label: 'New business', is_default: true, position: 10,
    description: 'A plant Northwind has never instrumented: qualify the line, prove the telemetry, then commercials.',
    stages: [
      { name: 'qualification', label: 'Qualification', probability: 10, color: 'gray', forecast_category: 'pipeline', description: 'A named line, a budget owner and a reason to change this year.' },
      { name: 'discovery', label: 'Discovery', probability: 25, color: 'blue', forecast_category: 'pipeline', description: 'Controls stack, asset count and the metric the plant is judged on.' },
      { name: 'technical_validation', label: 'Technical validation', probability: 45, color: 'indigo', forecast_category: 'pipeline', description: 'Agent installed on a live cell, data flowing, IT and OT both satisfied.' },
      { name: 'proposal', label: 'Proposal sent', probability: 60, color: 'violet', forecast_category: 'best_case', description: 'Priced per connected asset, with the pilot results attached.' },
      { name: 'negotiation', label: 'Negotiation', probability: 80, color: 'amber', forecast_category: 'commit', description: 'Redlines, security review and procurement.' },
      WON('Closed won', 'Signed. Bookings and the onboarding handover start here.'),
      LOST('Closed lost', 'No decision, lost to a competitor, or the budget went elsewhere.'),
    ],
  },
  {
    object_type: 'deal', name: 'expansion', label: 'Expansion', position: 20,
    description: 'More lines, more sites, more assets inside an account already live on the platform.',
    stages: [
      { name: 'qualification', label: 'Expansion identified', probability: 20, color: 'gray', forecast_category: 'pipeline', description: 'Usage or a QBR surfaced a second line worth instrumenting.' },
      { name: 'discovery', label: 'Scoping', probability: 45, color: 'blue', forecast_category: 'best_case', description: 'Which assets, which plant, which budget holder.' },
      { name: 'proposal', label: 'Proposal sent', probability: 70, color: 'violet', forecast_category: 'commit', description: 'An uplift on the existing agreement rather than a new contract.' },
      { name: 'negotiation', label: 'Negotiation', probability: 88, color: 'amber', forecast_category: 'commit', description: 'Co-terming and the revised asset commitment.' },
      WON('Closed won', 'Assets added to the existing subscription.'),
      LOST('Closed lost', 'The expansion was deferred or the budget was cut.'),
    ],
  },
  {
    object_type: 'deal', name: 'renewal', label: 'Renewal', position: 30,
    description: 'An existing contract coming up for renewal: value review first, commercials second.',
    stages: [
      { name: 'renewal_outreach', label: 'Renewal outreach', probability: 40, color: 'blue', forecast_category: 'pipeline', description: 'Ninety days out: confirm the sponsor and open the conversation.' },
      { name: 'usage_review', label: 'Usage & value review', probability: 60, color: 'indigo', forecast_category: 'best_case', description: 'What the platform actually delivered against the assets they pay for.' },
      { name: 'commercial_terms', label: 'Commercial terms', probability: 75, color: 'violet', forecast_category: 'commit', description: 'Uplift, term and the asset count for the next period.' },
      { name: 'negotiation', label: 'Negotiation', probability: 90, color: 'amber', forecast_category: 'commit', description: 'Legal and procurement on a contract that already exists.' },
      WON('Renewed', 'Contract extended. Renewal date rolls forward.'),
      LOST('Churned', 'The customer did not renew.'),
    ],
  },
  {
    object_type: 'ticket', name: 'support', label: 'Support', is_default: true, position: 10,
    description: 'The standard service process for a platform issue, from triage to resolution.',
    stages: [
      { name: 'new', label: 'New', color: 'blue', description: 'Raised and not yet triaged.' },
      { name: 'waiting_on_us', label: 'Waiting on us', color: 'violet', description: 'The SLA clock is running against Northwind.' },
      { name: 'waiting_on_customer', label: 'Waiting on customer', color: 'amber', description: 'Paused pending logs, access or a maintenance window.' },
      { name: 'escalated', label: 'Escalated', color: 'red', description: 'With engineering, or with a named account manager.' },
      { name: 'closed', label: 'Closed', is_closed: true, is_won: true, color: 'gray', description: 'Resolved. Stamps the resolution time.' },
    ],
  },
];

export interface ViewSeed {
  object_type: string;
  name: string;
  description: string;
  columns: string[];
  filter: FilterNode | null;
  sort: SortSpec[];
  is_default?: boolean;
  position: number;
}

export const BUILTIN_VIEWS: ViewSeed[] = [
  {
    object_type: 'company', name: 'All companies', description: 'Every account in the book of business.',
    columns: ['name', 'industry', 'lifecycle_stage', 'region', 'employee_count', 'connected_assets', 'owner_id', 'last_activity_at'],
    filter: null, sort: [{ property: 'last_activity_at', direction: 'desc' }], is_default: true, position: 10,
  },
  {
    object_type: 'company', name: 'Key accounts', description: 'Named accounts with an executive sponsor and a mission-critical support tier.',
    columns: ['name', 'industry', 'connected_assets', 'support_tier', 'renewal_date', 'owner_id'],
    filter: { op: 'and', filters: [{ property: 'is_key_account', operator: 'eq', value: true }] },
    sort: [{ property: 'connected_assets', direction: 'desc' }], position: 20,
  },
  {
    object_type: 'company', name: 'Open pipeline over $75k', description: 'Accounts whose open deals add up to more than $75,000 — the accounts worth a forecast conversation, biggest pipeline first.',
    columns: ['name', 'industry', 'open_deal_count', 'total_open_deal_value', 'associated_contact_count', 'owner_id'],
    filter: {
      op: 'and',
      filters: [{ property: 'total_open_deal_value', operator: 'gt', value: 7_500_000 }],
    },
    sort: [{ property: 'total_open_deal_value', direction: 'desc' }], position: 30,
  },
  {
    object_type: 'company', name: 'Gone quiet', description: 'Customers and opportunities with no logged activity in the last 30 days.',
    columns: ['name', 'lifecycle_stage', 'owner_id', 'last_activity_at', 'support_tier'],
    filter: {
      op: 'and',
      filters: [
        { property: 'lifecycle_stage', operator: 'in', values: ['customer', 'opportunity', 'sales_qualified_lead'] },
        { association: 'activity', operator: 'eq', value: 0, where: { op: 'and', filters: [{ property: 'occurred_at', operator: 'within_last', value: 30, unit: 'day' }] } },
      ],
    },
    sort: [{ property: 'last_activity_at', direction: 'asc' }], position: 40,
  },
  {
    object_type: 'contact', name: 'All contacts', description: 'Everyone Northwind knows.',
    columns: ['full_name', 'job_title', 'email', 'lifecycle_stage', 'buying_role', 'owner_id', 'last_activity_at'],
    filter: null, sort: [{ property: 'last_activity_at', direction: 'desc' }], is_default: true, position: 10,
  },
  {
    object_type: 'contact', name: 'Sales qualified leads', description: 'Qualified people who have not yet become customers.',
    columns: ['full_name', 'job_title', 'lead_status', 'lead_source', 'owner_id', 'last_activity_at'],
    filter: { op: 'and', filters: [{ property: 'lifecycle_stage', operator: 'in', values: ['sales_qualified_lead', 'opportunity'] }] },
    sort: [{ property: 'last_activity_at', direction: 'desc' }], position: 20,
  },
  {
    object_type: 'contact', name: 'Champions and economic buyers', description: 'The people who actually sign — filtered to decision-making roles.',
    columns: ['full_name', 'job_title', 'buying_role', 'seniority', 'email', 'owner_id'],
    filter: { op: 'and', filters: [{ property: 'buying_role', operator: 'in', values: ['champion', 'economic_buyer'] }] },
    sort: [{ property: 'full_name', direction: 'asc' }], position: 30,
  },
  {
    object_type: 'contact', name: 'No contact in 45 days', description: 'Open leads that have gone cold and need a touch.',
    columns: ['full_name', 'job_title', 'lead_status', 'last_contacted_at', 'owner_id'],
    filter: {
      op: 'and',
      filters: [
        { property: 'lead_status', operator: 'not_in', values: ['unqualified'] },
        { op: 'or', filters: [
          { property: 'last_contacted_at', operator: 'is_not_set' },
          { property: 'last_contacted_at', operator: 'before', value: '-45d' },
        ] },
      ],
    },
    sort: [{ property: 'last_contacted_at', direction: 'asc' }], position: 40,
  },
  {
    object_type: 'deal', name: 'All deals', description: 'Every opportunity, open or closed, across all three motions.',
    columns: ['name', 'pipeline', 'deal_stage', 'amount', 'close_date', 'owner_id', 'forecast_category'],
    filter: null, sort: [{ property: 'close_date', direction: 'asc' }], is_default: true, position: 10,
  },
  {
    object_type: 'deal', name: 'Open pipeline', description: 'Deals still in play, biggest first. “Open” is read from the stage, not from its name.',
    columns: ['name', 'pipeline', 'deal_stage', 'amount', 'weighted_amount', 'close_date', 'owner_id'],
    filter: { op: 'and', filters: [{ property: 'deal_status', operator: 'eq', value: 'open' }] },
    sort: [{ property: 'amount', direction: 'desc' }], position: 20,
  },
  {
    object_type: 'deal', name: 'Closing this quarter', description: 'Open deals with a close date inside the current quarter.',
    columns: ['name', 'deal_stage', 'amount', 'probability', 'weighted_amount', 'close_date', 'owner_id'],
    filter: {
      op: 'and',
      filters: [
        { property: 'deal_status', operator: 'eq', value: 'open' },
        { property: 'close_date', operator: 'between', values: ['start_of_quarter', 'end_of_quarter'] },
      ],
    },
    sort: [{ property: 'close_date', direction: 'asc' }], position: 30,
  },
  {
    object_type: 'deal', name: 'Renewals in flight', description: 'Everything running through the renewal motion, soonest close first.',
    columns: ['name', 'deal_stage', 'amount', 'probability', 'close_date', 'owner_id'],
    filter: {
      op: 'and',
      filters: [
        { property: 'pipeline', operator: 'eq', value: 'renewal' },
        { property: 'deal_status', operator: 'eq', value: 'open' },
      ],
    },
    sort: [{ property: 'close_date', direction: 'asc' }], position: 40,
  },
  {
    object_type: 'deal', name: 'Won this year', description: 'Closed-won business booked since 1 January.',
    columns: ['name', 'pipeline', 'amount', 'close_date', 'deal_type', 'owner_id', 'close_reason'],
    filter: {
      op: 'and',
      filters: [
        { property: 'deal_status', operator: 'eq', value: 'won' },
        { property: 'close_date', operator: 'after', value: 'start_of_year' },
      ],
    },
    sort: [{ property: 'close_date', direction: 'desc' }], position: 50,
  },
  {
    object_type: 'ticket', name: 'All tickets', description: 'Every support request.',
    columns: ['subject', 'status', 'priority', 'category', 'owner_id', 'created'],
    filter: null, sort: [{ property: 'created', direction: 'desc' }], is_default: true, position: 10,
  },
  {
    object_type: 'ticket', name: 'Open queue', description: 'Anything not yet closed, urgent first.',
    columns: ['subject', 'status', 'priority', 'category', 'sla_due_at', 'owner_id'],
    filter: { op: 'and', filters: [{ property: 'status', operator: 'neq', value: 'closed' }] },
    sort: [{ property: 'priority', direction: 'desc' }, { property: 'sla_due_at', direction: 'asc' }], position: 20,
  },
  {
    object_type: 'ticket', name: 'SLA at risk', description: 'Open tickets already past their SLA target or due inside the next 24 hours.',
    columns: ['subject', 'status', 'priority', 'sla_due_at', 'category', 'owner_id'],
    filter: {
      op: 'and',
      filters: [
        { property: 'status', operator: 'neq', value: 'closed' },
        { property: 'sla_due_at', operator: 'before', value: '+1d' },
      ],
    },
    sort: [{ property: 'sla_due_at', direction: 'asc' }], position: 30,
  },
];

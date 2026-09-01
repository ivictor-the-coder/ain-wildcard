/**
 * The CRM surface: object lists, record pages and the data model.
 *
 * `/contacts` and `/companies` are the two an operator lives in; `/records/:type`
 * is the same screen for everything else, so an object type invented this
 * afternoon has a list, a record page, filters, views and bulk actions without
 * a line of code being written for it.
 */
import { useEffect } from 'react';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, SkeletonText, humanize, pluralize, useFormat } from '@/client/design';
import type { CommandDef, NavItem, RouteDef, WidgetDef } from '@/client/kernel/registry-types';
import { useRouter } from '@/client/kernel/router';
import { useQuery, type ListEnvelope } from '@/client/kernel/api';
import { ObjectListPage, listHref, recordHref } from './list';
import { RecordPage } from './record';
import { DataModelPage } from './admin';
import { useUserIndex, useUsers, type CrmRecord } from './api';
import './crm.css';

/* --------------------------------- screens -------------------------------- */

const ContactsPage = () => <ObjectListPage objectType="contact" />;
const CompaniesPage = () => <ObjectListPage objectType="company" />;
const DealsPage = () => <ObjectListPage objectType="deal" />;
const TicketsPage = () => <ObjectListPage objectType="ticket" />;

const ContactRecord = () => { const { params } = useRouter(); return <RecordPage objectType="contact" id={params.id} />; };
const CompanyRecord = () => { const { params } = useRouter(); return <RecordPage objectType="company" id={params.id} />; };
const DealRecord = () => { const { params } = useRouter(); return <RecordPage objectType="deal" id={params.id} />; };
const TicketRecord = () => { const { params } = useRouter(); return <RecordPage objectType="ticket" id={params.id} />; };

/**
 * `/records/company` used to render the Companies screen under a breadcrumb
 * reading "Data model › company", with the nav highlighting the wrong entry
 * and the tab titled with the raw slug. An object type that has a screen of
 * its own has one address; everything else keeps the generic one.
 */
const DEDICATED = new Set(['contact', 'company', 'deal', 'ticket']);

function useCanonicalRedirect(canonical: string | null): boolean {
  const { location, navigate } = useRouter();
  const away = !!canonical && canonical !== location.path;
  useEffect(() => {
    if (away && canonical) navigate(`${canonical}${location.search}`, { replace: true });
  }, [away, canonical, location.search, navigate]);
  return away;
}

const GenericList = () => {
  const { params } = useRouter();
  const away = useCanonicalRedirect(DEDICATED.has(params.type) ? listHref(params.type) : null);
  if (away) return null;
  return <ObjectListPage key={params.type} objectType={params.type} />;
};

const GenericRecord = () => {
  const { params } = useRouter();
  const away = useCanonicalRedirect(DEDICATED.has(params.type) ? recordHref(params.type, params.id) : null);
  if (away) return null;
  return <RecordPage key={`${params.type}/${params.id}`} objectType={params.type} id={params.id} />;
};

/* --------------------------------- widgets -------------------------------- */

interface RecordListEnvelope extends ListEnvelope<CrmRecord> { total_count: number }

function QuietAccounts() {
  const f = useFormat();
  const { navigate } = useRouter();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);
  const { data, error, loading, refetch } = useQuery<RecordListEnvelope>('/v1/records/company', {
    sort: 'last_activity_at', order: 'asc', limit: 6,
  });

  return (
    <Card
      title="Accounts gone quiet"
      description="Longest since anyone logged anything"
      actions={<Button size="sm" variant="ghost" onClick={() => navigate('/companies')}>All companies</Button>}
    >
      {error && (
        <ErrorState
          title="The account list did not answer"
          message={error.body.message}
          code={`${error.status} /v1/records/company`}
          requestId={error.body.request_id ?? null}
          action={<Button size="sm" variant="primary" onClick={refetch}>Try again</Button>}
        />
      )}
      {!error && loading && <SkeletonText lines={5} />}
      {!error && !loading && !data?.data.length && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No accounts yet"
          body="The first company you create shows up here."
          action={<Button size="sm" variant="primary" onClick={() => navigate('/companies?new=1')}>New company</Button>}
        />
      )}
      {!error && data?.data.map((row) => (
        <button
          key={row.id}
          type="button"
          className="crm-widgetrow"
          onClick={() => navigate(recordHref('company', row.id))}
        >
          <Avatar name={row.display_name} seed={row.id} size={24} square />
          <span className="crm-widgetrow__text">
            <span className="crm-widgetrow__title u-truncate">{row.display_name}</span>
            <span className="crm-widgetrow__sub u-truncate">
              {row.owner_id ? userIndex.get(row.owner_id)?.name ?? 'Unassigned' : 'Unassigned'}
              {Number(row.properties.total_open_deal_value ?? 0) > 0
                ? ` · ${f.money(Number(row.properties.total_open_deal_value))} open`
                : ''}
            </span>
          </span>
          <span className="crm-widgetrow__when">
            {row.properties.last_activity_at ? f.relative(Number(row.properties.last_activity_at)) : 'never'}
          </span>
        </button>
      ))}
    </Card>
  );
}

function NewestContacts() {
  const f = useFormat();
  const { navigate } = useRouter();
  const { data, error, loading, refetch } = useQuery<RecordListEnvelope>('/v1/records/contact', {
    sort: 'created', order: 'desc', limit: 6,
  });

  return (
    <Card
      title="Newest contacts"
      description="The people who arrived most recently"
      actions={<Button size="sm" variant="ghost" onClick={() => navigate('/contacts')}>All contacts</Button>}
    >
      {error && (
        <ErrorState
          title="The contact list did not answer"
          message={error.body.message}
          code={`${error.status} /v1/records/contact`}
          requestId={error.body.request_id ?? null}
          action={<Button size="sm" variant="primary" onClick={refetch}>Try again</Button>}
        />
      )}
      {!error && loading && <SkeletonText lines={5} />}
      {!error && !loading && !data?.data.length && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No contacts yet"
          body="Add the first person and they appear here."
          action={<Button size="sm" variant="primary" onClick={() => navigate('/contacts?new=1')}>New contact</Button>}
        />
      )}
      {!error && data?.data.map((row) => (
        <button
          key={row.id}
          type="button"
          className="crm-widgetrow"
          onClick={() => navigate(recordHref('contact', row.id))}
        >
          <Avatar name={row.display_name} seed={row.id} size={24} />
          <span className="crm-widgetrow__text">
            <span className="crm-widgetrow__title u-truncate">{row.display_name}</span>
            <span className="crm-widgetrow__sub u-truncate">{String(row.properties.job_title ?? '—')}</span>
          </span>
          {row.properties.lifecycle_stage
            ? <Badge tone="info" size="sm">{String(row.properties.lifecycle_stage).replace(/_/g, ' ')}</Badge>
            : null}
          <span className="crm-widgetrow__when">{f.relative(row.created)}</span>
        </button>
      ))}
    </Card>
  );
}

/* ------------------------------- registration ----------------------------- */

export const routes: RouteDef[] = [
  { path: '/contacts', element: ContactsPage, title: 'Contacts' },
  { path: '/contacts/:id', element: ContactRecord, title: 'Contact' },
  { path: '/companies', element: CompaniesPage, title: 'Companies' },
  { path: '/companies/:id', element: CompanyRecord, title: 'Company' },
  { path: '/records', element: DataModelPage, title: 'Data model' },
  { path: '/records/deal', element: DealsPage, title: 'Deals' },
  { path: '/records/deal/:id', element: DealRecord, title: 'Deal' },
  { path: '/records/ticket', element: TicketsPage, title: 'Tickets' },
  { path: '/records/ticket/:id', element: TicketRecord, title: 'Ticket' },
  // A custom object's slug is the only name the route knows before the schema
  // answers; the page replaces it with the workspace's own label on arrival.
  { path: '/records/:type', element: GenericList, title: (params) => pluralize(humanize(params.type), 2) },
  { path: '/records/:type/:id', element: GenericRecord, title: (params) => humanize(params.type) },
];

export const nav: NavItem[] = [
  { id: 'crm.contacts', label: 'Contacts', to: '/contacts', group: 'crm', order: 10, icon: 'contacts' },
  { id: 'crm.companies', label: 'Companies', to: '/companies', group: 'crm', order: 20, icon: 'building' },
  { id: 'crm.model', label: 'Data model', to: '/records', group: 'crm', order: 90, icon: 'layers', minRole: 'admin' },
];

export const commands: CommandDef[] = [
  { id: 'crm.contacts', title: 'Contacts', subtitle: 'Every person in the book', group: 'Go to', keywords: ['people', 'crm', 'leads'], icon: 'contacts', run: (go) => go('/contacts') },
  { id: 'crm.companies', title: 'Companies', subtitle: 'Accounts, with their pipeline', group: 'Go to', keywords: ['accounts', 'crm'], icon: 'building', run: (go) => go('/companies') },
  { id: 'crm.deals', title: 'Deals', subtitle: 'Every opportunity, filterable', group: 'Go to', keywords: ['pipeline', 'opportunities'], icon: 'deals', run: (go) => go('/records/deal') },
  { id: 'crm.tickets', title: 'Tickets', subtitle: 'The support queue', group: 'Go to', keywords: ['support', 'queue'], icon: 'tickets', run: (go) => go('/records/ticket') },
  { id: 'crm.tasks', title: 'Tasks', subtitle: 'Everything anyone still owes a customer', group: 'Go to', keywords: ['todo', 'follow up', 'queue'], icon: 'check-circle', run: (go) => go('/records/task') },
  { id: 'crm.calls', title: 'Calls', subtitle: 'Every call logged, newest first', group: 'Go to', keywords: ['phone', 'dials', 'activity'], icon: 'phone', run: (go) => go('/records/call') },
  { id: 'crm.model', title: 'Data model', subtitle: 'Objects, properties and associations', group: 'Go to', keywords: ['schema', 'properties', 'custom object'], icon: 'layers', run: (go) => go('/records') },
  { id: 'crm.new-contact', title: 'New contact', subtitle: 'Add a person', group: 'Create', keywords: ['add', 'person', 'lead'], icon: 'plus', run: (go) => go('/contacts?new=1') },
  { id: 'crm.new-company', title: 'New company', subtitle: 'Add an account', group: 'Create', keywords: ['add', 'account'], icon: 'plus', run: (go) => go('/companies?new=1') },
  { id: 'crm.new-deal', title: 'New deal', subtitle: 'Open an opportunity', group: 'Create', keywords: ['add', 'opportunity'], icon: 'plus', run: (go) => go('/records/deal?new=1') },
  { id: 'crm.new-object', title: 'New custom object', subtitle: 'Extend the object model', group: 'Create', keywords: ['schema', 'custom', 'object'], icon: 'layers', run: (go) => go('/records') },
];

export const widgets: WidgetDef[] = [
  { id: 'crm.quiet-accounts', title: 'Accounts gone quiet', description: 'Longest since anyone logged anything', span: 4, component: QuietAccounts, group: 'crm' },
  { id: 'crm.newest-contacts', title: 'Newest contacts', description: 'The people who arrived most recently', span: 4, component: NewestContacts, group: 'crm' },
];

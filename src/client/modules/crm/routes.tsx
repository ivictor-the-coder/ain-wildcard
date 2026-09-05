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
import type { CommandDef, NavItem, RouteDef, SettingsPage, WidgetDef } from '@/client/kernel/registry-types';
import { useRouter } from '@/client/kernel/router';
import { useQuery, type ListEnvelope } from '@/client/kernel/api';
import { ObjectListPage, listHref, recordHref } from './list';
import { RecordPage } from './record';
import { DataModelPage } from './admin';
import { useUserIndex, useUsers, type CrmRecord } from './api';
import { ACTIVITY_PATHS, hasDedicatedAddress } from './links';
import './crm.css';

/* --------------------------------- screens -------------------------------- */

const ContactsPage = () => <ObjectListPage objectType="contact" />;
const CompaniesPage = () => <ObjectListPage objectType="company" />;
const TicketsPage = () => <ObjectListPage objectType="ticket" />;

const ContactRecord = () => { const { params } = useRouter(); return <RecordPage objectType="contact" id={params.id} />; };
const CompanyRecord = () => { const { params } = useRouter(); return <RecordPage objectType="company" id={params.id} />; };
const TicketRecord = () => { const { params } = useRouter(); return <RecordPage objectType="ticket" id={params.id} />; };

/**
 * The activity queues — notes, calls, meetings, emails, tasks — each get a
 * list and a record page at their own address. A route with a fixed title is
 * what lets the shell label the list crumb "Tasks" on the record page beneath
 * it; the generic `/records/:type` route can only name itself once the schema
 * has answered, which is too late for a parent crumb.
 */
const ACTIVITY_TITLES: Record<string, [singular: string, plural: string]> = {
  note: ['Note', 'Notes'], call: ['Call', 'Calls'], meeting: ['Meeting', 'Meetings'], email: ['Email', 'Emails'], task: ['Task', 'Tasks'],
};

const activityRoutes: RouteDef[] = Object.entries(ACTIVITY_PATHS).flatMap(([type, path]) => {
  const List = () => <ObjectListPage objectType={type} />;
  const Record = () => { const { params } = useRouter(); return <RecordPage key={params.id} objectType={type} id={params.id} />; };
  const [singular, plural] = ACTIVITY_TITLES[type];
  return [
    { path, element: List, title: plural },
    { path: `${path}/:id`, element: Record, title: singular },
  ];
});

/**
 * `/records/company` used to render the Companies screen under a breadcrumb
 * reading "Data model › company", with the nav highlighting the wrong entry
 * and the tab titled with the raw slug. An object type that has a screen of
 * its own has one address; everything else keeps the generic one.
 *
 * Deals are the same story one module over: the pipeline owns the board, the
 * table and the deal record, so `/records/deal` no longer draws a second deal
 * list with its own columns and its own money format — it hands over.
 */
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
  const away = useCanonicalRedirect(hasDedicatedAddress(params.type) ? listHref(params.type) : null);
  if (away) return null;
  return <ObjectListPage key={params.type} objectType={params.type} />;
};

const GenericRecord = () => {
  const { params } = useRouter();
  const away = useCanonicalRedirect(hasDedicatedAddress(params.type) ? recordHref(params.type, params.id) : null);
  if (away) return null;
  return <RecordPage key={`${params.type}/${params.id}`} objectType={params.type} id={params.id} />;
};

/**
 * The data model is a settings concern as much as a CRM one, and the brief
 * lists it at `/settings/data-model`. One screen, two doors: this address hands
 * over to `/records`, which is where the nav, the lists' "Properties" button
 * and every `?type=` deep link already point.
 */
const DataModelSettings = () => {
  const away = useCanonicalRedirect('/records');
  return away ? null : <DataModelPage />;
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
            ? <Badge tone="info" size="sm">{humanize(String(row.properties.lifecycle_stage))}</Badge>
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
  { path: '/tickets', element: TicketsPage, title: 'Tickets' },
  { path: '/tickets/:id', element: TicketRecord, title: 'Ticket' },
  ...activityRoutes,
  { path: '/records', element: DataModelPage, title: 'Data model' },
  { path: '/settings/data-model', element: DataModelSettings, title: 'Data model' },
  // A custom object's slug is the only name the route knows before the schema
  // answers; the page replaces it with the workspace's own label on arrival.
  { path: '/records/:type', element: GenericList, title: (params) => pluralize(humanize(params.type), 2) },
  { path: '/records/:type/:id', element: GenericRecord, title: (params) => humanize(params.type) },
];

export const nav: NavItem[] = [
  { id: 'crm.contacts', label: 'Contacts', to: '/contacts', group: 'crm', order: 10, icon: 'contacts' },
  { id: 'crm.companies', label: 'Companies', to: '/companies', group: 'crm', order: 20, icon: 'building' },
  // Tickets are a queue somebody works all day, not a sub-list of the data
  // model: with no entry of their own every ticket screen highlighted "Data
  // model" and crumbed under it.
  { id: 'crm.tickets', label: 'Tickets', to: '/tickets', group: 'crm', order: 40, icon: 'tickets' },
  { id: 'crm.model', label: 'Data model', to: '/records', group: 'crm', order: 90, icon: 'layers', minRole: 'admin' },
];

/**
 * The shell already offers "Go to" for every nav destination and "Create" for
 * every object type the workspace can store, so nothing here repeats those.
 * What is left is the screens the sidebar does not list.
 */
export const commands: CommandDef[] = [
  { id: 'crm.tasks', title: 'Tasks', subtitle: 'Everything anyone still owes a customer', group: 'Go to', keywords: ['todo', 'follow up', 'queue'], icon: 'check-circle', run: (go) => go(listHref('task')) },
  { id: 'crm.calls', title: 'Calls', subtitle: 'Every call logged, newest first', group: 'Go to', keywords: ['phone', 'dials', 'activity'], icon: 'phone', run: (go) => go(listHref('call')) },
  { id: 'crm.import-contacts', title: 'Import contacts', subtitle: 'From a CSV, with column mapping and a per-row result', group: 'Run', keywords: ['csv', 'upload', 'bulk', 'spreadsheet'], icon: 'upload', run: (go) => go('/contacts?import=1') },
  { id: 'crm.import-companies', title: 'Import companies', subtitle: 'From a CSV, with column mapping and a per-row result', group: 'Run', keywords: ['csv', 'upload', 'bulk', 'spreadsheet', 'accounts'], icon: 'upload', run: (go) => go('/companies?import=1') },
];

export const settings: SettingsPage[] = [
  {
    id: 'crm.data-model',
    label: 'Data model',
    group: 'Workspace',
    order: 45,
    path: '/settings/data-model',
    element: DataModelSettings,
    description: 'Objects, properties, rollups and association types',
  },
];

export const widgets: WidgetDef[] = [
  { id: 'crm.quiet-accounts', title: 'Accounts gone quiet', description: 'Longest since anyone logged anything', span: 4, component: QuietAccounts, group: 'crm' },
  { id: 'crm.newest-contacts', title: 'Newest contacts', description: 'The people who arrived most recently', span: 4, component: NewestContacts, group: 'crm' },
];

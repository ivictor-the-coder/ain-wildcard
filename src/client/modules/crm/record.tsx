/**
 * The record page.
 *
 * Three columns, because that is the shape of the job: what this record is on
 * the left, what has happened to it in the middle, what it is connected to on
 * the right. Every value on it is editable in place, every entry in the middle
 * is a real row from the merged timeline, and every action on it writes.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Accordion, Avatar, Badge, Banner, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState,
  Icons, IconButton, Inline, MenuButton, Modal, Page, Pill, PillGroup, Select, Skeleton, SkeletonText,
  Spinner, Switch, Tooltip, AlertTriangleIcon, ArrowLeftIcon, CheckCircleIcon, RotateCcwIcon, humanize, iconByName,
  useFormat, useToast,
  type MenuSection,
} from '@/client/design';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import { useCurrentCrumb } from '@/client/kernel/shell';
import type { ApiClientError } from '@/client/kernel/api';
import {
  archiveRecord, associate, crmChanged, destroyRecord, disassociate, mergeRecords, patchRecord,
  restoreRecord,
  useAssociationTypes, useProperties, useRecord, useSchema, useSimilar, useStageHistory, useTimeline, useUserIndex,
  useUsers,
  type AssociationSummary, type CrmRecord, type ObjectTypeDef, type PropertyDef, type PropertyValue, type TimelineItem,
  type WorkspaceUser,
} from './api';
import { InlineProperty, LogActivityDialog, RecordFormDialog, activityMeta } from './dialogs';
import { RecordPicker, SlaBadge, UserChip, ValueView } from './values';
import { listHref, recordHref } from './links';
import { slug } from './naming';
import { describeMergeResult, duplicateReason, isEmptyValue as isEmpty, planMerge, primaryCompany, type MergeOutcome } from './merge';
import {
  ACTIVITY_LINK, canMarkPrimary, directActivityIds, groupAssociations, isActivityDef, linkableObjectTypes,
  loggedOnTargets, mergeCellCompact, reachedThrough, showsAssociationLabel, timeInStage, viaFor,
} from './record-model';

/* --------------------------------- helpers -------------------------------- */

/**
 * The timeline names its icon after the thing that happened — `call`, `meeting`,
 * `task` — which is not what the icon set calls the picture of it. Without this
 * every logged call rendered as the fallback "…" glyph.
 */
const ICON_ALIAS: Record<string, string> = {
  'life-buoy': 'tickets', 'sticky-note': 'note', 'check-square': 'check-circle',
  history: 'clock', call: 'phone', meeting: 'calendar', email: 'mail', task: 'check-circle',
  ticket: 'tickets', deal: 'trending-up', contact: 'user', company: 'building',
};

const Glyph = ({ name, size = 15 }: { name: string; size?: number }) => {
  const Icon = iconByName(ICON_ALIAS[name] ?? name);
  return <Icon size={size} />;
};

const KIND_LABEL: Record<TimelineItem['kind'], string> = {
  activity: 'Activities',
  property_change: 'Property changes',
  event: 'System events',
  association: 'Associations',
};

const KIND_TONE: Record<TimelineItem['kind'], 'brand' | 'info' | 'purple' | 'neutral'> = {
  activity: 'brand', property_change: 'info', association: 'purple', event: 'neutral',
};

const ACTIVITY_KINDS = ['note', 'call', 'meeting', 'email', 'task'] as const;

/**
 * `/similar` scores 0–100 already. Clamping is cheap insurance: a percentage
 * over 100 beside a destructive Merge button is a lie about how sure we are.
 */
const confidence = (score: number): number => Math.min(100, Math.max(0, Math.round(score)));

/**
 * The primary flag lives on the `from` end of an edge, so the same star means
 * two different sentences depending on which way the association points. Saying
 * the wrong one turns a useful marker into a claim nobody can check.
 */
function primaryClaim(
  edge: AssociationSummary,
  self: string,
  otherLabel: string,
  selfLabel: string,
): string {
  if (edge.direction === 'incoming') {
    return edge.is_primary
      ? `${self} is ${edge.display_name}’s primary ${selfLabel}`
      : `Make ${self} ${edge.display_name}’s primary ${selfLabel}`;
  }
  return edge.is_primary
    ? `${edge.display_name} is the primary ${otherLabel} here`
    : `Make ${edge.display_name} the primary ${otherLabel}`;
}

/* -------------------------------- the page -------------------------------- */

export function RecordPage({ objectType, id }: { objectType: string; id: string }) {
  const { navigate } = useRouter();
  const session = useSession();
  const toast = useToast();
  const f = useFormat();

  const record = useRecord(objectType, id);
  const props = useProperties(objectType);
  const schema = useSchema();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);
  const associationTypes = useAssociationTypes();

  const objectDef = useMemo<ObjectTypeDef | undefined>(
    () => schema.data?.object_types.find((t) => t.name === objectType) as ObjectTypeDef | undefined,
    [schema.data, objectType],
  );
  /**
   * A note is not a company. It has no duplicates worth scoring, nothing can
   * be logged *on* it, and its only links are the records it was logged on —
   * so the page waits for the schema to say which kind of thing this is
   * before it asks for a duplicate list or offers a merge.
   */
  const isActivity = isActivityDef(objectDef);
  const similar = useSimilar(objectDef && !isActivity ? objectType : null, id);
  // Only tickets and deals move through a pipeline; the route refuses the rest.
  const pipelined = !!schema.data?.pipelines.some((p) => p.object_type === objectType);
  const stages = useStageHistory(pipelined ? objectType : null, id);

  const [kinds, setKinds] = useState<TimelineItem['kind'][]>([]);
  const [rollUp, setRollUp] = useState(true);
  const timeline = useTimeline(objectType, id, kinds, rollUp && !isActivity);

  const [logging, setLogging] = useState<(typeof ACTIVITY_KINDS)[number] | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  /** Object type being created from the associations rail, linked on save. */
  const [linkingNew, setLinkingNew] = useState<string | null>(null);
  const [merging, setMerging] = useState<CrmRecord | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [busyOwner, setBusyOwner] = useState(false);
  const [primaryBusy, setPrimaryBusy] = useState<string | null>(null);

  const activityProps = useProperties(logging);
  const newLinkProps = useProperties(linkingNew);

  const properties = useMemo(() => props.data?.data ?? [], [props.data]);
  const groups = useMemo(() => {
    const map = new Map<string, PropertyDef[]>();
    for (const property of properties) {
      if (property.hidden) continue;
      const arr = map.get(property.group) ?? [];
      arr.push(property);
      map.set(property.group, arr);
    }
    return [...map.entries()];
  }, [properties]);

  const data = record.data;

  useCurrentCrumb(data?.display_name);

  /**
   * Who this person works for. It was only in the right-hand rail, which on a
   * narrow window is below the fold — so the first question anyone asks about a
   * contact was the last thing the page answered.
   */
  const employer = useMemo<AssociationSummary | null>(() => {
    if (!data || objectType === 'company' || isActivity) return null;
    const edges = (data.associations ?? []).filter(
      (edge) => edge.object_type === 'company' && edge.association_type !== ACTIVITY_LINK,
    );
    return edges.find((edge) => edge.is_primary) ?? edges[0] ?? null;
  }, [data, objectType, isActivity]);

  /** For an activity, the record it was logged on answers the same question. */
  const loggedOn = useMemo(() => (data && isActivity ? loggedOnTargets(data.associations ?? []) : []), [data, isActivity]);
  const direct = useMemo(() => directActivityIds(data?.associations ?? []), [data]);

  const [completing, setCompleting] = useState(false);
  const completeTask = async () => {
    if (!data) return;
    setCompleting(true);
    try {
      await patchRecord(objectType, id, { properties: { status: 'completed' } });
      crmChanged();
      record.refetch();
      toast.success('Task completed', `“${data.display_name}” is done, and says so on every record it was logged on.`);
    } catch (e) {
      toast.error('Task not completed', (e as ApiClientError).body.message);
    } finally {
      setCompleting(false);
    }
  };

  const setOwner = async (ownerId: string | null) => {
    if (!data) return;
    setBusyOwner(true);
    try {
      await patchRecord(objectType, id, { owner_id: ownerId });
      crmChanged();
      toast.success('Owner changed', ownerId ? `${userIndex.get(ownerId)?.name ?? ownerId} owns this now.` : 'Nobody owns this record now.');
    } catch (e) {
      toast.error('Owner not changed', (e as ApiClientError).body.message);
    } finally {
      setBusyOwner(false);
    }
  };

  const unlink = async (edge: AssociationSummary) => {
    try {
      await disassociate(edge.id);
      crmChanged();
      toast.success('Association removed', `${edge.display_name} is no longer linked here.`);
    } catch (e) {
      toast.error('Association not removed', (e as ApiClientError).body.message);
    }
  };

  const link = async (targetId: string, primary: boolean) => {
    if (!data) return;
    try {
      await associate({ from_id: data.id, to_id: targetId, primary });
      crmChanged();
      setLinking(null);
      toast.success(
        'Records linked',
        primary
          ? 'The association shows on both sides, and this is now the primary link of its kind.'
          : 'The association shows on both sides, with its label.',
      );
    } catch (e) {
      toast.error('Records not linked', (e as ApiClientError).body.message);
    }
  };

  /**
   * The primary flag belongs to the `from` side of the edge, so a contact's
   * primary company is set from either page — the direction on the summary
   * says which end to send. Making it primary here clears the flag on its
   * siblings of the same type, which is what "primary" means.
   */
  const makePrimary = async (edge: AssociationSummary) => {
    if (!data || edge.is_primary) return;
    setPrimaryBusy(edge.id);
    try {
      await associate(
        edge.direction === 'incoming'
          ? { from_id: edge.record_id, to_id: data.id, association_type: edge.association_type, primary: true }
          : { from_id: data.id, to_id: edge.record_id, association_type: edge.association_type, primary: true },
      );
      crmChanged();
      record.refetch();
      const other = schema.data?.object_types.find((t) => t.name === edge.object_type)?.label ?? humanize(edge.object_type);
      const mine = schema.data?.object_types.find((t) => t.name === objectType)?.label ?? humanize(objectType);
      toast.success(
        'Primary link set',
        edge.direction === 'incoming'
          ? `${data.display_name} is now ${edge.display_name}’s primary ${mine.toLowerCase()}.`
          : `${edge.display_name} is now the primary ${other.toLowerCase()} on this record.`,
      );
    } catch (e) {
      toast.error('Primary link not set', (e as ApiClientError).body.message);
    } finally {
      setPrimaryBusy(null);
    }
  };

  /* ------------------------------- boot states ----------------------------- */

  if (record.error) {
    return (
      <Page title="Record" eyebrow={humanize(objectType)}>
        <ErrorState
          title={record.error.status === 404 ? 'No such record' : 'This record could not be read'}
          message={record.error.body.message}
          code={`${record.error.status} /v1/records/${objectType}/${id}`}
          requestId={record.error.body.request_id ?? null}
          action={
            <Inline gap={3}>
              <Button variant="primary" onClick={record.refetch}>Try again</Button>
              <Button variant="ghost" onClick={() => navigate(listHref(objectType))}>
                Back to the list
              </Button>
            </Inline>
          }
        />
      </Page>
    );
  }

  if (!data) {
    return (
      <Page title="Loading…" eyebrow={humanize(objectType)}>
        <div className="crm-record">
          <div><Skeleton height={180} /><Skeleton height={320} /></div>
          <div><Skeleton height={60} /><SkeletonText lines={10} /></div>
          <div><Skeleton height={220} /></div>
        </div>
      </Page>
    );
  }

  const primary = objectDef?.primary_property ?? 'name';
  const lifecycleProp = properties.find((p) => p.name === 'lifecycle_stage');
  const lifecycleValue = lifecycleProp ? data.properties.lifecycle_stage ?? null : null;
  const secondary = objectDef?.secondary_property ?? null;
  const secondaryProp = secondary ? properties.find((p) => p.name === secondary) : undefined;
  const primaryLabel = properties.find((p) => p.name === primary)?.label ?? 'Name';
  const associations = data.associations ?? [];
  const activityTypes = new Set((schema.data?.object_types ?? []).filter((t) => t.category === 'activity').map((t) => t.name));
  const byType = groupAssociations(associations, isActivity, (type) => activityTypes.has(type));
  const duplicates = similar.data?.data ?? [];
  // Only the types an association type actually connects to this one. Offering
  // the rest reported a link the platform then filed under the wildcard label,
  // where it showed on neither record and could not be taken back.
  const linkTargets = linkableObjectTypes(
    objectType,
    isActivity,
    (schema.data?.object_types ?? []).filter((t) => t.category === 'record'),
    schema.data?.association_types ?? [],
  );
  const newLinkTarget = linkTargets.find((t) => t.name === linkingNew) ?? null;
  // The type the plus button opens on: another type where one exists, this one
  // where it links to itself. Empty when the data model connects this object to
  // nothing at all, and then there is nothing to open.
  const firstLinkTarget = (linkTargets.find((t) => t.name !== objectType) ?? linkTargets[0])?.name ?? '';
  const typeLabel = (name: string): string =>
    (schema.data?.object_types.find((t) => t.name === name)?.label ?? humanize(name)).toLowerCase();
  const ownLabel = (objectDef?.label ?? humanize(objectType)).toLowerCase();
  const merged = reachedThrough(data);
  const railTitle = isActivity ? 'Logged on' : 'Associations';
  const openTask = objectType === 'task' && !['completed', 'cancelled', 'canceled', 'deferred'].includes(String(data.properties.status ?? ''));
  const currentSpell = stages.data?.data.find((spell) => spell.is_current) ?? null;

  const actions: MenuSection[] = [{
    id: 'record',
    items: [
      { id: 'copy', label: 'Copy record id', icon: <Icons.copy size={14} />, onSelect: () => { void navigator.clipboard?.writeText(data.id); toast.info('Record id copied', data.id); } },
      // Two notes with the same subject are two notes. Merging is for the
      // records that can genuinely be the same thing twice.
      ...(isActivity ? [] : [{ id: 'merge', label: 'Merge a duplicate into this record', icon: <Icons.layers size={14} />, onSelect: () => setMerging(data) }]),
      data.archived
        ? {
          id: 'restore',
          label: 'Restore this record',
          icon: <RotateCcwIcon size={14} />,
          onSelect: async () => {
            await restoreRecord(objectType, id);
            crmChanged();
            toast.success('Record restored', `${data.display_name} is back in the list.`);
          },
        }
        : { id: 'archive', label: 'Archive this record', icon: <Icons.trash size={14} />, danger: true, onSelect: () => setConfirmArchive(true) },
      { id: 'destroy', label: 'Delete permanently', icon: <AlertTriangleIcon size={14} />, danger: true, onSelect: () => setConfirmDestroy(true) },
    ],
  }];

  return (
    <Page
      width="wide"
      eyebrow={objectDef?.label ?? humanize(objectType)}
      title={data.display_name}
      badge={
        // Who they are to the business belongs beside the name, not three
        // scrolls down a properties rail.
        (lifecycleValue || data.archived) ? (
          <Inline gap={2}>
            {lifecycleValue && <ValueView property={lifecycleProp} value={lifecycleValue} users={userIndex} compact />}
            {data.archived && <Badge tone="warning" size="sm">Archived</Badge>}
          </Inline>
        ) : undefined
      }
      subtitle={
        <>
          {employer && (
            <>
              <a
                className="crm-link"
                href={recordHref(employer.object_type, employer.record_id)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  navigate(recordHref(employer.object_type, employer.record_id));
                }}
              >
                {employer.display_name}
              </a>
              {' · '}
            </>
          )}
          {loggedOn.length > 0 && (
            <>
              Logged on{' '}
              <a
                className="crm-link"
                href={recordHref(loggedOn[0].object_type, loggedOn[0].record_id)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  navigate(recordHref(loggedOn[0].object_type, loggedOn[0].record_id));
                }}
              >
                {loggedOn[0].display_name}
              </a>
              {loggedOn.length > 1 ? ` and ${f.plural(loggedOn.length - 1, 'other')}` : ''}
              {' · '}
            </>
          )}
          {currentSpell && (
            <>
              <Tooltip content={`Entered ${currentSpell.stage_label} ${f.dateTime(currentSpell.entered_at)}`}>
                <span>{timeInStage(currentSpell, f.plural)}</span>
              </Tooltip>
              {' · '}
            </>
          )}
          Created {f.date(data.created)} · last touched {f.relative(data.updated)}
          {merged && (
            <>
              {' · '}
              <span title={`Merged id: ${merged.id}`}>{merged.text}</span>
            </>
          )}
        </>
      }
      actions={
        <Inline gap={3}>
          {/* Nothing is logged *on* a note; on a task the one action that
              matters most is finishing it. */}
          {!isActivity && ACTIVITY_KINDS.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={kind === 'note' ? 'secondary' : 'ghost'}
              iconLeft={activityMeta[kind].icon}
              onClick={() => setLogging(kind)}
            >
              {activityMeta[kind].label}
            </Button>
          ))}
          {openTask && (
            <Button size="sm" variant="primary" iconLeft={<CheckCircleIcon size={14} />} loading={completing} onClick={() => { void completeTask(); }}>
              Mark complete
            </Button>
          )}
          <MenuButton sections={actions} label="More actions on this record" icon={<Icons.more size={16} />} />
        </Inline>
      }
    >
      {data.archived && (
        <Banner
          tone="warning"
          title="This record is archived"
          actions={
            <Button
              size="sm"
              onClick={async () => { await restoreRecord(objectType, id); crmChanged(); toast.success('Record restored', `${data.display_name} is back in the list.`); }}
            >
              Restore it
            </Button>
          }
        >
          It keeps its history, its associations and its id, and it stays out of every list until it is restored.
        </Banner>
      )}

      <div className="crm-record">
        {/* ------------------------------ properties --------------------------- */}
        <div className="crm-record__col">
          <Card padding="tight" className="crm-identity">
            <div className="crm-identity__head">
              <Avatar name={data.display_name} seed={data.id} size={44} square={objectType !== 'contact'} />
              <div className="crm-identity__text">
                <div className="crm-identity__name u-truncate">{data.display_name}</div>
                {secondary && (
                  <div className="crm-identity__sub u-truncate">
                    <ValueView property={secondaryProp} value={data.properties[secondary] ?? null} users={userIndex} compact />
                  </div>
                )}
                {employer && (
                  <a
                    className="crm-identity__at"
                    href={recordHref(employer.object_type, employer.record_id)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                      e.preventDefault();
                      navigate(recordHref(employer.object_type, employer.record_id));
                    }}
                  >
                    <Icons.building size={12} />
                    <span className="u-truncate">{employer.display_name}</span>
                    {employer.is_primary && <Icons.star size={11} title={`Primary ${typeLabel(employer.object_type)}`} />}
                  </a>
                )}
                {loggedOn[0] && (
                  <a
                    className="crm-identity__at"
                    href={recordHref(loggedOn[0].object_type, loggedOn[0].record_id)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                      e.preventDefault();
                      navigate(recordHref(loggedOn[0].object_type, loggedOn[0].record_id));
                    }}
                  >
                    <Glyph name={loggedOn[0].object_type} size={12} />
                    <span className="u-truncate">{loggedOn[0].display_name}</span>
                  </a>
                )}
              </div>
            </div>
            <div className="crm-identity__owner">
              <span className="crm-prop__label">Owner</span>
              <div className="crm-identity__ownerctl">
                <Select
                  value={data.owner_id ?? ''}
                  onChange={(next) => { void setOwner(next || null); }}
                  options={[
                    { value: '', label: 'Unassigned' },
                    // A seat that has not accepted its invitation can hold a
                    // record and nobody would be working it; the picker says so
                    // before the assignment, not the roster afterwards.
                    ...(users.data?.data ?? []).map((u) => ({
                      value: u.id,
                      label: u.status === 'invited' ? `${u.name} · invited` : u.name,
                    })),
                  ]}
                  aria-label="Record owner"
                  size="sm"
                  disabled={busyOwner}
                />
                {busyOwner && <Spinner size={13} />}
              </div>
            </div>
            <div className="crm-identity__meta">
              <span className="u-mono">{data.id}</span>
              <Badge tone="neutral" size="sm">via {humanize(data.source)}</Badge>
            </div>
          </Card>

          <div className="crm-props">
            <div className="crm-props__head">
              <h2 className="crm-props__title">Properties</h2>
              <Switch size="sm" checked={showEmpty} onChange={setShowEmpty} label="Show empty" />
            </div>
            {props.error && (
              <ErrorState
                title="The property list did not load"
                message={props.error.body.message}
                requestId={props.error.body.request_id ?? null}
                action={<Button size="sm" onClick={props.refetch}>Try again</Button>}
              />
            )}
            {(() => {
              // One accordion with an id per group: three panels all called
              // `acc-only` gave every trigger the same `aria-controls` target.
              const items = groups
                .map(([group, list]) => ({
                  group,
                  visible: list.filter((p) => showEmpty || (data.properties[p.name] !== null && data.properties[p.name] !== undefined && data.properties[p.name] !== '')),
                }))
                .filter(({ visible }) => visible.length > 0)
                .map(({ group, visible }) => ({
                  id: `props-${slug(group) || 'group'}`,
                  title: `${group} · ${visible.length}`,
                  content: (
                    <div className="crm-props__list">
                      {visible.map((property) => (
                        <InlineProperty
                          key={property.name}
                          record={data}
                          property={property}
                          users={users.data?.data ?? []}
                          userIndex={userIndex}
                          onSaved={record.refetch}
                        />
                      ))}
                    </div>
                  ),
                }));
              return items.length ? <Accordion plain items={items} defaultOpen={items.slice(0, 2).map((item) => item.id)} /> : null;
            })()}
          </div>
        </div>

        {/* ------------------------------- timeline ---------------------------- */}
        <div className="crm-record__col crm-record__col--mid">
          <div className="crm-timeline__toolbar">
            <PillGroup label="Filter the timeline">
              <Pill active={kinds.length === 0} onClick={() => setKinds([])}>Everything</Pill>
              {(Object.keys(KIND_LABEL) as TimelineItem['kind'][]).map((kind) => (
                <Pill
                  key={kind}
                  active={kinds.includes(kind)}
                  onClick={() => setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))}
                >
                  {KIND_LABEL[kind]}
                </Pill>
              ))}
            </PillGroup>
            <span className="u-spacer" />
            {!isActivity && (
              <Tooltip content="Roll up everything logged against this record’s contacts, deals and tickets">
                <span><Switch size="sm" checked={rollUp} onChange={setRollUp} label="Roll up" /></span>
              </Tooltip>
            )}
          </div>

          {timeline.error && (
            <ErrorState
              title="The timeline did not load"
              message={timeline.error.body.message}
              code={`${timeline.error.status} /v1/records/${objectType}/${id}/timeline`}
              requestId={timeline.error.body.request_id ?? null}
              action={<Button size="sm" variant="primary" onClick={timeline.refetch}>Try again</Button>}
            />
          )}

          {!timeline.error && timeline.loading && <div className="crm-timeline__loading"><SkeletonText lines={12} /></div>}

          {!timeline.error && !timeline.loading && timeline.items.length === 0 && (
            isActivity ? (
              <EmptyState
                title={`Nothing has happened to this ${ownLabel} since it was logged`}
                body="Every edit to it lands here, with who made it and what changed."
              />
            ) : (
              <EmptyState
                title="Nothing on this timeline yet"
                body={`Log the first call or write a note and it lands here, next to every property change ${data.display_name} goes through.`}
                action={<Button variant="primary" iconLeft={<Icons.note size={14} />} onClick={() => setLogging('note')}>Write a note</Button>}
              />
            )
          )}

          {!timeline.error && timeline.items.length > 0 && (
            <ol className="crm-timeline">
              {timeline.items.map((item) => {
                const activityType = item.kind === 'activity' ? String(item.data.object_type ?? '') : '';
                const kindLabel = activityType
                  ? (schema.data?.object_types.find((t) => t.name === activityType)?.label ?? humanize(activityType))
                  : humanize(item.kind);
                // An association row carries no actor — the platform does not
                // record who linked what — and printing the type name "User"
                // there read as a person called User.
                const actor = item.actor_id
                  ? <UserChip id={item.actor_id} user={userIndex.get(item.actor_id)} size={16} />
                  : item.actor_type !== 'user' ? <span className="crm-muted">{humanize(item.actor_type)}</span> : null;
                // The roll-up names a neighbour even for activities this record
                // holds directly; its own edges are the authority on "own".
                const via = viaFor(item, direct);
                return (
                  <li className="crm-tl" key={`${item.kind}:${item.id}:${item.cursor}`}>
                    <span className={`crm-tl__icon crm-tl__icon--${item.kind}`}><Glyph name={item.icon} size={14} /></span>
                    <div className="crm-tl__body">
                      <div className="crm-tl__head">
                        <span className="crm-tl__title">{item.title}</span>
                        <Badge tone={KIND_TONE[item.kind]} size="sm">{kindLabel}</Badge>
                        <span className="u-spacer" />
                        <Tooltip content={f.dateTime(item.at)}>
                          <span className="crm-tl__when">{f.relative(item.at)}</span>
                        </Tooltip>
                      </div>
                      {item.body && <p className="crm-tl__text">{item.body}</p>}
                      {activityType && (
                        <ActivityFacts
                          item={item}
                          type={activityType}
                          onChanged={() => { timeline.refetch(); record.refetch(); }}
                        />
                      )}
                      {(actor || via) && (
                        <div className="crm-tl__foot">
                          {actor}
                          {via && (
                            <>
                              {actor && <span className="crm-muted">·</span>}
                              <a className="crm-link" href={recordHref(via.object_type, via.id)}>
                                via {via.display_name}
                              </a>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {timeline.hasMore && (
            <div className="crm-timeline__more">
              <Button variant="secondary" loading={timeline.loadingMore} onClick={timeline.loadMore}>
                Older entries
              </Button>
            </div>
          )}
        </div>

        {/* ----------------------------- associations -------------------------- */}
        <div className="crm-record__col">
          <Card
            title={railTitle}
            description={isActivity
              ? `The records this ${ownLabel} is attached to — it shows on each of their timelines`
              : 'Labelled both ways, with the primary link marked'}
            actions={
              <Tooltip
                content={`No association type connects ${objectDef?.plural_label.toLowerCase() ?? 'this object'} to anything yet — define one in the data model`}
                disabled={!!firstLinkTarget}
              >
                <IconButton
                  size="sm"
                  label={isActivity ? 'Attach to another record' : 'Link another record'}
                  icon={<Icons.plus size={14} />}
                  disabled={!firstLinkTarget}
                  onClick={() => setLinking(firstLinkTarget)}
                />
              </Tooltip>
            }
          >
            {byType.size === 0 && (
              <EmptyState
                size="sm"
                inline
                illustration={null}
                title={isActivity ? 'Not attached to any record' : 'Not linked to anything yet'}
                body={isActivity
                  ? `A ${ownLabel} that is not logged on a contact, company, deal or ticket shows on no timeline at all.`
                  : 'Associations are what make a company page show its contacts and its deals.'}
                action={firstLinkTarget
                  ? (
                    <Button size="sm" variant="secondary" onClick={() => setLinking(firstLinkTarget)}>
                      {isActivity ? 'Attach to a record' : 'Link a record'}
                    </Button>
                  )
                  : (
                    <Button size="sm" variant="secondary" onClick={() => navigate('/records')}>
                      Define an association type
                    </Button>
                  )}
              />
            )}
            {[...byType.entries()].map(([type, edges]) => {
              const sectionLabel = schema.data?.object_types.find((t) => t.name === type)?.plural_label ?? humanize(type);
              return (
                <div className="crm-assoc" key={type}>
                  <div className="crm-assoc__head">
                    <Glyph name={schema.data?.object_types.find((t) => t.name === type)?.icon ?? 'link'} size={13} />
                    <span>{sectionLabel}</span>
                    <Badge tone="neutral" size="sm">{edges.length}</Badge>
                    <span className="u-spacer" />
                    {/* A section can exist for a type that is not linkable — a
                        stranded wildcard link surfaced so it can be removed.
                        Offering "+" there would only make another one. */}
                    {linkTargets.some((t) => t.name === type) && (
                      <IconButton size="sm" label={`Link a ${type}`} icon={<Icons.plus size={13} />} onClick={() => setLinking(type)} />
                    )}
                  </div>
                  {edges.map((edge) => (
                    <div className="crm-assoc__row" key={edge.id}>
                      <a className="crm-link u-truncate" href={recordHref(edge.object_type, edge.record_id)}>
                        {edge.display_name}
                      </a>
                      {/* "Deals" under a heading that already reads Deals says
                          nothing; "Employs" and "Requested by" say something. */}
                      {showsAssociationLabel(edge, sectionLabel, railTitle) && <Badge tone="neutral" size="sm">{edge.label}</Badge>}
                      {canMarkPrimary(edge) && (() => {
                        // Which end owns the flag decides what the star means: on
                        // a company page the star beside a contact says "this is
                        // that person's primary company", not the other way round.
                        const label = primaryClaim(edge, data.display_name, typeLabel(edge.object_type), typeLabel(objectType));
                        return (
                          <Tooltip content={edge.is_primary ? `${label} — choose another to move it` : label}>
                            <button
                              type="button"
                              className={`crm-assoc__primary${edge.is_primary ? ' is-primary' : ''}`}
                              aria-pressed={edge.is_primary}
                              aria-label={label}
                              disabled={primaryBusy === edge.id}
                              onClick={() => { void makePrimary(edge); }}
                            >
                              {primaryBusy === edge.id ? <Spinner size={12} /> : <Icons.star size={12} />}
                            </button>
                          </Tooltip>
                        );
                      })()}
                      <span className="u-spacer" />
                      <IconButton
                        size="sm"
                        label={`Unlink ${edge.display_name}`}
                        icon={<Icons.x size={13} />}
                        onClick={() => { void unlink(edge); }}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </Card>

          {pipelined && (
            <Card
              title="Status history"
              description="Every status this record has been in, and how long it stayed"
            >
              {stages.error && (
                <ErrorState
                  title="The status history did not load"
                  message={stages.error.body.message}
                  requestId={stages.error.body.request_id ?? null}
                  action={<Button size="sm" onClick={stages.refetch}>Try again</Button>}
                />
              )}
              {!stages.error && stages.loading && <SkeletonText lines={3} />}
              {!stages.error && stages.data && (
                <ol className="crm-spells">
                  {[...stages.data.data].reverse().map((spell) => (
                    <li key={`${spell.stage}:${spell.entered_at}`} className={`crm-spell${spell.is_current ? ' is-current' : ''}`}>
                      <div className="crm-spell__head">
                        <span className="crm-spell__stage">{spell.stage_label}</span>
                        {spell.is_current && <Badge tone="brand" size="sm">Now</Badge>}
                        <span className="u-spacer" />
                        <span className="crm-spell__span">{timeInStage(spell, f.plural)}</span>
                      </div>
                      <div className="crm-spell__meta">
                        <Tooltip content={f.dateTime(spell.entered_at)}><span>Entered {f.date(spell.entered_at)}</span></Tooltip>
                        {spell.moved_by && (
                          <>
                            <span aria-hidden>·</span>
                            <UserChip id={spell.moved_by} user={userIndex.get(spell.moved_by)} size={14} />
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}

          {!isActivity && (
            <Card
              title="Possible duplicates"
              description="Scored against every other record of this type, with the reason"
            >
              {similar.loading && <SkeletonText lines={3} />}
              {!similar.loading && duplicates.length === 0 && (
                <EmptyState
                  size="sm"
                  inline
                  illustration={null}
                  title="No likely duplicate"
                  body={`Nothing else in ${objectDef?.plural_label.toLowerCase() ?? 'this object'} looks like ${data.display_name}.`}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => setMerging(data)}>
                      Merge one anyway
                    </Button>
                  }
                />
              )}
              {duplicates.map((match) => (
                <DuplicateCandidate
                  key={match.record.id}
                  record={match.record}
                  score={confidence(match.score)}
                  reasons={match.reasons.map((reason) => duplicateReason(reason, objectType, primaryLabel))}
                  secondary={secondaryProp}
                  users={userIndex}
                  onMerge={() => setMerging(match.record)}
                />
              ))}
            </Card>
          )}
        </div>
      </div>

      {/* --------------------------------- dialogs ------------------------------ */}

      {logging && (
        <LogActivityDialog
          open
          onClose={() => setLogging(null)}
          kind={logging}
          record={data}
          properties={activityProps.data?.data ?? []}
          users={users.data?.data ?? []}
          onLogged={() => { timeline.refetch(); record.refetch(); }}
        />
      )}

      <LinkDialog
        open={!!linking}
        onClose={() => setLinking(null)}
        types={linkTargets.map((t) => ({ name: t.name, label: t.plural_label }))}
        initialType={linking ?? ''}
        exclude={associations.map((a) => a.record_id)}
        onLink={link}
        onCreateNew={(type) => { setLinking(null); setLinkingNew(type); }}
      />

      {/* The other half of linking: the record you want does not exist yet. It
          is created and associated in one write, so nobody has to remember to
          come back and link it. */}
      {linkingNew && newLinkTarget && (
        <RecordFormDialog
          open
          onClose={() => setLinkingNew(null)}
          objectType={newLinkTarget}
          properties={newLinkProps.data?.data ?? []}
          users={users.data?.data ?? []}
          associateTo={[data.id]}
          associateLabel={data.display_name}
          onCreated={(created) => {
            crmChanged();
            record.refetch();
            toast.success('Linked to the new record', `${created.display_name} was created and linked to ${data.display_name}.`);
          }}
        />
      )}

      {!isActivity && (
        <MergeDialog
          open={!!merging}
          onClose={() => setMerging(null)}
          winner={data}
          candidate={merging && merging.id !== data.id ? merging : null}
          properties={properties}
          users={userIndex}
          typeLabel={typeLabel}
          onMerged={() => { record.refetch(); similar.refetch(); timeline.refetch(); }}
        />
      )}

      <ConfirmDialog
        open={confirmArchive}
        onCancel={() => setConfirmArchive(false)}
        onConfirm={async () => {
          setConfirmArchive(false);
          try {
            await archiveRecord(objectType, id);
            crmChanged();
            toast.success('Record archived', `${data.display_name} is out of the list — restore it from here any time.`);
            record.refetch();
          } catch (e) {
            toast.error('Record not archived', (e as ApiClientError).body.message);
          }
        }}
        title={`Archive ${data.display_name}?`}
        body="It keeps its history, its associations and its id. Nothing is deleted."
        confirmLabel="Archive"
      />

      <ConfirmDialog
        open={confirmDestroy}
        onCancel={() => setConfirmDestroy(false)}
        onConfirm={async () => {
          setConfirmDestroy(false);
          try {
            await destroyRecord(objectType, id);
            crmChanged();
            toast.success('Record deleted', `${data.display_name} and its values are gone for good.`);
            navigate(listHref(objectType));
          } catch (e) {
            toast.error('Record not deleted', (e as ApiClientError).body.message);
          }
        }}
        title={`Permanently delete ${data.display_name}?`}
        body="This is not archiving. The record, its property values and its history go, and no id resolves to it afterwards. Type the record's name to confirm."
        confirmLabel="Delete for ever"
        confirmPhrase={data.display_name}
      />

      {associationTypes.error && (
        <Banner tone="warning" compact title="Association labels could not be read">
          {associationTypes.error.body.message}
        </Banner>
      )}
    </Page>
  );
}

/* ------------------------------ activity facts ---------------------------- */

const OPEN_TASK = new Set(['not_started', 'in_progress', 'waiting']);

/**
 * The fields that make a logged task a task and a call a call. Without them
 * the timeline read "Critic Task subject · Activity" five times over, and the
 * only way to complete a task was to open its own record and edit Status.
 */
function ActivityFacts({ item, type, onChanged }: { item: TimelineItem; type: string; onChanged: () => void }) {
  const f = useFormat();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const props = (item.data.properties ?? {}) as Record<string, PropertyValue>;
  const shown = (item.data.formatted ?? {}) as Record<string, string>;
  const fact = (name: string): string | null => (props[name] === null || props[name] === undefined || props[name] === '' ? null : shown[name] ?? String(props[name]));

  const complete = async () => {
    setBusy(true);
    try {
      await patchRecord('task', item.record_id, { properties: { status: 'completed' } });
      crmChanged();
      toast.success('Task completed', `“${item.title}” is done, and says so on every record it was linked to.`);
      onChanged();
    } catch (e) {
      toast.error('Task not completed', (e as ApiClientError).body.message);
    } finally {
      setBusy(false);
    }
  };

  const facts: { key: string; node: React.ReactNode }[] = [];
  const badge = (key: string, label: string | null, tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' = 'neutral') => {
    if (label) facts.push({ key, node: <Badge tone={tone} size="sm">{label}</Badge> });
  };
  const text = (key: string, value: string | null) => {
    if (value) facts.push({ key, node: <span className="crm-tl__fact">{value}</span> });
  };

  switch (type) {
    case 'task': {
      const status = String(props.status ?? 'not_started');
      const done = status === 'completed';
      badge('status', fact('status') ?? humanize(status), done ? 'success' : status === 'waiting' ? 'warning' : 'neutral');
      if (typeof props.due_at === 'number') facts.push({ key: 'due', node: <SlaBadge dueAt={props.due_at} closed={!OPEN_TASK.has(status)} /> });
      badge('priority', fact('priority') ? `${fact('priority')} priority` : null, props.priority === 'urgent' || props.priority === 'high' ? 'danger' : 'neutral');
      text('type', fact('task_type'));
      if (typeof props.completed_at === 'number') text('completed', `Completed ${f.date(props.completed_at)}`);
      break;
    }
    case 'call':
      badge('direction', fact('direction'), 'info');
      text('duration', typeof props.duration_minutes === 'number' ? `${f.number(props.duration_minutes)} min` : null);
      badge('outcome', fact('outcome'), props.outcome === 'connected' ? 'success' : 'neutral');
      break;
    case 'email':
      badge('direction', fact('direction'), 'info');
      text('route', props.from_email || props.to_email ? `${fact('from_email') ?? '—'} → ${fact('to_email') ?? '—'}` : null);
      badge('status', fact('status'), props.status === 'replied' ? 'success' : props.status === 'bounced' ? 'danger' : 'neutral');
      break;
    case 'meeting':
      badge('type', fact('meeting_type'), 'info');
      text('when', typeof props.start_at === 'number' ? `${f.dateTime(props.start_at)}${typeof props.end_at === 'number' ? ` – ${f.time(props.end_at)}` : ''}` : null);
      text('location', fact('location'));
      badge('outcome', fact('outcome'), props.outcome === 'held' ? 'success' : props.outcome === 'no_show' ? 'danger' : 'neutral');
      text('attendees', typeof props.attendee_count === 'number' ? f.plural(props.attendee_count, 'attendee') : null);
      break;
    default:
      break;
  }

  const canComplete = type === 'task' && OPEN_TASK.has(String(props.status ?? 'not_started'));
  if (!facts.length && !canComplete) return null;
  return (
    <div className="crm-tl__facts">
      {facts.map(({ key, node }) => <span key={key} className="crm-tl__factitem">{node}</span>)}
      {canComplete && (
        <Button size="sm" variant="ghost" iconLeft={<CheckCircleIcon size={13} />} loading={busy} onClick={() => { void complete(); }}>
          Mark complete
        </Button>
      )}
    </div>
  );
}

/* ------------------------------- link dialog ------------------------------ */

function LinkDialog({ open, onClose, types, initialType, exclude, onLink, onCreateNew }: {
  open: boolean;
  onClose: () => void;
  types: { name: string; label: string }[];
  initialType: string;
  exclude: string[];
  onLink: (id: string, primary: boolean) => Promise<void>;
  onCreateNew: (objectType: string) => void;
}) {
  const [type, setType] = useState(initialType);
  const [target, setTarget] = useState('');
  const [primary, setPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = type || initialType || types[0]?.name || '';

  useEffect(() => { if (open) setPrimary(false); }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Link a record"
      description="Ain infers the association type from the two object types, and its label from the type."
      footer={
        <>
          <Button variant="ghost" iconLeft={<Icons.plus size={14} />} onClick={() => onCreateNew(active)} disabled={busy || !active}>
            Create a new one
          </Button>
          <span className="u-spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!target}
            onClick={async () => { setBusy(true); await onLink(target, primary); setBusy(false); setTarget(''); }}
          >
            Link
          </Button>
        </>
      }
    >
      <div className="crm-form">
        <label className="crm-form__label" htmlFor="link-type">What kind of record</label>
        <Select
          id="link-type"
          value={active}
          onChange={(next) => { setType(next); setTarget(''); }}
          options={types.map((t) => ({ value: t.name, label: t.label }))}
        />
        {active && (
          <RecordPicker
            objectType={active}
            value={target}
            onChange={setTarget}
            label="Record to link"
            exclude={exclude}
          />
        )}
        <Checkbox
          checked={primary}
          onChange={setPrimary}
          label="Make this the primary link"
          hint="One link of each kind can be primary — it leads the list and any existing primary stands down."
        />
      </div>
    </Modal>
  );
}

/* ---------------------------- duplicate candidate ------------------------- */

/**
 * One scored duplicate, with enough beside the name to tell two records with
 * the same name apart: the company it belongs to, its status and when it was
 * created. Two tickets both called "Dashboard loads slowly" are a duplicate
 * or two customers with the same problem, and only those facts say which.
 */
function DuplicateCandidate({ record, score, reasons, secondary, users, onMerge }: {
  record: CrmRecord;
  score: number;
  reasons: string[];
  secondary: PropertyDef | undefined;
  users: Map<string, WorkspaceUser>;
  onMerge: () => void;
}) {
  const f = useFormat();
  // The scorer hands back the record without its associations; the company is
  // the distinguishing fact, so it is read from the record itself.
  const full = useRecord(record.object_type, record.id);
  const company = full.data ? primaryCompany(full.data) : null;
  const secondaryValue = secondary ? record.properties[secondary.name] ?? null : null;
  return (
    <div className="crm-dupe">
      <div className="crm-dupe__head">
        <a className="crm-link crm-dupe__name" href={recordHref(record.object_type, record.id)}>
          {record.display_name}
        </a>
        <Badge tone={score > 80 ? 'danger' : 'warning'} size="sm">{score}% match</Badge>
      </div>
      <div className="crm-dupe__facts">
        {company && (
          <span className="crm-dupe__fact">
            <Icons.building size={11} />
            <a className="crm-link" href={recordHref(company.object_type, company.record_id)}>{company.display_name}</a>
          </span>
        )}
        {secondary && secondaryValue !== null && secondaryValue !== '' && (
          <span className="crm-dupe__fact"><ValueView property={secondary} value={secondaryValue} users={users} compact /></span>
        )}
        <span className="crm-dupe__fact">Created {f.date(record.created)}</span>
      </div>
      <p className="crm-dupe__why">{reasons.join(' · ')}</p>
      <Button size="sm" variant="secondary" iconLeft={<Icons.layers size={13} />} onClick={onMerge}>
        Merge into this record
      </Button>
    </div>
  );
}

/* ------------------------------- merge dialog ----------------------------- */

const OUTCOME_LABEL: Record<MergeOutcome, { label: string; tone: 'success' | 'neutral' | 'info' | 'warning' | 'purple' }> = {
  filled: { label: 'Fills the blank', tone: 'success' },
  kept: { label: 'Survivor keeps its own', tone: 'neutral' },
  combined: { label: 'Combined', tone: 'purple' },
  newest: { label: 'Newer stamp wins', tone: 'info' },
  locked: { label: 'Not copied — maintained by the platform', tone: 'warning' },
};

function MergeDialog({ open, onClose, winner, candidate, properties, users, typeLabel, onMerged }: {
  open: boolean;
  onClose: () => void;
  winner: CrmRecord;
  candidate: CrmRecord | null;
  properties: PropertyDef[];
  users: Map<string, WorkspaceUser>;
  typeLabel: (objectType: string) => string;
  onMerged: () => void;
}) {
  const toast = useToast();
  const [loserId, setLoserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const chosen = candidate?.id ?? loserId;
  // Read in full — the scorer's copy carries no associations, and which
  // relationships move is the half of the preview that matters most.
  const loser = useRecord(open && chosen ? winner.object_type : null, chosen || null);
  const plan = useMemo(
    () => (loser.data ? planMerge(winner, loser.data, properties) : null),
    [winner, loser.data, properties],
  );

  useEffect(() => { if (!open) { setLoserId(''); setAcknowledged(false); } }, [open]);
  useEffect(() => { setAcknowledged(false); }, [chosen]);

  const conflict = plan?.companyConflict ?? null;
  const blocked = !chosen || !plan || (!!conflict && !acknowledged);

  const submit = async () => {
    if (!chosen || !loser.data) return;
    setBusy(true);
    try {
      const result = await mergeRecords(winner.object_type, winner.id, chosen);
      crmChanged();
      toast.success('Duplicate merged', describeMergeResult(winner, result.winner, result.associations_moved));
      onMerged();
      onClose();
      setLoserId('');
    } catch (e) {
      toast.error('Nothing was merged', (e as ApiClientError).body.message);
    } finally {
      setBusy(false);
    }
  };

  const moving = plan?.moves.filter((move) => move.status === 'moves') ?? [];
  const staying = plan?.moves.filter((move) => move.status !== 'moves') ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Merge a duplicate"
      description={`${winner.display_name} survives. Below is every value that differs and every link that will move, before anything is written.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={blocked} onClick={() => { void submit(); }}>
            Merge into {winner.display_name}
          </Button>
        </>
      }
    >
      <div className="crm-form">
        <div className="crm-mergepair">
          <div className="crm-mergepair__side">
            <Badge tone="success" size="sm">Survives</Badge>
            <strong>{winner.display_name}</strong>
            {primaryCompany(winner) && <span className="crm-muted">{primaryCompany(winner)?.display_name}</span>}
            <span className="u-mono crm-muted">{winner.id}</span>
          </div>
          <ArrowLeftIcon size={18} />
          <div className="crm-mergepair__side">
            <Badge tone="warning" size="sm">Merged away</Badge>
            {loser.data ? (
              <>
                <strong>{loser.data.display_name}</strong>
                {primaryCompany(loser.data) && <span className="crm-muted">{primaryCompany(loser.data)?.display_name}</span>}
                <span className="u-mono crm-muted">{loser.data.id}</span>
              </>
            ) : candidate ? (
              <>
                <strong>{candidate.display_name}</strong>
                <span className="u-mono crm-muted">{candidate.id}</span>
              </>
            ) : (
              <RecordPicker
                id="merge-loser"
                objectType={winner.object_type}
                value={loserId}
                onChange={setLoserId}
                label="The duplicate to merge away"
                exclude={[winner.id]}
              />
            )}
          </div>
        </div>

        {chosen && loser.error && (
          <Banner tone="danger" compact title="The duplicate could not be read">{loser.error.body.message}</Banner>
        )}
        {chosen && !loser.error && loser.loading && !plan && <SkeletonText lines={4} />}

        {conflict && (
          <Banner tone="warning" title={`These ${typeLabel(winner.object_type)}s belong to different accounts`}>
            <p className="crm-mergewarn">
              {winner.display_name} is {conflict.winner.display_name}’s; the duplicate is {conflict.loser.display_name}’s.
              Merging moves {conflict.loser.display_name}’s link onto the survivor, so it would show under both accounts.
            </p>
            <Checkbox
              checked={acknowledged}
              onChange={setAcknowledged}
              label="They are the same record — merge anyway"
            />
          </Banner>
        )}

        {plan && (
          <>
            <section className="crm-mergesec" aria-label="Properties that differ">
              <h3 className="crm-mergesec__title">Properties that differ · {plan.rows.length}</h3>
              {plan.rows.length === 0 ? (
                <p className="crm-mergesec__empty">Every value the duplicate holds is already on the survivor. Nothing changes on the property side.</p>
              ) : (
                <div className="crm-mergetable__wrap">
                  <table className="crm-mergetable">
                    <thead>
                      <tr>
                        <th scope="col">Property</th>
                        <th scope="col">Survives</th>
                        <th scope="col">Merged away</th>
                        <th scope="col">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((row) => (
                        <tr key={row.property.name} className={`is-${row.outcome}`}>
                          <th scope="row">{row.property.label}</th>
                          {/* Two stamps side by side are compared as dates,
                              never as "last week vs 6 months ago". */}
                          <td className={row.outcome === 'filled' || row.outcome === 'newest' ? (isEmpty(row.winner) ? '' : 'is-loses') : 'is-survives'}>
                            <ValueView property={row.property} value={row.winner} users={users} compact={mergeCellCompact(row.property)} />
                          </td>
                          <td className={row.outcome === 'filled' || row.outcome === 'newest' || row.outcome === 'combined' ? 'is-survives' : 'is-loses'}>
                            <ValueView property={row.property} value={row.loser} users={users} compact={mergeCellCompact(row.property)} />
                          </td>
                          <td><Badge tone={OUTCOME_LABEL[row.outcome].tone} size="sm">{OUTCOME_LABEL[row.outcome].label}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="crm-mergesec" aria-label="Associations that move">
              <h3 className="crm-mergesec__title">Associations · {moving.length} move across</h3>
              {plan.moves.length === 0 ? (
                <p className="crm-mergesec__empty">The duplicate is not linked to anything, so no relationship moves.</p>
              ) : (
                <ul className="crm-mergemoves">
                  {[...moving, ...staying].map(({ edge, status }) => (
                    <li key={edge.id} className={`crm-mergemoves__row${conflict && edge.record_id === conflict.loser.record_id ? ' is-conflict' : ''}`}>
                      <Glyph name={edge.object_type} size={13} />
                      <span className="crm-mergemoves__name">{edge.display_name}</span>
                      <Badge tone="neutral" size="sm">{edge.label}</Badge>
                      <span className="u-spacer" />
                      {status === 'moves' && (
                        <Badge tone={conflict && edge.record_id === conflict.loser.record_id ? 'warning' : 'purple'} size="sm">Moves across</Badge>
                      )}
                      {status === 'already_linked' && <Badge tone="neutral" size="sm">Already linked</Badge>}
                      {status === 'self' && <Badge tone="neutral" size="sm">Link between the two goes</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

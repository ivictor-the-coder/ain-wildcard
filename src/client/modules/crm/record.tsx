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
  Avatar, Badge, Banner, Button, Card, Checkbox, Collapsible, ConfirmDialog, EmptyState, ErrorState,
  Icons, IconButton, Inline, MenuButton, Modal, Page, Pill, PillGroup, Select, Skeleton, SkeletonText,
  Spinner, Switch, Tooltip, AlertTriangleIcon, ArrowLeftIcon, RotateCcwIcon, humanize, iconByName,
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
  useAssociationTypes, useProperties, useRecord, useSchema, useSimilar, useTimeline, useUserIndex,
  useUsers,
  type AssociationSummary, type CrmRecord, type ObjectTypeDef, type PropertyDef, type TimelineItem,
} from './api';
import { InlineProperty, LogActivityDialog, RecordFormDialog, activityMeta } from './dialogs';
import { RecordPicker, UserChip, ValueView } from './values';
import { listHref, recordHref } from './list';

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
  const similar = useSimilar(objectType, id);
  const associationTypes = useAssociationTypes();

  const [kinds, setKinds] = useState<TimelineItem['kind'][]>([]);
  const [rollUp, setRollUp] = useState(true);
  const timeline = useTimeline(objectType, id, kinds, rollUp);

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

  const objectDef = useMemo<ObjectTypeDef | undefined>(
    () => schema.data?.object_types.find((t) => t.name === objectType) as ObjectTypeDef | undefined,
    [schema.data, objectType],
  );
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
    if (!data || objectType === 'company') return null;
    const edges = (data.associations ?? []).filter(
      (edge) => edge.object_type === 'company' && edge.association_type !== 'activity_to_record',
    );
    return edges.find((edge) => edge.is_primary) ?? edges[0] ?? null;
  }, [data, objectType]);

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
  const associations = data.associations ?? [];
  const byType = new Map<string, AssociationSummary[]>();
  for (const edge of associations) {
    if (edge.association_type === 'activity_to_record') continue;
    const arr = byType.get(edge.object_type) ?? [];
    arr.push(edge);
    byType.set(edge.object_type, arr);
  }
  const duplicates = similar.data?.data ?? [];
  const linkTargets = (schema.data?.object_types ?? []).filter((t) => t.category === 'record');
  const newLinkTarget = linkTargets.find((t) => t.name === linkingNew) ?? null;
  const typeLabel = (name: string): string =>
    (schema.data?.object_types.find((t) => t.name === name)?.label ?? humanize(name)).toLowerCase();

  const actions: MenuSection[] = [{
    id: 'record',
    items: [
      { id: 'copy', label: 'Copy record id', icon: <Icons.copy size={14} />, onSelect: () => { void navigator.clipboard?.writeText(data.id); toast.info('Record id copied', data.id); } },
      { id: 'merge', label: 'Merge a duplicate into this record', icon: <Icons.layers size={14} />, onSelect: () => setMerging(data) },
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
          Created {f.date(data.created)} · last touched {f.relative(data.updated)}
          {data.merged_from ? ` · reached through merged id ${data.merged_from}` : ''}
        </>
      }
      actions={
        <Inline gap={3}>
          {ACTIVITY_KINDS.map((kind) => (
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
              </div>
            </div>
            <div className="crm-identity__owner">
              <span className="crm-prop__label">Owner</span>
              <div className="crm-identity__ownerctl">
                <Select
                  value={data.owner_id ?? ''}
                  onChange={(next) => { void setOwner(next || null); }}
                  options={[{ value: '', label: 'Unassigned' }, ...(users.data?.data ?? []).map((u) => ({ value: u.id, label: u.name }))]}
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
            {groups.map(([group, list], index) => {
              const visible = list.filter((p) => showEmpty || (data.properties[p.name] !== null && data.properties[p.name] !== undefined && data.properties[p.name] !== ''));
              if (!visible.length) return null;
              return (
                <Collapsible key={group} title={`${group} · ${visible.length}`} defaultOpen={index < 2}>
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
                </Collapsible>
              );
            })}
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
            <Tooltip content="Roll up everything logged against this record’s contacts, deals and tickets">
              <span><Switch size="sm" checked={rollUp} onChange={setRollUp} label="Roll up" /></span>
            </Tooltip>
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
            <EmptyState
              title="Nothing on this timeline yet"
              body={`Log the first call or write a note and it lands here, next to every property change ${data.display_name} goes through.`}
              action={<Button variant="primary" iconLeft={<Icons.note size={14} />} onClick={() => setLogging('note')}>Write a note</Button>}
            />
          )}

          {!timeline.error && timeline.items.length > 0 && (
            <ol className="crm-timeline">
              {timeline.items.map((item) => (
                <li className="crm-tl" key={`${item.kind}:${item.id}:${item.cursor}`}>
                  <span className={`crm-tl__icon crm-tl__icon--${item.kind}`}><Glyph name={item.icon} size={14} /></span>
                  <div className="crm-tl__body">
                    <div className="crm-tl__head">
                      <span className="crm-tl__title">{item.title}</span>
                      <Badge tone={KIND_TONE[item.kind]} size="sm">{humanize(item.kind)}</Badge>
                      <span className="u-spacer" />
                      <Tooltip content={f.dateTime(item.at)}>
                        <span className="crm-tl__when">{f.relative(item.at)}</span>
                      </Tooltip>
                    </div>
                    {item.body && <p className="crm-tl__text">{item.body}</p>}
                    <div className="crm-tl__foot">
                      {item.actor_id
                        ? <UserChip id={item.actor_id} user={userIndex.get(item.actor_id)} size={16} />
                        : <span className="crm-muted">{humanize(item.actor_type)}</span>}
                      {item.via && (
                        <>
                          <span className="crm-muted">·</span>
                          <a className="crm-link" href={recordHref(item.via.object_type, item.via.id)}>
                            via {item.via.display_name}
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
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
            title="Associations"
            description="Labelled both ways, with the primary link marked"
            actions={
              <IconButton
                size="sm"
                label="Link another record"
                icon={<Icons.plus size={14} />}
                onClick={() => setLinking(linkTargets.find((t) => t.name !== objectType)?.name ?? 'company')}
              />
            }
          >
            {byType.size === 0 && (
              <EmptyState
                size="sm"
                inline
                illustration={null}
                title="Not linked to anything yet"
                body="Associations are what make a company page show its contacts and its deals."
                action={
                  <Button size="sm" variant="secondary" onClick={() => setLinking(linkTargets.find((t) => t.name !== objectType)?.name ?? 'company')}>
                    Link a record
                  </Button>
                }
              />
            )}
            {[...byType.entries()].map(([type, edges]) => (
              <div className="crm-assoc" key={type}>
                <div className="crm-assoc__head">
                  <Glyph name={schema.data?.object_types.find((t) => t.name === type)?.icon ?? 'link'} size={13} />
                  <span>{schema.data?.object_types.find((t) => t.name === type)?.plural_label ?? humanize(type)}</span>
                  <Badge tone="neutral" size="sm">{edges.length}</Badge>
                  <span className="u-spacer" />
                  <IconButton size="sm" label={`Link a ${type}`} icon={<Icons.plus size={13} />} onClick={() => setLinking(type)} />
                </div>
                {edges.map((edge) => (
                  <div className="crm-assoc__row" key={edge.id}>
                    <a className="crm-link u-truncate" href={recordHref(edge.object_type, edge.record_id)}>
                      {edge.display_name}
                    </a>
                    <Badge tone="neutral" size="sm">{edge.label}</Badge>
                    {(() => {
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
            ))}
          </Card>

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
              <div className="crm-dupe" key={match.record.id}>
                <div className="crm-dupe__head">
                  <a className="crm-link u-truncate" href={recordHref(match.record.object_type, match.record.id)}>
                    {match.record.display_name}
                  </a>
                  {/* The scorer already answers on a 0–100 scale. */}
                  <Badge tone={confidence(match.score) > 80 ? 'danger' : 'warning'} size="sm">
                    {confidence(match.score)}% match
                  </Badge>
                </div>
                <p className="crm-dupe__why">{match.reasons.join(' · ')}</p>
                <Button size="sm" variant="secondary" iconLeft={<Icons.layers size={13} />} onClick={() => setMerging(match.record)}>
                  Merge into this record
                </Button>
              </div>
            ))}
          </Card>
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

      <MergeDialog
        open={!!merging}
        onClose={() => setMerging(null)}
        winner={data}
        candidate={merging && merging.id !== data.id ? merging : null}
        onMerged={() => { record.refetch(); similar.refetch(); timeline.refetch(); }}
      />

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

/* ------------------------------- merge dialog ----------------------------- */

function MergeDialog({ open, onClose, winner, candidate, onMerged }: {
  open: boolean;
  onClose: () => void;
  winner: CrmRecord;
  candidate: CrmRecord | null;
  onMerged: () => void;
}) {
  const toast = useToast();
  const [loserId, setLoserId] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = candidate?.id ?? loserId;

  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const result = await mergeRecords(winner.object_type, winner.id, chosen);
      crmChanged();
      toast.success(
        'Duplicate merged',
        `${result.properties_filled.length} blank ${result.properties_filled.length === 1 ? 'property was' : 'properties were'} filled in and ${result.associations_moved} associations moved across. The old id still resolves here.`,
      );
      onMerged();
      onClose();
      setLoserId('');
    } catch (e) {
      toast.error('Nothing was merged', (e as ApiClientError).body.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Merge a duplicate"
      description={`${winner.display_name} survives. The duplicate's values fill its blanks, its associations and activities move across, and its id keeps resolving here.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!chosen} onClick={() => { void submit(); }}>
            Merge into {winner.display_name}
          </Button>
        </>
      }
    >
      <div className="crm-form">
        {candidate ? (
          <div className="crm-mergepair">
            <div className="crm-mergepair__side">
              <Badge tone="success" size="sm">Survives</Badge>
              <strong>{winner.display_name}</strong>
              <span className="u-mono crm-muted">{winner.id}</span>
            </div>
            <ArrowLeftIcon size={18} />
            <div className="crm-mergepair__side">
              <Badge tone="warning" size="sm">Merged away</Badge>
              <strong>{candidate.display_name}</strong>
              <span className="u-mono crm-muted">{candidate.id}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="crm-mergepair__side">
              <Badge tone="success" size="sm">Survives</Badge>
              <strong>{winner.display_name}</strong>
              <span className="u-mono crm-muted">{winner.id}</span>
            </div>
            <label className="crm-form__label" htmlFor="merge-loser">The duplicate to merge away</label>
            <RecordPicker
              id="merge-loser"
              objectType={winner.object_type}
              value={loserId}
              onChange={setLoserId}
              label="The duplicate to merge away"
              exclude={[winner.id]}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

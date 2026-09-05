/**
 * What the record page decides before it draws anything.
 *
 * Five of the ten object types are activities — a note, a call, an email, a
 * meeting, a task — and an activity is not a company. Its only associations
 * are the records it was logged on; it cannot have a call logged *on it*; two
 * notes with the same subject are two notes, not a duplicate. Everything that
 * turns on that distinction lives here, pure, so the same rule reads the same
 * way on the page and in a test that never opens a browser.
 */
import type { AssociationSummary, CrmRecord, ObjectTypeDef, PropertyDef, TimelineItem, ViewDef } from './api';

/** The wildcard label the platform uses to pin an activity to a record. */
export const ACTIVITY_LINK = 'activity_to_record';

export const isActivityDef = (def: Pick<ObjectTypeDef, 'category'> | undefined): boolean =>
  def?.category === 'activity';

/**
 * The right-hand rail, grouped by the far object's type.
 *
 * On a company or a contact the activity edges are left out: the notes and
 * calls they point at are the timeline in the middle column, and listing 29 of
 * them under "Notes" in the rail would show the same thing twice. On a note
 * they are the *only* edges there are, and dropping them is how the rail came
 * to say "Not linked to anything yet" beside a timeline saying the opposite.
 */
export function groupAssociations(
  edges: AssociationSummary[],
  activityPage: boolean,
): Map<string, AssociationSummary[]> {
  const byType = new Map<string, AssociationSummary[]>();
  for (const edge of edges) {
    if (!activityPage && edge.association_type === ACTIVITY_LINK) continue;
    const arr = byType.get(edge.object_type) ?? [];
    arr.push(edge);
    byType.set(edge.object_type, arr);
  }
  return byType;
}

/** The records an activity was logged on, the one it was logged from first. */
export const loggedOnTargets = (edges: AssociationSummary[]): AssociationSummary[] =>
  edges
    .filter((edge) => edge.association_type === ACTIVITY_LINK)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.created - b.created);

/** Ids of the activities attached to this record directly, by its own edges. */
export const directActivityIds = (edges: AssociationSummary[]): Set<string> =>
  new Set(edges.filter((edge) => edge.association_type === ACTIVITY_LINK).map((edge) => edge.record_id));

/**
 * Where the timeline says an item came from. The roll-up prefers the edge
 * that names a neighbour, so a note logged on both Carmen and her company came
 * back on Carmen's own page as "via Andina Envases". If the record's own edges
 * reach the activity, it is hers, and there is no "via" to speak of.
 */
export function viaFor(item: Pick<TimelineItem, 'record_id' | 'via'>, direct: Set<string>): TimelineItem['via'] {
  return direct.has(item.record_id) ? null : item.via;
}

/**
 * The label badge on a rail row earns its place when it says something the
 * section heading does not: "Employs" under Contacts, "Requested by" under
 * Contacts on a ticket. "Deals" under a heading reading Deals is noise.
 */
export function showsAssociationLabel(edge: Pick<AssociationSummary, 'label'>, sectionLabel: string, cardTitle?: string): boolean {
  const label = edge.label.trim().toLowerCase();
  if (!label) return false;
  if (label === sectionLabel.trim().toLowerCase()) return false;
  if (cardTitle && label === cardTitle.trim().toLowerCase()) return false;
  return true;
}

/**
 * A primary star means "this is the contact's main company". On the wildcard
 * activity link it means nothing, and a control that means nothing must not be
 * offered.
 */
export const canMarkPrimary = (edge: Pick<AssociationSummary, 'association_type'>): boolean =>
  edge.association_type !== ACTIVITY_LINK;

/**
 * The merge preview lays two values side by side. "last week vs 6 months ago"
 * is a comparison of moods; the absolute stamp is what a person compares.
 */
export const mergeCellCompact = (property: Pick<PropertyDef, 'type'>): boolean =>
  property.type !== 'datetime' && property.type !== 'date';

/**
 * The header's second line for a merged-in visit. The duplicate's own name is
 * gone with the merge — the API resolves its id straight to the survivor — so
 * the sentence says what happened and keeps the id for the hover, never for
 * the prose.
 */
export function reachedThrough(record: Pick<CrmRecord, 'merged_from'>): { text: string; id: string } | null {
  if (!record.merged_from) return null;
  return { text: 'reached through a duplicate merged into this record', id: record.merged_from };
}

/**
 * Which saved views a person is shown. The checkbox on the save dialog says
 * "Share with the workspace"; unticked, the view is the author's own. The API
 * still lists it for everyone, so the screen keeps the promise itself: a view
 * is in the bar when it is shared, or when it is mine. Views with no owner
 * are the ones Ain ships with.
 */
export function visibleViews(views: ViewDef[], userId: string | null | undefined): ViewDef[] {
  return views.filter((view) => view.shared || !view.owner_id || view.owner_id === userId);
}

/**
 * `?view=` names a view that is not in the bar — deleted, or a teammate's
 * private one. The list still has to open somewhere, and the address bar
 * should not keep pointing at a view that is not there.
 */
export function staleViewParam(viewId: string, views: ViewDef[], loaded: boolean): boolean {
  return loaded && !!viewId && !views.some((view) => view.id === viewId);
}

/** The state a list is in before its grid can be drawn. */
export type ListBootPhase = 'loading' | 'missing_type' | 'error' | 'ready';

/**
 * A slug the object model does not know is not a server failure. The schema is
 * the authority: once it has answered and the type is not in it, the answer is
 * "no such object" with a door to the data model — not a red banner quoting a
 * request id and a Try again that re-issues the same 404.
 */
export function listBootPhase(input: {
  schemaLoaded: boolean;
  typeKnown: boolean;
  schemaError: boolean;
  propertiesError: boolean;
}): ListBootPhase {
  if (input.schemaLoaded && !input.typeKnown) return 'missing_type';
  if (input.schemaError || input.propertiesError) return 'error';
  if (!input.schemaLoaded) return 'loading';
  return 'ready';
}

/* ------------------------------ stage history ----------------------------- */

export interface StageSpell {
  object: 'stage_spell';
  pipeline: string;
  pipeline_label: string;
  stage: string;
  stage_label: string;
  probability: number | null;
  is_closed: boolean;
  is_won: boolean;
  entered_at: number;
  exited_at: number | null;
  duration_ms: number;
  days_in_stage: number;
  is_current: boolean;
  moved_by: string | null;
  source: string | null;
  moved_to: string | null;
}

/** "9 days in Escalated" — the one figure a queue owner reads first. */
export function timeInStage(spell: Pick<StageSpell, 'days_in_stage' | 'stage_label' | 'is_current'>, plural: (n: number, word: string) => string): string {
  const span = spell.days_in_stage === 0 ? 'Less than a day' : plural(spell.days_in_stage, 'day');
  return `${span} in ${spell.stage_label}`;
}

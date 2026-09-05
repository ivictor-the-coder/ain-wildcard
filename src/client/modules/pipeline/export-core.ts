/**
 * The deals table as a file.
 *
 * The CRM's contact and company lists export what they show; the deal table
 * did not, so the one set a sales leader most often wants in a spreadsheet —
 * this quarter's commit, sorted by amount — had to be retyped. The values
 * here are the stored ones, in the shape the CRM export uses: money as a
 * decimal number, a close date as an ISO-8601 day, picklists and owners as the
 * labels the grid shows. `$80,000.00` is neither a number nor a currency a
 * spreadsheet can sum.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string;
}

/** The slice of a deal record the export reads. */
export interface ExportableDeal {
  id: string;
  display_name: string;
  owner_id: string | null;
  properties: Record<string, unknown>;
}

export interface ExportContext {
  /** Whether the table is showing every pipeline, so the pipeline is a column. */
  allMode: boolean;
  /** Minor units → the major-unit decimal the workspace's currency uses. */
  major: (minor: number) => number;
  /** The workspace's clock, for the days-in-stage column. */
  now: number;
  accountName: (deal: ExportableDeal) => string;
  pipelineLabel: (deal: ExportableDeal) => string;
  stageLabel: (deal: ExportableDeal) => string;
  ownerName: (id: string | null) => string;
}

const DAY_MS = 86_400_000;

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** A stored calendar day, written as the day it was stored as. */
export const isoDay = (ts: number | null): string => (ts === null ? '' : new Date(ts).toISOString().slice(0, 10));

/** A stored instant, written in full so a spreadsheet can read it back exactly. */
export const isoInstant = (ts: number | null): string => (ts === null ? '' : new Date(ts).toISOString());

/** The columns of the deal table, in the order the table shows them. */
export function dealExportColumns(ctx: ExportContext): CsvColumn<ExportableDeal>[] {
  const money = (value: unknown): string => {
    const minor = num(value);
    return minor === null ? '' : String(ctx.major(minor));
  };
  return [
    { header: 'Id', value: (row) => row.id },
    { header: 'Deal', value: (row) => row.display_name },
    { header: 'Account', value: (row) => ctx.accountName(row) },
    ...(ctx.allMode ? [{ header: 'Pipeline', value: (row: ExportableDeal) => ctx.pipelineLabel(row) }] : []),
    { header: 'Stage', value: (row) => ctx.stageLabel(row) },
    { header: 'Amount', value: (row) => money(row.properties.amount) },
    { header: 'Probability', value: (row) => text(num(row.properties.probability) ?? '') },
    { header: 'Weighted', value: (row) => money(row.properties.weighted_amount) },
    { header: 'Close date', value: (row) => isoDay(num(row.properties.close_date)) },
    { header: 'Owner', value: (row) => ctx.ownerName(row.owner_id) },
    { header: 'Forecast category', value: (row) => text(row.properties.forecast_category) },
    { header: 'Status', value: (row) => text(row.properties.deal_status) },
    {
      header: 'Days in stage',
      value: (row) => {
        const entered = num(row.properties.stage_entered_at);
        return entered === null ? '' : String(Math.floor((ctx.now - entered) / DAY_MS));
      },
    },
    { header: 'Stage entered', value: (row) => isoInstant(num(row.properties.stage_entered_at)) },
  ];
}

/** The header row and one line per deal, ready for the CSV writer. */
export function dealCsv<T>(rows: T[], columns: CsvColumn<T>[]): { headers: string[]; lines: string[][] } {
  return {
    headers: columns.map((column) => column.header),
    lines: rows.map((row) => columns.map((column) => column.value(row))),
  };
}

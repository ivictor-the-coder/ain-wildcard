import { formatMoney } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/time';
import type { Ctx } from '../../kernel/context';
import type { PropertyIndex } from './filter';
import type { PropertyDef, PropertyValue } from './types';

/**
 * Property values as a person reads them.
 *
 * Everything the CRM stores is stored to be computed with, not to be read:
 * money is integer minor units, an instant is epoch milliseconds, an enum is
 * its machine value and an owner is a user id. Printing any of those raw is
 * how a timeline ends up reporting that an $80,000 deal went from 8000000 to
 * 8000001 — so every human-facing string the CRM produces comes through here,
 * the one place that knows the workspace's locale, timezone and currency.
 *
 * An instance is request-scoped: it memoises the workspace settings and the
 * handful of names a page resolves, and is thrown away with the response, so
 * a renamed teammate is never shown under their old name.
 */

interface WorkspaceFormat {
  locale: string;
  timeZone: string;
  currency: string;
}

/** Digits a CRM number can carry before the reader stops caring. */
const NUMBER_FRACTION_DIGITS = 6;

export class ValueFormatter {
  private workspace: WorkspaceFormat | null = null;
  private readonly names = new Map<string, string>();
  private decimal: Intl.NumberFormat | null = null;

  constructor(private readonly ctx: Ctx, private readonly orgId: string) {}

  get settings(): WorkspaceFormat {
    if (!this.workspace) {
      const row = this.ctx.db.get<{ locale: string; timezone: string; default_currency: string }>(
        `SELECT locale, timezone, default_currency FROM orgs WHERE id = ?`, this.orgId,
      );
      this.workspace = {
        locale: row?.locale || 'en-US',
        timeZone: row?.timezone || 'UTC',
        currency: row?.default_currency || 'usd',
      };
    }
    return this.workspace;
  }

  /**
   * One value, formatted through its property's type. `null` means there is
   * nothing to show — the caller decides whether that reads as "empty".
   *
   * Both shapes of a value arrive here: the typed value on a live record, and
   * the text the audit trail stored for it. They format identically, which is
   * what keeps a record panel and its history telling the same story.
   */
  format(prop: PropertyDef | null, value: PropertyValue): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) {
      const parts = value.map((item) => this.format(prop, item)).filter((part): part is string => part !== null);
      return parts.length ? parts.join(', ') : null;
    }
    if (typeof value === 'object') return JSON.stringify(value);

    const text = String(value);
    if (!prop) return text;
    switch (prop.type) {
      case 'currency': return this.money(prop, text);
      case 'number': return this.number(text);
      case 'date': case 'datetime': return this.instant(prop.type, text);
      case 'bool': return this.boolean(text);
      case 'user': return this.user(text);
      case 'reference': return this.reference(text);
      default: return prop.options.length ? this.option(prop, text) : text;
    }
  }

  /** Every set property of a record, formatted, keyed by property name. */
  record(index: PropertyIndex, properties: Record<string, PropertyValue>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(properties)) {
      const shown = this.format(index.get(name) ?? null, value);
      if (shown !== null) out[name] = shown;
    }
    return out;
  }

  /** A teammate's name for their user id. Falls back to the email, then the id. */
  user(id: string): string {
    const cached = this.names.get(`u:${id}`);
    if (cached !== undefined) return cached;
    const row = this.ctx.db.get<{ name: string; email: string }>(`SELECT name, email FROM users WHERE id = ?`, id);
    const name = row?.name || row?.email || id;
    this.names.set(`u:${id}`, name);
    return name;
  }

  private reference(id: string): string {
    const cached = this.names.get(`r:${id}`);
    if (cached !== undefined) return cached;
    const row = this.ctx.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND id = ?`, this.orgId, id,
    );
    const name = row?.display_name || id;
    this.names.set(`r:${id}`, name);
    return name;
  }

  private money(prop: PropertyDef, text: string): string {
    const amount = Number(text.replace(/[\s,]/g, ''));
    if (!Number.isFinite(amount)) return text;
    return formatMoney(
      { amount: Math.round(amount), currency: prop.currency || this.settings.currency },
      { locale: this.settings.locale },
    );
  }

  private number(text: string): string {
    const value = Number(text.replace(/[\s,]/g, ''));
    if (!Number.isFinite(value)) return text;
    if (!this.decimal) {
      this.decimal = new Intl.NumberFormat(this.settings.locale, { maximumFractionDigits: NUMBER_FRACTION_DIGITS });
    }
    return this.decimal.format(value);
  }

  /**
   * A `date` is a calendar date stored at UTC midnight, so it is read back in
   * UTC: rendering "close date 21 September" through a UTC-4 workspace would
   * move it to the 20th. A `datetime` is a real instant and belongs in the
   * workspace's own timezone, which is where the person reading it lives.
   */
  private instant(type: 'date' | 'datetime', text: string): string {
    const ts = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
    if (!Number.isFinite(ts)) return text;
    return type === 'date'
      ? formatDate(ts, { locale: this.settings.locale, timeZone: 'UTC' })
      : formatDateTime(ts, { locale: this.settings.locale, timeZone: this.settings.timeZone });
  }

  private boolean(text: string): string {
    return text === 'true' || text === '1' ? 'Yes' : 'No';
  }

  /** Enum values print as their option label, one save's worth at a time. */
  private option(prop: PropertyDef, text: string): string {
    return text.split(', ')
      .map((part) => prop.options.find((option) => option.value === part)?.label ?? part)
      .join(', ');
  }
}

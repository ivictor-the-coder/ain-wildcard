/**
 * Reading and writing credit grants, their ledger and everything credits put on
 * an invoice.
 *
 * The rules this file exists to keep:
 *
 *  - A balance is `SUM(delta_micro)` over the ledger. There is no other source.
 *  - Every write appends; nothing is updated in place, so the history of a
 *    grant is the ledger and the ledger is complete.
 *  - A grant and the invoice line that paid for it are written in one
 *    transaction, and a settled usage period always produces lines whose
 *    amounts sum back to what the period would have cost with no credits.
 *  - One usage period settles once. The identity of a settlement is the window
 *    it covers, not a string the caller happened to pass, because the caller's
 *    string is exactly what changes when a retry goes wrong.
 *
 * As in metering, no `*_micro` column is ever read as a JavaScript number: they
 * are projected as text and folded in BigInt, and a write that would not
 * survive the round trip is refused with a 400 rather than crashing on a bind.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson, type Bindable } from '../../kernel/db';
import { badRequest, conflict, isApiError, notFound } from '../../../shared/errors';
import { newId } from '../../../shared/ids';
import { allocate, formatMoney, money, mulFraction } from '../../../shared/money';
import { DAY, addInterval, interval, periodFor, type Interval } from '../../../shared/time';
import {
  assertStorableMicro, bigOf, microToDecimal, microToNumber, microToWholeUnits, parseMicro, unitsToMicro,
} from '../metering/units';
import {
  BURN_ORDER, applicabilityKey, applicableTo, describeApplicability, isLive, orderCandidates,
  unitsWorthBurning, type Candidate,
} from './burn';
import {
  ALL_CHARGES, type Applicability, type BalanceBucket, type BillableItem, type BillableItemKind,
  type BillableItemStatus, type ChargeTarget, type CreditApplication, type CreditBalance,
  type CreditGrant, type CreditKind, type GrantInput, type GrantStatus, type LedgerEntry,
  type LedgerEntryType, type Settlement, type SettlementSkip, type SettlementStatus,
  type SettleUsageInput, type SkipSettlementInput, type TierBasis, type TopUpInput, type TopUpResult,
} from './types';
import type { TrueUpRequest, TrueUpResult } from '../metering/types';

const MICRO = 1_000_000n;

/**
 * The one thing credits needs from invoicing: raise the charge an account owes
 * right now. Declared structurally rather than imported so credits keeps
 * working — holding the grant instead of releasing it — in a build where no
 * invoicing module is installed.
 */
interface PurchaseCharger {
  customer(orgId: string, id: string): { id: string; currency: string } | null;
  invoiceNow(orgId: string, customerId: string, opts?: { subscription?: string | null }): { id: string };
}

interface GrantRow {
  id: string; org_id: string; customer_id: string; name: string; category: CreditGrant['category'];
  kind: CreditKind; currency: string; meter_id: string | null; unit_label: string | null;
  amount_micro: string; applicability: string; effective_at: number; expires_at: number | null;
  priority: number; rollover: CreditGrant['rollover']; rollover_cap_micro: string | null;
  source: CreditGrant['source']; source_ref: string | null; metadata: string;
  created: number; updated: number;
}

/**
 * Spelled out rather than `g.*` because two of these columns are micro-units:
 * a $90m prepaid pool passes 2^53 micro and `SELECT *` would make every read of
 * that grant throw for the rest of its life.
 */
const GRANT_COLUMNS = `g.id, g.org_id, g.customer_id, g.name, g.category, g.kind, g.currency,
  g.meter_id, g.unit_label, CAST(g.amount_micro AS TEXT) AS amount_micro, g.applicability,
  g.effective_at, g.expires_at, g.priority, g.rollover,
  CAST(g.rollover_cap_micro AS TEXT) AS rollover_cap_micro, g.source, g.source_ref, g.metadata,
  g.created, g.updated`;

/** A grant row joined to the ledger facts that define its state. */
interface GrantState extends GrantRow {
  balance_micro: string;
  has_void: number;
  has_expiry: number;
  has_rollover: number;
  /** 1 while the purchase line that bought this grant is still unbilled. */
  awaiting_payment: number;
}

interface LedgerRow {
  id: string; org_id: string; grant_id: string; customer_id: string; seq: number;
  type: LedgerEntryType; delta_micro: string; balance_after_micro: string; currency: string;
  kind: CreditKind; reason: string; ref_type: string | null; ref_id: string | null;
  period_start: number | null; period_end: number | null; metadata: string; created: number;
}

const LEDGER_COLUMNS = `id, org_id, grant_id, customer_id, seq, type,
  CAST(delta_micro AS TEXT) AS delta_micro, CAST(balance_after_micro AS TEXT) AS balance_after_micro,
  currency, kind, reason, ref_type, ref_id, period_start, period_end, metadata, created`;

interface ItemRow {
  id: string; org_id: string; customer_id: string; settlement_id: string | null; grant_id: string | null;
  kind: BillableItemKind; description: string; currency: string; amount: number; billed_amount: number;
  credit_applied: number; quantity_micro: string; unit_label: string | null; price_id: string | null;
  meter_id: string | null; period_start: number | null; period_end: number | null;
  status: BillableItemStatus; invoice_id: string | null; invoice_item_id: string | null;
  metadata: string; created: number; updated: number;
}

const ITEM_COLUMNS = `id, org_id, customer_id, settlement_id, grant_id, kind, description, currency,
  amount, billed_amount, credit_applied, CAST(quantity_micro AS TEXT) AS quantity_micro, unit_label,
  price_id, meter_id, period_start, period_end, status, invoice_id, invoice_item_id, metadata,
  created, updated`;

interface SettlementRow {
  id: string; org_id: string; customer_id: string; meter_id: string | null; price_id: string;
  currency: string; period_start: number; period_end: number; quantity_micro: string;
  billed_quantity: number; covered_quantity_micro: string; charged_quantity: number;
  full_amount: number; covered_amount: number; charged_amount: number;
  unit_credit_amount: number; monetary_credit_amount: number; idem_key: string;
  status: SettlementStatus; superseded_by: string | null; skip_reason: string | null;
  skip_detail: string | null; subscription_id: string | null; subscription_item_id: string | null;
  prior_quantity_micro: string; prior_amount: number;
  cycle_start: number | null; cycle_end: number | null; cycle_source: string | null;
  basis_settlements: string | null;
  created: number;
}

const SETTLEMENT_COLUMNS = `id, org_id, customer_id, meter_id, price_id, currency, period_start,
  period_end, CAST(quantity_micro AS TEXT) AS quantity_micro, billed_quantity,
  CAST(covered_quantity_micro AS TEXT) AS covered_quantity_micro, charged_quantity, full_amount,
  covered_amount, charged_amount, unit_credit_amount, monetary_credit_amount, idem_key,
  status, superseded_by, skip_reason, skip_detail, subscription_id, subscription_item_id,
  CAST(prior_quantity_micro AS TEXT) AS prior_quantity_micro, prior_amount,
  cycle_start, cycle_end, cycle_source, basis_settlements, created`;

/**
 * A grant's whole state in one row.
 *
 * The second join is what stops a customer holding credit nobody was billed
 * for: a top-up's grant points at the purchase line that bought it, and while
 * that line is still sitting in the outbox unbilled the grant is held. The join
 * adds at most one row per grant (`p.id` is the primary key), so the ledger
 * folds below are unaffected.
 */
const GRANT_STATE_SQL = `
  SELECT ${GRANT_COLUMNS},
         CAST(COALESCE(SUM(l.delta_micro), 0) AS TEXT) AS balance_micro,
         COALESCE(MAX(CASE WHEN l.type = 'void' THEN 1 ELSE 0 END), 0) AS has_void,
         COALESCE(MAX(CASE WHEN l.type = 'expiry' THEN 1 ELSE 0 END), 0) AS has_expiry,
         COALESCE(MAX(CASE WHEN l.type = 'rollover_out' THEN 1 ELSE 0 END), 0) AS has_rollover,
         COALESCE(MAX(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END), 0) AS awaiting_payment
  FROM credit_grants g
  LEFT JOIN credit_ledger l ON l.grant_id = g.id AND l.org_id = g.org_id
  LEFT JOIN credit_billable_items p
         ON g.source = 'topup' AND p.id = g.source_ref AND p.org_id = g.org_id`;

export interface GrantListFilter {
  customer?: string;
  status?: GrantStatus;
  category?: CreditGrant['category'];
  kind?: CreditKind;
  currency?: string;
  meter?: string;
  limit?: number;
}

export interface ItemListFilter {
  customer?: string;
  status?: BillableItemStatus;
  kind?: BillableItemKind;
  settlement?: string;
  limit?: number;
}

export interface SettlementListFilter {
  customer?: string;
  /** `all` by default: a refused period is not hidden from the list. */
  status?: SettlementStatus | 'all';
  price?: string;
  subscription?: string;
  limit?: number;
}

export class Credits {
  /** Meter names for the copy on grants and balances; ids never change. */
  private readonly meterNames = new Map<string, string>();

  constructor(private readonly ctx: Ctx) {}

  private meterLabels(orgId: string, ids: string[]): Record<string, string> {
    for (const id of ids) {
      if (this.meterNames.has(id)) continue;
      this.meterNames.set(id, this.ctx.svc.metering.meter(orgId, id)?.name ?? id);
    }
    return Object.fromEntries(ids.map((id) => [id, this.meterNames.get(id) ?? id]));
  }

  /* -------------------------------- grants -------------------------------- */

  grants(orgId: string, filter: GrantListFilter = {}): CreditGrant[] {
    const clauses = ['g.org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.customer) { clauses.push('g.customer_id = ?'); params.push(filter.customer); }
    if (filter.category) { clauses.push('g.category = ?'); params.push(filter.category); }
    if (filter.kind) { clauses.push('g.kind = ?'); params.push(filter.kind); }
    if (filter.currency) { clauses.push('g.currency = ?'); params.push(filter.currency); }
    if (filter.meter) { clauses.push('g.meter_id = ?'); params.push(filter.meter); }
    const rows = this.ctx.db.all<GrantState>(
      `${GRANT_STATE_SQL} WHERE ${clauses.join(' AND ')} GROUP BY g.id
       ORDER BY (g.expires_at IS NULL), g.expires_at ASC, g.priority ASC, g.created ASC LIMIT ?`,
      ...params, Math.min(filter.limit ?? 100, 500),
    );
    const now = this.ctx.now();
    const grants = rows.map((row) => this.hydrateGrant(row, now, orgId));
    return filter.status ? grants.filter((g) => g.status === filter.status) : grants;
  }

  grant(orgId: string, id: string): CreditGrant | null {
    const row = this.ctx.db.get<GrantState>(`${GRANT_STATE_SQL} WHERE g.org_id = ? AND g.id = ? GROUP BY g.id`, orgId, id);
    return row ? this.hydrateGrant(row, this.ctx.now(), orgId) : null;
  }

  requireGrant(orgId: string, id: string): CreditGrant {
    const found = this.grant(orgId, id);
    if (!found) throw notFound('credit grant', id);
    return found;
  }

  createGrant(orgId: string, input: GrantInput): CreditGrant {
    return this.ctx.atomic(() => this.insertGrant(orgId, input, 'grant', input.reason));
  }

  private insertGrant(orgId: string, input: GrantInput, entryType: LedgerEntryType, reason?: string): CreditGrant {
    const now = this.ctx.now();
    const kind = input.kind ?? 'monetary';
    const currency = (input.currency ?? this.ctx.svc.core.currency(orgId)).toLowerCase();
    const amountMicro = kind === 'monetary'
      ? BigInt(assertMinorUnits(input.amount)) * MICRO
      : parseMicro(input.amount, 'amount');
    if (amountMicro <= 0n) {
      throw badRequest('parameter_invalid', 'A credit grant is for a positive amount. To take credit away, void the grant or write an adjustment.', 'amount');
    }
    assertStorableMicro(amountMicro, {
      subject: 'This grant',
      param: 'amount',
      remedy: 'Issue it as more than one grant.',
    });

    let meterId: string | null = null;
    let meterUnitLabel: string | null = null;
    if (kind === 'unit') {
      const key = input.meter ?? input.applicability?.meters?.[0] ?? null;
      if (!key) {
        throw badRequest(
          'parameter_missing',
          'A unit-denominated grant names the meter whose units it holds — a pack of telemetry events cannot pay for exported gigabytes.',
          'meter',
        );
      }
      const meter = this.ctx.svc.metering.requireMeter(orgId, key);
      meterId = meter.id;
      meterUnitLabel = meter.unit_label;
    }

    const applicability = this.resolveApplicability(orgId, normalizeApplicability(input.applicability, meterId));
    const effectiveAt = input.effective_at ?? now;
    const expiresAt = input.expires_at ?? null;
    if (expiresAt !== null && expiresAt <= effectiveAt) {
      throw badRequest('parameter_invalid', 'A grant expires after it becomes effective.', 'expires_at');
    }
    const rollover = input.rollover ?? 'none';
    if (rollover !== 'none' && expiresAt === null) {
      throw badRequest('parameter_invalid', 'Rollover happens at expiry, so a grant with a rollover policy needs an `expires_at`.', 'rollover');
    }
    const rolloverCapMicro = rollover === 'capped'
      ? assertStorableMicro(
          input.rollover_cap === undefined || input.rollover_cap === null
            ? (() => { throw badRequest('parameter_missing', 'A capped rollover needs the cap it is capped at.', 'rollover_cap'); })()
            : kind === 'monetary' ? BigInt(assertMinorUnits(input.rollover_cap)) * MICRO : parseMicro(input.rollover_cap, 'rollover_cap'),
          { subject: 'This rollover cap', param: 'rollover_cap', remedy: 'A cap above the grant itself has the same effect as `rollover: "full"`.' },
        )
      : null;

    const row: GrantRow = {
      id: input.id ?? newId('creditgrant'),
      org_id: orgId,
      customer_id: input.customer,
      name: input.name?.trim() || defaultGrantName(kind, input.category ?? 'paid'),
      category: input.category ?? 'paid',
      kind,
      currency,
      meter_id: meterId,
      unit_label: input.unit_label ?? meterUnitLabel,
      amount_micro: String(amountMicro),
      applicability: JSON.stringify(applicability),
      effective_at: effectiveAt,
      expires_at: expiresAt,
      priority: input.priority ?? 0,
      rollover,
      rollover_cap_micro: rolloverCapMicro === null ? null : String(rolloverCapMicro),
      source: input.source ?? 'manual',
      source_ref: input.source_ref ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      created: now,
      updated: now,
    };
    this.ctx.db.insert('credit_grants', { ...row, amount_micro: amountMicro, rollover_cap_micro: rolloverCapMicro });

    this.append(orgId, row, entryType, amountMicro, {
      reason: reason ?? `Granted ${describeAmount(kind, amountMicro, currency, row.unit_label)}`,
      refType: input.source === 'topup' ? 'credit_topup' : null,
      refId: input.source_ref ?? null,
    });

    if (expiresAt !== null) {
      this.ctx.enqueue(orgId, 'credits.expire_grant', { grant: row.id }, {
        runAt: expiresAt, idemKey: `credits.expire:${row.id}`,
      });
    }
    if (effectiveAt > now) {
      this.ctx.enqueue(orgId, 'credits.activate_grant', { grant: row.id }, {
        runAt: effectiveAt, idemKey: `credits.activate:${row.id}`,
      });
    }

    const grant = this.requireGrant(orgId, row.id);
    this.ctx.emit(orgId, 'credit_grant.created', grant, { objectId: grant.id, objectType: 'credit_grant' });
    return grant;
  }

  updateGrant(orgId: string, id: string, patch: { name?: string; priority?: number; expires_at?: number | null; metadata?: Record<string, string> }): CreditGrant {
    const before = this.requireGrant(orgId, id);
    if (before.status === 'voided' || before.status === 'expired') {
      throw conflict('credit_grant_closed', `Grant ${id} is ${before.status}; its terms cannot change. Issue a new grant instead.`);
    }
    return this.ctx.atomic(() => {
      const changes: Record<string, Bindable> = { updated: this.ctx.now() };
      if (patch.name !== undefined) changes.name = patch.name.trim();
      if (patch.priority !== undefined) changes.priority = patch.priority;
      if (patch.metadata !== undefined) changes.metadata = JSON.stringify(patch.metadata);
      if (patch.expires_at !== undefined) {
        if (patch.expires_at !== null && patch.expires_at <= before.effective_at) {
          throw badRequest('parameter_invalid', 'A grant expires after it becomes effective.', 'expires_at');
        }
        if (before.rollover !== 'none' && patch.expires_at === null) {
          throw badRequest('parameter_invalid', 'This grant rolls over at expiry, so it cannot be given an open-ended life.', 'expires_at');
        }
        changes.expires_at = patch.expires_at;
        this.ctx.jobs.cancel(orgId, { idemKey: `credits.expire:${id}` }, this.ctx.now());
        if (patch.expires_at !== null) {
          this.ctx.enqueue(orgId, 'credits.expire_grant', { grant: id }, { runAt: patch.expires_at, idemKey: `credits.expire:${id}` });
        }
      }
      this.ctx.db.patch('credit_grants', 'id', id, changes);
      const after = this.requireGrant(orgId, id);
      this.ctx.emit(orgId, 'credit_grant.updated', after, {
        objectId: id, objectType: 'credit_grant',
        previous: { name: before.name, priority: before.priority, expires_at: before.expires_at },
      });
      return after;
    });
  }

  voidGrant(orgId: string, id: string, reason?: string): CreditGrant {
    return this.ctx.atomic(() => {
      const state = this.requireState(orgId, id);
      const grant = this.hydrateGrant(state, this.ctx.now(), orgId);
      if (grant.status === 'voided') return grant;
      const balance = bigOf(state.balance_micro);
      if (balance > 0n) {
        this.append(orgId, state, 'void', -balance, {
          reason: reason ?? `Voided with ${describeAmount(grant.kind, balance, grant.currency, grant.unit_label)} unused`,
        });
      } else {
        // A void with nothing left still belongs in the ledger: it is the
        // difference between "spent" and "withdrawn".
        this.append(orgId, state, 'void', 0n, { reason: reason ?? 'Voided after the balance was already spent' });
      }
      this.ctx.jobs.cancel(orgId, { idemKey: `credits.expire:${id}` }, this.ctx.now());
      const after = this.requireGrant(orgId, id);
      this.ctx.emit(orgId, 'credit_grant.voided', {
        ...after, voided_balance: microToNumber(balance), reason: reason ?? null,
      }, { objectId: id, objectType: 'credit_grant', previous: { status: grant.status } });
      return after;
    });
  }

  /**
   * Give back a paid grant. The unused balance leaves the ledger and, when the
   * grant came from a top-up, a matching negative line goes to the invoice —
   * refunded pro rata to what was actually returned.
   */
  refundGrant(orgId: string, id: string, opts: { amount?: number | string; reason?: string } = {}): { grant: CreditGrant; line: BillableItem | null; refunded: number } {
    return this.ctx.atomic(() => {
      const state = this.requireState(orgId, id);
      const grant = this.hydrateGrant(state, this.ctx.now(), orgId);
      if (grant.category !== 'paid') {
        throw badRequest('credit_grant_not_refundable', 'Only paid credit can be refunded; promotional credit is voided instead.', 'id');
      }
      const balance = bigOf(state.balance_micro);
      const requested = opts.amount === undefined
        ? balance
        : grant.kind === 'monetary' ? BigInt(assertMinorUnits(opts.amount)) * MICRO : parseMicro(opts.amount, 'amount');
      if (requested <= 0n) throw badRequest('parameter_invalid', 'Refund a positive amount.', 'amount');
      if (requested > balance) {
        throw badRequest(
          'credit_refund_exceeds_balance',
          `Grant ${id} has ${describeAmount(grant.kind, balance, grant.currency, grant.unit_label)} left; ${describeAmount(grant.kind, requested, grant.currency, grant.unit_label)} cannot be refunded.`,
          'amount',
        );
      }
      this.append(orgId, state, 'refund', -requested, { reason: opts.reason ?? 'Refunded to the customer' });

      let line: BillableItem | null = null;
      const purchase = state.source === 'topup' && state.source_ref
        ? this.ctx.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM credit_billable_items WHERE org_id = ? AND id = ?`, orgId, state.source_ref)
        : undefined;
      if (purchase) {
        // Pro rata on what is being handed back, rounded once.
        const refundMoney = mulFraction(money(purchase.amount, purchase.currency), requested, bigOf(state.amount_micro));
        line = this.insertItem(orgId, {
          customer: grant.customer,
          grant: grant.id,
          kind: 'topup',
          description: `Refund — ${purchase.description}`,
          currency: purchase.currency,
          amount: -refundMoney.amount,
          billedAmount: -refundMoney.amount,
          quantityMicro: 0n,
          unitLabel: purchase.unit_label,
          price: purchase.price_id,
          meter: purchase.meter_id,
          metadata: { refund_of: purchase.id },
        });
      }
      const after = this.requireGrant(orgId, id);
      this.ctx.emit(orgId, 'credit_grant.refunded', {
        grant: after, refunded: microToNumber(requested), refunded_decimal: microToDecimal(requested),
        line: line?.id ?? null, amount: line?.amount ?? 0,
      }, { objectId: id, objectType: 'credit_grant' });
      return { grant: after, line, refunded: microToNumber(requested) };
    });
  }

  /* -------------------------------- ledger -------------------------------- */

  ledger(orgId: string, grantId: string, limit = 200): { grant: CreditGrant; entries: LedgerEntry[]; reconciled: boolean } {
    const grant = this.requireGrant(orgId, grantId);
    const rows = this.ctx.db.all<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM credit_ledger WHERE org_id = ? AND grant_id = ? ORDER BY seq ASC LIMIT ?`,
      orgId, grantId, Math.min(limit, 1000),
    );
    // The running balance on each entry must equal the sum of every delta up to
    // it. Checking it on read is cheap and turns a silent corruption loud.
    let running = 0n;
    let reconciled = true;
    for (const row of rows) {
      running += bigOf(row.delta_micro);
      if (running !== bigOf(row.balance_after_micro)) reconciled = false;
    }
    return { grant, entries: rows.map(hydrateEntry), reconciled };
  }

  customerLedger(orgId: string, customerId: string | null, limit = 100): LedgerEntry[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (customerId) { clauses.push('customer_id = ?'); params.push(customerId); }
    return this.ctx.db.all<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM credit_ledger WHERE ${clauses.join(' AND ')} ORDER BY created DESC, seq DESC LIMIT ?`,
      ...params, Math.min(limit, 500),
    ).map(hydrateEntry);
  }

  private append(
    orgId: string, grant: LedgerTarget, type: LedgerEntryType, deltaMicro: bigint,
    opts: { reason: string; refType?: string | null; refId?: string | null; periodStart?: number | null; periodEnd?: number | null; metadata?: Record<string, string> },
  ): LedgerEntry {
    const before = bigOf(this.ctx.db.pluck<string>(
      `SELECT CAST(COALESCE(SUM(delta_micro), 0) AS TEXT) FROM credit_ledger WHERE org_id = ? AND grant_id = ?`,
      orgId, grant.id,
    ));
    const after = before + deltaMicro;
    if (after < 0n) {
      throw conflict(
        'credit_balance_would_go_negative',
        `That would take grant ${grant.id} to ${microToDecimal(after)}. Credit cannot be drawn below zero — the ledger is the balance.`,
      );
    }
    const seq = Number(this.ctx.db.pluck<number>(
      `SELECT COALESCE(MAX(seq), 0) + 1 FROM credit_ledger WHERE org_id = ? AND grant_id = ?`, orgId, grant.id) ?? 1);
    const row: LedgerRow = {
      id: newId('ledger'),
      org_id: orgId,
      grant_id: grant.id,
      customer_id: grant.customer_id,
      seq,
      type,
      delta_micro: String(deltaMicro),
      balance_after_micro: String(after),
      currency: grant.currency,
      kind: grant.kind,
      reason: opts.reason,
      ref_type: opts.refType ?? null,
      ref_id: opts.refId ?? null,
      period_start: opts.periodStart ?? null,
      period_end: opts.periodEnd ?? null,
      metadata: JSON.stringify(opts.metadata ?? {}),
      created: this.ctx.now(),
    };
    this.ctx.db.insert('credit_ledger', { ...row, delta_micro: deltaMicro, balance_after_micro: after });
    return hydrateEntry(row);
  }

  /* ------------------------------- balances ------------------------------- */

  balance(orgId: string, customerId: string): CreditBalance {
    const now = this.ctx.now();
    const grants = this.grants(orgId, { customer: customerId, limit: 500 });
    const buckets = new Map<string, BalanceBucket>();

    for (const grant of grants) {
      if (grant.status !== 'active' && grant.status !== 'exhausted') continue;
      const key = `${grant.currency}:${grant.kind}:${grant.meter ?? '-'}:${applicabilityKey(grant.applicability)}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          currency: grant.currency,
          kind: grant.kind,
          meter: grant.meter,
          unit_label: grant.unit_label,
          applicability: grant.applicability,
          applies_to: grant.applies_to,
          available: 0,
          available_decimal: '0',
          by_category: { paid: 0, promotional: 0 },
          next_expiry: null,
          grants: [],
        };
        buckets.set(key, bucket);
      }
      bucket.grants.push(grant);
      bucket.by_category[grant.category] += grant.balance;
      if (grant.balance > 0 && grant.expires_at !== null) {
        if (!bucket.next_expiry || grant.expires_at < bucket.next_expiry.at) {
          bucket.next_expiry = {
            at: grant.expires_at, amount: grant.balance, amount_decimal: grant.balance_decimal,
            grant: grant.id, grant_name: grant.name,
          };
        }
      }
    }

    const balances = [...buckets.values()].map((bucket) => {
      const micro = bucket.grants.reduce((acc, g) => acc + parseMicro(g.balance_decimal, 'balance'), 0n);
      return {
        ...bucket,
        available: microToNumber(micro),
        available_decimal: microToDecimal(micro),
      };
    }).sort((a, b) => a.key.localeCompare(b.key));

    const currencies = [...new Set(balances.map((b) => b.currency))].sort();
    return {
      object: 'credit_balance',
      customer: customerId,
      as_of: now,
      balances,
      totals_by_currency: currencies.map((currency) => {
        const mine = balances.filter((b) => b.currency === currency);
        const expiries = mine.map((b) => b.next_expiry?.at).filter((at): at is number => typeof at === 'number');
        return {
          currency,
          monetary_available: mine.filter((b) => b.kind === 'monetary').reduce((acc, b) => acc + b.available, 0),
          unit_pots: mine.filter((b) => b.kind === 'unit' && b.available > 0).length,
          next_expiry: expiries.length ? Math.min(...expiries) : null,
        };
      }),
      scheduled: grants.filter((g) => g.status === 'scheduled'),
      burn_order: BURN_ORDER,
    };
  }

  /* -------------------------------- top-ups ------------------------------- */

  /**
   * Buy a credit pack. The invoice line and the grant are written together or
   * not at all — a customer can never be charged for credit they did not get,
   * or hold credit nobody was billed for.
   */
  topUp(orgId: string, input: TopUpInput): TopUpResult {
    return this.ctx.atomic(() => {
      const price = this.ctx.svc.catalog.requirePrice(orgId, input.price);
      const product = this.ctx.svc.catalog.product(orgId, price.product);
      const quantity = input.quantity ?? 1;
      const currency = (input.currency ?? price.currency).toLowerCase();
      const line = this.ctx.svc.catalog.compute(price, quantity, currency, { unitLabel: product?.unit_label ?? null });

      const unitsPerPack = Number(price.metadata.units_per_pack ?? price.metadata.events_per_pack
        ?? product?.metadata.units_per_pack ?? product?.metadata.events_per_pack ?? 0);
      const meterKey = input.applicability?.meters?.[0]
        ?? price.recurring?.meter ?? price.metadata.meter ?? product?.metadata.meter ?? null;
      const kind: CreditKind = input.kind ?? (unitsPerPack > 0 && meterKey ? 'unit' : 'monetary');

      if (kind === 'unit' && !unitsPerPack && input.grant_amount === undefined) {
        throw badRequest(
          'credit_pack_size_unknown',
          `Price ${price.id} does not say how many units one pack contains. Set \`units_per_pack\` on the price or the product, or pass \`grant_amount\`.`,
          'price',
        );
      }
      const grantAmount = input.grant_amount ?? (kind === 'unit' ? unitsPerPack * quantity : line.amount);

      const itemId = newId('lineitem');
      const grant = this.insertGrant(orgId, {
        customer: input.customer,
        name: input.name ?? `${product?.name ?? 'Credit pack'}${quantity > 1 ? ` ×${quantity}` : ''}`,
        category: input.category ?? 'paid',
        kind,
        currency,
        meter: kind === 'unit' ? meterKey : null,
        amount: grantAmount,
        applicability: input.applicability ?? (meterKey ? { scope: 'targeted', meters: [meterKey] } : undefined),
        effective_at: input.effective_at,
        expires_at: input.expires_at ?? null,
        priority: input.priority,
        rollover: input.rollover,
        rollover_cap: input.rollover_cap,
        source: 'topup',
        source_ref: itemId,
        metadata: { ...(input.metadata ?? {}), price: price.id, packs: String(quantity) },
      }, 'grant', `Purchased ${quantity} × ${product?.name ?? price.nickname ?? 'credit pack'}`);

      const item = this.insertItem(orgId, {
        id: itemId,
        customer: input.customer,
        grant: grant.id,
        kind: 'topup',
        description: `${product?.name ?? price.nickname ?? 'Credit pack'} — ${quantity} × ${grantLabel(kind, unitsPerPack, grant.unit_label, line.amount, currency)}`,
        currency,
        amount: line.amount,
        billedAmount: line.amount,
        quantityMicro: unitsToMicro(quantity),
        unitLabel: product?.unit_label ?? null,
        price: price.id,
        meter: grant.meter,
        metadata: { grant: grant.id, packs: String(quantity) },
      });

      // The charge comes first, and the grant is unspendable until it lands.
      // Raised here, inside the same transaction, so the ordinary case is one
      // call: the pack is bought, the invoice exists, the credit is live.
      const charge = this.chargePurchase(orgId, input.customer, item.id);

      this.ctx.emit(orgId, 'credit.topup_purchased', {
        grant: grant.id, customer: input.customer, price: price.id, quantity,
        amount: line.amount, currency, line: item.id,
        granted: grant.amount, granted_decimal: grant.amount_decimal, kind,
        invoice: charge.invoice, charge_deferred: charge.deferred,
      }, { objectId: grant.id, objectType: 'credit_grant' });

      return {
        object: 'credit_topup',
        grant: this.requireGrant(orgId, grant.id),
        line: this.requireItem(orgId, item.id),
        amount: line.amount, currency, quantity,
        invoice: charge.invoice, charge_deferred: charge.deferred,
        created: this.ctx.now(),
      };
    });
  }

  /**
   * Raise the charge for a credit purchase, now.
   *
   * Stripe's rule is that you charge and *then* grant, and the reason is the
   * one this had to learn: a grant minted beside a line nobody ever invoices is
   * credit the business gave away. So the purchase line goes to invoicing the
   * moment it is written, and if invoicing cannot take it — an account it does
   * not know yet, a currency it cannot bill in — the reason is recorded, the
   * grant stays held, and the daily purchase watch tries again. What never
   * happens is spendable credit against an unbilled line.
   */
  private chargePurchase(
    orgId: string, customerId: string, itemId: string,
  ): { invoice: string | null; deferred: { code: string; message: string } | null } {
    const item = this.ctx.db.get<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM credit_billable_items WHERE org_id = ? AND id = ?`, orgId, itemId);
    if (!item) throw notFound('billable item', itemId);
    if (item.status !== 'pending') return { invoice: item.invoice_id, deferred: null };

    const invoicing = (this.ctx.svc as { billing?: PurchaseCharger }).billing;
    if (!invoicing) {
      return this.deferCharge(orgId, item, {
        code: 'invoicing_unavailable',
        message: 'No invoicing module is installed, so this purchase cannot be charged for yet. The credit is held until it is.',
      });
    }
    // Asked before it is attempted, so the reason a purchase is still unbilled
    // is a sentence about this account rather than whatever error invoicing
    // happened to raise three calls deep.
    const account = invoicing.customer(orgId, customerId);
    if (!account) {
      return this.deferCharge(orgId, item, {
        code: 'resource_missing',
        message: `Invoicing has no customer record for ${customerId}, so nothing can charge for this purchase. The credit is held until there is one.`,
      });
    }
    if (account.currency && account.currency !== item.currency) {
      return this.deferCharge(orgId, item, {
        code: 'currency_mismatch',
        message: `This purchase is priced in ${item.currency.toUpperCase()} and ${customerId} is billed in ${account.currency.toUpperCase()}, so it cannot go on their invoice. Sell the pack in ${account.currency.toUpperCase()}, or bill the account in ${item.currency.toUpperCase()}.`,
      });
    }
    try {
      const invoice = invoicing.invoiceNow(orgId, customerId);
      const after = this.ctx.db.get<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM credit_billable_items WHERE org_id = ? AND id = ?`, orgId, itemId);
      if (after && after.status === 'pending') {
        return this.deferCharge(orgId, item, {
          code: 'purchase_not_claimed',
          message: `Invoice ${invoice.id} was raised but did not take this line, so the purchase is still unbilled.`,
        });
      }
      return { invoice: after?.invoice_id ?? invoice.id, deferred: null };
    } catch (e) {
      const code = isApiError(e) ? e.code : 'invoicing_failed';
      const message = e instanceof Error ? e.message : String(e);
      return this.deferCharge(orgId, item, { code, message });
    }
  }

  /** Record why a purchase is still unbilled, on the line itself. */
  private deferCharge(
    orgId: string, item: ItemRow, reason: { code: string; message: string },
  ): { invoice: null; deferred: { code: string; message: string } } {
    const metadata = { ...parseJson<Record<string, string>>(item.metadata, {}), charge_deferred: reason.code, charge_deferred_reason: reason.message };
    this.ctx.db.patch('credit_billable_items', 'id', item.id, {
      metadata: JSON.stringify(metadata), updated: this.ctx.now(),
    });
    this.ctx.emit(orgId, 'credit.purchase_awaiting_charge', {
      line: item.id, customer: item.customer_id, grant: item.grant_id,
      amount: item.amount, currency: item.currency,
      code: reason.code, message: reason.message, since: item.created,
    }, { objectId: item.id, objectType: 'credit_billable_item' });
    return { invoice: null, deferred: reason };
  }

  /**
   * Every credit purchase still waiting for its charge, oldest first.
   *
   * A grant held against one of these is unspendable, so this is the list of
   * customers who have bought credit they cannot use yet — and of revenue the
   * platform has recognised nowhere.
   */
  unbilledPurchases(orgId: string, limit = 200): BillableItem[] {
    return this.ctx.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM credit_billable_items
       WHERE org_id = ? AND status = 'pending' AND kind = 'topup' AND amount > 0
       ORDER BY created ASC LIMIT ?`,
      orgId, Math.min(limit, 500),
    ).map(hydrateItem);
  }

  /** The daily retry: bill every purchase whose charge could not be raised. */
  billUnbilledPurchases(orgId: string, limit = 200): { charged: string[]; still_waiting: string[] } {
    const charged: string[] = [];
    const waiting: string[] = [];
    for (const item of this.unbilledPurchases(orgId, limit)) {
      const outcome = this.ctx.atomic(() => this.chargePurchase(orgId, item.customer, item.id));
      if (outcome.invoice) charged.push(item.id); else waiting.push(item.id);
    }
    return { charged, still_waiting: waiting };
  }

  private requireItem(orgId: string, id: string): BillableItem {
    const row = this.ctx.db.get<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM credit_billable_items WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) throw notFound('billable item', id);
    return hydrateItem(row);
  }

  /* ------------------------------ settlement ------------------------------ */

  /**
   * Price a usage period and draw credits against it.
   *
   * Unit credits come off the quantity, monetary credits come off the money,
   * and the two invoice lines that come out — the credit-covered portion and
   * the charged portion — always add back up to what the period would have cost
   * with no credits at all.
   */
  settleUsage(orgId: string, input: SettleUsageInput): Settlement {
    const idemKey = input.idem_key
      ?? `${input.customer}:${input.price}:${input.period_start}:${input.period_end}`;
    return this.ctx.atomic(() => {
      if (!(input.period_end > input.period_start)) {
        throw badRequest('parameter_invalid', 'A billing period ends after it starts.', 'period_end');
      }
      const price = this.ctx.svc.catalog.requirePrice(orgId, input.price);

      // The period is the identity. Checked before `idem_key` and before any
      // work, because a retry that generated a fresh key is still the same
      // period — and settling it again would spend the customer's money twice
      // for usage they have already paid for.
      const already = this.settlementForPeriod(orgId, input.customer, price.id, input.period_start, input.period_end);
      if (already && already.status === 'settled') return this.hydrateSettlement(orgId, already);
      if (already) {
        // This exact window has already been declined once and the reason has
        // not gone anywhere. Point at the record rather than deciding again.
        throw conflict(
          'usage_period_already_settled',
          `This window was recorded as skipped settlement ${already.id}${already.superseded_by ? `, superseded by ${already.superseded_by}` : ''}. ${already.skip_reason ? `Reason: ${already.skip_reason}.` : ''} Nothing about it has changed, so settling it now would still draw credit twice.`,
          { settlement: already.id, status: already.status, superseded_by: already.superseded_by },
        );
      }

      const existing = this.ctx.db.get<SettlementRow>(
        `SELECT ${SETTLEMENT_COLUMNS} FROM credit_settlements WHERE org_id = ? AND idem_key = ?`, orgId, idemKey);
      if (existing) return this.hydrateSettlement(orgId, existing);

      // A window that overlaps a settled one without matching it is a boundary
      // that has moved — a retry that lost its place, a period recomputed
      // against a different anchor. Either way part of this usage is already
      // billed, so it is a loud 409 rather than a second quiet draw.
      const clash = this.overlappingSettlement(orgId, input.customer, price.id, input.period_start, input.period_end);
      if (clash) {
        throw conflict(
          'usage_period_already_settled',
          `Settlement ${clash.id} already covers ${new Date(clash.period_start).toISOString()} to ${new Date(clash.period_end).toISOString()} for this customer on price ${price.id}, which overlaps the period you asked to settle. Settling it again would draw credit twice for usage that is already billed.`,
          {
            settlement: clash.id, period_start: clash.period_start, period_end: clash.period_end,
            requested_start: input.period_start, requested_end: input.period_end,
            covered_amount: clash.covered_amount, charged_amount: clash.charged_amount,
          },
        );
      }

      const now = this.ctx.now();
      const product = this.ctx.svc.catalog.product(orgId, price.product);
      const currency = (input.currency ?? price.currency).toLowerCase();
      const meterKey = input.meter ?? price.recurring?.meter ?? price.metadata.meter ?? null;
      const meter = meterKey ? this.ctx.svc.metering.meter(orgId, meterKey) : null;

      let quantityMicro: bigint;
      if (input.quantity !== undefined) {
        quantityMicro = parseMicro(input.quantity, 'quantity');
      } else {
        if (!meter) {
          throw badRequest(
            'meter_required',
            `Price ${price.id} names no meter, so there is nothing to aggregate. Pass \`meter\` or supply the \`quantity\` directly.`,
            'meter',
          );
        }
        const usage = this.ctx.svc.metering.usageForPeriod(orgId, meter.id, input.customer, input.period_start, input.period_end);
        quantityMicro = parseMicro(usage.value_decimal, 'quantity');
      }
      const unitLabel = product?.unit_label ?? meter?.unit_label ?? null;

      /* The tier ladder belongs to the billing period, not to this window.
         Anything of the same cycle that has already been settled is the rung
         this window starts on, so a month billed in two pieces costs exactly
         what the month costs and its free tier is handed out once. */
      const cadence = price.recurring && price.recurring.interval_count > 0
        ? interval(price.recurring.interval, price.recurring.interval_count)
        : null;
      const basis = this.tierBasisFor(orgId, input, price.id, cadence);
      const cumulativeMicro = assertStorableMicro(basis.priorMicro + quantityMicro, {
        subject: `This billing period on ${price.id}`,
        param: 'period_end',
        remedy: 'Settle it against a shorter billing period.',
      });
      const priorBilled = microToWholeUnits(basis.priorMicro);
      // Rounded once on the cumulative total and once on the prior, then
      // differenced: across any partition of a period the halves add back up to
      // the whole, with no rounding gained or lost at a boundary.
      const billedQuantity = microToWholeUnits(cumulativeMicro) - priorBilled;
      const priceAt = (q: number) => this.ctx.svc.catalog.compute(price, q, currency, { unitLabel }).amount;
      const priorAmount = priorBilled > 0 ? priceAt(priorBilled) : 0;
      const cumulativeAmount = priceAt(priorBilled + billedQuantity);
      const cost = (q: number) => priceAt(priorBilled + q) - priorAmount;
      const fullAmount = cumulativeAmount - priorAmount;
      if (![priorAmount, cumulativeAmount, fullAmount].every(Number.isSafeInteger)) {
        throw badRequest(
          'amount_out_of_range',
          `${(priorBilled + billedQuantity).toLocaleString('en-US')} ${unitLabel ?? 'unit'}s of ${price.id} prices to more than one invoice line can carry exactly. Bill this period in parts.`,
          'period_end',
        );
      }

      const target: ChargeTarget = { currency, price: price.id, meter: meter?.id ?? null, product: price.product };

      /* 1. Unit credits take units off the bill. */
      const unitCandidates = meter ? this.eligible(orgId, input.customer, target, 'unit', now) : [];
      const availableUnits = unitCandidates.reduce((acc, c) => acc + c.balanceMicro, 0n);
      const coveredUnits = unitsWorthBurningSafe(cost, billedQuantity, availableUnits);
      const chargedQuantity = billedQuantity - coveredUnits;
      const afterUnits = cost(chargedQuantity);
      const unitCreditAmount = fullAmount - afterUnits;

      /* 2. Monetary credits take money off what is left. */
      const moneyCandidates = this.eligible(orgId, input.customer, target, 'monetary', now);
      const availableMoney = Number(moneyCandidates.reduce((acc, c) => acc + c.balanceMicro, 0n) / MICRO);
      const monetaryCreditAmount = Math.min(availableMoney, afterUnits);
      const chargedAmount = afterUnits - monetaryCreditAmount;
      const coveredAmount = fullAmount - chargedAmount;

      const settlementId = newId('usage');
      const label = price.nickname ?? product?.name ?? 'Metered usage';
      const applications: CreditApplication[] = [];

      if (coveredUnits > 0) {
        const draws = drawDown(unitCandidates, unitsToMicro(coveredUnits));
        // The money those units saved, split across the grants that paid for
        // them by largest remainder, so the parts equal the whole to the cent.
        const shares = allocate(money(unitCreditAmount, currency), proportionalWeights(draws.map((d) => d.micro)));
        draws.forEach((draw, i) => {
          const entry = this.append(orgId, ledgerTarget(draw.candidate), 'burn', -draw.micro, {
            reason: `${microToDecimal(draw.micro)} ${unitLabel ?? 'unit'}${draw.micro === MICRO ? '' : 's'} of ${label} covered by prepaid credit`,
            refType: 'credit_settlement', refId: settlementId,
            periodStart: input.period_start, periodEnd: input.period_end,
          });
          applications.push(applicationOf(draw.candidate, draw.micro, shares[i].amount, entry));
        });
      }

      if (monetaryCreditAmount > 0) {
        const draws = drawDown(moneyCandidates, BigInt(monetaryCreditAmount) * MICRO);
        for (const draw of draws) {
          const entry = this.append(orgId, ledgerTarget(draw.candidate), 'burn', -draw.micro, {
            reason: `Applied to ${label} for the period ending ${new Date(input.period_end).toISOString().slice(0, 10)}`,
            refType: 'credit_settlement', refId: settlementId,
            periodStart: input.period_start, periodEnd: input.period_end,
          });
          applications.push(applicationOf(draw.candidate, draw.micro, Number(draw.micro / MICRO), entry));
        }
      }

      const row: SettlementRow = {
        id: settlementId,
        org_id: orgId,
        customer_id: input.customer,
        meter_id: meter?.id ?? null,
        price_id: price.id,
        currency,
        period_start: input.period_start,
        period_end: input.period_end,
        quantity_micro: String(quantityMicro),
        billed_quantity: billedQuantity,
        covered_quantity_micro: String(unitsToMicro(coveredUnits)),
        charged_quantity: chargedQuantity,
        prior_quantity_micro: String(basis.priorMicro),
        prior_amount: priorAmount,
        cycle_start: basis.cycle.start,
        cycle_end: basis.cycle.end,
        cycle_source: basis.source,
        basis_settlements: JSON.stringify(basis.settlements),
        full_amount: fullAmount,
        covered_amount: coveredAmount,
        charged_amount: chargedAmount,
        unit_credit_amount: unitCreditAmount,
        monetary_credit_amount: monetaryCreditAmount,
        idem_key: idemKey,
        status: 'settled',
        superseded_by: null,
        skip_reason: null,
        skip_detail: null,
        subscription_id: input.subscription ?? null,
        subscription_item_id: input.subscription_item ?? null,
        created: now,
      };
      this.ctx.db.insert('credit_settlements', {
        ...row, quantity_micro: quantityMicro, covered_quantity_micro: unitsToMicro(coveredUnits),
        prior_quantity_micro: basis.priorMicro,
      });

      const noun = unitLabel ?? 'unit';
      if (coveredAmount > 0) {
        this.insertItem(orgId, {
          customer: input.customer, settlement: settlementId, kind: 'credit_covered',
          description: coveredUnits > 0
            ? `${label} — ${coveredUnits.toLocaleString('en-US')} ${noun}${coveredUnits === 1 ? '' : 's'} covered by prepaid credit`
            : `${label} — covered by credit balance`,
          currency, amount: coveredAmount, billedAmount: 0,
          quantityMicro: unitsToMicro(coveredUnits),
          unitLabel: noun, price: price.id, meter: meter?.id ?? null,
          periodStart: input.period_start, periodEnd: input.period_end,
          metadata: {
            unit_credit_amount: String(unitCreditAmount),
            monetary_credit_amount: String(monetaryCreditAmount),
            grants: applications.map((a) => a.grant).join(','),
          },
        });
      }
      // A period with usage always gets a charged line, even at zero, because
      // "1,200 events — included" is information. A period with no usage and no
      // credit drawn gets nothing: an empty month is not an invoice line.
      if (chargedAmount > 0 || (coveredAmount === 0 && billedQuantity > 0)) {
        this.insertItem(orgId, {
          customer: input.customer, settlement: settlementId, kind: 'charged',
          description: `${label} — ${chargedQuantity.toLocaleString('en-US')} ${noun}${chargedQuantity === 1 ? '' : 's'} charged`,
          currency, amount: chargedAmount, billedAmount: chargedAmount,
          quantityMicro: unitsToMicro(chargedQuantity),
          unitLabel: noun, price: price.id, meter: meter?.id ?? null,
          periodStart: input.period_start, periodEnd: input.period_end,
          metadata: { full_amount: String(fullAmount) },
        });
      }

      if (input.close_period && meter) {
        // The price travels with the closure so that a late event months from
        // now can be re-priced against exactly what this invoice was drawn on.
        this.ctx.svc.metering.closePeriod(orgId, {
          meter: meter.id, customer: input.customer,
          period_start: input.period_start, period_end: input.period_end,
          price: price.id, currency,
          // The rung travels with the closure too, so a late event months from
          // now is re-priced from where this window sat on the ladder rather
          // than from the bottom of it.
          prior_quantity: microToDecimal(basis.priorMicro),
          ref_type: 'credit_settlement', ref_id: settlementId,
        });
      }

      const settlement = this.hydrateSettlement(orgId, row);
      this.ctx.emit(orgId, 'credit.usage_settled', settlement, { objectId: settlementId, objectType: 'credit_settlement' });
      if (coveredAmount > 0 && chargedAmount > 0) {
        this.ctx.emit(orgId, 'credit.balance_exhausted_mid_period', {
          customer: input.customer, settlement: settlementId, meter: meter?.id ?? null,
          period_start: input.period_start, period_end: input.period_end,
          covered_amount: coveredAmount, charged_amount: chargedAmount, currency,
        }, { objectId: settlementId, objectType: 'credit_settlement' });
      }
      return settlement;
    });
  }

  /**
   * Where on the price's tiers a window starts.
   *
   * A graduated price gives its first units away once per billing period. This
   * finds the billing period the window belongs to and sums everything of that
   * period already settled for the same customer on the same price — in any
   * order, because two halves of a month settled back to front still have to
   * cost what the month costs.
   *
   * The period is taken from the caller when they state one, and otherwise
   * counted back one cadence from a boundary: this window's own end, or the end
   * of a window already settled within a cadence of it, which is a boundary
   * this one shares. A window longer than the cadence has no cycle to sit
   * inside, so it is its own basis and the ladder starts at zero. Which of the
   * three happened is recorded on the settlement, because a number that changes
   * what a customer pays has to be able to say where it came from.
   */
  private tierBasisFor(
    orgId: string, input: SettleUsageInput, priceId: string, cadence: Interval | null,
  ): { cycle: { start: number; end: number }; source: TierBasis['source']; priorMicro: bigint; settlements: string[] } {
    const window = { start: input.period_start, end: input.period_end };
    let cycle: { start: number; end: number } = window;
    let source: TierBasis['source'] = 'window';

    if (input.billing_period_start !== undefined || input.billing_period_end !== undefined) {
      const start = input.billing_period_start;
      const end = input.billing_period_end;
      if (start === undefined || end === undefined) {
        throw badRequest(
          'parameter_missing',
          'A billing period needs both ends. Give `billing_period_start` and `billing_period_end` together, or neither and it is derived from the price’s cadence.',
          start === undefined ? 'billing_period_start' : 'billing_period_end',
        );
      }
      if (start > window.start || end < window.end) {
        throw badRequest(
          'parameter_invalid',
          `The window ${iso(window.start)} – ${iso(window.end)} is not inside the billing period ${iso(start)} – ${iso(end)}. The tiers of a period can only be shared by windows that sit within it.`,
          'billing_period_start',
          { billing_period_start: start, billing_period_end: end, period_start: window.start, period_end: window.end },
        );
      }
      cycle = { start, end };
      source = 'stated';
    } else if (cadence) {
      /* Cycles are counted back from a boundary. This window's own end is one,
         and so is the end of any window of the same price already settled
         within a cycle's reach of it — the furthest of those is the closest
         thing to the real end of the cycle this window sits in. Taking it is
         what lets a period settled back to front add up to the same money as
         one settled front to back. */
      const reach = addInterval(window.end, cadence, new Date(window.end).getUTCDate());
      const laterBoundary = this.ctx.db.pluck<number>(
        `SELECT MAX(period_end) FROM credit_settlements
         WHERE org_id = ? AND customer_id = ? AND price_id = ? AND status = 'settled'
           AND period_end > ? AND period_end <= ?`,
        orgId, input.customer, priceId, window.end, reach,
      );
      const anchors = typeof laterBoundary === 'number' ? [laterBoundary, window.end] : [window.end];
      for (const anchor of anchors) {
        const derived = periodFor(anchor, cadence, window.start, new Date(anchor).getUTCDate());
        if (derived.start <= window.start && derived.end >= window.end) {
          cycle = { start: derived.start, end: derived.end };
          source = 'derived';
          break;
        }
      }
    }

    /* Overlap, not containment. A window that straddles this cycle's boundary
       has already priced part of it — the month billed 31 July to 30 August
       against a cycle that runs 3 August to 3 September — and a ladder that
       ignored it would give the four days left over their own free tier. The
       cycle widens to hold whatever it counted, so the period the settlement
       reports is one the settlements it names actually fit inside.

       Nothing else can be pulled in by that widening: a settled window cannot
       overlap another, so anything inside the widened span either overlapped
       the cycle already or overlaps the straddler that widened it. */
    const rows = this.ctx.db.all<{ id: string; period_start: number; period_end: number; quantity_micro: string }>(
      `SELECT id, period_start, period_end, CAST(quantity_micro AS TEXT) AS quantity_micro
       FROM credit_settlements
       WHERE org_id = ? AND customer_id = ? AND price_id = ? AND status = 'settled'
         AND period_start < ? AND period_end > ?
       ORDER BY period_start ASC`,
      orgId, input.customer, priceId, cycle.end, cycle.start,
    );
    for (const row of rows) {
      cycle = {
        start: Math.min(cycle.start, row.period_start),
        end: Math.max(cycle.end, row.period_end),
      };
    }
    return {
      cycle, source,
      priorMicro: rows.reduce((acc, row) => acc + bigOf(row.quantity_micro), 0n),
      settlements: rows.map((row) => row.id),
    };
  }

  settlement(orgId: string, id: string): Settlement | null {
    const row = this.ctx.db.get<SettlementRow>(`SELECT ${SETTLEMENT_COLUMNS} FROM credit_settlements WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? this.hydrateSettlement(orgId, row) : null;
  }

  /** The settlement for exactly this window, settled or refused. */
  private settlementForPeriod(orgId: string, customer: string, priceId: string, start: number, end: number): SettlementRow | undefined {
    return this.ctx.db.get<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM credit_settlements
       WHERE org_id = ? AND customer_id = ? AND price_id = ? AND period_start = ? AND period_end = ?`,
      orgId, customer, priceId, start, end,
    );
  }

  /**
   * Half-open windows overlap when each begins before the other ends. Only
   * settled windows count: a refusal has drawn no credit and billed nothing, so
   * it must never be the reason a later period cannot be billed.
   */
  private overlappingSettlement(orgId: string, customer: string, priceId: string, start: number, end: number): SettlementRow | undefined {
    return this.ctx.db.get<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM credit_settlements
       WHERE org_id = ? AND customer_id = ? AND price_id = ? AND status = 'settled'
         AND period_start < ? AND period_end > ?
       ORDER BY period_start ASC LIMIT 1`,
      orgId, customer, priceId, end, start,
    );
  }

  settlements(orgId: string, filter: SettlementListFilter = {}): Settlement[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.price) { clauses.push('price_id = ?'); params.push(filter.price); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    return this.ctx.db.all<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM credit_settlements WHERE ${clauses.join(' AND ')} ORDER BY created DESC LIMIT ?`,
      ...params, Math.min(filter.limit ?? 50, 200),
    ).map((row) => this.hydrateSettlement(orgId, row));
  }

  /**
   * Record a period the automatic run refused to settle.
   *
   * The overlap guard is right — settling a window whose usage is already
   * billed under another would draw a customer's credit twice. What was wrong
   * was where the refusal went: an event nobody queries, and a job marked
   * `done`. So the refusal is a row, and it carries the one thing that decides
   * whether anybody lost money: how much of the window the settlements that
   * superseded it actually cover. Two subscription items a day apart tile the
   * calendar between them, so coverage is 100% and the usage is billed exactly
   * once. A hole in that cover is real unbilled revenue, and says so.
   */
  recordSkippedSettlement(orgId: string, input: SkipSettlementInput): Settlement {
    return this.ctx.atomic(() => {
      const price = this.ctx.svc.catalog.price(orgId, input.price);
      const priceId = price?.id ?? input.price;
      const existing = this.settlementForPeriod(orgId, input.customer, priceId, input.period_start, input.period_end);
      if (existing) return this.hydrateSettlement(orgId, existing);

      // Only the facts of the refusal are stored. Coverage is worked out on
      // read, because it changes: the tail of a window refused today is
      // usually settled by the next cycle of the subscription that superseded
      // it, and a frozen "3% unbilled" would still be shouting a month later.
      const refusal: StoredSkip = {
        reason: input.reason,
        message: input.message,
        superseded_by: input.superseded_by ?? null,
        subscription: input.subscription ?? null,
        subscription_item: input.subscription_item ?? null,
      };
      const row: SettlementRow = {
        id: newId('usage'),
        org_id: orgId,
        customer_id: input.customer,
        meter_id: price ? (price.recurring?.meter ? this.ctx.svc.metering.meter(orgId, price.recurring.meter)?.id ?? null : null) : null,
        price_id: priceId,
        currency: (input.currency ?? price?.currency ?? this.ctx.svc.core.currency(orgId)).toLowerCase(),
        period_start: input.period_start,
        period_end: input.period_end,
        quantity_micro: '0',
        billed_quantity: 0,
        covered_quantity_micro: '0',
        charged_quantity: 0,
        full_amount: 0,
        covered_amount: 0,
        charged_amount: 0,
        unit_credit_amount: 0,
        monetary_credit_amount: 0,
        idem_key: `skip:${input.customer}:${priceId}:${input.period_start}:${input.period_end}`,
        prior_quantity_micro: '0',
        prior_amount: 0,
        cycle_start: null,
        cycle_end: null,
        cycle_source: null,
        basis_settlements: null,
        status: 'skipped',
        superseded_by: refusal.superseded_by,
        skip_reason: input.reason,
        skip_detail: JSON.stringify(refusal),
        subscription_id: input.subscription ?? null,
        subscription_item_id: input.subscription_item ?? null,
        created: this.ctx.now(),
      };
      this.ctx.db.insert('credit_settlements', {
        ...row, quantity_micro: 0, covered_quantity_micro: 0, prior_quantity_micro: 0,
      });
      const settlement = this.hydrateSettlement(orgId, row);
      this.ctx.emit(orgId, 'credit.settlement_skipped', {
        settlement: settlement.id,
        reason: input.reason, message: input.message,
        customer: input.customer, price: priceId,
        subscription: input.subscription ?? null, subscription_item: input.subscription_item ?? null,
        period_start: input.period_start, period_end: input.period_end,
        superseded_by: settlement.skip?.superseded_by ?? null,
        coverage_percent: settlement.skip?.coverage_percent ?? null,
        gaps: settlement.skip?.gaps ?? [], summary: settlement.skip?.summary ?? null,
      }, { objectId: settlement.id, objectType: 'credit_settlement' });
      return settlement;
    });
  }

  /**
   * Refused periods that still have a hole in them a whole billing cycle later.
   *
   * The gap left by a refusal is normally filled by the next cycle of the
   * subscription that superseded it — the tail of September's window is billed
   * when October's settles. A gap that has outlived the window it sits in is
   * something else: usage nothing has billed and nothing is going to. This is
   * the query that separates the two, and the daily watch turns it into an
   * event exactly once per period rather than every morning forever.
   */
  unbilledWindows(orgId: string, limit = 200): Settlement[] {
    return this.settlements(orgId, { status: 'skipped', limit })
      .filter((s) => (s.skip?.gaps ?? []).some((gap) => gap.overdue));
  }

  /** The refusal, plus how much of the window is billed as of right now. */
  private describeSkip(orgId: string, row: SettlementRow): SettlementSkip {
    const stored = parseJson<StoredSkip>(row.skip_detail ?? '{}', {
      reason: row.skip_reason ?? 'usage_period_already_settled', message: '',
      superseded_by: row.superseded_by, subscription: row.subscription_id,
      subscription_item: row.subscription_item_id,
    });
    const cover = this.coverageOf(orgId, row.customer_id, row.price_id, row.period_start, row.period_end);
    return {
      ...stored,
      superseded_by: stored.superseded_by ?? cover.covered_by[0] ?? null,
      covered_by: cover.covered_by,
      window_ms: cover.window_ms,
      covered_ms: cover.covered_ms,
      coverage_percent: cover.coverage_percent,
      gaps: cover.gaps,
      summary: describeCoverage(cover),
    };
  }

  /** How much of a window settled periods already cover, and where they do not. */
  private coverageOf(orgId: string, customer: string, priceId: string, start: number, end: number): Coverage {
    const rows = this.ctx.db.all<{ id: string; period_start: number; period_end: number }>(
      `SELECT id, period_start, period_end FROM credit_settlements
       WHERE org_id = ? AND customer_id = ? AND price_id = ? AND status = 'settled'
         AND period_start < ? AND period_end > ?
       ORDER BY period_start ASC`,
      orgId, customer, priceId, end, start,
    );
    const windowMs = Math.max(end - start, 0);
    let cursor = start;
    let covered = 0;
    const gaps: { start: number; end: number }[] = [];
    for (const row of rows) {
      const from = Math.max(row.period_start, start);
      const to = Math.min(row.period_end, end);
      if (to <= cursor) continue;
      if (from > cursor) gaps.push({ start: cursor, end: from });
      covered += to - Math.max(from, cursor);
      cursor = to;
    }
    if (cursor < end) gaps.push({ start: cursor, end });
    // A hole is only a hole once the cadence that would have filled it has come
    // round again — one more window's length past the hole's own end, plus a
    // day, because the settlement that fills it runs on the same instant the
    // cycle turns and a race is not a missing invoice.
    const now = this.ctx.now();
    return {
      covered_by: rows.map((r) => r.id),
      window_ms: windowMs,
      covered_ms: covered,
      coverage_percent: windowMs === 0 ? 100 : Math.round((covered / windowMs) * 10_000) / 100,
      gaps: gaps.map((gap) => ({ ...gap, overdue: now >= gap.end + windowMs + DAY })),
    };
  }

  /* -------------------------------- true-ups ------------------------------ */

  /**
   * Turn a priced true-up into money.
   *
   * Metering knows a billed period has drifted and, given the price it was
   * billed on, exactly what that drift is worth. It cannot bill anybody, so it
   * hands the signed amount here. This is the other half: an invoice line for
   * the difference, and — when the period was over-billed and credit had paid
   * for part of it — the credit handed back to the grants that paid, pro rata,
   * capped so a period can never be credited more than it drew.
   *
   * The mirror case, usage that arrived late, is priced marginally and then run
   * through the same burn-down order as any other charge, so a customer with
   * credit does not get a cash bill for a true-up their balance covers.
   */
  trueUp(orgId: string, request: TrueUpRequest): TrueUpResult {
    return this.ctx.atomic(() => {
      const now = this.ctx.now();
      const currency = request.currency.toLowerCase();
      const price = this.ctx.svc.catalog.requirePrice(orgId, request.price);
      const product = this.ctx.svc.catalog.product(orgId, price.product);
      const settlementId = request.settlement_ref?.type === 'credit_settlement' ? request.settlement_ref.id : null;
      const settlementRow = settlementId
        ? this.ctx.db.get<SettlementRow>(
            `SELECT ${SETTLEMENT_COLUMNS} FROM credit_settlements WHERE org_id = ? AND id = ?`, orgId, settlementId)
        : undefined;
      const noun = request.unit_label ?? product?.unit_label ?? 'unit';
      const moved = Math.abs(Number(request.quantity_decimal));
      const description = request.amount < 0
        ? `${request.meter_name} — true-up: ${moved.toLocaleString('en-US')} ${noun}${moved === 1 ? '' : 's'} withdrawn from the period ending ${new Date(request.period_end).toISOString().slice(0, 10)}`
        : `${request.meter_name} — true-up: ${moved.toLocaleString('en-US')} ${noun}${moved === 1 ? '' : 's'} that arrived after the period ending ${new Date(request.period_end).toISOString().slice(0, 10)} was billed`;

      const shared = {
        customer: request.customer,
        settlement: settlementRow?.id ?? null,
        kind: 'true_up' as const,
        description,
        currency,
        quantityMicro: parseMicro(request.quantity_decimal.replace('-', ''), 'quantity'),
        unitLabel: noun,
        price: price.id,
        meter: request.meter,
        periodStart: request.period_start,
        periodEnd: request.period_end,
      };

      if (request.amount < 0) {
        const magnitude = -request.amount;
        const restored = settlementRow
          ? this.restoreCredit(orgId, settlementRow, magnitude, request, now)
          : { amount: 0, applications: [] as CreditApplication[] };
        const item = this.insertItem(orgId, {
          ...shared,
          amount: -magnitude,
          billedAmount: -(magnitude - restored.amount),
          metadata: {
            late_arrival: request.late_arrival, closure: request.closure, resolution: request.resolution,
            credit_restored: String(restored.amount),
            grants: restored.applications.map((a) => a.grant).join(','),
          },
        });
        this.ctx.emit(orgId, 'credit.true_up_recorded', {
          line: item.id, customer: request.customer, resolution: request.resolution,
          closure: request.closure, late_arrival: request.late_arrival, settlement: settlementRow?.id ?? null,
          amount: item.amount, billed_amount: item.billed_amount, credit_restored: restored.amount,
          currency, quantity_decimal: request.quantity_decimal,
          applications: restored.applications,
        }, { objectId: item.id, objectType: 'credit_billable_item' });
        return { item: item.id, billed_amount: item.billed_amount, credit_amount: restored.amount };
      }

      /* A late arrival is a fresh charge, so it meets the burn order like one —
         and it is priced from where the period had actually climbed to: the
         units earlier windows of the same billing cycle consumed, plus the
         units this window was already billed for. */
      const target: ChargeTarget = { currency, price: price.id, meter: request.meter, product: price.product };
      const base = request.billed_quantity;
      const ladder = request.prior_quantity + base;
      const marginal = (q: number) =>
        this.ctx.svc.catalog.compute(price, ladder + q, currency, { unitLabel: noun }).amount
        - this.ctx.svc.catalog.compute(price, ladder, currency, { unitLabel: noun }).amount;
      const deltaUnits = Math.max(request.new_quantity - base, 0);
      const unitCandidates = request.meter ? this.eligible(orgId, request.customer, target, 'unit', now) : [];
      const availableUnits = unitCandidates.reduce((acc, c) => acc + c.balanceMicro, 0n);
      const coveredUnits = unitsWorthBurningSafe(marginal, deltaUnits, availableUnits);
      const afterUnits = marginal(deltaUnits - coveredUnits);
      const unitCredit = request.amount - afterUnits;
      const applications: CreditApplication[] = [];

      if (coveredUnits > 0) {
        const draws = drawDown(unitCandidates, unitsToMicro(coveredUnits));
        const shares = allocate(money(unitCredit, currency), proportionalWeights(draws.map((d) => d.micro)));
        draws.forEach((draw, i) => {
          const entry = this.append(orgId, ledgerTarget(draw.candidate), 'burn', -draw.micro, {
            reason: `${microToDecimal(draw.micro)} ${noun}${draw.micro === MICRO ? '' : 's'} of late ${request.meter_name} usage covered by prepaid credit`,
            refType: 'credit_true_up', refId: request.late_arrival,
            periodStart: request.period_start, periodEnd: request.period_end,
          });
          applications.push(applicationOf(draw.candidate, draw.micro, shares[i].amount, entry));
        });
      }

      const moneyCandidates = this.eligible(orgId, request.customer, target, 'monetary', now);
      const availableMoney = Number(moneyCandidates.reduce((acc, c) => acc + c.balanceMicro, 0n) / MICRO);
      const monetaryCredit = Math.min(availableMoney, afterUnits);
      if (monetaryCredit > 0) {
        const draws = drawDown(moneyCandidates, BigInt(monetaryCredit) * MICRO);
        for (const draw of draws) {
          const entry = this.append(orgId, ledgerTarget(draw.candidate), 'burn', -draw.micro, {
            reason: `Applied to the ${request.meter_name} true-up for the period ending ${new Date(request.period_end).toISOString().slice(0, 10)}`,
            refType: 'credit_true_up', refId: request.late_arrival,
            periodStart: request.period_start, periodEnd: request.period_end,
          });
          applications.push(applicationOf(draw.candidate, draw.micro, Number(draw.micro / MICRO), entry));
        }
      }

      const charged = afterUnits - monetaryCredit;
      const item = this.insertItem(orgId, {
        ...shared,
        amount: request.amount,
        billedAmount: charged,
        metadata: {
          late_arrival: request.late_arrival, closure: request.closure, resolution: request.resolution,
          unit_credit_amount: String(unitCredit), monetary_credit_amount: String(monetaryCredit),
          grants: applications.map((a) => a.grant).join(','),
        },
      });
      this.ctx.emit(orgId, 'credit.true_up_recorded', {
        line: item.id, customer: request.customer, resolution: request.resolution,
        closure: request.closure, late_arrival: request.late_arrival, settlement: settlementRow?.id ?? null,
        amount: item.amount, billed_amount: item.billed_amount,
        credit_applied: unitCredit + monetaryCredit,
        currency, quantity_decimal: request.quantity_decimal, applications,
      }, { objectId: item.id, objectType: 'credit_billable_item' });
      return { item: item.id, billed_amount: charged, credit_amount: -(unitCredit + monetaryCredit) };
    });
  }

  /**
   * Hand back the credit that paid for usage the customer no longer owes.
   *
   * The share is exactly the fraction of the original period credit covered,
   * rounded once, and capped by two things that both matter: the money still
   * left in this period's credit half after any earlier true-up, and, per grant,
   * what that grant actually drew. A grant that has since expired or been
   * voided cannot take it back — that share becomes cash off the bill instead,
   * because credit the customer can never spend is not a refund.
   */
  private restoreCredit(
    orgId: string, settlementRow: SettlementRow, magnitude: number, request: TrueUpRequest, now: number,
  ): { amount: number; applications: CreditApplication[] } {
    if (settlementRow.full_amount <= 0 || settlementRow.covered_amount <= 0) return { amount: 0, applications: [] };
    const currency = settlementRow.currency;
    const netApplied = Number(this.ctx.db.pluck<number>(
      `SELECT COALESCE(SUM(credit_applied), 0) FROM credit_billable_items
       WHERE org_id = ? AND settlement_id = ? AND kind = 'true_up'`, orgId, settlementRow.id) ?? 0);
    const headroom = settlementRow.covered_amount + netApplied;
    const share = mulFraction(money(magnitude, currency), settlementRow.covered_amount, settlementRow.full_amount).amount;
    const target = Math.max(Math.min(share, magnitude, headroom), 0);
    if (target === 0) return { amount: 0, applications: [] };

    const settlement = this.hydrateSettlement(orgId, settlementRow);
    const drawn = settlement.applications.filter((a) => a.amount > 0);
    if (!drawn.length) return { amount: 0, applications: [] };
    const shares = allocate(money(target, currency), drawn.map((a) => a.amount));

    const applications: CreditApplication[] = [];
    let restored = 0;
    drawn.forEach((application, i) => {
      const back = shares[i].amount;
      if (back <= 0) return;
      const state = this.ctx.db.get<GrantState>(
        `${GRANT_STATE_SQL} WHERE g.org_id = ? AND g.id = ? GROUP BY g.id`, orgId, application.grant);
      if (!state) return;
      const grant = this.hydrateGrant(state, now, orgId);
      if (!isLive(grant, now)) return;
      const drawnMicro = parseMicro(application.drawn_decimal, 'drawn');
      const micro = application.kind === 'monetary'
        ? BigInt(back) * MICRO
        : minBig(divRound(drawnMicro * BigInt(back), BigInt(application.amount)), drawnMicro);
      if (micro <= 0n) return;
      const entry = this.append(orgId, ledgerTarget({ grant, balanceMicro: 0n }), 'refund', micro, {
        reason: `Returned after ${request.meter_name} usage was withdrawn from the period ending ${new Date(request.period_end).toISOString().slice(0, 10)}`,
        refType: 'credit_true_up', refId: request.late_arrival,
        periodStart: request.period_start, periodEnd: request.period_end,
        metadata: { settlement: settlementRow.id, closure: request.closure },
      });
      restored += back;
      applications.push({
        ...application,
        drawn: amountOf(application.kind, -micro),
        drawn_decimal: microToDecimal(-micro),
        amount: -back,
        balance_after: entry.balance_after,
        balance_after_decimal: entry.balance_after_decimal,
        ledger_entry: entry.id,
      });
    });
    return { amount: restored, applications };
  }

  /* ---------------------------- expiry and roll --------------------------- */

  /**
   * Run at the grant's `expires_at`. Rolls over what the policy allows, expires
   * the rest, and does both exactly once however many times it is replayed.
   */
  expireGrant(orgId: string, grantId: string): { expired: number; rolled_over: number; successor: string | null } | null {
    return this.ctx.atomic(() => {
      const state = this.ctx.db.get<GrantState>(`${GRANT_STATE_SQL} WHERE g.org_id = ? AND g.id = ? GROUP BY g.id`, orgId, grantId);
      if (!state) return null;
      if (state.has_void || state.has_expiry || state.has_rollover) return null;
      if (state.expires_at === null || this.ctx.now() < state.expires_at) return null;
      const balance = bigOf(state.balance_micro);
      if (balance <= 0n) return null;

      const grant = this.hydrateGrant(state, this.ctx.now(), orgId);
      let rolled = 0n;
      let successorId: string | null = null;
      if (state.rollover !== 'none') {
        const cap = state.rollover === 'full' ? balance : minBig(balance, bigOf(state.rollover_cap_micro));
        if (cap > 0n) {
          this.append(orgId, state, 'rollover_out', -cap, {
            reason: `Rolled ${describeAmount(grant.kind, cap, grant.currency, grant.unit_label)} into the next period`,
          });
          const span = Math.max(state.expires_at - state.effective_at, DAY);
          const successor = this.insertGrant(orgId, {
            customer: state.customer_id,
            name: `${state.name} (rolled over)`,
            category: grant.category,
            kind: grant.kind,
            currency: grant.currency,
            meter: state.meter_id,
            unit_label: state.unit_label,
            amount: grant.kind === 'monetary' ? Number(cap / MICRO) : microToDecimal(cap),
            applicability: grant.applicability,
            effective_at: state.expires_at,
            expires_at: state.expires_at + span,
            priority: state.priority,
            rollover: state.rollover,
            rollover_cap: state.rollover_cap_micro === null
              ? null
              : grant.kind === 'monetary' ? Number(bigOf(state.rollover_cap_micro) / MICRO) : microToDecimal(bigOf(state.rollover_cap_micro)),
            source: 'rollover',
            source_ref: state.id,
            metadata: { ...grant.metadata, rolled_from: state.id },
          }, 'rollover_in', `Rolled over from ${state.id}`);
          successorId = successor.id;
          rolled = cap;
        }
      }

      const remaining = balance - rolled;
      if (remaining > 0n) {
        this.append(orgId, state, 'expiry', -remaining, {
          reason: `Expired unused on ${new Date(state.expires_at).toISOString().slice(0, 10)}`,
        });
      }
      const after = this.requireGrant(orgId, grantId);
      this.ctx.emit(orgId, 'credit_grant.expired', {
        grant: after,
        expired: microToNumber(remaining), expired_decimal: microToDecimal(remaining),
        rolled_over: microToNumber(rolled), rolled_over_decimal: microToDecimal(rolled),
        successor: successorId,
      }, { objectId: grantId, objectType: 'credit_grant', previous: { status: grant.status } });
      return { expired: microToNumber(remaining), rolled_over: microToNumber(rolled), successor: successorId };
    });
  }

  /* --------------------------- billable outbox ---------------------------- */

  billableItems(orgId: string, filter: ItemListFilter = {}): BillableItem[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (filter.settlement) { clauses.push('settlement_id = ?'); params.push(filter.settlement); }
    return this.ctx.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM credit_billable_items WHERE ${clauses.join(' AND ')} ORDER BY created ASC, id ASC LIMIT ?`,
      ...params, Math.min(filter.limit ?? 100, 500),
    ).map(hydrateItem);
  }

  /**
   * Everything this customer's credits owe an invoice, claimed in one go.
   *
   * This is what an invoice being drawn should trigger, and the credits module
   * triggers it from `invoice.created` rather than waiting to be asked: an
   * outbox nobody drains is the same thing as no outbox at all.
   */
  drainOutbox(orgId: string, customerId: string, invoiceId: string): BillableItem[] {
    return this.ctx.atomic(() => {
      const pending = this.billableItems(orgId, { customer: customerId, status: 'pending', limit: 500 });
      if (!pending.length) return [];
      return this.markInvoiced(orgId, pending.map((item) => item.id), invoiceId);
    });
  }

  /** Billing claims a batch of lines once they are on an invoice. */
  markInvoiced(orgId: string, ids: string[], invoiceId: string, invoiceItemIds: Record<string, string> = {}): BillableItem[] {
    return this.ctx.atomic(() => {
      const out: BillableItem[] = [];
      for (const id of ids) {
        const row = this.ctx.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM credit_billable_items WHERE org_id = ? AND id = ?`, orgId, id);
        if (!row) throw notFound('billable item', id);
        if (row.status === 'invoiced' && row.invoice_id !== invoiceId) {
          throw conflict('billable_item_already_invoiced', `Line ${id} is already on invoice ${row.invoice_id}.`);
        }
        this.ctx.db.patch('credit_billable_items', 'id', id, {
          status: 'invoiced', invoice_id: invoiceId,
          invoice_item_id: invoiceItemIds[id] ?? null, updated: this.ctx.now(),
        });
        out.push(hydrateItem({ ...row, status: 'invoiced', invoice_id: invoiceId, invoice_item_id: invoiceItemIds[id] ?? null }));
        // The moment a purchase is billed the credit it bought becomes
        // spendable, and that is worth an event: it is the difference between a
        // customer's balance reading zero and reading what they paid for.
        if (row.kind === 'topup' && row.grant_id && row.status === 'pending') {
          const grant = this.grant(orgId, row.grant_id);
          if (grant && grant.status === 'active') {
            this.ctx.emit(orgId, 'credit_grant.activated', {
              ...grant, invoice: invoiceId, purchase: row.id,
            }, { objectId: grant.id, objectType: 'credit_grant', previous: { status: 'scheduled', awaiting_payment: true } });
          }
        }
      }
      this.ctx.emit(orgId, 'credit.billable_items_invoiced', { invoice: invoiceId, items: ids }, {
        objectId: invoiceId, objectType: 'invoice',
      });
      return out;
    });
  }

  private insertItem(orgId: string, input: {
    id?: string; customer: string; settlement?: string | null; grant?: string | null;
    kind: BillableItemKind; description: string; currency: string; amount: number; billedAmount: number;
    quantityMicro: bigint; unitLabel?: string | null; price?: string | null; meter?: string | null;
    periodStart?: number | null; periodEnd?: number | null; metadata?: Record<string, string>;
  }): BillableItem {
    const now = this.ctx.now();
    const row: ItemRow = {
      id: input.id ?? newId('lineitem'),
      org_id: orgId,
      customer_id: input.customer,
      settlement_id: input.settlement ?? null,
      grant_id: input.grant ?? null,
      kind: input.kind,
      description: input.description,
      currency: input.currency,
      amount: input.amount,
      billed_amount: input.billedAmount,
      credit_applied: input.amount - input.billedAmount,
      quantity_micro: String(input.quantityMicro),
      unit_label: input.unitLabel ?? null,
      price_id: input.price ?? null,
      meter_id: input.meter ?? null,
      period_start: input.periodStart ?? null,
      period_end: input.periodEnd ?? null,
      status: 'pending',
      invoice_id: null,
      invoice_item_id: null,
      metadata: JSON.stringify(input.metadata ?? {}),
      created: now,
      updated: now,
    };
    this.ctx.db.insert('credit_billable_items', { ...row, quantity_micro: input.quantityMicro });
    return hydrateItem(row);
  }

  /* -------------------------------- helpers ------------------------------- */

  /** Grants that may pay for this charge right now, in burn-down order. */
  eligible(orgId: string, customerId: string, target: ChargeTarget, kind: CreditKind, now: number): Candidate[] {
    const rows = this.ctx.db.all<GrantState>(
      `${GRANT_STATE_SQL}
       WHERE g.org_id = ? AND g.customer_id = ? AND g.kind = ? AND g.currency = ?
         AND g.effective_at <= ? AND (g.expires_at IS NULL OR g.expires_at > ?)
       GROUP BY g.id
       HAVING COALESCE(MAX(CASE WHEN l.type = 'void' THEN 1 ELSE 0 END), 0) = 0
          AND COALESCE(MAX(CASE WHEN l.type = 'expiry' THEN 1 ELSE 0 END), 0) = 0
          AND COALESCE(MAX(CASE WHEN l.type = 'rollover_out' THEN 1 ELSE 0 END), 0) = 0
          AND COALESCE(MAX(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END), 0) = 0
          AND COALESCE(SUM(l.delta_micro), 0) > 0`,
      orgId, customerId, kind, target.currency, now, now,
    );
    const candidates = rows
      .map((row) => ({ grant: this.hydrateGrant(row, now, orgId), balanceMicro: bigOf(row.balance_micro) }))
      .filter((c) => applicableTo(c.grant, target));
    return orderCandidates(candidates);
  }

  /**
   * Applicability may be written with the names a human uses — an event name, a
   * price lookup key — but it is stored as ids, because that is what a charge
   * arrives carrying and a lookup key can be reassigned to another price.
   */
  private resolveApplicability(orgId: string, applicability: Applicability): Applicability {
    if (applicability.scope === 'all') return applicability;
    const meters = [...new Set(applicability.meters.map((key) => this.ctx.svc.metering.requireMeter(orgId, key).id))];
    const prices = [...new Set(applicability.prices.map((key) => {
      const found = this.ctx.svc.catalog.price(orgId, key) ?? this.ctx.svc.catalog.priceByLookupKey(orgId, key);
      if (!found) throw notFound('price', key);
      return found.id;
    }))];
    return { scope: 'targeted', meters, prices, products: [...new Set(applicability.products)] };
  }

  private requireState(orgId: string, id: string): GrantState {
    const row = this.ctx.db.get<GrantState>(`${GRANT_STATE_SQL} WHERE g.org_id = ? AND g.id = ? GROUP BY g.id`, orgId, id);
    if (!row) throw notFound('credit grant', id);
    return row;
  }

  private hydrateGrant(row: GrantState, now: number, orgId = row.org_id): CreditGrant {
    const balance = bigOf(row.balance_micro);
    const amount = bigOf(row.amount_micro);
    const applicability = parseJson<Applicability>(row.applicability, ALL_CHARGES);
    return {
      object: 'credit_grant',
      id: row.id,
      customer: row.customer_id,
      name: row.name,
      category: row.category,
      kind: row.kind,
      currency: row.currency,
      meter: row.meter_id,
      unit_label: row.unit_label,
      amount: amountOf(row.kind, amount),
      amount_decimal: microToDecimal(amount),
      balance: amountOf(row.kind, balance),
      balance_decimal: microToDecimal(balance),
      applicability,
      applies_to: describeApplicability(applicability, this.meterLabels(orgId, applicability.meters)),
      effective_at: row.effective_at,
      expires_at: row.expires_at,
      priority: row.priority,
      rollover: row.rollover,
      rollover_cap: row.rollover_cap_micro === null ? null : amountOf(row.kind, bigOf(row.rollover_cap_micro)),
      status: statusOf(row, balance, now),
      awaiting_payment: !!row.awaiting_payment,
      pending_purchase: row.awaiting_payment ? row.source_ref : null,
      source: row.source,
      source_ref: row.source_ref,
      metadata: parseJson<Record<string, string>>(row.metadata, {}),
      created: row.created,
      updated: row.updated,
    };
  }

  private hydrateSettlement(orgId: string, row: SettlementRow): Settlement {
    const quantity = bigOf(row.quantity_micro);
    const covered = bigOf(row.covered_quantity_micro);
    const entries = this.ctx.db.all<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM credit_ledger WHERE org_id = ? AND ref_type = 'credit_settlement' AND ref_id = ? ORDER BY created ASC, seq ASC`,
      orgId, row.id,
    );
    const grantsById = new Map(
      this.ctx.db.all<GrantState>(
        `${GRANT_STATE_SQL} WHERE g.org_id = ? AND g.id IN (${entries.map(() => '?').join(',') || `''`}) GROUP BY g.id`,
        orgId, ...entries.map((e) => e.grant_id),
      ).map((g) => [g.id, this.hydrateGrant(g, this.ctx.now(), orgId)]),
    );
    const unitShares = allocate(
      money(row.unit_credit_amount, row.currency),
      proportionalWeights(entries.filter((e) => e.kind === 'unit').map((e) => -bigOf(e.delta_micro))),
    );
    let unitIndex = 0;
    const applications: CreditApplication[] = entries.map((entry) => {
      const grant = grantsById.get(entry.grant_id);
      const drawn = -bigOf(entry.delta_micro);
      const amount = entry.kind === 'unit'
        ? (unitShares[unitIndex++]?.amount ?? 0)
        : Number(drawn / MICRO);
      return {
        grant: entry.grant_id,
        grant_name: grant?.name ?? entry.grant_id,
        category: grant?.category ?? 'paid',
        kind: entry.kind,
        expires_at: grant?.expires_at ?? null,
        priority: grant?.priority ?? 0,
        drawn: amountOf(entry.kind, drawn),
        drawn_decimal: microToDecimal(drawn),
        amount,
        balance_after: amountOf(entry.kind, bigOf(entry.balance_after_micro)),
        balance_after_decimal: microToDecimal(bigOf(entry.balance_after_micro)),
        ledger_entry: entry.id,
      };
    });
    const items = this.billableItems(orgId, { settlement: row.id, limit: 500 });
    const trueUps = items.filter((item) => item.kind === 'true_up');
    return {
      object: 'credit_settlement',
      id: row.id,
      status: row.status ?? 'settled',
      skip: row.status === 'skipped' ? this.describeSkip(orgId, row) : null,
      subscription: row.subscription_id ?? null,
      subscription_item: row.subscription_item_id ?? null,
      customer: row.customer_id,
      meter: row.meter_id,
      price: row.price_id,
      currency: row.currency,
      period_start: row.period_start,
      period_end: row.period_end,
      quantity: microToNumber(quantity),
      quantity_decimal: microToDecimal(quantity),
      billed_quantity: row.billed_quantity,
      tier_basis: tierBasisOf(row, quantity),
      covered_quantity: microToNumber(covered),
      charged_quantity: row.charged_quantity,
      full_amount: row.full_amount,
      covered_amount: row.covered_amount,
      charged_amount: row.charged_amount,
      unit_credit_amount: row.unit_credit_amount,
      monetary_credit_amount: row.monetary_credit_amount,
      applications,
      // What the invoice said, and what has changed since, kept apart on
      // purpose: `lines` still sums to `full_amount`, and a period that has
      // been trued up says so in its own list rather than quietly breaking the
      // one invariant a reader checks first.
      lines: items.filter((item) => item.kind !== 'true_up'),
      true_ups: trueUps,
      net_amount: row.full_amount + trueUps.reduce((acc, item) => acc + item.amount, 0),
      net_charged_amount: row.charged_amount + trueUps.reduce((acc, item) => acc + item.billed_amount, 0),
      burn_order: BURN_ORDER,
      created: row.created,
    };
  }
}

/* -------------------------------- helpers --------------------------------- */

/** What the refusal itself recorded, before anything was worked out from it. */
interface StoredSkip {
  reason: string;
  message: string;
  superseded_by: string | null;
  subscription: string | null;
  subscription_item: string | null;
}

interface Coverage {
  covered_by: string[];
  window_ms: number;
  covered_ms: number;
  coverage_percent: number;
  gaps: { start: number; end: number; overdue: boolean }[];
}

const iso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/**
 * The tier position a settlement was priced from, as the API returns it.
 *
 * Read off the stored columns rather than recomputed, because the settlements
 * around this one can change and the money on the invoice cannot.
 */
function tierBasisOf(row: SettlementRow, quantityMicro: bigint): TierBasis {
  const prior = bigOf(row.prior_quantity_micro);
  const cumulative = prior + quantityMicro;
  const settlements = parseJson<string[]>(row.basis_settlements ?? '[]', []);
  const start = row.cycle_start ?? row.period_start;
  const end = row.cycle_end ?? row.period_end;
  const source = (row.cycle_source ?? 'window') as TierBasis['source'];
  const units = (micro: bigint) => microToDecimal(micro);
  const explanation = prior === 0n
    ? `Priced from the first unit: nothing else of the billing period ${iso(start)} – ${iso(end)} has been settled on this price, so the tier ladder starts at zero.`
    : `${units(prior)} of the billing period ${iso(start)} – ${iso(end)} ${settlements.length === 1 ? 'was' : 'were'} already settled across ${settlements.length} earlier window${settlements.length === 1 ? '' : 's'}, so this window is priced as the units after ${units(prior)} rather than starting the tier ladder again.`;
  return {
    period_start: start,
    period_end: end,
    source,
    prior_quantity: microToNumber(prior),
    prior_quantity_decimal: microToDecimal(prior),
    prior_amount: row.prior_amount,
    cumulative_quantity: microToNumber(cumulative),
    cumulative_quantity_decimal: microToDecimal(cumulative),
    cumulative_amount: row.prior_amount + row.full_amount,
    settlements,
    explanation,
  };
}

/** The sentence a finance lead needs: was any money actually lost here? */
function describeCoverage(cover: Coverage): string {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  if (!cover.gaps.length) {
    return cover.covered_by.length === 1
      ? `Every hour of this period is already billed by settlement ${cover.covered_by[0]}, so no usage went unbilled.`
      : `Every hour of this period is already billed across ${cover.covered_by.length} settlements, so no usage went unbilled.`;
  }
  const spans = (gaps: Coverage['gaps']) => gaps.map((g) => `${day(g.start)}–${day(g.end)}`).join(', ');
  const overdue = cover.gaps.filter((g) => g.overdue);
  if (!overdue.length) {
    return `${cover.coverage_percent}% of this period is billed elsewhere; ${spans(cover.gaps)} is waiting for the next cycle of the subscription that superseded it.`;
  }
  return `${cover.coverage_percent}% of this period is billed elsewhere; ${spans(overdue)} has outlived a full billing cycle unbilled and needs a settlement of its own.`;
}

function statusOf(row: GrantState, balance: bigint, now: number): GrantStatus {
  if (row.has_void) return 'voided';
  if (row.has_expiry || row.has_rollover) return 'expired';
  if (row.expires_at !== null && now >= row.expires_at) return 'expired';
  // Two ways a grant can exist without being spendable: its start date has not
  // come, or the purchase that bought it has not been charged for yet.
  if (row.awaiting_payment || now < row.effective_at) return 'scheduled';
  return balance > 0n ? 'active' : 'exhausted';
}

/** Monetary grants report whole minor units; unit grants report their decimal. */
const amountOf = (kind: CreditKind, micro: bigint): number =>
  kind === 'monetary' ? Number(micro / MICRO) : microToNumber(micro);

function assertMinorUnits(value: number | string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest('parameter_invalid', 'A monetary credit amount is a whole number of minor units — 2500 for $25.00.', 'amount');
  }
  return n;
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Exact half-up division of two positive BigInts — no double ever sees them. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return (numerator + denominator / 2n) / denominator;
}

/**
 * Weights for `allocate`, scaled so the arithmetic inside it stays inside a
 * double. Micro-unit draws run to 1e12 and multiplying that by an amount in
 * minor units would leave the exact-integer range, which is precisely the kind
 * of drift this module exists to avoid.
 */
const WEIGHT_CEILING = 1_000_000n;

function proportionalWeights(values: bigint[]): number[] {
  const max = values.reduce((acc, v) => (v > acc ? v : acc), 0n);
  if (max <= 0n) return values.map(() => 0);
  const scale = max > WEIGHT_CEILING ? max / WEIGHT_CEILING : 1n;
  // Never let a real draw round away to a zero weight.
  return values.map((v) => (v > 0n ? Math.max(1, Number(v / scale)) : 0));
}

interface Draw { candidate: Candidate; micro: bigint }

/** Take `needed` micro-units from the candidates in order, oldest-expiring first. */
function drawDown(candidates: Candidate[], needed: bigint): Draw[] {
  const draws: Draw[] = [];
  let left = needed;
  for (const candidate of candidates) {
    if (left <= 0n) break;
    const take = minBig(candidate.balanceMicro, left);
    if (take <= 0n) continue;
    draws.push({ candidate, micro: take });
    left -= take;
  }
  return draws;
}

/** `unitsWorthBurning`, with the available balance still in micro-units. */
function unitsWorthBurningSafe(cost: (q: number) => number, quantity: number, availableMicro: bigint): number {
  if (availableMicro <= 0n || quantity <= 0) return 0;
  return unitsWorthBurning(cost, quantity, Number(availableMicro / MICRO));
}

function applicationOf(candidate: Candidate, drawnMicro: bigint, amount: number, entry: LedgerEntry): CreditApplication {
  return {
    grant: candidate.grant.id,
    grant_name: candidate.grant.name,
    category: candidate.grant.category,
    kind: candidate.grant.kind,
    expires_at: candidate.grant.expires_at,
    priority: candidate.grant.priority,
    drawn: amountOf(candidate.grant.kind, drawnMicro),
    drawn_decimal: microToDecimal(drawnMicro),
    amount,
    balance_after: entry.balance_after,
    balance_after_decimal: entry.balance_after_decimal,
    ledger_entry: entry.id,
  };
}

function defaultGrantName(kind: CreditKind, category: CreditGrant['category']): string {
  if (category === 'promotional') return kind === 'unit' ? 'Promotional usage credit' : 'Promotional credit';
  return kind === 'unit' ? 'Prepaid usage credit' : 'Prepaid credit';
}

function describeAmount(kind: CreditKind, micro: bigint, currency: string, unitLabel: string | null): string {
  if (kind === 'monetary') return formatMoney(money(Number(micro / MICRO), currency));
  const value = microToDecimal(micro);
  return `${value} ${unitLabel ?? 'unit'}${value === '1' ? '' : 's'}`;
}

function grantLabel(kind: CreditKind, unitsPerPack: number, unitLabel: string | null, amount: number, currency: string): string {
  return kind === 'unit'
    ? `${unitsPerPack.toLocaleString('en-US')} ${unitLabel ?? 'unit'}s`
    : `${formatMoney(money(amount, currency))} of credit`;
}

interface LedgerTarget { id: string; customer_id: string; currency: string; kind: CreditKind }

const ledgerTarget = (candidate: Candidate): LedgerTarget => ({
  id: candidate.grant.id,
  customer_id: candidate.grant.customer,
  currency: candidate.grant.currency,
  kind: candidate.grant.kind,
});

function normalizeApplicability(input: Partial<Applicability> | undefined, meterId: string | null): Applicability {
  const prices = input?.prices ?? [];
  const meters = input?.meters ?? (meterId ? [meterId] : []);
  const products = input?.products ?? [];
  const scope = input?.scope ?? (prices.length || meters.length || products.length ? 'targeted' : 'all');
  if (scope === 'all') return ALL_CHARGES;
  if (!prices.length && !meters.length && !products.length) {
    throw badRequest(
      'parameter_invalid',
      'A targeted grant needs at least one price, meter or product it may be spent on. Use scope "all" for credit that pays for anything.',
      'applicability',
    );
  }
  return { scope: 'targeted', prices, meters, products };
}

const hydrateEntry = (row: LedgerRow): LedgerEntry => {
  const delta = bigOf(row.delta_micro);
  const after = bigOf(row.balance_after_micro);
  return {
    object: 'credit_ledger_entry',
    id: row.id,
    grant: row.grant_id,
    customer: row.customer_id,
    seq: row.seq,
    type: row.type,
    delta: amountOf(row.kind, delta),
    delta_decimal: microToDecimal(delta),
    balance_after: amountOf(row.kind, after),
    balance_after_decimal: microToDecimal(after),
    currency: row.currency,
    kind: row.kind,
    reason: row.reason,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    period_start: row.period_start,
    period_end: row.period_end,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: row.created,
  };
};

const hydrateItem = (row: ItemRow): BillableItem => {
  const quantity = bigOf(row.quantity_micro);
  return {
    object: 'credit_billable_item',
    id: row.id,
    customer: row.customer_id,
    settlement: row.settlement_id,
    grant: row.grant_id,
    kind: row.kind,
    description: row.description,
    currency: row.currency,
    amount: row.amount,
    billed_amount: row.billed_amount,
    credit_applied: row.credit_applied,
    quantity: microToNumber(quantity),
    quantity_decimal: microToDecimal(quantity),
    unit_label: row.unit_label,
    price: row.price_id,
    meter: row.meter_id,
    period_start: row.period_start,
    period_end: row.period_end,
    status: row.status,
    invoice: row.invoice_id,
    invoice_item: row.invoice_item_id,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: row.created,
    updated: row.updated,
  };
};

export { hydrateEntry, hydrateItem };

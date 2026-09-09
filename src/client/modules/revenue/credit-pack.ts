/**
 * What a credit pack actually sells.
 *
 * `POST /v1/credit-topups` decides the grant's denomination from what the
 * request says the pack is redeemable against: a pack whose price or product
 * states a pack size *and* names a meter mints unit credit, and anything else
 * mints money. The pack picker sent neither, so the one pack this workspace
 * sells — 1,000,000 telemetry events a pack, drawn against the telemetry
 * meter — was issued as unrestricted money every time: five packs became
 * $2,300 spendable against any charge in USD instead of 5,000,000 prepaid
 * events, and the settlement that should have drawn events off the pot drew
 * money off it instead.
 *
 * The catalogue does not link the pack product to a meter (`prod_nw_credits`
 * carries `events_per_pack` and no `meter`), so the dialog has to ask. These
 * are the rules it asks by, mirroring the server's own precedence so what the
 * dialog promises is what the topup writes.
 */

/** The fields of a price the pack rules read. `metadata` carries the pack size. */
export interface PackPrice {
  id: string;
  product: string;
  metadata: Record<string, string>;
  recurring: { meter: string | null } | null;
}

/** The fields of a product the pack rules read, when the price is silent. */
export interface PackProduct {
  id: string;
  metadata: Record<string, string>;
  unit_label: string | null;
}

/**
 * Both spellings the catalogue uses for a pack size, in the server's order.
 * `events_per_pack` is what the telemetry pack carries; `units_per_pack` is
 * the general name a second pack product would be created with.
 */
const SIZE_KEYS = ['units_per_pack', 'events_per_pack'] as const;

const sizeIn = (metadata: Record<string, string> | undefined): number => {
  for (const key of SIZE_KEYS) {
    const raw = metadata?.[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
};

/**
 * How many of a meter's units one pack contains, 0 when the catalogue does
 * not say. The price wins over its product, which is the order
 * `credits.topUp` resolves them in — a repriced pack must be able to change
 * its size without editing the product every other price hangs off.
 */
export const packSize = (price: PackPrice | null | undefined, product: PackProduct | null | undefined): number =>
  (price ? sizeIn(price.metadata) || sizeIn(product?.metadata) : 0);

/**
 * The meter the catalogue itself names for this price, if any — a metered
 * price's own meter, then either metadata. Used only as the dialog's default:
 * the operator's choice is what is sent, so a pack can still be sold as
 * money against a price that names a meter.
 */
export function packMeterHint(
  price: PackPrice | null | undefined, product: PackProduct | null | undefined,
): string | null {
  if (!price) return null;
  return price.recurring?.meter ?? price.metadata.meter ?? product?.metadata.meter ?? null;
}

/** The "not a meter" option in the redemption picker — unrestricted money. */
export const PACK_ANY_CHARGE = 'any';

/**
 * What the topup will actually mint, decided before the charge is raised.
 *
 * `unit` needs both halves — a meter to denominate in and a pack size to
 * multiply — because a unit grant with no size is the server's
 * `credit_pack_size_unknown`, refused after the operator has pressed a button
 * that promised a charge.
 */
export type PackGrantPlan =
  | { kind: 'unit'; meter: string; unitsPerPack: number; units: number }
  | { kind: 'monetary'; meter: string | null };

export function packGrantPlan(
  redeemAgainst: string, unitsPerPack: number, quantity: number,
): PackGrantPlan {
  if (redeemAgainst === PACK_ANY_CHARGE || !redeemAgainst) return { kind: 'monetary', meter: null };
  if (unitsPerPack > 0) {
    return { kind: 'unit', meter: redeemAgainst, unitsPerPack, units: unitsPerPack * quantity };
  }
  return { kind: 'monetary', meter: redeemAgainst };
}

/**
 * The `kind`/`applicability` half of the request body.
 *
 * Both are sent explicitly rather than left to be inferred, because the
 * server's inference reads the catalogue and the operator's answer is allowed
 * to differ from it: a pack sold as goodwill money against a price that names
 * a meter has to arrive as money, not as the units the price implies.
 */
export function packTopUpBody(plan: PackGrantPlan): {
  kind: 'unit' | 'monetary';
  applicability: { scope: 'all' | 'targeted'; meters?: string[] };
} {
  return plan.meter
    ? { kind: plan.kind, applicability: { scope: 'targeted', meters: [plan.meter] } }
    : { kind: plan.kind, applicability: { scope: 'all' } };
}

/**
 * What the customer receives, in the denomination they receive it in — stated
 * beside what they are charged, because "Charge $2,300.00" alone never said
 * whether the money bought events or more money.
 */
export function packGrantLine(
  plan: PackGrantPlan,
  opts: {
    quantity: number;
    /** The pack noun from the product — "pack", "bundle". */
    packLabel: string;
    /** The meter's name, for the targeted cases. */
    meterName: string | null;
    /** `units(f, n, unit_label)` — pluralised units in the workspace's format. */
    units: (count: number) => string;
    /** `moneyIn(f, minor, currency)`, for the monetary cases. */
    money: (minor: number) => string;
    /** What the charge comes to, in minor units; null while it is being priced. */
    amount: number | null;
    plural: (count: number, noun: string) => string;
  },
): string {
  const packs = opts.plural(opts.quantity, opts.packLabel);
  if (plan.kind === 'unit') {
    const each = opts.units(plan.unitsPerPack);
    const total = opts.units(plan.units);
    const against = opts.meterName ?? 'the chosen meter';
    return `${packs} × ${each} — ${total} of prepaid usage, drawn against ${against} and nothing else.`;
  }
  const worth = opts.amount === null ? 'the amount charged' : opts.money(opts.amount);
  return plan.meter
    ? `${worth} of credit, spendable on ${opts.meterName ?? 'the chosen meter'} only — this price does not say how many units a ${opts.packLabel} holds, so the pack is sold as money.`
    : `${worth} of credit, spendable on any charge in this currency.`;
}

/**
 * Why the redemption target cannot be left unanswered on a pack that is sold
 * in units. Returned as the field's own message so the sale is withheld with
 * a reason rather than a disabled button.
 */
export function packRedemptionError(
  redeemAgainst: string, unitsPerPack: number, unitsLabel: string,
): string | null {
  if (redeemAgainst) return null;
  return unitsPerPack > 0
    ? `This pack is sold in units — ${unitsLabel} a pack — so it has to name the meter those units belong to. A pack of telemetry events cannot pay for exported gigabytes.`
    : 'Say what this credit may be spent on.';
}

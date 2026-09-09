/**
 * What a late arrival is worth, and which way it can be settled.
 *
 * An open late arrival carries `amount: null` — nothing has been priced yet,
 * because pricing it *is* settling it. The settle dialog read that null and
 * told the operator "Not priced — the period was billed without naming a
 * price", which was false for every closure that names one, and then let them
 * choose between crediting and rebilling with no idea which way the money
 * went. Picking wrong came back as `This period is under-billed by 4750 minor
 * units, not over-billed. Resolve it as \`rebilled\`.` — the API's own words,
 * with the amount in minor units and the wire value of a radio button.
 *
 * `GET /v1/meter-period-closures/:id` re-prices the window on read and
 * returns `outstanding_amount`: the signed money the invoice still has to
 * move by. That is the same number the refusal is computed from, available
 * before anything is chosen, so the dialog can state the worth, offer only
 * the resolution the drift allows, and say why in the workspace's own money.
 */

/** Which way a billed period has drifted, and therefore how it may be settled. */
export type TrueUpDirection =
  /** The meter reads more than was billed: money is owed, so `rebilled`. */
  | 'under_billed'
  /** The meter reads less than was billed: money goes back, so `credited`. */
  | 'over_billed'
  /** The drift is real but the price gives it away free — either way, no money. */
  | 'free'
  /** The meter and the invoice agree again; there is nothing left to true up. */
  | 'agrees'
  /** The closure names no price, or its price can no longer value the window. */
  | 'unpriced';

export type TrueUpResolution = 'credited' | 'rebilled' | 'ignored';

/** The operator's word for each resolution — the radio, the button and the refusal share it. */
export const RESOLUTION_COPY: Readonly<Record<TrueUpResolution, string>> = {
  credited: 'Credit the difference',
  rebilled: 'Bill the difference',
  ignored: 'Leave it',
};

/** The period as the closure endpoint re-read it, which is what settling will price. */
export interface TrueUpBasis {
  /** Signed minor units the invoice still has to move by; null when it cannot be priced. */
  outstanding_amount: number | null;
  /** Signed units the meter has moved by since the freeze, true-ups included. */
  outstanding_quantity: number;
  /** The price the period was billed on, if it was billed on one. */
  price: string | null;
  currency: string | null;
}

export function trueUpDirection(basis: TrueUpBasis | null | undefined): TrueUpDirection | null {
  if (!basis) return null;
  if (basis.outstanding_quantity === 0) return 'agrees';
  if (!basis.price || basis.outstanding_amount === null) return 'unpriced';
  if (basis.outstanding_amount > 0) return 'under_billed';
  if (basis.outstanding_amount < 0) return 'over_billed';
  return 'free';
}

/**
 * The resolutions the server will accept for this drift. `ignored` is always
 * one of them — it is the only resolution that writes a word rather than
 * money, so it is the answer to every period that cannot be priced.
 */
export function allowedResolutions(direction: TrueUpDirection | null): TrueUpResolution[] {
  switch (direction) {
    case 'under_billed': return ['rebilled', 'ignored'];
    case 'over_billed': return ['credited', 'ignored'];
    case 'free': return ['credited', 'rebilled', 'ignored'];
    case 'agrees':
    case 'unpriced': return ['ignored'];
    // Nothing has been read back yet: offer everything and let the read
    // narrow it, rather than pre-selecting a direction we do not know.
    default: return ['credited', 'rebilled', 'ignored'];
  }
}

/**
 * Which resolution the dialog opens on. `credited` used to be hardcoded, so
 * the commonest drift — usage that arrived late, and is therefore owed —
 * opened on the one answer the server refuses.
 */
export function defaultResolution(direction: TrueUpDirection | null): TrueUpResolution {
  const allowed = allowedResolutions(direction);
  return allowed[0];
}

/**
 * Why a resolution is not on offer, in the direction's own terms. Shown on
 * the disabled option, so the reason is where the choice is rather than in a
 * refusal after the fact.
 */
export function resolutionBlockedBecause(
  resolution: TrueUpResolution,
  direction: TrueUpDirection | null,
  worth: string,
): string | null {
  if (allowedResolutions(direction).includes(resolution)) return null;
  switch (direction) {
    case 'under_billed':
      return `This period is under-billed by ${worth}, so there is nothing to credit — “${RESOLUTION_COPY.rebilled}” is what this drift needs.`;
    case 'over_billed':
      return `This period is over-billed by ${worth}, so there is nothing more to bill — “${RESOLUTION_COPY.credited}” is what this drift needs.`;
    case 'agrees':
      return 'The meter and the invoice agree again, so no money moves either way. Record the drift and move on.';
    case 'unpriced':
      return 'This period was billed without a price, so the drift cannot be valued — it can only be recorded.';
    default:
      return null;
  }
}

/**
 * What the worth line says. The direction is stated, not left to a minus
 * sign: "$47.50 the customer still owes" and "$47.50 owed back to the
 * customer" are opposite facts that a signed amount alone reads the same way
 * to anyone skimming.
 */
export function trueUpWorthText(
  direction: TrueUpDirection | null,
  opts: {
    /** `moneyIn(f, minor, currency)` over the unsigned amount. */
    money: (minor: number) => string;
    /** `units(f, n, unit_label)` over the unsigned quantity. */
    units: (count: number) => string;
    basis: TrueUpBasis | null | undefined;
    loading: boolean;
  },
): string {
  const { basis } = opts;
  if (!basis) return opts.loading ? 'Re-pricing the window…' : 'Not read yet';
  const amount = basis.outstanding_amount;
  switch (direction) {
    case 'under_billed':
      return `${opts.money(Math.abs(amount ?? 0))} the customer still owes — ${opts.units(Math.abs(basis.outstanding_quantity))} arrived after the invoice was drawn.`;
    case 'over_billed':
      return `${opts.money(Math.abs(amount ?? 0))} owed back to the customer — ${opts.units(Math.abs(basis.outstanding_quantity))} was billed and never used.`;
    case 'free':
      return `Nothing — ${opts.units(Math.abs(basis.outstanding_quantity))} of drift that this price does not charge for.`;
    case 'agrees':
      return 'Nothing — the meter and the invoice agree again.';
    case 'unpriced':
      return basis.price
        ? 'The price this period was billed on can no longer value the window, so the drift cannot be settled in money.'
        : 'Not priced — this period was frozen without a price, so there is nothing to re-price the drift against.';
    default:
      return 'Re-pricing the window…';
  }
}

/**
 * The refusal, in the reader's words.
 *
 * A `resolution` refusal is the server saying the drift runs the other way,
 * which the dialog now knows for itself — so it says it in the workspace's
 * money and with the label on the radio button, and never repeats an API
 * message that names minor units and a wire enum. Everything else is the
 * server's to explain and is passed through.
 */
export function trueUpRefusalText(
  error: { code: string; param: string | null; message: string },
  direction: TrueUpDirection | null,
  worth: string,
): string {
  if (error.param === 'resolution') {
    // The refused radio is whichever one the drift's direction rules out, and
    // `resolutionBlockedBecause` already names the one it needs instead.
    const refused: TrueUpResolution = direction === 'over_billed' ? 'rebilled' : 'credited';
    const because = resolutionBlockedBecause(refused, direction, worth);
    if (because) return because;
  }
  if (error.code === 'true_up_already_settled') {
    return 'The meter and the invoice agree again — another true-up settled this window while this dialog was open. Record the drift as “Leave it”.';
  }
  if (error.code === 'late_arrival_already_resolved') {
    return 'This window has already been settled, and a resolution that moved money is not replaced in place. Record the correction as its own adjustment.';
  }
  if (error.param === 'price') {
    return 'This period was frozen without a price, so the drift cannot be valued. Record it as “Leave it”.';
  }
  return error.message;
}

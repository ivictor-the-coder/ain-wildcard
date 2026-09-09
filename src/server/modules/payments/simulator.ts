/**
 * The simulated processor, and the whole of its honesty policy.
 *
 * There is no acquirer behind this platform. Rather than hide that behind a
 * random number generator, every payment method declares what it will do and
 * this file does exactly that, every time, forever. Two consequences follow,
 * and both are the point:
 *
 *  - a critic can trigger any decline on purpose — attach a method with
 *    `simulated_behavior: "incorrect_cvc"` and every charge against it comes
 *    back `incorrect_cvc`, with the outcome text an issuer would send;
 *  - a year of billing replays identically. Nothing here reads the wall clock
 *    or `Math.random`, so `POST /v1/time/advance` produces the same recovery
 *    story on every machine.
 *
 * `simulated_decline_count` is what makes recovery testable: a method set to
 * decline three times and then succeed is exactly the card that comes good
 * after payday, and it is the only way to prove the retry schedule works
 * without waiting three weeks.
 */
import type {
  ChargeOutcome, DeclineCode, DeclineSeverity, NetworkStatus, OutcomeType,
  PaymentMethodType, RiskLevel, SimulatedBehavior,
} from './types';

/** FNV-1a. Deterministic, dependency-free, and good enough to spread values. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface DeclineProfile {
  code: DeclineCode;
  severity: DeclineSeverity;
  outcome_type: OutcomeType;
  network_status: NetworkStatus;
  /** Forwardable to the customer as-is. */
  seller_message: string;
  /** For whoever has to get the money in. */
  advice: string;
  /** The error message on the intent. */
  message: string;
}

/**
 * The decline catalogue.
 *
 * Severity is the only field dunning reads, and it is the difference between a
 * retry schedule that recovers money and one that annoys customers: waiting
 * helps a `soft` decline, sometimes helps a `hard` one, and never once helped
 * a `final` one.
 */
export const DECLINES: Record<DeclineCode, DeclineProfile> = {
  insufficient_funds: {
    code: 'insufficient_funds',
    severity: 'soft',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card was declined for insufficient funds.',
    seller_message: 'The bank declined this payment because the account did not have enough available balance.',
    advice: 'Worth retrying — this is the decline most likely to clear on its own once the account is topped up or payday lands.',
  },
  card_declined: {
    code: 'card_declined',
    severity: 'hard',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card was declined.',
    seller_message: 'The bank declined this payment and did not say why. Their fraud rules are the usual cause.',
    advice: 'Retry later with a longer gap, but ask for a different card if the second attempt is refused the same way.',
  },
  do_not_honor: {
    code: 'do_not_honor',
    // Response code 05. It reads like a final refusal and is not one: the
    // networks file it under "issuer cannot approve at this time", alongside
    // insufficient funds, and it is the decline that clears most often on a
    // later presentation. It is the stolen/lost/pickup family below that the
    // issuer means never to see again.
    severity: 'hard',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card was declined: do not honor.',
    seller_message: 'The bank declined this payment without giving a reason. The cardholder has to ask their bank why.',
    advice: 'Worth one more presentation after a longer gap — this is the issuer’s generic refusal, and it often clears once the cardholder has spoken to their bank. Ask for a different card if it is refused the same way again.',
  },
  stolen_card: {
    code: 'stolen_card',
    severity: 'final',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card has been reported stolen.',
    seller_message: 'The bank has reported this card as stolen and will refuse every charge against it.',
    advice: 'Never present this card again — the network treats a retry on a stolen card as a merchant problem. Ask the customer for a different card, and do not tell them the reason the issuer gave.',
  },
  lost_card: {
    code: 'lost_card',
    severity: 'final',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card has been reported lost.',
    seller_message: 'The bank has reported this card as lost and will refuse every charge against it.',
    advice: 'Never present this card again. The customer has a replacement by now — ask for it, and do not tell them the reason the issuer gave.',
  },
  pickup_card: {
    code: 'pickup_card',
    severity: 'final',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The issuer has asked for the card to be retained.',
    seller_message: 'The bank has withdrawn this card and will refuse every charge against it.',
    advice: 'Never present this card again — a pick-up response is the issuer cancelling the card, not a temporary refusal. Ask the customer for a different one.',
  },
  fraudulent: {
    code: 'fraudulent',
    severity: 'final',
    outcome_type: 'blocked',
    network_status: 'declined_by_network',
    message: 'The payment was declined as fraudulent.',
    seller_message: 'The bank suspects this payment is fraudulent and has blocked it.',
    advice: 'Never present this card again. Confirm the account with the customer by a channel you already trust before taking a different card from them.',
  },
  restricted_card: {
    code: 'restricted_card',
    severity: 'final',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card cannot be used for this kind of payment.',
    seller_message: 'The bank has restricted this card and will not allow it to be charged like this.',
    advice: 'Stop retrying — the restriction is on the card itself, and every presentation gets the same answer. Ask the customer for a card that is not restricted.',
  },
  expired_card: {
    code: 'expired_card',
    severity: 'final',
    outcome_type: 'invalid',
    network_status: 'not_sent_to_network',
    message: 'The card has expired.',
    seller_message: 'The card on file has expired, so the bank will refuse every charge against it.',
    advice: 'Stop retrying and ask for a new card — no amount of waiting un-expires one.',
  },
  incorrect_cvc: {
    code: 'incorrect_cvc',
    // Final, not hard: the stored security code does not change between
    // attempts, so the second presentation sends the same wrong digits as the
    // first. Only a corrected card fixes it, which is what `final` means.
    severity: 'final',
    outcome_type: 'invalid',
    network_status: 'declined_by_network',
    message: 'The security code is incorrect.',
    seller_message: 'The bank rejected the card’s security code.',
    advice: 'The stored details are wrong and every retry sends the same wrong code. Ask the customer to re-enter the card, then present the bill again by hand.',
  },
  processing_error: {
    code: 'processing_error',
    severity: 'soft',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'An error occurred while processing the card.',
    seller_message: 'The payment could not be processed. This is usually a temporary fault at the bank.',
    advice: 'Retry — this one is on the network, not on the customer, and it usually clears within a day.',
  },
  authentication_required: {
    code: 'authentication_required',
    // The one severity that reads oddly and is nonetheless right. Waiting
    // cannot fix this — an off-session attempt is refused by construction, so
    // a retry schedule spends every attempt on an outcome it could never have
    // changed. What fixes it is the cardholder, and that is a person's job,
    // which is exactly the line `final` draws.
    severity: 'final',
    outcome_type: 'issuer_declined',
    network_status: 'declined_by_network',
    message: 'The card requires the cardholder to authenticate before it can be charged.',
    seller_message: 'The bank wants the cardholder to confirm this payment before it will go through.',
    advice: 'No off-session charge can ever satisfy this, however often it is retried. Present the bill again with the customer there — POST /v1/invoices/:id/retry with off_session=false — and approve it at the next_action that comes back. The issuer remembers the mandate afterwards, so later renewals collect on their own.',
  },
  account_closed: {
    code: 'account_closed',
    severity: 'final',
    outcome_type: 'invalid',
    network_status: 'not_sent_to_network',
    message: 'The bank account has been closed.',
    seller_message: 'The bank account this direct debit is set up against has been closed.',
    advice: 'Stop retrying and collect new bank details — a closed account never reopens.',
  },
  no_account: {
    code: 'no_account',
    severity: 'final',
    outcome_type: 'invalid',
    network_status: 'not_sent_to_network',
    message: 'The bank could not find an account matching these details.',
    seller_message: 'The bank could not find an account matching the details on file.',
    advice: 'The details are wrong. Ask for them again rather than retrying.',
  },
  debit_not_authorized: {
    code: 'debit_not_authorized',
    severity: 'hard',
    outcome_type: 'blocked',
    network_status: 'declined_by_network',
    message: 'The direct debit mandate does not authorise this debit.',
    seller_message: 'The account holder has not authorised this direct debit, or the mandate has been cancelled.',
    advice: 'Get the mandate re-signed. Retrying an unauthorised debit can cost a fee at some banks.',
  },
};

export const DECLINE_CODES = Object.keys(DECLINES) as DeclineCode[];

export const severityOf = (code: DeclineCode): DeclineSeverity => DECLINES[code].severity;

/* ------------------------------- the decision ----------------------------- */

export interface AttemptContext {
  /** The intent being confirmed — the risk score is derived from its id. */
  intentId: string;
  methodId: string;
  methodType: PaymentMethodType;
  behavior: SimulatedBehavior;
  /** Null means "declines forever", which is what a dead card does. */
  declineCount: number | null;
  /** How many charges this method has already taken, successful or not. */
  priorCharges: number;
  /** Nobody at the keyboard: a bank that wants authentication just declines. */
  offSession: boolean;
  /** The customer has already been through the authentication step. */
  authenticated: boolean;
  amount: number;
  currency: string;
}

export type SimulationResult =
  | { result: 'succeeded'; outcome: ChargeOutcome; authorizationCode: string }
  | { result: 'declined'; code: DeclineCode; profile: DeclineProfile; outcome: ChargeOutcome }
  | { result: 'requires_action'; description: string }
  | { result: 'processing'; settlesInDays: number; outcome: ChargeOutcome };

/** Days a direct debit sits in `processing` before the bank answers either way. */
export const BANK_DEBIT_SETTLEMENT_DAYS = 3;

const riskOf = (intentId: string): { score: number; level: RiskLevel } => {
  const score = hash32(`risk:${intentId}`) % 100;
  const level: RiskLevel = score >= 90 ? 'highest' : score >= 70 ? 'elevated' : 'normal';
  return { score, level };
};

const authorizationCodeFor = (intentId: string): string =>
  String(hash32(`auth:${intentId}`) % 1_000_000).padStart(6, '0');

/**
 * Would this attempt be declined?
 *
 * The method's behaviour says what the decline is; `simulated_decline_count`
 * says how many attempts it survives. Counting charges against the method
 * rather than against the invoice is deliberate: a card that is short of funds
 * is short of funds for every bill it is presented with, which is the same
 * thing the issuer sees.
 */
function declines(ctx: AttemptContext): boolean {
  if (ctx.behavior === 'succeeds') return false;
  if (ctx.declineCount === null) return true;
  return ctx.priorCharges < ctx.declineCount;
}

export function successOutcome(ctx: AttemptContext, network: NetworkStatus = 'approved_by_network'): ChargeOutcome {
  const risk = riskOf(ctx.intentId);
  return {
    type: 'authorized',
    network_status: network,
    reason: null,
    risk_level: risk.level,
    risk_score: risk.score,
    seller_message: network === 'pending_settlement'
      ? 'The bank accepted the debit instruction and will confirm settlement in a few days.'
      : 'Payment complete.',
    explanation: network === 'pending_settlement'
      ? `The mandate was accepted, so the debit is on its way. This one clears in ${BANK_DEBIT_SETTLEMENT_DAYS} days and can still be returned unpaid inside that window.`
      : `Authorised by the issuer on the first presentation${ctx.priorCharges > 0 ? `, after ${ctx.priorCharges} earlier attempt${ctx.priorCharges === 1 ? '' : 's'} on this method` : ''}.`,
  };
}

export function declineOutcome(ctx: AttemptContext, profile: DeclineProfile): ChargeOutcome {
  const risk = riskOf(ctx.intentId);
  return {
    type: profile.outcome_type,
    network_status: profile.network_status,
    reason: profile.code,
    risk_level: risk.level,
    risk_score: risk.score,
    seller_message: profile.seller_message,
    explanation: `${profile.seller_message} ${profile.advice}`,
  };
}

/**
 * Run one attempt against the simulated processor.
 *
 * The order of the branches is the order a real gateway resolves them: a card
 * that needs authentication is stopped before it reaches the network, a debit
 * is accepted for settlement rather than authorised on the spot, and only then
 * does the declared behaviour decide.
 */
export function simulate(ctx: AttemptContext): SimulationResult {
  // A card that only ever wanted the cardholder to confirm has now had that
  // confirmation. Refusing it a second time would make the authentication step
  // theatre rather than a step.
  const satisfied = ctx.behavior === 'authentication_required' && ctx.authenticated;
  if (satisfied || !declines(ctx)) {
    if (ctx.methodType === 'bank_debit') {
      return {
        result: 'processing',
        settlesInDays: BANK_DEBIT_SETTLEMENT_DAYS,
        outcome: successOutcome(ctx, 'pending_settlement'),
      };
    }
    return { result: 'succeeded', outcome: successOutcome(ctx), authorizationCode: authorizationCodeFor(ctx.intentId) };
  }

  // A bank that wants the cardholder present cannot be satisfied by a retry
  // schedule. On-session we can ask; off-session all we can do is report it,
  // which is exactly the decline code the networks defined for the situation.
  if (ctx.behavior === 'authentication_required' && !ctx.offSession && !ctx.authenticated) {
    return {
      result: 'requires_action',
      description: 'The issuer wants the cardholder to confirm this payment. Send them to the authentication step to approve it.',
    };
  }

  // A direct debit is not declined at the till: the instruction is accepted,
  // presented, and returned unpaid days later. Modelling that as an instant
  // decline is how a billing system reports a failure the bank has not made yet.
  if (ctx.methodType === 'bank_debit') {
    return {
      result: 'processing',
      settlesInDays: BANK_DEBIT_SETTLEMENT_DAYS,
      outcome: successOutcome(ctx, 'pending_settlement'),
    };
  }

  const profile = DECLINES[ctx.behavior as DeclineCode];
  return { result: 'declined', code: profile.code, profile, outcome: declineOutcome(ctx, profile) };
}

/** A debit that has been presented comes back one of exactly two ways. */
export type DebitSettlement =
  | Extract<SimulationResult, { result: 'succeeded' }>
  | Extract<SimulationResult, { result: 'declined' }>;

/** The answer a direct debit comes back with once it has been presented. */
export function settleBankDebit(ctx: AttemptContext): DebitSettlement {
  if (!declines(ctx)) {
    return { result: 'succeeded', outcome: successOutcome(ctx), authorizationCode: authorizationCodeFor(ctx.intentId) };
  }
  const code: DeclineCode = ctx.behavior === 'succeeds' ? 'processing_error' : (ctx.behavior as DeclineCode);
  const profile = DECLINES[code];
  return { result: 'declined', code, profile, outcome: declineOutcome(ctx, profile) };
}

/** What a method will do next time it is charged, in one sentence. */
export function describeBehavior(behavior: SimulatedBehavior, declineCount: number | null): string {
  if (behavior === 'succeeds') return 'Charges against this method are authorised.';
  const profile = DECLINES[behavior];
  if (declineCount === null || declineCount <= 0) return `Every charge against this method is declined: ${profile.message}`;
  return `The first ${declineCount} charge${declineCount === 1 ? '' : 's'} against this method ${declineCount === 1 ? 'is' : 'are'} declined (${profile.code}); after that it is authorised.`;
}

/** Deterministic, plausible last four digits for a simulated method. */
export const last4For = (seed: string): string => String(hash32(`last4:${seed}`) % 10_000).padStart(4, '0');

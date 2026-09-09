import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SignatureRecipe } from './types';

/**
 * A timestamped HMAC, signed the way Stripe signs one, because a subscriber
 * that has verified a Stripe webhook has already written this code.
 *
 * The timestamp is inside the signed material, not beside it. Signing the body
 * alone produces a signature that stays valid forever, so anyone who captures
 * one delivery can replay it at the subscriber for as long as the secret lives.
 * Binding the instant means a replay is only accepted inside the tolerance.
 */

/** `ain-signature: t=1788825600000,v1=<hex>`. */
export const SIGNATURE_HEADER = 'ain-signature';

/** Five minutes, the same window Stripe's libraries default to. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** The scheme id, so a second scheme can be added without breaking the first. */
export const SIGNATURE_SCHEME = 'v1';

export const signedPayload = (timestamp: number, body: string): string => `${timestamp}.${body}`;

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(signedPayload(timestamp, body)).digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},${SIGNATURE_SCHEME}=${sign(secret, timestamp, body)}`;
}

export interface ParsedSignature {
  timestamp: number | null;
  /** Every `v1=` in the header — a roll leaves two valid signatures for a while. */
  signatures: string[];
}

export function parseSignature(header: string): ParsedSignature {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 't' && /^-?\d+$/.test(value ?? '')) timestamp = Number(value);
    else if (key === SIGNATURE_SCHEME && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

export interface VerifyInput {
  payload: string;
  header: string;
  secret: string;
  now: number;
  toleranceMs?: number;
}

export interface SignatureCheck {
  object: 'webhook_signature_check';
  valid: boolean;
  /** Why not, in the words a subscriber should log. */
  reason: string;
  timestamp: number | null;
  age_ms: number | null;
  expected: string | null;
}

/**
 * Constant-time on the comparison, because a byte-at-a-time `===` on a
 * signature is a timing oracle a patient caller can walk to a forgery.
 */
const equals = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export function verify(input: VerifyInput): SignatureCheck {
  const tolerance = input.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  const parsed = parseSignature(input.header);
  if (parsed.timestamp === null) {
    return {
      object: 'webhook_signature_check', valid: false, timestamp: null, age_ms: null, expected: null,
      reason: `The header carries no t= timestamp, so there is nothing to sign. Expected "t=<unix ms>,${SIGNATURE_SCHEME}=<hex>".`,
    };
  }
  const expected = sign(input.secret, parsed.timestamp, input.payload);
  const age = input.now - parsed.timestamp;
  if (!parsed.signatures.length) {
    return {
      object: 'webhook_signature_check', valid: false, timestamp: parsed.timestamp, age_ms: age, expected,
      reason: `The header carries no ${SIGNATURE_SCHEME}= signature.`,
    };
  }
  // The signature is checked before the age. A stale-but-genuine delivery and a
  // forgery are different problems, and reporting the first as the second sends
  // an integrator hunting a clock skew that is not there.
  if (!parsed.signatures.some((candidate) => equals(candidate, expected))) {
    return {
      object: 'webhook_signature_check', valid: false, timestamp: parsed.timestamp, age_ms: age, expected,
      reason: 'No signature in the header matches this payload under this secret. Sign the raw request body — the bytes as they arrived, before any JSON round-trip.',
    };
  }
  if (Math.abs(age) > tolerance) {
    return {
      object: 'webhook_signature_check', valid: false, timestamp: parsed.timestamp, age_ms: age, expected,
      reason: `The signature is genuine but the timestamp is ${Math.round(Math.abs(age) / 1000)}s ${age > 0 ? 'old' : 'in the future'}, past the ${Math.round(tolerance / 1000)}s tolerance. Reject it as a replay.`,
    };
  }
  return {
    object: 'webhook_signature_check', valid: true, timestamp: parsed.timestamp, age_ms: age, expected,
    reason: 'The signature matches this payload under this endpoint’s secret, inside the replay window.',
  };
}

export const signatureRecipe = (): SignatureRecipe => ({
  header: SIGNATURE_HEADER,
  algorithm: 'hmac-sha256',
  format: `t=<unix ms>,${SIGNATURE_SCHEME}=<hex hmac>`,
  signed_payload: '<t> + "." + <the raw request body>',
  tolerance_ms: SIGNATURE_TOLERANCE_MS,
  instructions:
    `Read ${SIGNATURE_HEADER}, split it on commas into t= and ${SIGNATURE_SCHEME}=, and compute `
    + 'HMAC-SHA256 over `${t}.${rawBody}` with this endpoint’s signing secret. Compare in constant time, '
    + 'then reject anything whose t is more than the tolerance away from your own clock. Match against every '
    + `${SIGNATURE_SCHEME}= value in the header, not just the first: the scheme allows more than one, and rolling `
    + 'the secret takes effect on the next attempt, so re-deploy the new secret before you roll.',
});

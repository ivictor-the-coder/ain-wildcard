/**
 * What handing over an invitation link actually sets in motion.
 *
 * `POST /v1/auth/accept` does one of two things, and the workspace is on the
 * wrong side of the only fact that decides which: whether that address already
 * signs in to Ain. An address Ain has never seen is *enrolled* — the password
 * it is given becomes the one it signs in with from then on. An address that
 * already has an account is *verified* — the password it is given is checked
 * against the one that account already holds, and this workspace never writes
 * it. That asymmetry is the fix for the platform's worst hole: identity is one
 * global row with one shared `password_hash`, so a workspace that could set it
 * through an invitation could set it for every *other* workspace the person
 * belongs to, and any admin anywhere could invite `dana@northwind.io`, accept
 * their own invitation with a password of their choosing, and walk into
 * Northwind as its owner.
 *
 * Which is why nothing here says "they set a password". That is true for half
 * the people who will open the link and false for the other half, and no
 * screen can tell them apart: `GET /v1/auth/invitations/:token` withholds
 * whether the address is known to Ain on purpose — the person holding the link
 * first is the admin who minted it, and "is this address already on Ain?" is
 * not theirs to learn. So every sentence about redeeming a link is written to
 * be true in both branches, and it is written once, here, because the roster
 * says it in four places.
 */
import type { Role } from './types';

/** `an admin`, `a member` — the ladder's own words, with the right article. */
export const withArticle = (role: Role): string => (/^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`);

/**
 * The clause every sentence about redeeming a link has to carry. It never
 * promises a password is chosen, and never asks the reader which half they are
 * in — the accept screen finds that out from the answer, not from the link.
 */
export const CREDENTIAL_RULE =
  'they confirm their Ain password — the one they already sign in with, or one they choose now if this address is new '
  + 'to Ain';

/** What the link does when it is opened, for the admin about to pass it on. */
export const whatTheLinkDoes = (role: Role): string =>
  `Opens /accept, where ${CREDENTIAL_RULE}. They land in the workspace as ${withArticle(role)}. It works once.`;

import type { Me, UserId } from "@ember/protocol";
import { clientOf, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { jsonBodyOf } from "./bodies";
import { toBase64url } from "./encoding";
import { guestSignIn, type Env } from "./env";
import { notFound } from "./error-pages";
import { hmacKey } from "./hmac";
import { appPage, empty, formAnswer } from "./pages";
import { workspace } from "./workspace";

// Sign-in links, as Campfire's session transfers are: opening one signs that browser in as the person
// its id was made for, until it expires. Campfire's link is `/session/transfers/<id>`; this one keeps
// the id in its fragment (`transferLink`), and its page sends it in a request's body, so no address the
// Worker is asked for, nor Cloudflare's log of one, holds it. The id is a Rails signed id of the person;
// this one is their id, the session that showed it and when it expires, signed with SESSION_SECRET as
// avatar tokens are, so changing the secret ends every link, as changing Campfire's SECRET_KEY_BASE
// does. Unlike Campfire's, a link works only while that session is still signed in as someone who may
// show it: the person it's for, or an active administrator. So whatever ends a session, signing out, a
// password reset, a removal or a ban, ends the links it showed, and losing administrator rights ends the
// links an administrator showed of others. A new password saved from a profile, and Disconnect Memberful,
// end their person's other sessions but keep the one that asks, so they end the links it showed until
// then instead. A link was shown 4 hours before it expires, by the Workspace's clock, which also says
// when its session's links ended, so the two compare.

/** `User::Transferable::TRANSFER_LINK_EXPIRY_DURATION`. */
export const TRANSFER_LINK_EXPIRY_MS = 4 * 60 * 60 * 1000;

/** What a sign-in link says: whom it signs in, the session that showed it, and when. */
export interface Transfer {
  userId: UserId;
  /** The id of the session whose page showed the link. */
  sessionId: string;
  /** When it showed it, in milliseconds, by the Workspace's clock. */
  shownAt: number;
}

const encoder = new TextEncoder();

/** What signs `transfer`'s link that expires at `expiresAt`: its HMAC under `secret`, as base64url. */
async function signatureOf({ userId, sessionId }: Transfer, expiresAt: string, secret: string): Promise<string> {
  const signed = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(JSON.stringify(["transfer", userId, sessionId, expiresAt])));
  return toBase64url(new Uint8Array(signed));
}

/**
 * `user.transfer_id`: the id of a new sign-in link for `transfer`, which works for 4 hours from when it
 * was shown, as often as it's opened, while its session lasts:
 * `<their id>.<the session's id>.<when it expires, in base 36 milliseconds>.<signature>`.
 */
export async function newTransferId(transfer: Transfer, secret: string): Promise<string> {
  const expiresAt = (transfer.shownAt + TRANSFER_LINK_EXPIRY_MS).toString(36);
  return `${transfer.userId}.${transfer.sessionId}.${expiresAt}.${await signatureOf(transfer, expiresAt, secret)}`;
}

/**
 * `User.find_by_transfer_id`: what `transferId` says, or null unless `newTransferId` made it under
 * `secret` and it hasn't expired by `now`. The person's id comes last but three, so a dot in it can't
 * move the rest.
 */
export async function transferOf(transferId: string, secret: string, now: number): Promise<Transfer | null> {
  const parts = transferId.split(".");
  const [sessionId, expiresAt, signature] = parts.splice(-3);
  const userId = parts.join(".");
  if (!userId || !sessionId || !expiresAt || !signature) return null;
  const expiry = Number.parseInt(expiresAt, 36);
  const transfer = { userId, sessionId, shownAt: expiry - TRANSFER_LINK_EXPIRY_MS };
  const [given, expected] = [encoder.encode(signature), encoder.encode(await signatureOf(transfer, expiresAt, secret))];
  if (given.length !== expected.length || !crypto.subtle.timingSafeEqual(given, expected)) return null;
  return now < expiry ? transfer : null;
}

/**
 * `GET /session/transfers`, for anyone, signed in or not: the app's page, which signs in with the id in
 * its fragment straight away.
 */
export async function transferPage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(request);
  return appPage(request, env, "/");
}

/**
 * `POST /api/session/transfers`, with the link's id (`LinkSignIn`): signs this browser in as the person
 * the id names, with a session of its own that replaces any it had without ending it, and answers who
 * that is. An id that's expired, tampered with or made up, or one for someone who's no longer active,
 * answers 400 with nothing else, as there, and so does a guest's while guests can't sign in, one whose
 * session can no longer show it or has ended the links it showed until then, or a body without an id.
 */
export async function transferSession(request: Request, env: Env): Promise<Response> {
  // Any JSON value parses, null and numbers included, so don't assume an object.
  const body: unknown = await jsonBodyOf(request);
  const transferId = typeof body === "object" && body !== null ? (body as Record<string, unknown>).transferId : undefined;
  const transfer = typeof transferId === "string" ? await transferOf(transferId, env.SESSION_SECRET, Date.now()) : null;
  if (!transfer) return empty(400);
  const token = newSessionToken();
  const user = await workspace(env).transferSession(transfer, await tokenDigest(token, env.SESSION_SECRET), clientOf(request), guestSignIn(env));
  return user ? formAnswer({ user } satisfies { user: Me }, 201, sessionCookie(request, token)) : empty(400);
}

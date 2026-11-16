import { ASSISTANT_ID, type UserId } from "@ember/protocol";
import { toBase64url } from "./encoding";
import { hmacKey } from "./hmac";
import { VERSION } from "./version";
import type { DirectoryEntry } from "./workspace-store";

// The addresses of people's avatars, /users/<token>/avatar?v=<version>, which the people directory and
// `user.updated` frames give out and avatars.ts serves. The token names someone and is signed so nobody
// can make one up, and the version changes whenever they do. @ember's picture comes with Ember, so its
// address names the release too (&release=<version>): browsers keep an avatar for half an hour, and
// would go on showing @ember's old picture after an update that changes it.

const encoder = new TextEncoder();

/** How much of its HMAC a token keeps. */
const SIGNATURE_BYTES = 16;

/**
 * Makes `User#avatar_token`s: someone's id and the first 16 bytes of its HMAC under SESSION_SECRET, as
 * base64url. They never expire, and changing the secret changes them all, as changing Campfire's
 * `SECRET_KEY_BASE` does.
 */
async function avatarTokens(secret: string): Promise<(userId: UserId) => Promise<string>> {
  const key = await hmacKey(secret);
  return async (userId) => {
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`avatar:${userId}`));
    return `${userId}.${toBase64url(new Uint8Array(signature, 0, SIGNATURE_BYTES))}`;
  };
}

/** Whose avatar `token` is, or null unless it's one `avatarTokens` made under `secret`. */
export async function avatarTokenUser(token: string, secret: string): Promise<UserId | null> {
  const userId = token.slice(0, Math.max(token.lastIndexOf("."), 0));
  if (!userId) return null;
  const [given, expected] = [encoder.encode(token), encoder.encode(await (await avatarTokens(secret))(userId))];
  return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected) ? userId : null;
}

/** `updated_at.to_fs(:number)`: when someone or something last changed, to the second, as 14 digits. */
export const versionOf = (updatedAt: string) => updatedAt.slice(0, 19).replace(/\D/g, "");

/** The address of the avatar `token` names, for someone who last changed at `updatedAt`. */
function avatarPath(userId: UserId, token: string, updatedAt: string): string {
  const path = `/users/${encodeURIComponent(token)}/avatar?v=${versionOf(updatedAt)}`;
  return userId === ASSISTANT_ID ? `${path}&release=${VERSION}` : path;
}

/**
 * The tokens the directory has listed, under the secret that made them, since signing is most of what
 * listing everyone costs. Only people the directory lists go in, so nobody can fill it with made-up ids.
 */
let listed = { secret: "", tokens: new Map<UserId, string>() };

/**
 * The people directory's entries, each with its avatar's address: `user_avatar_path(user.avatar_token, v: ...)`,
 * `agent` only for an AI agent's, and `adminsOnly` only for one kept for administrators.
 */
export async function directoryOf<Entry extends DirectoryEntry>(
  entries: Entry[],
  secret: string,
): Promise<Array<Omit<Entry, "updatedAt" | "agent" | "keptFor"> & { avatarUrl: string; agent?: true; adminsOnly?: true }>> {
  if (listed.secret !== secret) listed = { secret, tokens: new Map() };
  const { tokens } = listed;
  const tokenOf = await avatarTokens(secret);
  return Promise.all(
    entries.map(async ({ updatedAt, agent, keptFor, ...user }) => {
      let token = tokens.get(user.id);
      if (token === undefined) tokens.set(user.id, (token = await tokenOf(user.id)));
      return { ...user, avatarUrl: avatarPath(user.id, token, updatedAt), ...(agent && { agent }), ...(keptFor !== null && { adminsOnly: true as const }) };
    }),
  );
}

/**
 * A change to someone's picture in the same second as their last change, which waits `ms` for the next.
 * Their avatar's address counts whole seconds, and browsers keep the picture they have at an address.
 * Waiting, rather than dating the change a second ahead, keeps every change in the past, so a change
 * that follows, dated now, can't take the address back to one an earlier picture had.
 */
export class TooSoon {
  constructor(readonly ms: number) {}
}

/** TooSoon, for a change made `now` to the picture of someone who last changed at `updatedAt`, or null once it's a later second. */
export function tooSoonAfter(updatedAt: string, now: number): TooSoon | null {
  const wait = (Math.floor(Date.parse(updatedAt) / 1000) + 1) * 1000 - now;
  // Changes are dated by this clock, so that's a second at most; one dated by another clock, ahead of it, isn't waited for.
  return wait > 0 && wait <= 1000 ? new TooSoon(wait) : null;
}

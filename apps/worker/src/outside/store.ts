import type { UserId } from "@ember/protocol";
import { statement, type Db } from "../db";
import { ACTIVE, setSetting } from "../workspace-store";

// What the Workspace keeps of outside AI (migrations/0062_outside_ai.sql): the AI apps that registered
// themselves, and each app connected as one person, from the code its person's answer sends it back
// with to the tokens it then asks with, and the refresh tokens it has replaced. Every token is kept as
// its digest alone.

/** An AI app that registered itself: the id Ember gave it, the name it gave, and where it may have a browser sent back. */
export interface OutsideClient {
  id: string;
  name: string;
  redirectUris: string[];
}

/** A connection as its person's answer begins it: the app, what it's allowed, and the code it's sent back with, by its digest, with the challenge it proves it began with. */
export interface NewOutsideConnection {
  id: string;
  userId: UserId;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  resource: string | null;
  codeDigest: string;
  codeChallenge: string;
  codeExpiresAt: string;
}

/** The tokens of a connection, by their digests, with when each expires. */
export interface OutsideTokens {
  accessDigest: string;
  accessExpiresAt: string;
  refreshDigest: string;
  refreshExpiresAt: string;
}

/** A connection as Ember keeps it: whose, which app's, what it's allowed, and whether the app has exchanged its code for tokens. */
export interface StoredOutsideConnection {
  id: string;
  userId: UserId;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  resource: string | null;
  codeChallenge: string;
  codeExpiresAt: string;
  exchanged: boolean;
  refreshExpiresAt: string | null;
  createdAt: string;
  usedAt: string | null;
}

interface ConnectionRow {
  id: string;
  user_id: UserId;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scope: string;
  resource: string | null;
  code_challenge: string;
  code_expires_at: string;
  access_digest: string | null;
  refresh_expires_at: string | null;
  created_at: string;
  used_at: string | null;
}

const connection = (row: ConnectionRow): StoredOutsideConnection => ({
  id: row.id,
  userId: row.user_id,
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUri: row.redirect_uri,
  scope: row.scope,
  resource: row.resource,
  codeChallenge: row.code_challenge,
  codeExpiresAt: row.code_expires_at,
  exchanged: row.access_digest !== null,
  refreshExpiresAt: row.refresh_expires_at,
  createdAt: row.created_at,
  usedAt: row.used_at,
});

// A connection is good only while its person is: active, and not someone who signed in with just a name.
const CONNECTIONS = `SELECT c.id, c.user_id, c.client_id, c.client_name, c.redirect_uri, c.scope, c.resource, c.code_challenge, c.code_expires_at,
    c.access_digest, c.refresh_expires_at, c.created_at, c.used_at
  FROM outside_connections AS c JOIN users ON users.id = c.user_id AND users.status = ${ACTIVE} AND users.guest = 0`;

const SET_OUTSIDE_AI = setSetting("outside_ai");

/** Forgets the spent refresh tokens of connections that are gone: it goes in the batch of whatever forgets connections. */
export const FORGET_SPENT_OF_FORGOTTEN = `DELETE FROM outside_spent_tokens WHERE connection_id NOT IN (SELECT id FROM outside_connections)`;

export class OutsideStore {
  constructor(private readonly db: Db) {}

  /** Turns outside AI on or off, recording when. Turning it off forgets every connection and every app that registered. */
  async turn(on: boolean, now: string): Promise<void> {
    await this.db.batch([
      statement(SET_OUTSIDE_AI, JSON.stringify(on), now),
      ...(on ? [] : [statement(`DELETE FROM outside_connections`), statement(`DELETE FROM outside_spent_tokens`), statement(`DELETE FROM outside_clients`)]),
    ]);
  }

  /**
   * Keeps `client`, an app that registered itself, unless Ember keeps `max` already: answers whether it
   * did. Once there are that many, the ones registered before `staleBefore` that nobody is connecting
   * or connected through are forgotten first: a connection whose code or refresh token has expired
   * keeps no app.
   */
  async register(client: OutsideClient, now: string, max: number, staleBefore: string): Promise<boolean> {
    const [, registered] = (await this.db.batch([
      statement(
        `DELETE FROM outside_clients WHERE created_at < ?1 AND (SELECT count(*) FROM outside_clients) >= ?2
           AND NOT EXISTS (SELECT 1 FROM outside_connections WHERE client_id = outside_clients.id
             AND ((access_digest IS NULL AND code_expires_at > ?3) OR (access_digest IS NOT NULL AND refresh_expires_at > ?3)))`,
        staleBefore,
        max,
        now,
      ),
      statement(
        `INSERT INTO outside_clients (id, name, redirect_uris, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE (SELECT count(*) FROM outside_clients) < ?5 RETURNING id`,
        ...[client.id, client.name, JSON.stringify(client.redirectUris), now, max],
      ),
    ])) as [unknown[], unknown[]];
    return registered.length > 0;
  }

  /** The app that registered itself as `id`, or null. */
  async client(id: string): Promise<OutsideClient | null> {
    const [row] = await this.db.all<{ id: string; name: string; redirect_uris: string }>(`SELECT id, name, redirect_uris FROM outside_clients WHERE id = ?`, id);
    return row ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  /**
   * Begins `begun`, unless its person has `max` connections already: answers whether it did. Theirs
   * that came to nothing are forgotten first: the ones whose code expired unexchanged, and whose
   * refresh token has.
   */
  async begin(begun: NewOutsideConnection, now: string, max: number): Promise<boolean> {
    const [, , , kept] = (await this.db.batch([
      statement(`DELETE FROM outside_connections WHERE user_id = ? AND access_digest IS NULL AND code_expires_at <= ?`, begun.userId, now),
      statement(`DELETE FROM outside_connections WHERE user_id = ? AND refresh_expires_at <= ?`, begun.userId, now),
      statement(FORGET_SPENT_OF_FORGOTTEN),
      statement(
        `INSERT INTO outside_connections (id, user_id, client_id, client_name, redirect_uri, scope, resource, code_digest, code_challenge, code_expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE (SELECT count(*) FROM outside_connections WHERE user_id = ?2) < ?12 RETURNING id`,
        ...[begun.id, begun.userId, begun.clientId, begun.clientName, begun.redirectUri, begun.scope, begun.resource, begun.codeDigest, begun.codeChallenge, begun.codeExpiresAt, now, max],
      ),
    ])) as [unknown[], unknown[], unknown[], unknown[]];
    return kept.length > 0;
  }

  /** The connection whose code has the digest `codeDigest`, exchanged or not, or null. */
  async byCode(codeDigest: string): Promise<StoredOutsideConnection | null> {
    const [row] = await this.db.all<ConnectionRow>(`${CONNECTIONS} WHERE c.code_digest = ?`, codeDigest);
    return row ? connection(row) : null;
  }

  /**
   * Gives the connection `id` its first `tokens`, while its code is unexchanged and hasn't expired:
   * answers whether it was. A connection that began without saying where it connects to is for
   * `resource` from now on, if that's given.
   */
  async exchange(id: string, tokens: OutsideTokens, resource: string | null, now: string): Promise<boolean> {
    const [exchanged] = (await this.db.batch([
      statement(
        `UPDATE outside_connections SET access_digest = ?, access_expires_at = ?, refresh_digest = ?, refresh_expires_at = ?, resource = coalesce(resource, ?)
         WHERE id = ? AND access_digest IS NULL AND code_expires_at > ? RETURNING id`,
        ...[tokens.accessDigest, tokens.accessExpiresAt, tokens.refreshDigest, tokens.refreshExpiresAt, resource, id, now],
      ),
    ])) as [unknown[]];
    return exchanged.length > 0;
  }

  /** The connection whose refresh token has the digest `refreshDigest`, or null. */
  async byRefresh(refreshDigest: string): Promise<StoredOutsideConnection | null> {
    const [row] = await this.db.all<ConnectionRow>(`${CONNECTIONS} WHERE c.refresh_digest = ?`, refreshDigest);
    return row ? connection(row) : null;
  }

  /**
   * Gives the connection `id` its next `tokens`, in place of the ones the refresh token with the digest
   * `was` came with, while that's still its refresh token: answers whether it was. The one it replaces
   * is kept as spent, until `now` passes when it would have expired.
   */
  async rotate(id: string, was: string, tokens: OutsideTokens, now: string): Promise<boolean> {
    const [, , rotated] = (await this.db.batch([
      statement(`DELETE FROM outside_spent_tokens WHERE connection_id = ? AND expires_at <= ?`, id, now),
      statement(
        `INSERT INTO outside_spent_tokens (digest, connection_id, expires_at)
         SELECT refresh_digest, id, refresh_expires_at FROM outside_connections WHERE id = ? AND refresh_digest = ?`,
        id,
        was,
      ),
      statement(
        `UPDATE outside_connections SET access_digest = ?, access_expires_at = ?, refresh_digest = ?, refresh_expires_at = ?
         WHERE id = ? AND refresh_digest = ? RETURNING id`,
        ...[tokens.accessDigest, tokens.accessExpiresAt, tokens.refreshDigest, tokens.refreshExpiresAt, id, was],
      ),
    ])) as [unknown[], unknown[], unknown[]];
    return rotated.length > 0;
  }

  /**
   * Forgets the connection one of whose refresh tokens, spent since, has the digest `spentDigest`:
   * something has a copy of it. One that would have expired by `now` ends nothing, whether or not it's
   * been forgotten yet, as any expired token is only refused.
   */
  async forgetSpent(spentDigest: string, now: string): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM outside_connections WHERE id IN (SELECT connection_id FROM outside_spent_tokens WHERE digest = ? AND expires_at > ?)`, spentDigest, now),
      statement(FORGET_SPENT_OF_FORGOTTEN),
    ]);
  }

  /** The connection whose access token has the digest `accessDigest`, while that hasn't expired, or null. */
  async byAccess(accessDigest: string, now: string): Promise<StoredOutsideConnection | null> {
    const [row] = await this.db.all<ConnectionRow>(`${CONNECTIONS} WHERE c.access_digest = ? AND c.access_expires_at > ?`, accessDigest, now);
    return row ? connection(row) : null;
  }

  /** Records that the app of the connection `id` asked Ember something at `now`. */
  async touch(id: string, now: string): Promise<void> {
    await this.db.batch([statement(`UPDATE outside_connections SET used_at = ? WHERE id = ?`, now, id)]);
  }

  /** Forgets the connection `id`. */
  async forget(id: string): Promise<void> {
    await this.db.batch([statement(`DELETE FROM outside_connections WHERE id = ?`, id), statement(`DELETE FROM outside_spent_tokens WHERE connection_id = ?`, id)]);
  }

  /** Forgets the connection of the app `clientId` one of whose tokens has the digest `tokenDigest`, if there is one. */
  async forgetByToken(tokenDigest: string, clientId: string): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM outside_connections WHERE access_digest = ? AND client_id = ?`, tokenDigest, clientId),
      statement(`DELETE FROM outside_connections WHERE refresh_digest = ? AND client_id = ?`, tokenDigest, clientId),
      statement(FORGET_SPENT_OF_FORGOTTEN),
    ]);
  }

  /** The apps connected as `userId`, newest first: the ones that exchanged their code, whose refresh token hasn't expired. */
  async connectionsOf(userId: UserId, now: string): Promise<StoredOutsideConnection[]> {
    const rows = await this.db.all<ConnectionRow>(
      `${CONNECTIONS} WHERE c.user_id = ? AND c.access_digest IS NOT NULL AND c.refresh_expires_at > ? ORDER BY c.created_at DESC, c.id DESC`,
      userId,
      now,
    );
    return rows.map(connection);
  }

  /** Forgets the connection `id` of `userId`'s: answers whether they had it. */
  async disconnect(userId: UserId, id: string): Promise<boolean> {
    const [forgotten] = (await this.db.batch([
      statement(`DELETE FROM outside_connections WHERE id = ? AND user_id = ? RETURNING id`, id, userId),
      statement(FORGET_SPENT_OF_FORGOTTEN),
    ])) as [unknown[], unknown[]];
    return forgotten.length > 0;
  }
}

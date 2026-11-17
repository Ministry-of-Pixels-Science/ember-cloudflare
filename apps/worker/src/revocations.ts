import type { CloseCode, RoomId } from "@ember/protocol";
import { statement, type Db } from "./db";

// Revoking access to rooms: what the Workspace's outbox asks of a room (src/workspace.ts), and the
// room's record of when it revoked access, by socket tag, in its own SQLite storage or in D1 (see
// db.ts), and in memory while the room runs.

/** The sockets one revocation closes in a room, and what it closes them with. */
export interface Revocation {
  /** A person's id, for all their sockets, `sessionTag(id)` for one session's, `addressTag(ip)` for those from an IP address, `EVERYONE`, or `OPEN_ROOMS_ONLY`. */
  tag: string;
  code: CloseCode;
}

/** What the tag on a session's sockets starts with. */
export const SESSION_TAG_PREFIX = "s:";

/** The tag on the sockets a session opens, besides its person's id, so revoking the session can find them. */
export const sessionTag = (sessionId: string) => `${SESSION_TAG_PREFIX}${sessionId}`;

/** What the tag on the sockets from an IP address starts with. */
export const ADDRESS_TAG_PREFIX = "ip:";

/** The tag on the sockets from an IP address, so banning it, or lifting the ban, can find them. */
export const addressTag = (ipAddress: string) => `${ADDRESS_TAG_PREFIX}${ipAddress}`;

/** The longest an IP address is written, as IPv6 ending in IPv4's form: no tag needs to be longer. */
export const MAX_ADDRESS_LENGTH = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255".length;

/**
 * The tag a revocation names to close every socket in a room, which deleting the room does. No socket
 * carries it, and no person's id or session's tag can be it.
 */
export const EVERYONE = "*";

/**
 * The tag a revocation names once a room open to everyone is made private, for the AI apps that reach
 * only open rooms (`outside/tools`), as they send as someone still in it: the room turns away what the
 * Workspace let them send before. No socket carries it, and no person's id or session's tag can be it.
 */
export const OPEN_ROOMS_ONLY = "*open";

/**
 * How long the Workspace's word that someone may open a room holds. The Worker passes it on at once,
 * so an older one has been held up somewhere, and its socket is told to connect again for a new one.
 */
export const AUTHORIZATION_TTL_MS = 60_000;

/**
 * How long a room keeps a revocation: an authorization's lifetime, with a few more minutes in case
 * the Workspace's clock and the room's disagree.
 */
export const REVOCATIONS_KEPT_MS = 5 * AUTHORIZATION_TTL_MS;

/** Records revocations of a JSON list of tags at one time, keeping the latest for each. */
const RECORD = `INSERT INTO revocations (room_id, tag, revoked_at) SELECT ?, value, ? FROM json_each(?) WHERE true
  ON CONFLICT (room_id, tag) DO UPDATE SET revoked_at = max(revoked_at, excluded.revoked_at)`;

export class Revocations {
  /** The room's revocations kept from before, once read: an authorization never needs older ones. */
  private recent: Map<string, number> | null = null;

  constructor(
    private readonly db: Db,
    readonly roomId: RoomId,
  ) {}

  /**
   * Whether to turn away a socket that the Workspace let through for `tags` at `authorizedAt`: it
   * may have been checked before one of them lost access here, or before the room was deleted, or
   * it's too old to trust.
   */
  async refuse(tags: string[], authorizedAt: number, now = Date.now()): Promise<boolean> {
    if (!(now - authorizedAt <= AUTHORIZATION_TTL_MS)) return true;
    const recent = await this.read(now);
    // At or before: the clock only counts milliseconds, and a check in the same one as the
    // revocation may have read what came before it.
    return [...tags, EVERYONE].some((tag) => authorizedAt <= (recent.get(tag) ?? -Infinity));
  }

  /** Records that the Workspace revoked `tags` at `revokedAt`, forgetting revocations too old to matter. */
  async record(tags: string[], revokedAt: number, now = Date.now()): Promise<void> {
    const recent = await this.read(now);
    await this.db.batch([
      statement(`DELETE FROM revocations WHERE room_id = ? AND revoked_at < ?`, this.roomId, now - REVOCATIONS_KEPT_MS),
      statement(RECORD, this.roomId, revokedAt, JSON.stringify(tags)),
    ]);
    for (const [tag, at] of recent) if (at < now - REVOCATIONS_KEPT_MS) recent.delete(tag);
    for (const tag of tags) recent.set(tag, Math.max(revokedAt, recent.get(tag) ?? -Infinity));
  }

  /** Forgets every revocation here, once a deleted room's record of its deletion has served its time. */
  async forget(): Promise<void> {
    await this.db.run(`DELETE FROM revocations WHERE room_id = ?`, this.roomId);
    this.recent = new Map();
  }

  private async read(now: number): Promise<Map<string, number>> {
    if (!this.recent) {
      const rows = await this.db.all<{ tag: string; revoked_at: number }>(
        `SELECT tag, revoked_at FROM revocations WHERE room_id = ? AND revoked_at >= ?`,
        this.roomId,
        now - REVOCATIONS_KEPT_MS,
      );
      this.recent = new Map(rows.map((row) => [row.tag, row.revoked_at]));
    }
    return this.recent;
  }
}

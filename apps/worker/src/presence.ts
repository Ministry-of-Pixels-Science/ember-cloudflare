import type { UserId, WorkspaceServerFrame } from "@ember/protocol";

/**
 * How long a workspace socket counts after the Workspace last heard from it, as a room socket counts for
 * viewing (viewing.ts): the app pings every 25 seconds, so only a connection that dropped without closing
 * goes this long unheard.
 */
export const PRESENCE_TTL_MS = 60_000;

/**
 * How long changes to who's active are gathered before they're told, so that a tab reloading tells of
 * nothing, and a deploy's reconnects go out in a few frames rather than one each.
 */
export const PRESENCE_GATHERING_MS = 1_000;

/** What a workspace socket's attachment keeps of its tab's presence. */
interface SocketPresence {
  userId: UserId;
  /** Whether the tab is in use, as it last said, or since it connected, until it says. */
  active: boolean;
  /** Whether the tab has said, which has it hear who's active. */
  listening: boolean;
  /** When the Workspace last heard from the socket, other than its pings: as it connected, or as it last said. */
  heardAt: number;
}

/** What `socket`'s attachment keeps of its presence, or null for one let in before it kept any. */
const presenceOf = (socket: WebSocket) => socket.deserializeAttachment() as SocketPresence | null;

/** Sends `data` on `socket`, unless it has closed since, which leaves nothing to clean up. */
function sendOn(socket: WebSocket, data: string): void {
  try {
    socket.send(data);
  } catch {
    // Its close handler notes that it closed.
  }
}

/**
 * Who's active in the workspace, as Slack shows it: someone with a tab open that's in use, which the
 * Workspace has heard from lately (`PRESENCE_TTL_MS`), and everyone else is away. Each socket keeps its
 * presence in its attachment, which hibernation keeps. What the tabs that listen were last told is kept
 * in memory, and guessed from the sockets once the Workspace wakes. Changes go to the tabs that listen,
 * gathered over `PRESENCE_GATHERING_MS`.
 */
export class Presence {
  /** Who the tabs listening were last told is active, or null once the Workspace has woken, until it guesses. */
  private told: Set<UserId> | null = null;
  /** Whether `told` is a guess, from the sockets as the Workspace woke, rather than what was told. */
  private guessed = false;
  /** Whose sockets have changed since the last frame, who are told of again while `told` is a guess. */
  private readonly changed = new Set<UserId>();
  /** The wait for the next frame, while one is due. */
  private gathering: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  /** Starts keeping the presence of `socket`, one of `userId`'s that has just been let in, in use until it says otherwise. */
  connected(socket: WebSocket, userId: UserId, now = Date.now()): void {
    this.lastTold();
    socket.serializeAttachment({ userId, active: true, listening: false, heardAt: now } satisfies SocketPresence);
    this.change(userId);
  }

  /**
   * Keeps whether `socket`'s tab is in use, as it says, sending it the first time who the tabs listening
   * were last told is active, so that the changes they hear next bring it up to date with them.
   */
  said(socket: WebSocket, active: boolean, now = Date.now()): void {
    const presence = presenceOf(socket);
    if (!presence) return;
    const told = this.lastTold();
    socket.serializeAttachment({ ...presence, active, listening: true, heardAt: now } satisfies SocketPresence);
    if (!presence.listening) sendOn(socket, JSON.stringify({ type: "presence", active: [...told], away: [] } satisfies WorkspaceServerFrame));
    this.change(presence.userId);
  }

  /** Notes that `socket` has closed, or is closing. */
  closed(socket: WebSocket): void {
    const presence = presenceOf(socket);
    if (!presence) return;
    this.lastTold();
    this.change(presence.userId);
  }

  /** Notes that `userId`'s sockets have changed, and has the tabs listening told of it in a moment. */
  private change(userId: UserId): void {
    this.changed.add(userId);
    this.gathering ??= setTimeout(() => this.tellChanges(), PRESENCE_GATHERING_MS);
  }

  /** Tells the tabs listening who has become active or away since they were last told, if anyone has. */
  private tellChanges(): void {
    this.gathering = null;
    const before = this.lastTold();
    const now = this.activeAt(Date.now());
    const changed = new Set(this.guessed ? this.changed : []);
    for (const userId of before) if (!now.has(userId)) changed.add(userId);
    for (const userId of now) if (!before.has(userId)) changed.add(userId);
    this.told = now;
    this.guessed = false;
    this.changed.clear();
    if (changed.size === 0) return;
    const ids = [...changed];
    const frame: WorkspaceServerFrame = { type: "presence", active: ids.filter((id) => now.has(id)), away: ids.filter((id) => !now.has(id)) };
    const data = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) if (socket.readyState === WebSocket.OPEN && presenceOf(socket)?.listening) sendOn(socket, data);
  }

  /**
   * Who the tabs listening were last told is active, guessed once the Workspace has woken as everyone
   * with a socket open that's in use, whenever it was last heard from, as they were told as it came.
   */
  private lastTold(): Set<UserId> {
    if (this.told === null) {
      this.told = this.activeAt(null);
      this.guessed = true;
    }
    return this.told;
  }

  /** Everyone with a socket open that's in use and was heard from within `PRESENCE_TTL_MS` of `now`, or ever, for null. */
  private activeAt(now: number | null): Set<UserId> {
    const active = new Set<UserId>();
    for (const socket of this.ctx.getWebSockets()) {
      const presence = socket.readyState === WebSocket.OPEN ? presenceOf(socket) : null;
      if (presence?.active && (now === null || now - this.lastHeard(socket, presence) <= PRESENCE_TTL_MS)) active.add(presence.userId);
    }
    return active;
  }

  /** When the Workspace last heard from `socket`, or the runtime answered its ping. */
  private lastHeard(socket: WebSocket, { heardAt }: SocketPresence): number {
    return Math.max(heardAt, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0);
  }
}

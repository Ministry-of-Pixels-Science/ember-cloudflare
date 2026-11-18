import type { UserId, WorkspaceServerFrame } from "@ember/protocol";
import { isViewing } from "./viewing";

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
  /** Whether the tab has said whether it's in use, which has it hear who's active. */
  listening: boolean;
  /** Whether the tab is shown, as its address said and its `presence.visible` frames since. */
  visible: boolean;
  /** When the Workspace last heard from the socket, other than its pings: as it connected, or as it last said either. */
  heardAt: number;
  /** Whether the tabs listening were last told the socket's person is active, which outlasts the Workspace's sleep here. */
  told: boolean;
}

/**
 * What a workspace socket's attachment keeps of its tab. One the Workspace let in before it kept who the
 * tab is for keeps whether it's shown once it says so, and nothing before then, and counts as neither in
 * use nor listening: a socket stays connected when the Workspace takes new code after hibernating.
 */
type Kept = SocketPresence | Pick<SocketPresence, "visible" | "heardAt">;

/** What a socket with nothing kept counts as saying, like one whose address didn't say: that its tab isn't shown. */
const UNSAID: Kept = { visible: false, heardAt: 0 };

const keptOf = (socket: WebSocket) => (socket.deserializeAttachment() as Kept | null) ?? UNSAID;

/** What `socket`'s attachment keeps of its presence, or null for one let in before the Workspace kept who its tab is for. */
function presenceOf(socket: WebSocket): SocketPresence | null {
  const kept = keptOf(socket);
  return "userId" in kept ? kept : null;
}

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
 * presence in its attachment, which hibernation keeps, with whether its tab is shown, which says who has
 * Ember in view (`inView`). What the tabs that listen were last told is kept in memory, and on its
 * people's sockets, which the Workspace reads it back from once it wakes. Changes go to the tabs that
 * listen, gathered over `PRESENCE_GATHERING_MS`.
 */
export class Presence {
  /** Who the tabs listening were last told is active, or null once the Workspace has woken, until it reads that back. */
  private told: Set<UserId> | null = null;
  /**
   * Whether `told` was read back from the sockets as the Workspace woke, rather than kept as it was told,
   * which a socket let in or closed just before the Workspace stopped can't have had noted.
   */
  private readBack = false;
  /** Whose sockets have changed since the last frame, who are told of again while `told` was read back. */
  private readonly changed = new Set<UserId>();
  /** The wait for the next frame, while one is due. */
  private gathering: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  /**
   * Starts keeping the presence of `socket`, one of `userId`'s that has just been let in, in use until it
   * says otherwise, and shown or not as its address said (`visible`).
   */
  connected(socket: WebSocket, userId: UserId, visible: boolean, now = Date.now()): void {
    const told = this.lastTold().has(userId);
    socket.serializeAttachment({ userId, active: true, listening: false, visible, heardAt: now, told } satisfies SocketPresence);
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

  /**
   * Keeps whether `socket`'s tab is shown, as it says, which a socket let in before the Workspace kept its
   * presence says too. That doesn't make the tab in use or not, which it says itself, but it's heard
   * from, which can make its person active again.
   */
  shown(socket: WebSocket, visible: boolean, now = Date.now()): void {
    const presence = presenceOf(socket);
    if (!presence) return socket.serializeAttachment({ visible, heardAt: now } satisfies Kept);
    this.lastTold();
    socket.serializeAttachment({ ...presence, visible, heardAt: now } satisfies SocketPresence);
    this.change(presence.userId);
  }

  /**
   * Whether `userId` has Ember in view: a tab of theirs has said it's shown, and the Workspace has heard
   * from it lately, as a room asks of whoever's viewing it (`isViewing`).
   */
  inView(userId: UserId, now = Date.now()): boolean {
    return this.ctx.getWebSockets(userId).some((socket) => socket.readyState === WebSocket.OPEN && isViewing(keptOf(socket), this.ctx.getWebSocketAutoResponseTimestamp(socket), now));
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
    const changed = new Set(this.readBack ? this.changed : []);
    for (const userId of before) if (!now.has(userId)) changed.add(userId);
    for (const userId of now) if (!before.has(userId)) changed.add(userId);
    for (const userId of new Set([...this.changed, ...changed])) this.noteTold(userId, now.has(userId));
    this.told = now;
    this.readBack = false;
    this.changed.clear();
    if (changed.size === 0) return;
    const ids = [...changed];
    const frame: WorkspaceServerFrame = { type: "presence", active: ids.filter((id) => now.has(id)), away: ids.filter((id) => !now.has(id)) };
    const data = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) if (socket.readyState === WebSocket.OPEN && presenceOf(socket)?.listening) sendOn(socket, data);
  }

  /** Notes on each of `userId`'s open sockets whether the tabs listening were told they're active, for `lastTold` to read back. */
  private noteTold(userId: UserId, told: boolean): void {
    for (const socket of this.ctx.getWebSockets(userId)) {
      const presence = socket.readyState === WebSocket.OPEN ? presenceOf(socket) : null;
      if (presence && presence.told !== told) socket.serializeAttachment({ ...presence, told } satisfies SocketPresence);
    }
  }

  /**
   * Who the tabs listening were last told is active, read back once the Workspace has woken from the open
   * sockets, which note it (`noteTold`).
   */
  private lastTold(): Set<UserId> {
    if (this.told === null) {
      this.told = new Set();
      for (const socket of this.ctx.getWebSockets()) {
        const presence = socket.readyState === WebSocket.OPEN ? presenceOf(socket) : null;
        if (presence?.told) this.told.add(presence.userId);
      }
      this.readBack = true;
    }
    return this.told;
  }

  /** Everyone with a socket open that's in use and was heard from within `PRESENCE_TTL_MS` of `now`. */
  private activeAt(now: number): Set<UserId> {
    const active = new Set<UserId>();
    for (const socket of this.ctx.getWebSockets()) {
      const presence = socket.readyState === WebSocket.OPEN ? presenceOf(socket) : null;
      if (presence?.active && now - this.lastHeard(socket, presence) <= PRESENCE_TTL_MS) active.add(presence.userId);
    }
    return active;
  }

  /** When the Workspace last heard from `socket`, or the runtime answered its ping. */
  private lastHeard(socket: WebSocket, { heardAt }: SocketPresence): number {
    return Math.max(heardAt, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0);
  }
}

import type { User, UserId } from "@ember/protocol";

/**
 * How long a room socket counts after the room last heard from it. The app pings every 25 seconds, so
 * only a connection that dropped without closing goes this long unheard.
 */
export const VIEWING_TTL_MS = 60_000;

/** What a room socket's attachment says about whether its person is viewing the room. */
export interface Viewing {
  user: User;
  /** Whether the socket's tab is shown, as its address said and its `presence.visible` frames since. */
  visible: boolean;
  /** When the room last heard from the socket, other than its pings: as it connected, or said whether its tab is shown. */
  heardAt: number;
  /** The message whose thread the tab has open, from its `thread.open` until its `thread.close`, or another's `thread.open`. */
  thread?: string;
  /** Set on a socket that shows a part of the room apart from its timeline, as its address said: its person views the thread it has open, and not the room, which they aren't in for it. */
  apart?: true;
}

/**
 * Whether a socket has its person viewing the room, as a connected membership has in Campfire: its tab
 * is shown, and the room heard from it, or the runtime answered its ping (`lastPing`), within
 * `VIEWING_TTL_MS`.
 */
export function isViewing({ visible, heardAt }: Pick<Viewing, "visible" | "heardAt">, lastPing: Date | null, now: number): boolean {
  return visible && now - Math.max(heardAt, lastPing?.getTime() ?? 0) <= VIEWING_TTL_MS;
}

/**
 * Everyone viewing the room whose sockets `state` holds, once each, however many tabs they have it open in,
 * or with `thread`, everyone viewing that message's thread in it. A socket that shows a thread apart from
 * the room's timeline has its person viewing the thread alone.
 */
export function viewersOf(state: DurableObjectState, now = Date.now(), thread?: string): UserId[] {
  const viewers = new Set<UserId>();
  for (const socket of state.getWebSockets()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    const viewing = socket.deserializeAttachment() as Viewing;
    if (thread === undefined ? viewing.apart : viewing.thread !== thread) continue;
    if (isViewing(viewing, state.getWebSocketAutoResponseTimestamp(socket), now)) viewers.add(viewing.user.id);
  }
  return [...viewers];
}

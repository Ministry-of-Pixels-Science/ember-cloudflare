import {
  startingInvolvement,
  type Blocks,
  type Favorites,
  type HuddleSounds,
  type Involvement,
  type LiveHuddle,
  type Room,
  type RoomId,
  type SharedRoom,
  type Sidebar,
  type SidebarRoom,
  type UserId,
} from "@ember/protocol";
import { hearsAllHuddleSounds } from "@ember/protocol/huddles";
import { isHidden } from "./involvement";

// Someone's rooms keep the order `GET /api/sidebar` gives them, the order they were put in them, which
// `/` and `/rooms` go by. The sidebar lists their DMs apart from the other rooms, and lists the rooms
// they've starred first, in the order they starred them, then the rooms the workspace's shared order
// ranks, in its order, then the rest in the order they were put in them, rather than by name, as the
// project's owner chose, so a room that's just been made, or that they've just been put in, comes last.
// Their DMs go by when each was last active, latest first, as Campfire's sorted_list_controller.js sorts
// them. The rooms someone has hidden, whose level is "invisible", are listed too, for them to open, but
// their sidebar leaves them out.

/** A row in the sidebar's Rooms: a room shared by name, open or private. */
export type SharedSidebarRoom = Extract<SidebarRoom, SharedRoom>;
/** A row in the sidebar's DMs. */
export type DirectSidebarRoom = Exclude<SidebarRoom, SharedSidebarRoom>;

/** `rooms` apart, as the sidebar lists them: the rooms, then the DMs, each in the order given, but none hidden. */
export function apart(rooms: SidebarRoom[]): { shared: SharedSidebarRoom[]; directs: DirectSidebarRoom[] } {
  const shared: SharedSidebarRoom[] = [];
  const directs: DirectSidebarRoom[] = [];
  for (const room of rooms) {
    if (isHidden(room)) continue;
    if (room.kind === "direct") directs.push(room);
    else shared.push(room);
  }
  return { shared, directs };
}

/**
 * Whether `room` is a DM started as `meId` joined, with someone who was here already, that nobody has
 * written in yet. Everyone here has one with them, so their own lists leave those out until a message
 * comes in one, while the people already here see theirs from the start, as Slack shows someone new.
 */
export const isQuietWelcome = (room: SidebarRoom, meId: UserId) => room.kind === "direct" && room.joined?.userId === meId && room.activeAt === room.joined.at;

/** Each room's place in `order`. */
const placesIn = (order: RoomId[]) => new Map(order.map((id, place) => [id, place]));

/**
 * `rooms`, given in the order someone was put in them, in the sidebar's order: the rooms in `favorites`
 * first, then the ones `sharedOrder` ranks, then the rest as they're given, each room's places worked
 * out once rather than at every comparison.
 */
export function inSidebarOrder<T extends SharedRoom>(rooms: T[], favorites: RoomId[], sharedOrder: RoomId[] = []): T[] {
  const stars = placesIn(favorites);
  const shared = placesIn(sharedOrder);
  return (
    rooms
      .map((room, given) => ({ room, star: stars.get(room.id) ?? Infinity, shared: shared.get(room.id) ?? Infinity, given }))
      // Two rooms that neither ranks are Infinity - Infinity apart, which is NaN, so they go by what's next.
      .sort((a, b) => a.star - b.star || a.shared - b.shared || a.given - b.given)
      .map(({ room }) => room)
  );
}

/**
 * `directs`, in the order the sidebar lists them: the one active latest first, as Campfire's
 * sorted_list_controller.js sorts its rows, and of two active at once, the one made later.
 */
export function inDirectOrder<T extends DirectSidebarRoom>(directs: T[]): T[] {
  return directs.toReversed().sort((a, b) => (a.activeAt < b.activeAt ? 1 : a.activeAt > b.activeAt ? -1 : 0));
}

/**
 * `order` with `roomId` moved to just before `beforeId`, or last when that's null, as a starred room's
 * row moves.
 */
export function movedBefore(order: RoomId[], roomId: RoomId, beforeId: RoomId | null): RoomId[] {
  const others = order.filter((id) => id !== roomId);
  const place = beforeId === null ? -1 : others.indexOf(beforeId);
  return place === -1 ? [...others, roomId] : [...others.slice(0, place), roomId, ...others.slice(place)];
}

/**
 * Whether the sidebar marks `room` unread, as rooms_list_controller.js marks its row: never the room
 * the tab shows, `currentRoomId`, which counts as read while it's open, or one it leaves out, hidden
 * after it was marked.
 */
export const markedUnread = (room: SidebarRoom, currentRoomId: RoomId | null) => room.unread && room.id !== currentRoomId && !isHidden(room);

/**
 * `rooms` with `room` as it is now, in place of what it was, keeping its mark and level, or last, read
 * and at the level a room starts at, as the room someone was put in most recently, whether it's just
 * been made or they've just been put in it, which is where the list has it when it loads again.
 * A DM keeps the later of the two times it was last active, since a message can come between the server
 * reading it and its answer arriving.
 */
export function withRoom(rooms: SidebarRoom[], room: Room): SidebarRoom[] {
  return rooms.some((r) => r.id === room.id)
    ? rooms.map((r) => (r.id === room.id ? { ...room, ...laterActivity(r, room), ...markOf(r), involvement: r.involvement } : r))
    : [...rooms, { ...room, unread: false, involvement: startingInvolvement(room) }];
}

/** `listed`'s unread mark, since when, and in a DM how many messages it counts, when it's marked. */
const markOf = ({ unread, unreadSince, unreadCount }: SidebarRoom): Pick<SidebarRoom, "unread" | "unreadSince" | "unreadCount"> => ({
  unread,
  ...(unreadSince !== undefined && { unreadSince }),
  ...(unreadCount !== undefined && { unreadCount }),
});

/**
 * `room` marked unread as of `at`, with `count` messages in a DM, or read when `at` is null. The server
 * tells of a room's mark only as it makes one, so a room marked already takes the new time: the read
 * between them came in the same events as the message after it, and the server told only of the mark
 * they leave. A DM's comes with each message, with how many there are now.
 */
function marked(room: SidebarRoom, at: string | null, count?: number): SidebarRoom {
  const { unreadSince: _, unreadCount: __, ...unmarked } = room;
  if (at === null) return { ...unmarked, unread: false };
  return { ...unmarked, unread: true, unreadSince: at, ...(count !== undefined && { unreadCount: count }) };
}

/** `listed`'s time last active, when it's a DM and that's later than `room`'s. */
const laterActivity = (listed: SidebarRoom, room: Room) =>
  listed.kind === "direct" && room.kind === "direct" && listed.activeAt > room.activeAt ? { activeAt: listed.activeAt } : {};

/** `rooms` with DM `roomId` active at `at`, unless it was later. */
const withActivity = (rooms: SidebarRoom[], roomId: RoomId, at: string): SidebarRoom[] =>
  rooms.map((room) => (room.id === roomId && room.kind === "direct" && room.activeAt < at ? { ...room, activeAt: at } : room));

/** `huddles` with room `roomId`'s as `huddle` has it, or without one once it's null: the huddle is over, or the room gone. */
function withHuddle(huddles: Sidebar["huddles"], roomId: RoomId, huddle: LiveHuddle | null): Sidebar["huddles"] {
  const { [roomId]: _, ...others } = huddles;
  return huddle ? { ...others, [roomId]: huddle } : others;
}

/**
 * A change to someone's rooms, which the server's list shows the next time it's asked: a room as it was
 * saved, here or anywhere else, one that's gone for this person, deleted or no longer theirs, a room the
 * workspace socket says has been marked unread or read, a DM it says a message has come in, a room
 * whose huddle it says someone joined or left, a room's level, as one saved in any of their tabs leaves
 * it, their stars, as a star saved in any of their tabs leaves them, the shared order, as saving it
 * here leaves their rooms in it, or whom they've blocked, as blocking or unblocking someone in any of
 * their tabs leaves them.
 */
export type RoomChange =
  | { type: "saved"; room: Room }
  | { type: "gone"; roomId: RoomId }
  | { type: "marked"; roomId: RoomId; at: string | null; count?: number }
  | { type: "active"; roomId: RoomId; at: string }
  | { type: "huddle"; roomId: RoomId; huddle: LiveHuddle | null }
  | { type: "involved"; roomId: RoomId; involvement: Involvement }
  | { type: "starred"; favorites: Favorites }
  | { type: "reordered"; sharedOrder: RoomId[] }
  | { type: "blocked"; blocks: Blocks };

/** What the server answers a change to a room with: the room as saved, gone for this person, or their level in it. */
export type RoomAnswer = Extract<RoomChange, { type: "saved" | "gone" | "involved" }>;

/**
 * A change to the list: to someone's rooms, to the welcome card: the join link's new code, made here,
 * or the card dismissed, here or in another of their tabs, to which of a huddle's sounds they hear, as
 * a switch on their profile leaves them, in any of their tabs, or for an administrator, to how many open
 * reports they see, as the workspace socket says once a report is made or handled.
 */
export type SidebarChange =
  | RoomChange
  | { type: "join code"; joinCode: string }
  | { type: "invitation dismissed" }
  | { type: "huddle sounds"; sounds: HuddleSounds }
  | { type: "reports"; open: number };

/**
 * Someone's rooms: the server's list, once it arrives, with the changes made since it was asked for,
 * which it may not show. Asked for again, it keeps the list it has until the new one arrives. It
 * follows one list on its way at a time, so it's asked for again only once the last has come or failed to.
 */
export interface RoomListState {
  list: Sidebar | null;
  /** While a list is on its way, the changes made since it was asked for, which it may not show; otherwise null. */
  pending: SidebarChange[] | null;
  /** Whether the list that came last may have a room in the wrong place, so it's to be asked for again (`putBackIn`). */
  askAgain: boolean;
}

export const NO_ROOM_LIST: RoomListState = { list: null, pending: [], askAgain: false };

/** The list when the first doesn't arrive: no rooms, stars or blocks. */
const NO_SIDEBAR: Sidebar = { rooms: [], favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {}, blocks: { userIds: [], version: 0 } };

/** A change, or the list asked for, arriving, or failing to. */
export type RoomListAction = SidebarChange | { type: "asked" } | { type: "loaded"; list: Sidebar } | { type: "unanswered" };

/** `list` with `sounds` as the ones of a huddle's its person hears, which it leaves out while they hear them all, as the server's does. */
function withHuddleSounds({ huddleSounds: _, ...list }: Sidebar, sounds: HuddleSounds): Sidebar {
  return hearsAllHuddleSounds(sounds) ? list : { ...list, huddleSounds: sounds };
}

function changed(list: Sidebar, change: SidebarChange): Sidebar {
  switch (change.type) {
    case "saved":
      return { ...list, rooms: withRoom(list.rooms, change.room) };
    // A room that's gone takes its star with it, as the server's stars leave out the rooms someone can't
    // star, so an order saved next lists the stars it knows.
    case "gone": {
      const stars = list.favorites.rooms;
      const favorites = stars.includes(change.roomId) ? { ...list.favorites, rooms: stars.filter((id) => id !== change.roomId) } : list.favorites;
      return { ...list, rooms: list.rooms.filter((room) => room.id !== change.roomId), favorites, huddles: withHuddle(list.huddles, change.roomId, null) };
    }
    case "marked":
      return { ...list, rooms: list.rooms.map((room) => (room.id === change.roomId ? marked(room, change.at, change.count) : room)) };
    case "active":
      return { ...list, rooms: withActivity(list.rooms, change.roomId, change.at) };
    case "huddle":
      return { ...list, huddles: withHuddle(list.huddles, change.roomId, change.huddle) };
    case "involved":
      return { ...list, rooms: list.rooms.map((room) => (room.id === change.roomId ? { ...room, involvement: change.involvement } : room)) };
    case "join code":
      return { ...list, invitation: list.invitation && { ...list.invitation, joinCode: change.joinCode } };
    case "invitation dismissed":
      return { ...list, invitation: null };
    case "huddle sounds":
      return withHuddleSounds(list, change.sounds);
    // Stars come from a star's answer, the socket and the list itself, in whatever order they arrive,
    // so the newest stands.
    case "starred":
      return change.favorites.version > list.favorites.version ? { ...list, favorites: change.favorites } : list;
    case "reordered":
      return { ...list, sharedOrder: change.sharedOrder };
    // As stars do, blocks come from a block's answer, the socket and the list itself, so the newest stands.
    case "blocked":
      return change.blocks.version > list.blocks.version ? { ...list, blocks: change.blocks } : list;
    // The socket's counts come in order, and the last of them is the newest, even replayed over a list that's newer than some.
    case "reports":
      return { ...list, openReports: change.open };
  }
}

/**
 * Whether `changes`, made while `list` was on its way, take someone out of a room it lists and put them
 * back in, which may leave the room in the wrong place, since the list doesn't say which it shows: the
 * room where it was before they were taken out, which the changes move last, or where it is since they
 * were put back, which the changes move past any room they were put in after it.
 */
function putBackIn(list: Sidebar, changes: SidebarChange[]): boolean {
  const listed = new Set(list.rooms.map((room) => room.id));
  const takenOut = new Set<RoomId>();
  for (const change of changes) {
    if (change.type === "gone" && listed.has(change.roomId)) takenOut.add(change.roomId);
    else if (change.type === "saved" && takenOut.has(change.room.id)) return true;
  }
  return false;
}

export function roomListReducer(state: RoomListState, action: RoomListAction): RoomListState {
  switch (action.type) {
    case "asked":
      return { ...state, pending: [], askAgain: false };
    case "loaded": {
      const pending = state.pending ?? [];
      return { list: pending.reduce(changed, action.list), pending: null, askAgain: putBackIn(action.list, pending) };
    }
    // When the first list fails to arrive, there are no rooms to show, rather than a list loading for good.
    case "unanswered":
      return { list: state.list ?? NO_SIDEBAR, pending: null, askAgain: false };
    default:
      return { ...state, list: state.list && changed(state.list, action), pending: state.pending && [...state.pending, action] };
  }
}

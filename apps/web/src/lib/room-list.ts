import {
  startingInvolvement,
  type Favorites,
  type Involvement,
  type LiveHuddle,
  type Room,
  type RoomId,
  type SharedRoom,
  type Sidebar,
  type SidebarRoom,
} from "@ember/protocol";
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

/** `listed`'s unread mark, and since when, when it's marked. */
const markOf = ({ unread, unreadSince }: SidebarRoom): Pick<SidebarRoom, "unread" | "unreadSince"> => (unreadSince === undefined ? { unread } : { unread, unreadSince });

/**
 * `room` marked unread as of `at`, or read when that's null. The server tells of a mark only as it makes
 * one, so a room marked already takes the new time: the read between them came in the same events as the
 * message after it, and the server told only of the mark they leave.
 */
function marked(room: SidebarRoom, at: string | null): SidebarRoom {
  if (at === null) {
    const { unreadSince: _, ...read } = room;
    return { ...read, unread: false };
  }
  return { ...room, unread: true, unreadSince: at };
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
 * it, their stars, as a star saved in any of their tabs leaves them, or the shared order, as saving it
 * here leaves their rooms in it.
 */
export type RoomChange =
  | { type: "saved"; room: Room }
  | { type: "gone"; roomId: RoomId }
  | { type: "marked"; roomId: RoomId; at: string | null }
  | { type: "active"; roomId: RoomId; at: string }
  | { type: "huddle"; roomId: RoomId; huddle: LiveHuddle | null }
  | { type: "involved"; roomId: RoomId; involvement: Involvement }
  | { type: "starred"; favorites: Favorites }
  | { type: "reordered"; sharedOrder: RoomId[] };

/** What the server answers a change to a room with: the room as saved, gone for this person, or their level in it. */
export type RoomAnswer = Extract<RoomChange, { type: "saved" | "gone" | "involved" }>;

/**
 * A change to the list: to someone's rooms, or to the welcome card: the join link's new code, made here,
 * or the card dismissed, here or in another of their tabs.
 */
export type SidebarChange = RoomChange | { type: "join code"; joinCode: string } | { type: "invitation dismissed" };

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

/** A change, or the list asked for, arriving, or failing to. */
export type RoomListAction = SidebarChange | { type: "asked" } | { type: "loaded"; list: Sidebar } | { type: "unanswered" };

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
      return { ...list, rooms: list.rooms.map((room) => (room.id === change.roomId ? marked(room, change.at) : room)) };
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
    // Stars come from a star's answer, the socket and the list itself, in whatever order they arrive,
    // so the newest stands.
    case "starred":
      return change.favorites.version > list.favorites.version ? { ...list, favorites: change.favorites } : list;
    case "reordered":
      return { ...list, sharedOrder: change.sharedOrder };
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
      return { list: state.list ?? { rooms: [], favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {} }, pending: null, askAgain: false };
    default:
      return { ...state, list: state.list && changed(state.list, action), pending: state.pending && [...state.pending, action] };
  }
}

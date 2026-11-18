import type { Favorites, LiveHuddle, Room, Sidebar, SidebarRoom } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import {
  apart,
  inDirectOrder,
  inSidebarOrder,
  isQuietWelcome,
  markedUnread,
  NO_ROOM_LIST,
  roomListReducer,
  withRoom,
  type DirectSidebarRoom,
  type RoomListAction,
  type SharedSidebarRoom,
} from "./room-list";

const NOON = "2026-10-15T12:00:00.000Z";
const room = (id: string, name: string, unread = false): SharedSidebarRoom => ({ id, kind: "open", name, icon: null, unread, involvement: "mentions" });
/** A DM between the people `names` names, as active as it started, at noon. */
const direct = (id: string, ...names: string[]): DirectSidebarRoom => ({
  id,
  kind: "direct",
  members: names.map((name) => ({ id: name.toLowerCase(), name })),
  activeAt: NOON,
  unread: false,
  involvement: "everything",
});
const unstarred: Favorites = { rooms: [], version: 0 };
/** The sidebar's list of `rooms`, starred as `favorites` says. */
const sidebar = (rooms: SidebarRoom[], favorites = unstarred): Sidebar => ({ rooms, favorites, sharedOrder: [], invitation: null, huddles: {}, blocks: { userIds: [], version: 0 } });

describe("Create an open room", () => {
  it("puts a new room last, as the room someone was put in most recently, and the sidebar below every other room, whatever its name", () => {
    const rooms = apart(withRoom([room("r1", "general"), room("r2", "Zebra"), room("r3", "Design")], room("r4", "Annex"))).shared;
    expect(rooms.map((r) => r.name)).toEqual(["general", "Zebra", "Design", "Annex"]);
    expect(inSidebarOrder(rooms, []).map((r) => r.name)).toEqual(["general", "Zebra", "Design", "Annex"]);
    // Below the starred rooms and the ones the shared order ranks, which it doesn't yet.
    expect(inSidebarOrder(rooms, ["r3"], ["r2", "r1"]).map((r) => r.name)).toEqual(["Design", "Zebra", "general", "Annex"]);
  });

  it("keeps a room saved before the list arrives, and adds it to the list when it does", () => {
    const list = sidebar([room("r2", "general")]);
    const saved = roomListReducer(NO_ROOM_LIST, { type: "saved", room: room("r1", "Design") });
    expect(saved.list).toBeNull();
    expect(roomListReducer(saved, { type: "loaded", list })).toEqual({ list: sidebar([room("r2", "general"), room("r1", "Design")]), pending: null, askAgain: false });
  });
});

describe("Room settings page", () => {
  it("keeps a renamed room in its place, in the sidebar too", () => {
    const rooms = apart(withRoom([room("r1", "Design"), room("r2", "general")], room("r1", "Product design"))).shared;
    expect(rooms).toEqual([room("r1", "Product design"), room("r2", "general")]);
    expect(inSidebarOrder(rooms, [])).toEqual([room("r1", "Product design"), room("r2", "general")]);
  });

  it("keeps a rename saved before the list arrives over the name the list has", () => {
    const list = sidebar([room("r1", "Design"), room("r2", "general")]);
    const renamed = roomListReducer(NO_ROOM_LIST, { type: "saved", room: room("r1", "Product design") });
    expect(roomListReducer(renamed, { type: "loaded", list }).list!.rooms).toEqual([room("r1", "Product design"), room("r2", "general")]);
  });

  it("changes the list in place once it has arrived", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar([room("r1", "Design")]) });
    expect(roomListReducer(loaded, { type: "saved", room: room("r1", "Product design") })).toEqual({
      list: sidebar([room("r1", "Product design")]),
      pending: null,
      askAgain: false,
    });
  });
});

describe("Open a room", () => {
  const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar([room("r1", "Design")]) });

  it("keeps the list while it's asked for again, and the changes made meanwhile once the new one arrives", () => {
    const asked = roomListReducer(loaded, { type: "asked" });
    expect(asked.list).toEqual(loaded.list);
    const saved = roomListReducer(asked, { type: "saved", room: room("r3", "Finance") });
    expect(saved.list!.rooms.map((r) => r.id)).toEqual(["r1", "r3"]);
    // Asked for before Finance was made, the new list hasn't got it.
    const list = sidebar([room("r1", "Design"), room("r2", "general")]);
    expect(roomListReducer(saved, { type: "loaded", list })).toEqual({ list: sidebar([...list.rooms, room("r3", "Finance")]), pending: null, askAgain: false });
  });

  it("keeps the list it has when asking again fails", () => {
    expect(roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "unanswered" })).toEqual(loaded);
  });

  it("shows no rooms, rather than loading for good, when the first list fails to arrive", () => {
    expect(roomListReducer(NO_ROOM_LIST, { type: "unanswered" })).toEqual({ list: sidebar([]), pending: null, askAgain: false });
  });
});

describe("Add and remove private room members", () => {
  it("takes a room that's gone for this person out of the list, even one the list hadn't arrived with yet", () => {
    const list = sidebar([room("r1", "Design"), room("r2", "general")]);
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list });
    expect(roomListReducer(loaded, { type: "gone", roomId: "r1" }).list!.rooms).toEqual([room("r2", "general")]);
    const early = roomListReducer(NO_ROOM_LIST, { type: "gone", roomId: "r1" });
    expect(roomListReducer(early, { type: "loaded", list }).list!.rooms).toEqual([room("r2", "general")]);
  });

  it("asks for the list again when it may have a room in the wrong place, one someone was taken out of and put back in while it was on its way", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar([room("r1", "general"), room("r2", "Design")]) });
    // While a list is on its way, Ada is taken out of Design and put back in it, then put in Finance.
    const changes: RoomListAction[] = [{ type: "gone", roomId: "r2" }, { type: "saved", room: room("r2", "Design") }, { type: "saved", room: room("r3", "Finance") }];
    const changed = changes.reduce(roomListReducer, roomListReducer(loaded, { type: "asked" }));
    const now = sidebar([room("r1", "general"), room("r2", "Design"), room("r3", "Finance")]);
    expect(changed.list).toEqual(now);

    // Asked for after all three, the list has Design where it is now, which the changes move past Finance.
    const unsure = roomListReducer(changed, { type: "loaded", list: now });
    expect(unsure.askAgain).toBe(true);
    expect(roomListReducer(roomListReducer(unsure, { type: "asked" }), { type: "loaded", list: now })).toEqual({ list: now, pending: null, askAgain: false });

    // Asked for after she was taken out and before she was put back, it hasn't got Design, which the changes put last.
    expect(roomListReducer(changed, { type: "loaded", list: sidebar([room("r1", "general")]) })).toEqual({ list: now, pending: null, askAgain: false });
  });
});

describe("Unread rooms", () => {
  const list = sidebar([room("r1", "Design"), room("r2", "general", true)]);
  const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list });

  /** `listed`, marked unread as of `at`. */
  const since = (listed: SidebarRoom, at = NOON): SidebarRoom => ({ ...listed, unread: true, unreadSince: at });

  it("marks a room unread or read, and keeps its mark when it's saved, as a new room has none", () => {
    const marked = roomListReducer(loaded, { type: "marked", roomId: "r1", at: NOON });
    expect(marked.list!.rooms).toEqual([since(room("r1", "Design")), room("r2", "general", true)]);
    expect(roomListReducer(marked, { type: "marked", roomId: "r2", at: null }).list!.rooms).toEqual([since(room("r1", "Design")), room("r2", "general")]);

    const renamed: Room = { id: "r1", kind: "open", name: "Product design", icon: null };
    expect(withRoom(marked.list!.rooms, renamed)).toEqual([since(room("r1", "Product design")), room("r2", "general", true)]);
    const finance: Room = { id: "r3", kind: "open", name: "Finance", icon: null };
    expect(withRoom(marked.list!.rooms, finance).at(-1)).toEqual(room("r3", "Finance"));
  });

  it("takes the time the server marks a room unread as of, even over a mark whose read it never told", () => {
    const later = "2026-10-15T12:05:00.000Z";
    const marked = roomListReducer(loaded, { type: "marked", roomId: "r1", at: NOON });
    // The server read the room and marked it again in one go, telling only of the new mark.
    const again = roomListReducer(marked, { type: "marked", roomId: "r1", at: later });
    expect(again.list!.rooms[0]).toEqual(since(room("r1", "Design"), later));
    const read = roomListReducer(again, { type: "marked", roomId: "r1", at: null });
    expect(read.list!.rooms[0]).toEqual(room("r1", "Design"));
    expect(roomListReducer(read, { type: "marked", roomId: "r1", at: later }).list!.rooms[0]).toEqual(since(room("r1", "Design"), later));
  });

  it("marks a room's row unread unless the tab shows the room", () => {
    expect(markedUnread(room("r1", "Design", true), null)).toBe(true);
    expect(markedUnread(room("r1", "Design", true), "r2")).toBe(true);
    expect(markedUnread(room("r1", "Design", true), "r1")).toBe(false);
    expect(markedUnread(room("r1", "Design"), null)).toBe(false);
  });

  it("keeps a mark made while a list is on its way over the one the list has", () => {
    const asked = roomListReducer(loaded, { type: "asked" });
    const read = roomListReducer(asked, { type: "marked", roomId: "r2", at: null });
    expect(roomListReducer(read, { type: "loaded", list }).list!.rooms).toEqual([room("r1", "Design"), room("r2", "general")]);
  });

  it("counts the messages a DM's mark says have come since, until it's read, keeping the count as the DM's saved", () => {
    const dm = direct("d1", "Ada", "Grace");
    const listed = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar([dm]) });
    const marked = roomListReducer(roomListReducer(listed, { type: "marked", roomId: "d1", at: NOON, count: 1 }), { type: "marked", roomId: "d1", at: NOON, count: 2 });
    const counted: SidebarRoom = { ...dm, unread: true, unreadSince: NOON, unreadCount: 2 };
    expect(marked.list!.rooms).toEqual([counted]);
    expect(withRoom(marked.list!.rooms, { id: "d1", kind: "direct", members: dm.members, activeAt: NOON })).toEqual([counted]);
    expect(roomListReducer(marked, { type: "marked", roomId: "d1", at: null }).list!.rooms).toEqual([dm]);
  });
});

describe("Regenerate the join link", () => {
  const invited: Sidebar = { ...sidebar([room("r1", "general")]), invitation: { roomId: "r1", joinCode: "aB3d-Ef5h-iJ7k" } };

  it("gives the welcome card the join link's new code, even over a list asked for before it was made", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: invited });
    const regenerated = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "join code", joinCode: "Zy9x-Wv8u-Ts7r" });
    expect(regenerated.list!.invitation).toEqual({ roomId: "r1", joinCode: "Zy9x-Wv8u-Ts7r" });
    expect(roomListReducer(regenerated, { type: "loaded", list: invited }).list!.invitation).toEqual({ roomId: "r1", joinCode: "Zy9x-Wv8u-Ts7r" });
  });

  it("gives no invitation to someone the welcome card isn't for", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar([room("r2", "Design")]) });
    expect(roomListReducer(loaded, { type: "join code", joinCode: "Zy9x-Wv8u-Ts7r" }).list!.invitation).toBeNull();
  });
});

describe("Welcome card for administrators, until they dismiss it", () => {
  it("takes the welcome card away, even from a list asked for before it was dismissed", () => {
    const invited: Sidebar = { ...sidebar([room("r1", "general")]), invitation: { roomId: "r1", joinCode: "aB3d-Ef5h-iJ7k" } };
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: invited });
    const dismissed = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "invitation dismissed" });
    expect(dismissed.list!.invitation).toBeNull();
    expect(dismissed.list!.rooms).toEqual(invited.rooms);
    expect(roomListReducer(dismissed, { type: "loaded", list: invited }).list!.invitation).toBeNull();
  });
});

/** Four rooms, in the order someone was put in them, which isn't by name. */
const four = [room("r1", "general"), room("r2", "Zebra"), room("r3", "Design"), room("r4", "Ops")];

describe("Room order", () => {
  it("lists the starred rooms first, in the order they were starred, then the rest in the order they were put in them", () => {
    expect(inSidebarOrder(four, ["r4", "r2"]).map((r) => r.name)).toEqual(["Ops", "Zebra", "general", "Design"]);
  });

  it("passes over stars on rooms the list hasn't got", () => {
    expect(inSidebarOrder(four, ["gone", "r3"]).map((r) => r.name)).toEqual(["Design", "general", "Zebra", "Ops"]);
  });

  it("keeps the rooms nothing ranks in the order they were put in them, whatever their names and ids", () => {
    const rooms = [room("r4", "zed"), room("r2", "alpha"), room("r3", "Éclair"), room("r1", "ALPHA")];
    expect(inSidebarOrder(rooms, []).map((r) => r.id)).toEqual(["r4", "r2", "r3", "r1"]);
  });
});

describe("Shared room order", () => {
  it("lists the rooms the shared order ranks after the stars, in its order, then the rest in the order they were put in them", () => {
    expect(inSidebarOrder(four, ["r4"], ["r3", "r4", "r2"]).map((r) => r.name)).toEqual(["Ops", "Design", "Zebra", "general"]);
  });

  it("passes over ranks of rooms the list hasn't got", () => {
    expect(inSidebarOrder(four, [], ["gone", "r2"]).map((r) => r.name)).toEqual(["Zebra", "general", "Design", "Ops"]);
  });

  it("takes the order an administrator saves here, over a list asked for before they saved it", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar(four) });
    const reordered = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "reordered", sharedOrder: ["r4", "r1"] });
    expect(reordered.list!.sharedOrder).toEqual(["r4", "r1"]);
    expect(roomListReducer(reordered, { type: "loaded", list: sidebar(four) }).list!.sharedOrder).toEqual(["r4", "r1"]);
  });

  it("starts with none when the first list fails to arrive", () => {
    expect(roomListReducer(NO_ROOM_LIST, { type: "unanswered" }).list!.sharedOrder).toEqual([]);
  });
});

describe("Star rooms", () => {
  it("keeps the newest stars, from a star's answer, the socket or the list, whichever arrives last", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar(four, { rooms: ["r1"], version: 2 }) });
    const starred = roomListReducer(loaded, { type: "starred", favorites: { rooms: ["r1", "r2"], version: 3 } });
    expect(starred.list!.favorites).toEqual({ rooms: ["r1", "r2"], version: 3 });
    // The answer to the star, arriving after the socket's news of the unstar that followed it.
    expect(roomListReducer(starred, { type: "starred", favorites: { rooms: ["r1"], version: 2 } }).list).toBe(starred.list);
    expect(roomListReducer(starred, { type: "starred", favorites: { rooms: ["r2"], version: 3 } }).list).toBe(starred.list);
  });

  it("keeps stars saved while a list is on its way over the list's, unless the list's are newer", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar(four) });
    const starred = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "starred", favorites: { rooms: ["r3"], version: 1 } });
    expect(roomListReducer(starred, { type: "loaded", list: sidebar(four) }).list!.favorites).toEqual({ rooms: ["r3"], version: 1 });
    const newer = { rooms: ["r3", "r4"], version: 2 };
    expect(roomListReducer(starred, { type: "loaded", list: sidebar(four, newer) }).list!.favorites).toEqual(newer);
  });

  it("starts with none when the first list fails to arrive, so the next star counts", () => {
    const unanswered = roomListReducer(NO_ROOM_LIST, { type: "unanswered" });
    expect(unanswered.list!.favorites).toEqual(unstarred);
    expect(roomListReducer(unanswered, { type: "starred", favorites: { rooms: ["r1"], version: 1 } }).list!.favorites.rooms).toEqual(["r1"]);
  });
});

describe("Block someone", () => {
  const blocks = (userIds: string[], version: number) => ({ userIds, version });

  it("keeps the newest blocks, from a block's answer, the socket or the list, whichever arrives last", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: { ...sidebar(four), blocks: blocks(["u2"], 2) } });
    const blocked = roomListReducer(loaded, { type: "blocked", blocks: blocks(["u2", "u3"], 3) });
    expect(blocked.list!.blocks).toEqual(blocks(["u2", "u3"], 3));
    // The answer to the block, arriving after the socket's news of the unblock that followed it.
    expect(roomListReducer(blocked, { type: "blocked", blocks: blocks(["u2"], 2) }).list).toBe(blocked.list);
    expect(roomListReducer(blocked, { type: "blocked", blocks: blocks(["u3"], 3) }).list).toBe(blocked.list);
  });

  it("keeps blocks made while a list is on its way over the list's, unless the list's are newer", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar(four) });
    const blocked = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "blocked", blocks: blocks(["u3"], 1) });
    expect(roomListReducer(blocked, { type: "loaded", list: sidebar(four) }).list!.blocks).toEqual(blocks(["u3"], 1));
    const newer = { ...sidebar(four), blocks: blocks(["u3", "u4"], 2) };
    expect(roomListReducer(blocked, { type: "loaded", list: newer }).list!.blocks).toEqual(blocks(["u3", "u4"], 2));
  });

  it("starts with nobody blocked when the first list fails to arrive, so the next block counts", () => {
    const unanswered = roomListReducer(NO_ROOM_LIST, { type: "unanswered" });
    expect(unanswered.list!.blocks).toEqual(blocks([], 0));
    expect(roomListReducer(unanswered, { type: "blocked", blocks: blocks(["u2"], 1) }).list!.blocks.userIds).toEqual(["u2"]);
  });
});

describe("Reports", () => {
  it("takes an administrator's count of open reports from the socket, the last count standing even over a list that came after it", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: { ...sidebar(four), openReports: 1 } });
    expect(roomListReducer(loaded, { type: "reports", open: 2 }).list!.openReports).toBe(2);
    const asked = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "reports", open: 0 });
    expect(roomListReducer(asked, { type: "loaded", list: { ...sidebar(four), openReports: 1 } }).list!.openReports).toBe(0);
  });
});

describe("Reorder starred rooms", () => {
  it("drops the star of a room that's gone, as the server's stars do, so an order saved next is one it knows", () => {
    const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list: sidebar(four, { rooms: ["r1", "r3"], version: 2 }) });
    expect(roomListReducer(loaded, { type: "gone", roomId: "r1" }).list!.favorites).toEqual({ rooms: ["r3"], version: 2 });
    expect(roomListReducer(loaded, { type: "gone", roomId: "r2" }).list!.favorites).toBe(loaded.list!.favorites);
  });
});

describe("Welcome someone who joins", () => {
  const welcome: DirectSidebarRoom = { ...direct("d1", "Ada", "Grace"), joined: { userId: "ada", at: NOON } };

  it("keeps the DM that welcomed someone quiet for them until a message comes in it, but never for the person welcoming them", () => {
    expect(isQuietWelcome(welcome, "ada")).toBe(true);
    expect(isQuietWelcome(welcome, "grace")).toBe(false);
    expect(isQuietWelcome({ ...welcome, activeAt: "2026-10-15T12:05:00.000Z" }, "ada")).toBe(false);
    expect(isQuietWelcome(direct("d2", "Ada", "Grace"), "ada")).toBe(false);
    expect(isQuietWelcome(room("r1", "Design"), "ada")).toBe(false);
  });
});

describe("Conversations sidebar", () => {
  it("lists DMs apart from the rooms, each in the order given", () => {
    const rooms = [direct("d1", "Ada", "Grace"), room("r1", "Design"), direct("d2", "Ada"), room("r2", "general")];
    expect(apart(rooms)).toEqual({ shared: [room("r1", "Design"), room("r2", "general")], directs: [direct("d1", "Ada", "Grace"), direct("d2", "Ada")] });
  });
});

describe("Start or reopen a direct message", () => {
  it("lists a new DM last, as the room made most recently, and keeps a DM's mark as it's saved again", () => {
    const rooms = withRoom([room("r1", "Design")], { id: "d1", kind: "direct", members: [{ id: "ada", name: "Ada" }], activeAt: NOON });
    expect(rooms).toEqual([room("r1", "Design"), direct("d1", "Ada")]);
    const marked = rooms.map((r) => ({ ...r, unread: true }));
    expect(withRoom(marked, { id: "d1", kind: "direct", members: [{ id: "ada", name: "Ada" }], activeAt: NOON }).at(-1)).toEqual({ ...direct("d1", "Ada"), unread: true });
  });
});

describe("DM order", () => {
  /** `minutes` past noon. */
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 12, minutes)).toISOString();
  /** `dm`, last active `minutes` past noon. */
  const activeAt = (dm: DirectSidebarRoom, minutes: number): DirectSidebarRoom => ({ ...dm, activeAt: at(minutes) });
  const list = sidebar([room("r1", "Design"), activeAt(direct("d1", "Ada"), 1), activeAt(direct("d2", "Ada", "Grace"), 2)]);
  const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list });

  it("lists the DM active latest first, and of two active at once, the one made later", () => {
    const directs = [activeAt(direct("d1", "Ada"), 1), activeAt(direct("d2", "Grace"), 3), activeAt(direct("d3", "Linus"), 2), activeAt(direct("d4", "Alan"), 3)];
    expect(inDirectOrder(directs).map((dm) => dm.id)).toEqual(["d4", "d2", "d3", "d1"]);
    expect(directs.map((dm) => dm.id)).toEqual(["d1", "d2", "d3", "d4"]);
  });

  it("moves a DM as a message comes in it, but never back to an earlier time", () => {
    const moved = roomListReducer(loaded, { type: "active", roomId: "d1", at: at(5) });
    expect(moved.list!.rooms).toEqual([room("r1", "Design"), activeAt(direct("d1", "Ada"), 5), activeAt(direct("d2", "Ada", "Grace"), 2)]);
    expect(roomListReducer(moved, { type: "active", roomId: "d1", at: at(4) }).list!.rooms).toEqual(moved.list!.rooms);
    // Only a DM moves, and only one listed.
    expect(roomListReducer(moved, { type: "active", roomId: "r1", at: at(6) }).list!.rooms).toEqual(moved.list!.rooms);
    expect(roomListReducer(moved, { type: "active", roomId: "d9", at: at(6) }).list!.rooms).toEqual(moved.list!.rooms);
  });

  it("keeps a message heard while a list is on its way over the time the list has, unless the list's is later", () => {
    const heard = roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "active", roomId: "d1", at: at(5) });
    expect(roomListReducer(heard, { type: "loaded", list }).list!.rooms[1]).toEqual(activeAt(direct("d1", "Ada"), 5));
    const later = sidebar([room("r1", "Design"), activeAt(direct("d1", "Ada"), 7), activeAt(direct("d2", "Ada", "Grace"), 2)]);
    expect(roomListReducer(heard, { type: "loaded", list: later }).list!.rooms[1]).toEqual(activeAt(direct("d1", "Ada"), 7));
  });

  it("keeps the later of the times a DM was last active when it's saved again", () => {
    const listed = [activeAt(direct("d1", "Ada"), 5)];
    const saved = (minutes: number): Room => ({ id: "d1", kind: "direct", members: [{ id: "ada", name: "Ada" }], activeAt: at(minutes) });
    expect(withRoom(listed, saved(1))).toEqual(listed);
    expect(withRoom(listed, saved(7))).toEqual([activeAt(direct("d1", "Ada"), 7)]);
  });
});

describe("Notification levels", () => {
  const list = sidebar([room("r1", "Design"), direct("d1", "Ada")]);
  const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list });

  it("changes a room's level in place, keeps it as the room's saved, and starts a new room at its kind's", () => {
    const involved = roomListReducer(loaded, { type: "involved", roomId: "r1", involvement: "everything" });
    expect(involved.list!.rooms).toEqual([{ ...room("r1", "Design"), involvement: "everything" }, direct("d1", "Ada")]);

    const renamed: Room = { id: "r1", kind: "open", name: "Product design", icon: null };
    expect(withRoom(involved.list!.rooms, renamed)[0]).toEqual({ ...room("r1", "Product design"), involvement: "everything" });
    const ops: Room = { id: "r2", kind: "closed", name: "Ops", icon: null };
    expect(withRoom(involved.list!.rooms, ops).at(-1)).toEqual({ ...ops, unread: false, involvement: "mentions" });
    expect(withRoom([], { id: "d2", kind: "direct", members: [{ id: "grace", name: "Grace" }], activeAt: NOON })[0]!.involvement).toBe("everything");
  });

  it("keeps a level changed while a list is on its way over the one the list has", () => {
    const asked = roomListReducer(loaded, { type: "asked" });
    const involved = roomListReducer(asked, { type: "involved", roomId: "d1", involvement: "nothing" });
    expect(roomListReducer(involved, { type: "loaded", list }).list!.rooms).toEqual([room("r1", "Design"), { ...direct("d1", "Ada"), involvement: "nothing" }]);
  });
});

describe("Hide a room", () => {
  const hidden = <T extends SidebarRoom>(listed: T): T => ({ ...listed, involvement: "invisible" });

  it("leaves the rooms and DMs you've hidden out of the sidebar, which lists them for you to open", () => {
    const rooms = [hidden(room("r1", "Design")), room("r2", "general"), direct("d1", "Ada"), hidden(direct("d2", "Ada", "Grace"))];
    expect(apart(rooms)).toEqual({ shared: [room("r2", "general")], directs: [direct("d1", "Ada")] });
  });

  it("marks no row of a room you've hidden unread, so Activity leaves it out", () => {
    expect(markedUnread(hidden(room("r1", "Design", true)), null)).toBe(false);
    expect(markedUnread({ ...room("r1", "Design", true), involvement: "nothing" }, null)).toBe(true);
  });
});

describe("Huddles in your rooms", () => {
  /** A huddle with the people `userIds` names in it, started at noon. */
  const huddle = (...userIds: string[]): LiveHuddle => ({ startedAt: NOON, userIds });
  const list: Sidebar = { ...sidebar([room("r1", "Design"), room("r2", "general")]), huddles: { r1: huddle("ada") } };
  const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list });

  it("keeps who's in each room's huddle as the workspace socket says, until it says the huddle is over", () => {
    const joined = roomListReducer(loaded, { type: "huddle", roomId: "r1", huddle: huddle("ada", "grace") });
    expect(joined.list!.huddles).toEqual({ r1: huddle("ada", "grace") });
    const another = roomListReducer(joined, { type: "huddle", roomId: "r2", huddle: huddle("linus") });
    expect(another.list!.huddles).toEqual({ r1: huddle("ada", "grace"), r2: huddle("linus") });
    expect(roomListReducer(another, { type: "huddle", roomId: "r1", huddle: null }).list!.huddles).toEqual({ r2: huddle("linus") });
    expect(another.list!.rooms).toBe(loaded.list!.rooms);
  });

  it("takes whether a room allows huddles from the room as it's saved, which says so only while it doesn't", () => {
    const off = roomListReducer(loaded, { type: "saved", room: { id: "r1", kind: "open", name: "Design", icon: null, huddles: false } });
    expect(off.list!.rooms).toEqual([{ ...room("r1", "Design"), huddles: false }, room("r2", "general")]);
    // Its huddle is the room's to end, so the list keeps it until it hears that it's over.
    expect(off.list!.huddles).toEqual({ r1: huddle("ada") });
    const on = roomListReducer(off, { type: "saved", room: { id: "r1", kind: "open", name: "Design", icon: null } });
    expect(on.list!.rooms).toEqual([room("r1", "Design"), room("r2", "general")]);
  });

  it("forgets the huddle of a room that's gone", () => {
    expect(roomListReducer(loaded, { type: "gone", roomId: "r1" }).list!.huddles).toEqual({});
    expect(roomListReducer(loaded, { type: "gone", roomId: "r2" }).list!.huddles).toEqual({ r1: huddle("ada") });
  });

  it("keeps what it heard of a huddle while a list was on its way over what the list says", () => {
    const asked = roomListReducer(loaded, { type: "asked" });
    const over = roomListReducer(asked, { type: "huddle", roomId: "r1", huddle: null });
    expect(roomListReducer(over, { type: "loaded", list }).list!.huddles).toEqual({});
    const started = roomListReducer(asked, { type: "huddle", roomId: "r2", huddle: huddle("grace") });
    expect(roomListReducer(started, { type: "loaded", list }).list!.huddles).toEqual({ r1: huddle("ada"), r2: huddle("grace") });
  });
});

describe("Huddle sounds, which each person turns on or off for themselves", () => {
  const EVERY_SOUND = { music: true, chimes: true, ring: true };
  const NO_MUSIC = { ...EVERY_SOUND, music: false };
  const list = sidebar([room("r1", "general")]);
  const loaded = roomListReducer(NO_ROOM_LIST, { type: "loaded", list });

  it("keeps which of a huddle's sounds its person hears, and says nothing of them once they hear them all, as the server's list doesn't", () => {
    const quieter = roomListReducer(loaded, { type: "huddle sounds", sounds: NO_MUSIC });
    expect(quieter.list!.huddleSounds).toEqual(NO_MUSIC);
    expect(quieter.list!.rooms).toBe(loaded.list!.rooms);
    const ringless = roomListReducer(quieter, { type: "huddle sounds", sounds: { ...NO_MUSIC, ring: false } });
    expect(ringless.list!.huddleSounds).toEqual({ music: false, chimes: true, ring: false });

    const all = roomListReducer(ringless, { type: "huddle sounds", sounds: EVERY_SOUND });
    expect(all.list).not.toHaveProperty("huddleSounds");
    expect(all.list).toEqual(list);
  });

  it("keeps the sounds a switch saved while a list was on its way over the ones the list has, a sound turned back on too", () => {
    const asked = roomListReducer(loaded, { type: "asked" });
    const off = roomListReducer(asked, { type: "huddle sounds", sounds: NO_MUSIC });
    expect(roomListReducer(off, { type: "loaded", list }).list!.huddleSounds).toEqual(NO_MUSIC);
    const on = roomListReducer(asked, { type: "huddle sounds", sounds: EVERY_SOUND });
    expect(roomListReducer(on, { type: "loaded", list: { ...list, huddleSounds: NO_MUSIC } }).list).not.toHaveProperty("huddleSounds");
  });

  it("takes the sounds the list has otherwise, and has them all heard when the first list fails to arrive", () => {
    expect(roomListReducer(roomListReducer(loaded, { type: "asked" }), { type: "loaded", list: { ...list, huddleSounds: NO_MUSIC } }).list!.huddleSounds).toEqual(NO_MUSIC);
    expect(roomListReducer(NO_ROOM_LIST, { type: "unanswered" }).list).not.toHaveProperty("huddleSounds");
  });
});

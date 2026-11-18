import type { Involvement, LiveHuddle, PastHuddle, SidebarRoom } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { huddlesGoingOn, recentHuddles } from "./huddle-list";

const room = (id: string, involvement: Involvement = "mentions"): SidebarRoom => ({ id, kind: "open", name: id, icon: null, unread: false, involvement });
const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 9, minute)).toISOString();
/** A huddle going on since that minute past nine, with those people in it. */
const live = (minute: number, ...userIds: string[]): LiveHuddle => ({ startedAt: at(minute), userIds });
/** A huddle in `roomId` that started at that minute past nine and went on for ten. */
const over = (roomId: string, minute: number): PastHuddle => ({ roomId, messageId: `${roomId}-${minute}`, startedAt: at(minute), endedAt: at(minute + 10), userIds: ["ada", "grace"], replies: 0 });

describe("The huddles going on", () => {
  it("lists each with its room, the one that started latest first, and of two that started at once, in their rooms' order", () => {
    const rooms = [room("general"), room("random"), room("design"), room("ops")];
    const going = huddlesGoingOn(rooms, { ops: live(5, "linus"), general: live(5, "ada"), design: live(20, "grace") });
    expect(going.map(({ room, huddle }) => [room.id, huddle.userIds])).toEqual([
      ["design", ["grace"]],
      ["general", ["ada"]],
      ["ops", ["linus"]],
    ]);
    expect(going[0]!.room).toBe(rooms[2]);
  });

  it("leaves out a room hidden from the sidebar, and a huddle in a room that isn't listed", () => {
    const going = huddlesGoingOn([room("general"), room("quiet", "invisible")], { general: live(1, "ada"), quiet: live(2, "grace"), gone: live(3, "linus") });
    expect(going.map(({ room }) => room.id)).toEqual(["general"]);
  });

  it("lists none while none is going on", () => {
    expect(huddlesGoingOn([room("general")], {})).toEqual([]);
  });
});

describe("The huddles that are over", () => {
  it("keeps the order they were answered in, each with its room", () => {
    const rooms = [room("general"), room("random")];
    const recent = recentHuddles([over("random", 40), over("general", 30), over("random", 10)], rooms, {});
    expect(recent.map(({ room, huddle }) => [room.id, huddle.messageId])).toEqual([
      ["random", "random-40"],
      ["general", "general-30"],
      ["random", "random-10"],
    ]);
    expect(recent[0]!.room).toBe(rooms[1]);
  });

  it("leaves out those of a room that's no longer listed, and of one hidden from the sidebar", () => {
    const recent = recentHuddles([over("left", 40), over("quiet", 30), over("general", 10)], [room("general"), room("quiet", "invisible")], {});
    expect(recent.map(({ huddle }) => huddle.messageId)).toEqual(["general-10"]);
  });

  it("leaves out one the sidebar still has as going on in its room, until it hears otherwise, and lists the room's others", () => {
    const past = [over("general", 40), over("general", 10)];
    const listed = (going: Record<string, LiveHuddle>) => recentHuddles(past, [room("general")], going).map(({ huddle }) => huddle.messageId);
    expect(listed({ general: live(40, "ada") })).toEqual(["general-10"]);
    expect(listed({})).toEqual(["general-40", "general-10"]);
    // The room's next huddle, going on now, hides neither.
    expect(listed({ general: live(55, "ada") })).toEqual(["general-40", "general-10"]);
  });
});

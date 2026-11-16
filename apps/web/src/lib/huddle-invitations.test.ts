import type { LiveHuddle } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { invitationsReducer, NO_INVITATIONS, type HuddleInvitation, type HuddlesSeen, type InvitationsChange } from "./huddle-invitations";

const huddleOf = (...userIds: string[]): LiveHuddle => ({ startedAt: "2026-11-16T09:00:00.000Z", userIds });
const invited = (roomId: string, by = "priya", at = 1_000): InvitationsChange => ({ type: "invited", roomId, by, at });
/** The invitations after each of `changes`, from none. */
const after = (...changes: InvitationsChange[]) => changes.reduce(invitationsReducer, NO_INVITATIONS);
/** What Ada's tab sees: huddles on, her rooms the two direct messages, no huddle going on and none joined, but for what `seen` says. */
const seeing = (seen: Partial<HuddlesSeen> = {}): InvitationsChange => ({ type: "seen", on: true, meId: "ada", roomIds: new Set(["direct-1", "direct-2"]), live: {}, joinedRoomId: null, ...seen });
const rooms = (invitations: HuddleInvitation[]) => invitations.map(({ roomId }) => roomId);

describe("An invitation into a huddle", () => {
  it("rings from when it comes, after the ones before it", () => {
    expect(after(invited("direct-1"), invited("direct-2", "sam", 2_000))).toEqual([
      { roomId: "direct-1", by: "priya", at: 1_000, listed: false, live: false },
      { roomId: "direct-2", by: "sam", at: 2_000, listed: false, live: false },
    ]);
  });

  it("takes the place of the one before it for the same room, as the latest to come", () => {
    expect(after(invited("direct-1"), invited("direct-2"), invited("direct-1", "sam", 3_000))).toEqual([
      { roomId: "direct-2", by: "priya", at: 1_000, listed: false, live: false },
      { roomId: "direct-1", by: "sam", at: 3_000, listed: false, live: false },
    ]);
  });

  it("is over once it's answered or given up on, which leaves the others ringing", () => {
    const ringing = after(invited("direct-1"), invited("direct-2"));
    expect(rooms(invitationsReducer(ringing, { type: "over", roomId: "direct-1" }))).toEqual(["direct-2"]);
    // One for a room with none ringing changes nothing, the list itself included.
    expect(invitationsReducer(ringing, { type: "over", roomId: "direct-3" })).toBe(ringing);
  });
});

describe("What a tab sees of huddles", () => {
  it("marks an invitation whose room is among its person's, which rings on, the list as it is, while its huddle has yet to be heard of", () => {
    const ringing = after(invited("direct-1"), seeing());
    expect(ringing).toEqual([{ roomId: "direct-1", by: "priya", at: 1_000, listed: true, live: false }]);
    expect(invitationsReducer(ringing, seeing())).toBe(ringing);
  });

  it("marks one whose huddle is going on, which is over once the huddle is", () => {
    const going = after(invited("direct-1"), seeing({ live: { "direct-1": huddleOf("priya") } }));
    expect(going).toEqual([{ roomId: "direct-1", by: "priya", at: 1_000, listed: true, live: true }]);
    // Seen again, nothing changes.
    expect(invitationsReducer(going, seeing({ live: { "direct-1": huddleOf("priya") } }))).toBe(going);
    expect(invitationsReducer(going, seeing())).toEqual([]);
  });

  it("ends one whose person is in the huddle, in this tab or anywhere else", () => {
    const ringing = after(invited("direct-1"), invited("direct-2"), seeing());
    expect(rooms(invitationsReducer(ringing, seeing({ joinedRoomId: "direct-1" })))).toEqual(["direct-2"]);
    expect(rooms(invitationsReducer(ringing, seeing({ live: { "direct-2": huddleOf("sam", "ada") } })))).toEqual(["direct-1"]);
    // Being in another room's huddle ends neither.
    expect(invitationsReducer(ringing, seeing({ joinedRoomId: "general", live: { general: huddleOf("ada") } }))).toBe(ringing);
  });

  it("ends one into a room that's no longer this person's, which it has seen among theirs and no longer does", () => {
    const ringing = after(invited("direct-1"), invited("direct-2"), seeing());
    expect(rooms(invitationsReducer(ringing, seeing({ roomIds: new Set(["direct-2"]) })))).toEqual(["direct-2"]);
  });

  it("leaves one ringing into a room it has yet to see among its person's, as one made while the tab wasn't connected, until their rooms have brought it", () => {
    const ringing = after(invited("direct-3"));
    // Their rooms as they were before it was made, and before any have come.
    expect(invitationsReducer(ringing, seeing())).toBe(ringing);
    expect(invitationsReducer(ringing, seeing({ roomIds: null }))).toBe(ringing);
    // Loaded again, they bring it, after which it can be theirs no longer.
    const listed = invitationsReducer(ringing, seeing({ roomIds: new Set(["direct-1", "direct-3"]) }));
    expect(listed).toEqual([{ roomId: "direct-3", by: "priya", at: 1_000, listed: true, live: false }]);
    expect(invitationsReducer(listed, seeing())).toEqual([]);
  });

  it("ends them all once huddles are off", () => {
    expect(invitationsReducer(after(invited("direct-1"), invited("direct-2")), seeing({ on: false }))).toBe(NO_INVITATIONS);
    expect(invitationsReducer(NO_INVITATIONS, seeing({ on: false }))).toBe(NO_INVITATIONS);
  });
});

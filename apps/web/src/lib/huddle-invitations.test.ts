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
      { roomId: "direct-1", by: "priya", at: 1_000, live: false },
      { roomId: "direct-2", by: "sam", at: 2_000, live: false },
    ]);
  });

  it("takes the place of the one before it for the same room, as the latest to come", () => {
    expect(after(invited("direct-1"), invited("direct-2"), invited("direct-1", "sam", 3_000))).toEqual([
      { roomId: "direct-2", by: "priya", at: 1_000, live: false },
      { roomId: "direct-1", by: "sam", at: 3_000, live: false },
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
  it("leaves an invitation ringing, and the list as it is, while its huddle has yet to be heard of", () => {
    const ringing = after(invited("direct-1"));
    expect(invitationsReducer(ringing, seeing())).toBe(ringing);
  });

  it("marks one whose huddle is going on, which is over once the huddle is", () => {
    const going = after(invited("direct-1"), seeing({ live: { "direct-1": huddleOf("priya") } }));
    expect(going).toEqual([{ roomId: "direct-1", by: "priya", at: 1_000, live: true }]);
    // Seen again, nothing changes.
    expect(invitationsReducer(going, seeing({ live: { "direct-1": huddleOf("priya") } }))).toBe(going);
    expect(invitationsReducer(going, seeing())).toEqual([]);
  });

  it("ends one whose person is in the huddle, in this tab or anywhere else", () => {
    const ringing = after(invited("direct-1"), invited("direct-2"));
    expect(rooms(invitationsReducer(ringing, seeing({ joinedRoomId: "direct-1" })))).toEqual(["direct-2"]);
    expect(rooms(invitationsReducer(ringing, seeing({ live: { "direct-2": huddleOf("sam", "ada") } })))).toEqual(["direct-1"]);
    // Being in another room's huddle ends neither.
    expect(invitationsReducer(ringing, seeing({ joinedRoomId: "general", live: { general: huddleOf("ada") } }))).toBe(ringing);
  });

  it("ends one into a room that's no longer this person's, once their rooms have come", () => {
    const ringing = after(invited("direct-1"), invited("direct-3"));
    expect(invitationsReducer(ringing, seeing({ roomIds: null }))).toBe(ringing);
    expect(rooms(invitationsReducer(ringing, seeing()))).toEqual(["direct-1"]);
  });

  it("ends them all once huddles are off", () => {
    expect(invitationsReducer(after(invited("direct-1"), invited("direct-2")), seeing({ on: false }))).toBe(NO_INVITATIONS);
    expect(invitationsReducer(NO_INVITATIONS, seeing({ on: false }))).toBe(NO_INVITATIONS);
  });
});

import type { LiveHuddle, RoomId, UserId } from "@ember/protocol";

/** How long an invitation into a huddle rings before it gives up, unanswered. */
export const INVITATION_RINGS_MS = 30_000;

/**
 * An invitation into a room's huddle that rings in this tab: who invites its person, when it came, and
 * what the tab has seen since, the room among its person's and the huddle going on. It hears of the
 * huddle from the room's report, and of the invitation from whoever invites them, a moment before or
 * after.
 */
export interface HuddleInvitation {
  roomId: RoomId;
  by: UserId;
  /** When it came, by this tab's clock, which tells it from the one before it for the same room. */
  at: number;
  /**
   * Whether the tab has seen its room among its person's since it came, which it hasn't yet when the
   * room was made while the tab wasn't connected and their rooms are still loading again.
   */
  listed: boolean;
  /** Whether the tab has heard of the huddle going on since it came. */
  live: boolean;
}

export const NO_INVITATIONS: HuddleInvitation[] = [];

/** What the invitations that ring go by: whether huddles are on, this person's rooms, the huddles going on in them, and the one this tab is in. */
export interface HuddlesSeen {
  on: boolean;
  meId: UserId;
  /** This person's rooms, by their ids, or null until their list has come. */
  roomIds: ReadonlySet<RoomId> | null;
  live: Record<RoomId, LiveHuddle>;
  /** The room whose huddle this tab is in, or null while it's in none. */
  joinedRoomId: RoomId | null;
}

/**
 * What changes the invitations that ring: one that comes, one that's over, as it is once it's answered,
 * in this tab or another of its person's, once its room is said to be gone, or once it has rung for as
 * long as one does, and what the tab now sees of the huddles they're into.
 */
export type InvitationsChange = { type: "invited"; roomId: RoomId; by: UserId; at: number } | { type: "over"; roomId: RoomId } | ({ type: "seen" } & HuddlesSeen);

/** Whether a room is among this person's, as the tab sees them, which it isn't until their rooms have come. */
const isListed = (roomId: RoomId, seen: HuddlesSeen) => seen.roomIds?.has(roomId) ?? false;

/**
 * Whether an invitation still rings, by what the tab sees: not once the room is no longer its person's,
 * which it is when the tab has seen it among theirs and it's no longer there, nor once they're in the
 * huddle, in this tab or anywhere else, nor once the huddle is over, which it is when the tab has heard
 * of it and it's no longer going on.
 */
function rings({ roomId, listed, live }: HuddleInvitation, seen: HuddlesSeen): boolean {
  const huddle = seen.live[roomId];
  if (listed && !isListed(roomId, seen)) return false;
  if (seen.joinedRoomId === roomId || huddle?.userIds.includes(seen.meId)) return false;
  return huddle !== undefined || !live;
}

/** `invitation`, marked with what the tab has seen since it came: its room among its person's, and its huddle going on. */
function marked(invitation: HuddleInvitation, seen: HuddlesSeen): HuddleInvitation {
  const listed = invitation.listed || isListed(invitation.roomId, seen);
  const live = invitation.live || invitation.roomId in seen.live;
  return listed === invitation.listed && live === invitation.live ? invitation : { ...invitation, listed, live };
}

/** The invitations of `invitations` that ring still, by what the tab sees, each marked with what it has seen of its room and its huddle. */
function stillRinging(invitations: HuddleInvitation[], seen: HuddlesSeen): HuddleInvitation[] {
  if (!seen.on) return NO_INVITATIONS;
  return invitations.filter((invitation) => rings(invitation, seen)).map((invitation) => marked(invitation, seen));
}

/** `invitations` without the one into room `roomId`'s huddle. */
const without = (invitations: HuddleInvitation[], roomId: RoomId) => invitations.filter((invitation) => invitation.roomId !== roomId);

/** Whether two lists hold the same invitations, in the same order. */
const areSame = (some: HuddleInvitation[], others: HuddleInvitation[]) => some.length === others.length && some.every((invitation, index) => invitation === others[index]);

/**
 * The invitations into huddles that ring in this tab, in the order they came, one a room at most: a
 * later one for a room rings in place of the one before it. What changes none of them leaves the list
 * as it is, so that seeing the same huddles again changes nothing.
 */
export function invitationsReducer(invitations: HuddleInvitation[], change: InvitationsChange): HuddleInvitation[] {
  switch (change.type) {
    case "invited":
      return [...without(invitations, change.roomId), { roomId: change.roomId, by: change.by, at: change.at, listed: false, live: false }];
    case "over":
      return invitations.some(({ roomId }) => roomId === change.roomId) ? without(invitations, change.roomId) : invitations;
    case "seen": {
      const ringing = stillRinging(invitations, change);
      return areSame(ringing, invitations) ? invitations : ringing;
    }
  }
}

import type { LiveHuddle, PastHuddle, RoomId, SidebarRoom } from "@ember/protocol";
import { isHidden } from "./involvement";

/** A huddle going on in one of someone's rooms or DMs, with the room it's in. */
export interface HuddleGoingOn {
  room: SidebarRoom;
  huddle: LiveHuddle;
}

/** A huddle that's over, with the room it was in. */
export interface HuddleOver {
  room: SidebarRoom;
  huddle: PastHuddle;
}

/**
 * The huddles going on in someone's rooms and DMs (`live`, by room), as the Huddles page lists them and
 * the sidebar's Huddles row counts them: the one that started latest first, and of two that started at
 * once, in their rooms' order. The rooms they've hidden from their sidebar are left out, as their unread
 * marks are.
 */
export function huddlesGoingOn(rooms: SidebarRoom[], live: Record<RoomId, LiveHuddle>): HuddleGoingOn[] {
  return rooms
    .flatMap((room) => {
      const huddle = live[room.id];
      return huddle && !isHidden(room) ? [{ room, huddle }] : [];
    })
    .sort((a, b) => (a.huddle.startedAt < b.huddle.startedAt ? 1 : a.huddle.startedAt > b.huddle.startedAt ? -1 : 0));
}

/**
 * The huddles that are over (`past`), as the Huddles page lists them, in the order the server answered
 * them, each with its room: those of the rooms someone is still in and hasn't hidden. One the sidebar
 * still has as going on in its room is left out until the sidebar hears it's over, rather than listed
 * twice.
 */
export function recentHuddles(past: PastHuddle[], rooms: SidebarRoom[], live: Record<RoomId, LiveHuddle>): HuddleOver[] {
  const listed = new Map(rooms.filter((room) => !isHidden(room)).map((room) => [room.id, room]));
  return past.flatMap((huddle) => {
    const room = listed.get(huddle.roomId);
    return room && live[huddle.roomId]?.startedAt !== huddle.startedAt ? [{ room, huddle }] : [];
  });
}

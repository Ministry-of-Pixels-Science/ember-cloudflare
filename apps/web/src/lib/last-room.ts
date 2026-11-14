import type { Room, RoomId } from "@ember/protocol";

// The last room this browser showed, for `/` and Go Back to return to, as Campfire keeps it in a
// permanent `last_room` cookie (TrackedRoomVisit). Like the cookie, it's the browser's, whoever signs
// in, and only a room they're in counts.

const KEY = "ember:last-room";

function storedLastRoom(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Remembers the room shown, writing only when it changes. */
export function rememberLastRoom(roomId: RoomId): void {
  try {
    if (localStorage.getItem(KEY) !== roomId) localStorage.setItem(KEY, roomId);
  } catch {
    // Storage can be refused, and then `/` goes to the room someone was put in first.
  }
}

/**
 * The last room visited, as Campfire's `last_room_visited` finds it: the last room shown, while it's one
 * of `rooms`. Or else, where Campfire takes the oldest room, the first of them, the room someone was put
 * in first, since they come in the order they were put in them. Null when there are none.
 */
export function lastRoomVisited(rooms: Room[]): Room | null {
  const lastRoomId = storedLastRoom();
  return rooms.find((room) => room.id === lastRoomId) ?? rooms[0] ?? null;
}

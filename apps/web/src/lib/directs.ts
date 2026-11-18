import type { DirectoryUser, DirectRoom, Me, Room, User, UserId } from "@ember/protocol";
import { canAsk } from "./agents";

/**
 * Names in a sentence, as Rails' `to_sentence` joins them for a DM's name: "Ada", "Ada and Grace", or
 * "Ada, Grace, and Alan".
 */
export function toSentence(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * Who a DM shows the person `meId` signs in: the others in it, or just them in their DM with themselves,
 * as the sidebar's row and the DM's settings list them.
 */
export function membersShown(room: DirectRoom, meId: UserId): User[] {
  const others = room.members.filter((member) => member.id !== meId);
  return others.length > 0 ? others : room.members;
}

/**
 * A room's name as the person `meId` reads it, as Campfire's `room_display_name` gives it: a shared
 * room's own, and a DM's others' names in a sentence, or their own in their DM with themselves. `nameOf`
 * gives each person's name as it is now.
 */
export function roomName(room: Room, meId: UserId, nameOf: (user: User) => string): string {
  return room.kind === "direct" ? toSentence(membersShown(room, meId).map(nameOf)) : room.name;
}

/** How many people New direct message lists at a time. */
export const PEOPLE_PAGE = 20;

/** What New direct message looks for in what's typed: the name without any @s before it. */
export function soughtName(typed: string): string {
  return typed.trim().replace(/^@+/, "").trim();
}

/** `text` in lower case as SQLite's LIKE and LOWER() have it, which fold A to Z and nothing else. */
const foldedCase = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The people New direct message lists `me` for `name`: everyone active, bots included, whose name has
 * `name` in it, or whose username starts with it, ignoring the case of A to Z, by name in lower case. It
 * leaves out `me`, and the AI agents only administrators can ask unless they're one, as a DM with one
 * wouldn't start, and orders people with the same name by id, where SQLite leaves them in no particular
 * order.
 */
export function peopleMatching(people: Iterable<DirectoryUser>, me: Me, name: string): DirectoryUser[] {
  const sought = foldedCase(name);
  const matches = (person: DirectoryUser) => foldedCase(person.name).includes(sought) || person.username?.startsWith(sought);
  return [...people]
    .filter((person) => person.status === "active" && person.id !== me.id && canAsk(person, me) && matches(person))
    .map((person) => ({ person, key: foldedCase(person.name) }))
    .sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.person.id < b.person.id ? -1 : 1))
    .map(({ person }) => person);
}

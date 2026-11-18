import type { DirectRoom, Room, User, UserId } from "@ember/protocol";
import { toSentence } from "./directs";

/** How many people a sentence about a huddle names before it counts the rest. */
const MAX_NAMED = 3;

const firstName = (name: string) => name.trim().split(/\s+/)[0]!;

const othersCounted = (count: number) => (count === 1 ? "1 other" : `${count} others`);

/**
 * `count` people as a sentence starts with them, `names` being those of them whose names are known: by
 * first name up to three, "Sam, Priya, and Leo", then how many others, "Sam, Priya, Leo, and 2 others",
 * and with no name known, "2 people".
 */
function peopleListed(names: string[], count: number): string {
  if (names.length === 0) return count === 1 ? "1 person" : `${count} people`;
  const named = names.slice(0, MAX_NAMED).map(firstName);
  return toSentence(count > named.length ? [...named, othersCounted(count - named.length)] : named);
}

/**
 * Who a huddle in a direct message is with, for the person `meId` signs in: the others in it, but for
 * whoever joins no huddle (`joinsNone`), which is the bots, AI agents among them, and anyone who can no
 * longer sign in.
 */
export const huddledWith = (room: DirectRoom, meId: UserId, joinsNone: (user: User) => boolean): User[] => room.members.filter((member) => member.id !== meId && !joinsNone(member));

/**
 * Whether a room has huddles where they're on: every shared room whose settings allow them, and a
 * direct message with someone to huddle with.
 */
export const hasHuddles = (room: Room, meId: UserId, joinsNone: (user: User) => boolean): boolean =>
  room.kind === "direct" ? huddledWith(room, meId, joinsNone).length > 0 : room.huddles !== false;

/**
 * Who the person `meId` signs in can invite into a huddle they're in, of the people in its room
 * (`members`): everyone but themselves, whoever is in it already (`inIt`), and whoever joins none.
 */
export const invitable = (members: User[], meId: UserId, inIt: ReadonlySet<UserId>, joinsNone: (user: User) => boolean): User[] =>
  members.filter((member) => member.id !== meId && !inIt.has(member.id) && !joinsNone(member));

/**
 * Where a room's huddle is, as "Huddle" and "Start a huddle" go on: "in Launch", or who a direct
 * message's is with, "with Priya Patel". `name` is the room's as whoever's reading it reads it.
 */
export const huddlePlace = (room: Room, name: string) => (room.kind === "direct" ? `with ${name}` : `in ${name}`);

const invited = (names: string[]) => `${peopleListed(names, names.length)} ${names.length === 1 ? "is" : "are"} invited`;

/** Who a huddle in a direct message invites, for whoever is about to start it, by their names: "Priya is invited once it starts." */
export const invitedOnceItStarts = (names: string[]) => `${invited(names)} once it starts.`;

/** Who someone in a huddle has just invited into it, by their names: "Priya and Sam are invited." */
export const invitedNow = (names: string[]) => `${invited(names)}.`;

/** Who's in a huddle that's going on, for someone about to join it: "Sam is in it now." */
export const inItNow = (names: string[], count: number) => `${peopleListed(names, count)} ${count === 1 ? "is" : "are"} in it now.`;

/**
 * Who's in a huddle, for someone in it, by the names of the others: "Just you in the huddle", "Sam and
 * you are in the huddle", and past three others, "Sam, Priya, Leo, and 2 others are in the huddle".
 */
export function inTheHuddle(others: string[]): string {
  if (others.length === 0) return "Just you in the huddle";
  const everyone = others.length <= MAX_NAMED ? toSentence([...others.map(firstName), "you"]) : peopleListed(others, others.length);
  return `${everyone} are in the huddle`;
}

/**
 * Who shares a screen in a huddle, for someone in it, by the names of the others who do, and whether
 * they do themselves: "Sam is sharing a screen", "You're sharing your screen", "Sam and you are sharing
 * screens". Null while nobody does.
 */
export function sharingScreens(others: string[], you: boolean): string | null {
  if (others.length === 0) return you ? "You're sharing your screen" : null;
  if (others.length === 1 && !you) return `${firstName(others[0]!)} is sharing a screen`;
  return `${toSentence([...others.map(firstName), ...(you ? ["you"] : [])])} are sharing screens`;
}

/**
 * Who's in a room's huddle, for anyone in the room: `others` are the names known of the `count` people in
 * it besides them, and `you` says they're in it too, when it's as `inTheHuddle` says it. For someone who
 * isn't, "Sam and Priya are in the huddle". Whoever has no name known is counted, "Sam and 2 others are
 * in the huddle", and with them in it, everyone is: "3 people are in the huddle".
 */
export function inItsHuddle(others: string[], count: number, you: boolean): string {
  if (you && others.length === count) return inTheHuddle(others);
  const [named, people] = you ? [[], count + 1] : [others, count];
  return `${peopleListed(named, people)} ${people === 1 ? "is" : "are"} in the huddle`;
}

/**
 * Who was in a huddle that's over, for anyone in its room, by the names of the others who were in it and
 * whether they were themselves: "Sam and Priya were in the huddle", "Sam and you were in the huddle",
 * "Only you were in the huddle", and past three others, "Sam, Priya, Leo, and 2 others were in the huddle".
 */
export function wereInTheHuddle(others: string[], you: boolean): string {
  if (others.length === 0) return you ? "Only you were in the huddle" : "Nobody was in the huddle";
  if (others.length === 1 && !you) return `${firstName(others[0]!)} was in the huddle`;
  const everyone = you && others.length <= MAX_NAMED ? toSentence([...others.map(firstName), "you"]) : peopleListed(others, others.length);
  return `${everyone} were in the huddle`;
}

/**
 * Who was in a room's huddle that's over, for anyone in the room, where only their ids are known:
 * `others` are the names known of the `count` people who were in it besides them, and `you` says they
 * were in it too, when it's as `wereInTheHuddle` says it. Whoever has no name known is counted, "Sam and
 * 2 others were in the huddle", and with them in it, everyone is: "3 people were in the huddle".
 */
export function wereInItsHuddle(others: string[], count: number, you: boolean): string {
  if (others.length === count) return wereInTheHuddle(others, you);
  const [named, people] = you ? [[], count + 1] : [others, count];
  return `${peopleListed(named, people)} ${people === 1 ? "was" : "were"} in the huddle`;
}

const counted = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`);

/**
 * How long a huddle went on, from when it started to when it ended, in whole minutes, as its message
 * says it of one that's over: "less than a minute", "24 minutes", "1 hour and 5 minutes".
 */
export function huddleLasted(startedAt: string, endedAt: string): string {
  const minutes = Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);
  if (minutes < 1) return "less than a minute";
  const [hours, left] = [Math.floor(minutes / 60), minutes % 60];
  if (hours === 0) return counted(left, "minute");
  return left === 0 ? counted(hours, "hour") : `${counted(hours, "hour")} and ${counted(left, "minute")}`;
}

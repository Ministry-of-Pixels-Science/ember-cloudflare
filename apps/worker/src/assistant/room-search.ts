import { hasWords, MAX_SEARCH_LENGTH, sanitizeSearch, searchTerms, type Message, type RoomId } from "@ember/protocol";
import type { Env } from "../env";
import { searchIndex } from "../search-index";
import { matchesOf } from "../searches";
import { ToolError, type EmberTool } from "./tool-calls";

// The first tool Ember runs for @ember and the agents: a search of the room they're asked in, for what was
// written there besides the messages they read with a question, which it leaves out, so that those don't
// crowd out what's older. It finds only that room's messages, which everyone who sees the answer can
// read, as the search page finds them for someone in the room.

/** The most messages a search answers with, the newest that match. */
export const MESSAGES_FOUND = 10;

/** The most characters of a message a search answers with, about a long paragraph. */
export const MAX_FOUND_LENGTH = 600;

const NAME = "search_messages";

const DESCRIPTION = [
  "Searches the messages of the room you're asked in, its threads too, and answers the newest that have every word you give, each with when it was written, who wrote it and what it says, leaving out the messages of the conversation you were given.",
  "Use it when the answer depends on something written in the room outside that conversation, such as what was decided, who said something, or a link or a number someone shared.",
  "It finds whole words as they were written, not meanings, so give one or two words the message would have, and search again with other words when nothing is found.",
].join(" ");

const TAKES = {
  type: "object",
  properties: { words: { type: "string", description: "The words to find: a message matches when it has them all, in any order." } },
  required: ["words"],
  additionalProperties: false,
};

/** The tool that searches room `roomId` for an answerer asked there, leaving out the messages `read` with its question, as the model has them. */
export function roomSearch(env: Env, roomId: RoomId, read: readonly string[]): EmberTool {
  const given = new Set(read);
  return { name: NAME, description: DESCRIPTION, takes: TAKES, run: ({ words }) => searched(env, roomId, given, words) };
}

/**
 * What a search of room `roomId` for `words` answers: its newest messages with them all, but those
 * `given` with the question, or that there are none. A page of the search holds more matches than a
 * question's conversation has messages, so what's left of a full one is enough to answer with.
 */
async function searched(env: Env, roomId: RoomId, given: ReadonlySet<string>, words: unknown): Promise<string> {
  if (typeof words !== "string" || !hasWords(words)) throw new ToolError("Give the words to find, as `words`.");
  if (words.length > MAX_SEARCH_LENGTH) throw new ToolError("That's too much to search for. Give one or two words.");
  const { hits, next } = await searchIndex(env).search({ terms: searchTerms(sanitizeSearch(words)), roomIds: [roomId], sort: "newest", after: null });
  // Every other match on the page is read before the newest are taken, as one the room no longer has is left out.
  const ungiven = hits.filter(({ messageId }) => !given.has(messageId));
  const others = await matchesOf(env, ungiven);
  const found = others.slice(0, MESSAGES_FOUND).map(({ message }) => message);
  if (found.length === 0) return ungiven.length === hits.length ? "No message in this room has those words." : "No message in this room has those words, but for those of the conversation you were given.";
  const more = next !== null || others.length > found.length;
  const count = more ? `The newest ${found.length} messages with those words, of more` : found.length === 1 ? "The only message with those words" : `All ${found.length} messages with those words, newest first`;
  return [`${count}:`, ...found.map(lineOf)].join("\n\n");
}

/** A message as a search answers with it: when it was written, in UTC, who wrote it, and its text, or its file's name, cut to what a search shows. */
function lineOf({ createdAt, creator, plainText, attachment, parentId }: Message): string {
  const text = attachment ? `(shares a file, ${plainText})` : plainText.trim();
  const shown = text.length > MAX_FOUND_LENGTH ? `${text.slice(0, MAX_FOUND_LENGTH - 1).trimEnd()}…` : text;
  const when = `${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`;
  return `[${when}${parentId === undefined ? "" : ", in a thread"}] ${creator.name}: ${shown}`;
}

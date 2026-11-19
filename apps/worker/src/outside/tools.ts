import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { hasWords, HISTORY_PAGE_SIZE, MAX_MESSAGE_HTML_LENGTH, MAX_SEARCH_LENGTH, MESSAGE_TOO_LONG, sanitizeSearch, searchTerms, type Message, type Room, type SidebarRoom, type UserId } from "@ember/protocol";
import type { OutsideScope } from "@ember/protocol/outside";
import { markdownHtml, MAX_MARKDOWN_LENGTH } from "../bots/markdown";
import type { Env } from "../env";
import { searchIndex } from "../search-index";
import { matchesOf } from "../searches";
import { workspace, type OutsideAccess } from "../workspace";

// What an AI app connected to Ember can ask of it, as the person who connected it: the rooms they're
// in, a room's messages, a thread's, and a search of them all, and, where they let it, sending a
// message as them. Each reaches only the rooms that person is in, the ones they've hidden too, as their
// own search does, and of those, the ones open to everyone, unless they let the app into their direct
// messages and private rooms too (the "private" scope), and what a tool answers is JSON for the app's
// model to read.

/** The most characters of a message a tool answers with, past which it's cut: about a page. */
export const MAX_SHOWN_LENGTH = 4_000;

/** The most messages a search answers with at once. */
export const MESSAGES_FOUND = 20;

/** Why a tool can't do what it's asked, in words for the app's model. */
class Refused extends Error {}

const NO_ROOM = "No room this connection reaches has that id. list_rooms lists the rooms it reaches.";

/** What a send past the most a person's apps may make in a minute is told. */
export const SENDING_TOO_FAST = "That's more messages than an app may send as them in a minute. Wait a minute before sending another.";

/** What a send of more Markdown than a Slack payload's blocks may hold is told. */
export const TOO_MUCH_MARKDOWN = `That's more Markdown than a message takes. Keep it to ${MAX_MARKDOWN_LENGTH.toLocaleString()} characters.`;

/** A room as an app is told of it: a direct message goes by the names of the others in it. */
interface ShownRoom {
  id: string;
  kind: Room["kind"];
  name: string;
}

/** The name an app is told for `room`, as `userId` has it. */
function nameOf(room: Room, userId: UserId): string {
  if (room.kind !== "direct") return room.name;
  const others = room.members.filter(({ id }) => id !== userId);
  return (others.length > 0 ? others : room.members).map(({ name }) => name).join(", ");
}

const shownRoom = (room: Room, userId: UserId): ShownRoom => ({ id: room.id, kind: room.kind, name: nameOf(room, userId) });
const listedRoom = (room: SidebarRoom, userId: UserId) => ({ ...shownRoom(room, userId), unread: room.unread });

/** A message as an app is told of it. */
interface ShownMessage {
  id: string;
  /** When it was written, in UTC. */
  at: string;
  from: string;
  text: string;
  /** The name of the file it shares. A file message's text is empty, unless it's a bot's, given a file after its text or cards. */
  file?: string;
  edited?: true;
  /** For a reply, the id of the message whose thread it's in, which read_thread reads. */
  reply_to?: string;
  /** For a message with a thread, how many replies it has, which read_thread reads. */
  replies?: number;
  /** For a message deleted while its thread has replies left, which keeps its place with nothing else of it. */
  deleted?: true;
}

const cut = (text: string) => (text.length > MAX_SHOWN_LENGTH ? `${text.slice(0, MAX_SHOWN_LENGTH - 1).trimEnd()}…` : text);

function shownMessage({ id, createdAt, creator, body, plainText, cards, attachment, editedAt, parentId, thread, deleted }: Message): ShownMessage {
  // A file message's plain text is only its file's name, which `file` says.
  const onlyFile = attachment !== undefined && body === "" && !cards;
  return {
    id,
    at: createdAt,
    from: creator.name,
    text: onlyFile ? "" : cut(plainText.trim()),
    ...(attachment && { file: attachment.name }),
    ...(editedAt !== null && { edited: true as const }),
    ...(parentId !== undefined && { reply_to: parentId }),
    ...(thread && { replies: thread.count }),
    ...(deleted && { deleted: true as const }),
  };
}

/** The room `roomId` names among those of its person's that an app reaches, which is all it may read. */
async function roomOf(env: Env, access: OutsideAccess, roomId: unknown): Promise<Room> {
  const room = typeof roomId === "string" ? (await workspace(env).outsideReadable(access)).find(({ id }) => id === roomId) : undefined;
  if (!room) throw new Refused(NO_ROOM);
  return room;
}

/**
 * What `reading` reads of room `room`, once the app still reaches the room, as it looks again then: the
 * room may have been made private as it was read, or its person taken out of it, and what was read then
 * written since.
 */
async function readIn<T>(env: Env, access: OutsideAccess, room: Room, reading: Promise<T>): Promise<T> {
  const read = await reading;
  await roomOf(env, access, room.id);
  return read;
}

async function listRooms(env: Env, access: OutsideAccess): Promise<unknown> {
  return { rooms: (await workspace(env).outsideRooms(access)).map((room) => listedRoom(room, access.userId)) };
}

/** A page of a room's messages, oldest first: its newest, or those before the message `before` names, with the id to read further back from, if there's more. */
async function readRoom(env: Env, access: OutsideAccess, { room_id: roomId, before }: Record<string, unknown>): Promise<unknown> {
  const room = await roomOf(env, access, roomId);
  if (before !== undefined && typeof before !== "string") throw new Refused("Give `before` as a message's id.");
  const page = await readIn(env, access, room, env.CHAT_ROOM.getByName(room.id).outsidePage(room.id, before === undefined ? {} : { before }));
  if (!page) throw new Refused("The room has no message with the id given as `before`.");
  return { room: shownRoom(room, access.userId), messages: page.messages.map(shownMessage), older: page.hasMore && page.messages.length > 0 ? page.messages[0]!.id : null };
}

/** A thread: the message it's under, then its newest replies, oldest first. */
async function readThread(env: Env, access: OutsideAccess, { room_id: roomId, message_id: messageId }: Record<string, unknown>): Promise<unknown> {
  const room = await roomOf(env, access, roomId);
  const thread = typeof messageId === "string" ? await readIn(env, access, room, env.CHAT_ROOM.getByName(room.id).botThread(room.id, messageId)) : null;
  if (!thread) throw new Refused("The room has no message with that id that a thread could be under. A reply's thread is under the message its `reply_to` names.");
  const [message, ...replies] = thread;
  return { room: shownRoom(room, access.userId), message: shownMessage(message!), replies: replies.map(shownMessage) };
}

/** The newest messages with every word of `words`, in the rooms of the person's that the app reaches, or the one `room_id` names, from the match `after` on. */
async function searchMessages(env: Env, access: OutsideAccess, { words, room_id: roomId, after }: Record<string, unknown>): Promise<unknown> {
  if (typeof words !== "string" || !hasWords(words)) throw new Refused("Give the words to find, as `words`.");
  if (words.length > MAX_SEARCH_LENGTH) throw new Refused("That's too much to search for. Give one or two words.");
  if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after))) throw new Refused("Give `after` as the `next` an earlier search answered.");
  const readable = await workspace(env).outsideReadable(access);
  const rooms = roomId === undefined ? readable : readable.filter(({ id }) => id === roomId);
  if (rooms.length === 0) throw new Refused(roomId === undefined ? "This connection reaches no room of theirs to search." : NO_ROOM);
  const { hits, next } = await searchIndex(env).search({ terms: searchTerms(sanitizeSearch(words)), roomIds: rooms.map(({ id }) => id), sort: "newest", after: after ?? null });
  const taken = hits.slice(0, MESSAGES_FOUND);
  const found = await matchesOf(env, taken);
  // Of the rooms it found something in, it answers from those it still reaches, as `readIn` does.
  const reached = new Set((await workspace(env).outsideReadable(access)).map(({ id }) => id));
  const byId = new Map(rooms.filter(({ id }) => reached.has(id)).map((room) => [room.id, shownRoom(room, access.userId)]));
  const matches = found.flatMap(({ message }) => {
    const room = byId.get(message.roomId);
    return room ? [{ room, ...shownMessage(message) }] : [];
  });
  // The index numbers its matches, so the search after this one starts past the last it took.
  return { matches, next: taken.length < hits.length ? taken.at(-1)!.number : next };
}

/**
 * Sends `text`, in Markdown, to a room as the person, in the thread under the message `thread_id` names,
 * if it names one. It reads as they wrote it, to everyone in the room. Markdown has no way to mention
 * anyone, and the room posts it as a reply, which goes to no bot, so a message sent this way calls
 * nobody, @ember and the agents included, even in a direct message with one.
 */
async function sendMessage(env: Env, access: OutsideAccess, { room_id: roomId, text, thread_id: threadId }: Record<string, unknown>): Promise<unknown> {
  if (typeof text !== "string" || text.trim() === "") throw new Refused("Give the message to send, as `text`.");
  // The tool takes as much Markdown as a Slack payload's blocks hold, as the bot API takes a bot's body;
  // the room, which measures a message's text, then says whether the markup it reads as is too long.
  if (text.length > MAX_MARKDOWN_LENGTH) throw new Refused(TOO_MUCH_MARKDOWN);
  if (threadId !== undefined && typeof threadId !== "string") throw new Refused("Give `thread_id` as the id of the message the thread is under.");
  const room = await roomOf(env, access, roomId);
  const sender = await workspace(env).outsideSender(access, room.id);
  if (sender === "limited") throw new Refused(SENDING_TOO_FAST);
  // Only now, once the room's reached and the sender's within their limit, is the markup built and its
  // length checked, so a message turned away for its room or rate never renders.
  const markup = markdownHtml(text);
  if (markup.length > MAX_MESSAGE_HTML_LENGTH) throw new Refused(MESSAGE_TOO_LONG);
  const sent = sender && (await env.CHAT_ROOM.getByName(room.id).createOutsideMessage(room.id, sender, markup, threadId));
  if (!sent) throw new Refused(NO_ROOM);
  if (typeof sent === "string") throw new Refused(sent);
  return { room: shownRoom(room, access.userId), message: shownMessage(sent) };
}

interface Tool {
  name: string;
  title: string;
  description: string;
  /** What it takes, as a JSON Schema's properties, with which of them it has to be given. */
  takes: Record<string, { type: string; description: string }>;
  required: string[];
  run: (env: Env, access: OutsideAccess, given: Record<string, unknown>) => Promise<unknown>;
}

const ROOM_ID = { type: "string", description: "The room's id, as list_rooms gives it." };

/** The tools a connection allowed to read has. */
const READING: Tool[] = [
  {
    name: "list_rooms",
    title: "List rooms",
    description:
      "Lists the rooms the connected person is in that this connection reaches: each one's id, its name, its kind (open to everyone, closed, which is private, or direct, a direct message named after the others in it), and whether it has messages they haven't read.",
    takes: {},
    required: [],
    run: listRooms,
  },
  {
    name: "read_room",
    title: "Read a room",
    description: `Reads a room's messages, oldest first: its newest ${HISTORY_PAGE_SIZE}, or the ${HISTORY_PAGE_SIZE} before the message \`before\` names. Each has its id, when it was written, who wrote it and its text. \`older\` is the id to give as \`before\` to read further back, or null at the room's start. A message with \`replies\` has a thread, which read_thread reads.`,
    takes: { room_id: ROOM_ID, before: { type: "string", description: "A message's id, to read the messages before it: the `older` an earlier read answered." } },
    required: ["room_id"],
    run: readRoom,
  },
  {
    name: "read_thread",
    title: "Read a thread",
    description: `Reads a thread in a room: the message it's under, then its newest ${HISTORY_PAGE_SIZE} replies, oldest first.`,
    takes: { room_id: ROOM_ID, message_id: { type: "string", description: "The id of the message the thread is under: one with `replies`, or a reply's `reply_to`." } },
    required: ["room_id", "message_id"],
    run: readThread,
  },
  {
    name: "search_messages",
    title: "Search messages",
    description: `Searches the messages of the rooms this connection reaches, threads too, and answers the newest ${MESSAGES_FOUND} that have every word given, each with its room. It finds whole words as they were written, not meanings, so give one or two words the message would have. \`next\` is the number to give as \`after\` for older matches, or null when there are none.`,
    takes: {
      words: { type: "string", description: "The words to find: a message matches when it has them all, in any order." },
      room_id: { type: "string", description: "A room's id, as list_rooms gives it, to search that room alone." },
      after: { type: "number", description: "The `next` an earlier search with the same words answered, for the matches after it." },
    },
    required: ["words"],
    run: searchMessages,
  },
];

/** The tools a connection allowed to send has. */
const SENDING: Tool[] = [
  {
    name: "send_message",
    title: "Send a message",
    description:
      "Sends a message to a room as the connected person: everyone in the room sees it as theirs, so send only what they asked for, worded as they'd want. `text` is Markdown. With `thread_id`, it's a reply in the thread under that message. No bot or AI assistant in Ember is sent it or answers it, even in a direct message with one. Answers the message as sent.",
    takes: {
      room_id: ROOM_ID,
      text: { type: "string", description: "The message, in Markdown." },
      thread_id: { type: "string", description: "The id of the message to reply under, in its thread: one with `replies`, or a reply's `reply_to`." },
    },
    required: ["room_id", "text"],
    run: sendMessage,
  },
];

/**
 * The tools each scope gives a connection, with what an app is told of them: one that asks its person
 * before changing anything goes by whether a tool only reads. "private" gives none, only more rooms for
 * the others to reach.
 */
const TOOLS: Partial<Record<OutsideScope, { tools: Tool[]; annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean } }>> = {
  read: { tools: READING, annotations: { readOnlyHint: true, openWorldHint: false } },
  write: { tools: SENDING, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
};

/** What a tool answers an app: what it found, as JSON, or why it couldn't, as an error its model reads. */
async function answered(found: Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await found) }] };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
}

/** Gives `server` the tools `access` allows its app, each doing what it does as the connection's person. */
export function registerTools(server: McpServer, env: Env, access: OutsideAccess): void {
  for (const { tools, annotations } of access.scopes.flatMap((scope) => TOOLS[scope] ?? [])) {
    for (const { name, title, description, takes, required, run } of tools) {
      const inputSchema = fromJsonSchema({ type: "object" as const, properties: takes, required, additionalProperties: false });
      server.registerTool(name, { title, description, inputSchema, annotations }, (given) => answered(run(env, access, given as Record<string, unknown>)));
    }
  }
}

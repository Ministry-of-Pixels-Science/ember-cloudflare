import { PARENT_TEXT_LENGTH, parentTextOf, THREAD_FACES, type Boost, type Card, type Message, type RoomId, type ThreadSummary, type TimelinePage, type User, type UserId } from "@ember/protocol";
import { hasLinkable, type PreparedBody } from "@ember/richtext";
import { statement, type Db, type Statement } from "./db";
import { fileSigner, type FileUrls } from "./files/addresses";
import { deletingAllFiles, deletingFilesOf, type AttachedFile } from "./files/blobs";
import { logEvent, logIndexing, logIndexingEach, logIndexingReplies } from "./room-log";
import type { IndexedMessage, SearchFacts } from "./search-index";

// Messages for one room, kept in the room's Durable Object SQLite storage or in D1 (see db.ts), each
// with the number of its latest change, and the deletions a tab that connects again may yet need to
// hear of (migrations/0015_numbered_changes.sql). A file message keeps its file (migrations/0029_file_messages.sql),
// whose addresses are signed as it's read, so they're always signed under the secret Ember has now, and a
// bot's message its cards (migrations/0034_message_cards.sql). A reply in a thread names its parent, and shows
// in the room's timeline only when it was also sent there, and a parent is read with its thread's summary
// (migrations/0044_threads.sql).

interface MessageRow {
  id: string;
  room_id: RoomId;
  client_message_id: string;
  creator_id: string;
  creator_name: string;
  body: string;
  plain_text: string;
  /**
   * A JSON array of the people it mentions, each `{ "id", "name" }` as they were when its text was last
   * written, or each an id alone in a row from before mentions kept names.
   */
  mentions: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  /** A file message's file, as JSON (`AttachedFile`), or null. */
  attachment: string | null;
  /** A bot's cards, as a JSON array of `Card`s, or null for a message without any. */
  cards: string | null;
  /** The message's boosts, a JSON array of `BoostRow`s. */
  boosts: string;
  /** For a reply in a thread, the message it replies to, or null. */
  parent_id: string | null;
  /** 1 for a message the room's timeline shows: every message but a reply sent only to its thread. */
  in_room: number;
  /** 1 for a message deleted while replies in its thread are left, which keeps its place for them. */
  deleted: number;
  /**
   * Its thread, a JSON `ThreadRow`, read with it, or null for a reply, which has none, or missing from a
   * row the search index kept before threads.
   */
  thread?: string | null;
  /** Who wrote its thread's newest replies, a JSON array of `ReplierRow`s. */
  repliers?: string | null;
  /** For a reply, the start of its parent's plain text, or null once the parent is deleted. */
  parent_text?: string | null;
}

/** How many replies a message's thread has, and when the newest was written, if it has any. */
interface ThreadRow {
  count: number;
  latest_at: string | null;
}

/** Someone who replied in a thread, with the id of their newest reply there. */
interface ReplierRow extends User {
  latest: string;
}

interface BoostRow {
  id: string;
  message_id: string;
  booster_id: string;
  booster_name: string;
  content: string;
  created_at: string;
}

/** The ids go as one JSON value, since both backends bind at most 100 values a statement. */
export const STORED_CLIENT_MESSAGE_IDS = `SELECT client_message_id FROM messages
  WHERE room_id = ? AND creator_id = ? AND client_message_id IN (SELECT value FROM json_each(?))`;

/**
 * Up to a number of someone's messages, in no particular order, read through the same index as the above.
 * One deleted already, kept for its thread, is left out, so deleting them all comes to an end.
 */
export const MESSAGES_BY = `SELECT id FROM messages WHERE room_id = ? AND creator_id = ? AND deleted = 0 LIMIT ?`;

/** As MESSAGES_BY, but only those written by a time. */
export const MESSAGES_BY_UNTIL = `SELECT id FROM messages WHERE room_id = ? AND creator_id = ? AND created_at <= ? AND deleted = 0 LIMIT ?`;

/** A message being deleted, or whose thread loses replies, as `REPLIES_LEFT` reads it. */
interface DeletingRow {
  id: string;
  parent_id: string | null;
  deleted: number;
  /** 1 when its thread has replies left once the messages being deleted have gone. */
  replies_left: number;
}

/**
 * Of the messages a JSON array ?3 names that room ?1 has, whose replies each is, whether it's been kept for
 * its thread already, and whether its thread has replies other than those a JSON array ?2 names.
 */
const REPLIES_LEFT = `SELECT id, parent_id, deleted, EXISTS (
    SELECT 1 FROM messages AS replies WHERE replies.parent_id = messages.id AND replies.id NOT IN (SELECT value FROM json_each(?2))
  ) AS replies_left
  FROM messages WHERE room_id = ?1 AND id IN (SELECT value FROM json_each(?3))`;

/** Keeps the messages of room `?` a JSON array names for their threads, at a time, without their text, file or cards. */
const KEEP_FOR_THREADS = `UPDATE messages SET body = '', plain_text = '', mentions = '[]', attachment = NULL, cards = NULL, deleted = 1, updated_at = ?3
  WHERE room_id = ?1 AND id IN (SELECT value FROM json_each(?2))`;

/** Numbers changes to the messages of room ?1 a JSON array ?2 names from ?3, in the order it names them. */
const NUMBER_CHANGES = `UPDATE messages SET change_seq = ?3 + (SELECT key FROM json_each(?2) AS listed WHERE listed.value = messages.id)
  WHERE room_id = ?1 AND id IN (SELECT value FROM json_each(?2))`;

/** Up to a number of the room's oldest messages, as deleting the room deletes them a batch at a time. */
export const OLDEST_MESSAGES = `SELECT id FROM messages WHERE room_id = ? ORDER BY id LIMIT ?`;

const toBoost = (row: BoostRow): Boost => ({
  id: row.id,
  messageId: row.message_id,
  booster: { id: row.booster_id, name: row.booster_name },
  content: row.content,
  createdAt: row.created_at,
});

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A page of messages, oldest first, and whether the room has older ones. */
type Page = { messages: Message[]; hasMore: boolean };

/** `value` with it and everything in it frozen, so whatever shares it can't change it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** For an edit that makes `message`'s plain text `plainText`, logs its thread's replies for the search index, if what they show of it changes. */
function logIndexingRepliesTo(roomId: RoomId, message: Message, plainText: string): Statement[] {
  const retold = message.thread !== undefined && parentTextOf(message.plainText) !== parentTextOf(plainText);
  return retold ? [logIndexingReplies(roomId, JSON.stringify([message.id]))] : [];
}

/** A link written as one, in a message's markup or its cards'. */
const WRITTEN_LINK = /<a\s[^>]*\bhref=/i;

/**
 * What search filters narrow a search by, as the search index keeps it: who wrote the message, its
 * thread's id, which is its own for a message with replies, whether its text or cards have a link, whether
 * it has a file, and whom it mentions. A link is one written as one, an address its text or cards show as
 * one (`hasLinkable`), or any other address in its cards; a file message shows its file in place of its
 * text, which is the file's name.
 */
function searchFactsOf(row: MessageRow): SearchFacts {
  return {
    creatorId: row.creator_id,
    threadId: row.parent_id ?? (threadOf(row) ? row.id : null),
    hasLink:
      WRITTEN_LINK.test(row.body) ||
      (row.attachment === null && hasLinkable(row.plain_text)) ||
      (row.cards !== null && (WRITTEN_LINK.test(row.cards) || hasLinkable(row.cards))),
    hasFile: row.attachment !== null,
    mentionIds: [...new Set((JSON.parse(row.mentions) as (User | UserId)[]).map((person) => (typeof person === "string" ? person : person.id)))],
  };
}

/** A message's thread, from its row, if it has replies. */
function threadOf(row: MessageRow): ThreadSummary | undefined {
  const thread = row.thread == null ? null : (JSON.parse(row.thread) as ThreadRow);
  if (!thread || thread.count === 0) return undefined;
  // json_group_array doesn't promise an order, so sort here rather than in the subquery.
  const repliers = (JSON.parse(row.repliers ?? "[]") as ReplierRow[]).sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  return { count: thread.count, latestAt: thread.latest_at!, people: repliers.map(({ id, name }) => ({ id, name })) };
}

function toMessage(row: MessageRow): Message {
  const thread = threadOf(row);
  return {
    id: row.id,
    clientMessageId: row.client_message_id,
    roomId: row.room_id,
    creator: { id: row.creator_id, name: row.creator_name },
    body: row.body,
    plainText: row.plain_text,
    mentions: (JSON.parse(row.mentions) as (User | UserId)[]).map((person) => (typeof person === "string" ? { id: person, name: "" } : person)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,
    // json_group_array doesn't promise an order, so sort here rather than in the subquery.
    boosts: (JSON.parse(row.boosts) as BoostRow[]).map(toBoost).sort(byId),
    ...(row.cards !== null && { cards: JSON.parse(row.cards) as Card[] }),
    // A row the search index kept from before threads has none of their columns.
    ...(row.parent_id != null && { parentId: row.parent_id, alsoSent: row.in_room === 1, parentText: row.parent_text ?? "" }),
    ...(thread && { thread }),
    ...(row.deleted === 1 && { deleted: true }),
  };
}

/** Signs a file's addresses (files/addresses.ts). */
type Signer = (key: string, name: string, preview?: boolean) => Promise<FileUrls>;

/** `file` as its message shows it, with its addresses signed by `sign`. */
const shownFile = async ({ preview, ...file }: AttachedFile, sign: Signer) => ({ ...file, ...(await sign(file.id, file.name, preview)) });

/** Rows as messages, each file message with its file, whose addresses `signer` signs, only once a row has one. */
async function toMessages(rows: MessageRow[], signer: () => Promise<Signer>): Promise<Message[]> {
  const messages = rows.map(toMessage);
  if (rows.every((row) => row.attachment === null)) return messages;
  const sign = await signer();
  return Promise.all(
    messages.map(async (message, index) => {
      const { attachment } = rows[index]!;
      return attachment === null ? message : { ...message, attachment: await shownFile(JSON.parse(attachment) as AttachedFile, sign) };
    }),
  );
}

/** What a message keeps of what was written: its text, as `prepareBody` keeps it, and a bot's cards, if it has any. */
export type StoredBody = Pick<PreparedBody, "html" | "plainText" | "mentions"> & { cards?: Card[] };

/** A file message's file, as the batch that stores the message posts it, with what records that its upload has finished as that message. */
export interface PostedFile {
  file: AttachedFile;
  finished: (messageId: string) => Statement;
}

/**
 * Messages with their boosts, their threads' summaries and a reply's parent's text gathered by subqueries,
 * so a page is one statement: one round trip to D1, and no list of message ids to bind (both backends bind
 * at most 100 values a statement). A thread's people are the `THREAD_FACES` who wrote its newest replies,
 * each under the name they wrote the latest with: the replies with none later by their writers, newest
 * first, which the thread's index reads in order, so nothing is sorted.
 */
const SELECT_MESSAGES = `SELECT messages.*, (
    SELECT json_group_array(json_object('id', boosts.id, 'message_id', boosts.message_id, 'booster_id', boosts.booster_id,
      'booster_name', boosts.booster_name, 'content', boosts.content, 'created_at', boosts.created_at))
    FROM boosts WHERE boosts.message_id = messages.id
  ) AS boosts, CASE WHEN messages.parent_id IS NULL THEN (
    SELECT json_object('count', count(*), 'latest_at', (
      SELECT latest.created_at FROM messages AS latest WHERE latest.parent_id = messages.id ORDER BY latest.id DESC LIMIT 1
    )) FROM messages AS replies WHERE replies.parent_id = messages.id
  ) END AS thread, CASE WHEN messages.parent_id IS NULL THEN (
    SELECT json_group_array(json_object('id', creator_id, 'name', creator_name, 'latest', id)) FROM (
      SELECT replies.creator_id, replies.creator_name, replies.id FROM messages AS replies
      WHERE replies.parent_id = messages.id AND NOT EXISTS (
        SELECT 1 FROM messages AS later WHERE later.parent_id = messages.id AND later.id > replies.id AND later.creator_id = replies.creator_id
      )
      ORDER BY replies.id DESC LIMIT ${THREAD_FACES}
    )
  ) END AS repliers, CASE WHEN messages.parent_id IS NOT NULL THEN (
    SELECT substr(parents.plain_text, 1, ${PARENT_TEXT_LENGTH}) FROM messages AS parents WHERE parents.id = messages.parent_id
  ) END AS parent_text FROM messages`;

// The newest page and the pages before and after a message are separate statements: SQLite can't seek an
// index through `? IS NULL OR id < ?`, so a single statement walked the room from its newest message
// down to the cursor. Each reads only the messages the timeline shows, through their own index, so the
// replies sent only to threads are never read.
export const NEWEST_MESSAGES = `${SELECT_MESSAGES} WHERE room_id = ? AND in_room = 1 ORDER BY id DESC LIMIT ?`;
export const MESSAGES_BEFORE = `${SELECT_MESSAGES} WHERE room_id = ? AND in_room = 1 AND id < ? ORDER BY id DESC LIMIT ?`;
export const MESSAGES_AFTER = `${SELECT_MESSAGES} WHERE room_id = ? AND in_room = 1 AND id > ? ORDER BY id LIMIT ?`;

/** How many messages the room's timeline shows, which reads every one. */
export const COUNT_MESSAGES = `SELECT COUNT(*) AS count FROM messages WHERE room_id = ? AND in_room = 1`;

/** A thread's newest replies, and the page before one of them, as the room's pages are. */
export const NEWEST_REPLIES = `${SELECT_MESSAGES} WHERE room_id = ? AND parent_id = ? ORDER BY id DESC LIMIT ?`;
export const REPLIES_BEFORE = `${SELECT_MESSAGES} WHERE room_id = ? AND parent_id = ? AND id < ? ORDER BY id DESC LIMIT ?`;

/**
 * How many changes behind a tab that connects again can be and still catch up, which is as long as the
 * room keeps a deleted message's id. One further behind gets the newest page, as a new tab does.
 */
export const CHANGES_KEPT = 100;

/** The room's latest change, or 0 before its first: the latest a message carries, or a deletion's after it. */
export const LATEST_CHANGE = `SELECT MAX(
    COALESCE((SELECT MAX(change_seq) FROM messages WHERE room_id = ?), 0),
    COALESCE((SELECT MAX(seq) FROM message_deletions WHERE room_id = ?), 0)
  ) AS seq`;
/**
 * The messages the room's timeline shows changed after a change, as they are now, in the order of their
 * latest changes, which their index holds, so the room reads only those, however many it has. A tab
 * opens a thread afresh as it catches up, so replies sent only to their threads are left out.
 */
export const MESSAGES_CHANGED_SINCE = `${SELECT_MESSAGES} WHERE room_id = ? AND change_seq > ? AND in_room = 1 ORDER BY change_seq`;
/** The messages deleted after a change. */
export const MESSAGES_DELETED_SINCE = `SELECT message_id FROM message_deletions WHERE room_id = ? AND seq > ? ORDER BY seq`;

/** The messages whose ids a JSON array lists. */
const MESSAGES_WITH_IDS = `${SELECT_MESSAGES} WHERE room_id = ? AND id IN (SELECT value FROM json_each(?))`;

/**
 * The longest row the search index keeps for a result to show, in UTF-16 code units: a row of Durable
 * Object SQLite takes 2 MB, and each unit takes at most 3 bytes of UTF-8, so this leaves room for the rest
 * of the index's row. A message with more, as one with many cards can have, goes without, and a search
 * reads it from its room.
 */
const MAX_INDEXED_ROW = 600_000;

/** The same in every room, which D1 alone can read at once. */
const MESSAGES_ANYWHERE_WITH_IDS = `${SELECT_MESSAGES} WHERE id IN (SELECT value FROM json_each(?))`;

/** A new message's place in a thread: the message it replies to, and whether it's also sent to the room. */
export interface InThread {
  parent: Message;
  alsoSend: boolean;
}

/** A message changed as another changed, with the number of its change. */
export interface Changed {
  message: Message;
  seq: number;
}

/**
 * What deleting messages did: the ids of those deleted, their deletions numbered from `seq` in that order,
 * and after them the messages changed, each kept without its text for its thread, or a parent whose
 * thread lost replies.
 */
export interface Deletion {
  deletedIds: string[];
  changed: Changed[];
  seq: number;
}

/** Which page `MessageStore.pageAt` reads: the one before a message, or after one, or with neither the newest. */
export interface PageCursor {
  before?: string;
  after?: string;
}

/** What changed in a room after a change a tab has seen, and the latest change. */
export interface Changes {
  /** The messages changed since, as they are now, oldest first. */
  messages: Message[];
  /** The ids of the messages deleted since, including any made since. */
  deletedIds: string[];
  seq: number;
}

export class MessageStore {
  /**
   * The room's latest change, read once and then counted here, since the room is the only writer of
   * its messages; null until read, and again after a batch fails, which D1 may have saved all the same.
   */
  private seq: number | null = null;
  /** What signs files' addresses, under `secret`, once the store has read a file message. */
  private signer: Promise<Signer> | null = null;
  /**
   * The newest page, by how many messages it holds, kept from one read until the room's next change:
   * every socket's welcome starts with it, and the room is the only writer of its messages. Frozen,
   * since every welcome shares it.
   */
  private readonly newest = new Map<number, Page>();
  /** Counts changes begun and done, so a read that overlapped one isn't kept: on D1, queries interleave. */
  private changes = 0;
  /** How many changes are under way. */
  private changing = 0;

  constructor(
    private readonly db: Db,
    readonly roomId: RoomId,
    private readonly secret: string,
  ) {}

  private readonly sign = () => (this.signer ??= fileSigner(this.secret));

  /** Rows as messages, with their files' addresses signed. */
  private messagesOf(rows: MessageRow[]): Promise<Message[]> {
    return toMessages(rows, this.sign);
  }

  /** The newest `limit` messages older than `before` (or the newest overall), oldest first. */
  async page(limit: number, before?: string): Promise<Page> {
    if (before !== undefined) return this.toPage(await this.db.all<MessageRow>(MESSAGES_BEFORE, this.roomId, before, limit + 1), limit);
    const kept = this.newest.get(limit);
    if (kept) return kept;
    const changes = this.changes;
    const page = await this.toPage(await this.db.all<MessageRow>(NEWEST_MESSAGES, this.roomId, limit + 1), limit);
    if (changes === this.changes && this.changing === 0) this.newest.set(limit, deepFreeze(page));
    return page;
  }

  /** The oldest `limit` messages newer than `after`, oldest first, and whether there are newer ones still. */
  async after(limit: number, after: string): Promise<{ messages: Message[]; hasNewer: boolean }> {
    const rows = await this.db.all<MessageRow>(MESSAGES_AFTER, this.roomId, after, limit + 1);
    return { messages: await this.messagesOf(rows.slice(0, limit)), hasNewer: rows.length > limit };
  }

  /**
   * The page before the message `before` names, or else after the one `after` names, or else the newest,
   * with whether the room has messages older than its first and newer than its last, or null when the
   * room doesn't have the message named.
   */
  async pageAt({ before, after }: PageCursor, limit: number): Promise<Omit<TimelinePage, "around"> | null> {
    if (before !== undefined) {
      const [cursor, { messages, hasMore }] = await Promise.all([this.find(before), this.page(limit, before)]);
      // The message named is newer than every message before it.
      return cursor && { messages, hasMore, hasNewer: messages.length > 0 };
    }
    if (after !== undefined) {
      const [cursor, { messages, hasNewer }] = await Promise.all([this.find(after), this.after(limit, after)]);
      return cursor && { messages, hasMore: messages.length > 0, hasNewer };
    }
    return { ...(await this.page(limit)), hasNewer: false };
  }

  /** How many messages the room has. */
  async count(): Promise<number> {
    return (await this.db.all<{ count: number }>(COUNT_MESSAGES, this.roomId))[0]!.count;
  }

  /**
   * The page around the message `id`: up to `limit` messages before it, it, and up to `limit` after, or
   * null when the room doesn't have it.
   */
  async around(id: string, limit: number): Promise<TimelinePage | null> {
    const [message, before, after] = await Promise.all([this.find(id), this.page(limit, id), this.after(limit, id)]);
    if (!message) return null;
    return { messages: [...before.messages, message, ...after.messages], hasMore: before.hasMore, hasNewer: after.hasNewer, around: id };
  }

  /**
   * A page to show in place of a timeline: the one around the message `around` names, if the room has
   * it, or else the newest `limit` messages.
   */
  async timeline(limit: number, around?: string): Promise<TimelinePage> {
    const page = around === undefined ? null : await this.around(around, limit);
    return page ?? { ...(await this.page(limit)), hasNewer: false, around: null };
  }

  /**
   * `timeline`'s page and the room's latest change, for a welcome. The room is the only writer of its
   * messages and changes them one event at a time, so the two agree.
   */
  async opening(limit: number, around?: string): Promise<TimelinePage & { seq: number }> {
    const [page, seq] = await Promise.all([this.timeline(limit, around), this.latestChange()]);
    return { ...page, seq };
  }

  /**
   * The thread of the message `parentId` names: the message, and its newest `limit` replies, oldest first,
   * with whether it has older ones. The message is null, with no replies, when the room doesn't have it or
   * it's a reply, which has no thread.
   */
  async thread(parentId: string, limit: number): Promise<Page & { parent: Message | null }> {
    const parent = await this.find(parentId);
    if (!parent || parent.parentId !== undefined) return { parent: null, messages: [], hasMore: false };
    return { parent, ...(await this.toPage(await this.db.all<MessageRow>(NEWEST_REPLIES, this.roomId, parentId, limit + 1), limit)) };
  }

  /** The newest `limit` replies in the thread of `parentId` older than `before`, oldest first. */
  async repliesBefore(parentId: string, before: string, limit: number): Promise<Page> {
    return this.toPage(await this.db.all<MessageRow>(REPLIES_BEFORE, this.roomId, parentId, before, limit + 1), limit);
  }

  /**
   * What changed after the room's change `since`, for a tab that has seen it, or null if the room can't
   * say: `since` is later than its latest change, or more than `CHANGES_KEPT` behind it.
   */
  async changesSince(since: number): Promise<Changes | null> {
    const seq = await this.latestChange();
    if (since > seq || seq - since > CHANGES_KEPT) return null;
    const [rows, deleted] = await Promise.all([
      this.db.all<MessageRow>(MESSAGES_CHANGED_SINCE, this.roomId, since),
      this.db.all<{ message_id: string }>(MESSAGES_DELETED_SINCE, this.roomId, since),
    ]);
    return { messages: (await this.messagesOf(rows)).sort(byId), deletedIds: deleted.map((row) => row.message_id), seq };
  }

  /** The messages `ids` names that the room has, in no particular order, for search results. */
  async withIds(ids: string[]): Promise<Message[]> {
    return this.messagesOf(await this.db.all<MessageRow>(MESSAGES_WITH_IDS, this.roomId, JSON.stringify(ids)));
  }

  /**
   * What the search index keeps of the messages `ids` names that the room has: their text, and their rows for
   * results to show. One deleted but kept for its thread is left out, as one deleted outright is.
   */
  async indexable(ids: string[]): Promise<IndexedMessage[]> {
    const rows = await this.db.all<MessageRow>(MESSAGES_WITH_IDS, this.roomId, JSON.stringify(ids));
    return rows.flatMap((row) => {
      if (row.deleted === 1) return [];
      const message = JSON.stringify(row);
      return [{ id: row.id, createdAt: row.created_at, text: row.plain_text, message: message.length <= MAX_INDEXED_ROW ? message : null, ...searchFactsOf(row) }];
    });
  }

  async find(id: string): Promise<Message | null> {
    const [row] = await this.db.all<MessageRow>(`${SELECT_MESSAGES} WHERE room_id = ? AND id = ?`, this.roomId, id);
    return row ? (await this.messagesOf([row]))[0]! : null;
  }

  /**
   * Stores a new message, logging it in the same transaction for the Workspace to mark the room unread
   * by, as a reply to a webhook delivery when it's one, and for the search index, and answers it with the
   * change's number. A file message posts `posted`'s file, recording that its upload has finished in
   * the same transaction. A reply in a thread, `inThread`, changes its parent's thread too, as the change
   * after it, logging the parent for the search index, whose results show its thread, and answers the
   * parent as it is then.
   */
  async create(
    id: string,
    clientMessageId: string,
    creator: User,
    body: StoredBody,
    now: string,
    kind: "message" | "reply" = "message",
    posted?: PostedFile,
    inThread?: InThread,
  ): Promise<{ message: Message; seq: number; parent: Changed | null }> {
    const inRoom = !inThread || inThread.alsoSend;
    const seq = await this.change(
      (seq) => [
        statement(
          `INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, plain_text, mentions, created_at, updated_at, change_seq, attachment, cards, parent_id, in_room)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          this.roomId,
          clientMessageId,
          creator.id,
          creator.name,
          body.html,
          body.plainText,
          JSON.stringify(body.mentions),
          now,
          now,
          seq,
          posted ? JSON.stringify(posted.file) : null,
          body.cards ? JSON.stringify(body.cards) : null,
          inThread?.parent.id ?? null,
          inRoom ? 1 : 0,
        ),
        logEvent(this.roomId, kind, creator.id, now, id, inRoom),
        logIndexing(this.roomId, id),
        ...(posted ? [posted.finished(id)] : []),
        ...(inThread ? [this.numbered(inThread.parent.id, seq + 1), logIndexing(this.roomId, inThread.parent.id)] : []),
      ],
      inThread ? 2 : 1,
    );
    // The room is the only writer of its messages, so the parent is as this left it.
    const parent = inThread ? { message: (await this.find(inThread.parent.id))!, seq: seq + 1 } : null;
    return {
      parent,
      message: {
        id,
        clientMessageId,
        roomId: this.roomId,
        creator,
        body: body.html,
        plainText: body.plainText,
        mentions: body.mentions,
        createdAt: now,
        updatedAt: now,
        editedAt: null,
        boosts: [],
        ...(posted && { attachment: await shownFile(posted.file, await this.sign()) }),
        ...(body.cards && { cards: body.cards }),
        ...(inThread && { parentId: inThread.parent.id, alsoSent: inThread.alsoSend, parentText: parentTextOf(inThread.parent.plainText) }),
      },
      seq,
    };
  }

  /** Which of `clientMessageIds` the room has stored from `creator`. */
  async storedClientMessageIds(creator: User, clientMessageIds: string[]): Promise<string[]> {
    const rows = await this.db.all<Pick<MessageRow, "client_message_id">>(
      STORED_CLIENT_MESSAGE_IDS,
      this.roomId,
      creator.id,
      JSON.stringify(clientMessageIds),
    );
    return rows.map((row) => row.client_message_id);
  }

  /** Everyone who wrote or reacted here, under each name they did it with. */
  async authors(): Promise<User[]> {
    return this.db.all<User>(
      `SELECT creator_id AS id, creator_name AS name FROM messages WHERE room_id = ?
       UNION SELECT booster_id, booster_name FROM boosts WHERE room_id = ?`,
      this.roomId,
      this.roomId,
    );
  }

  /**
   * Replaces a message's text, which marks it edited, and its cards with `body`'s, or takes them away,
   * since what's sent in its place is the whole message, logging it for the search index, and its
   * thread's replies if what they show of it changes, and answers the message as it is now with the
   * change's number, as the methods below that change a message answer theirs.
   */
  async updateBody(message: Message, body: StoredBody, now: string): Promise<{ message: Message; seq: number }> {
    const seq = await this.change((seq) => [
      statement(
        `UPDATE messages SET body = ?, plain_text = ?, mentions = ?, updated_at = ?, edited_at = ?, change_seq = ?, cards = ? WHERE room_id = ? AND id = ?`,
        body.html,
        body.plainText,
        JSON.stringify(body.mentions),
        now,
        now,
        seq,
        body.cards ? JSON.stringify(body.cards) : null,
        this.roomId,
        message.id,
      ),
      logIndexing(this.roomId, message.id),
      ...logIndexingRepliesTo(this.roomId, message, body.plainText),
    ]);
    const { cards: _, ...rest } = message;
    const edited = { ...rest, body: body.html, plainText: body.plainText, mentions: body.mentions, updatedAt: now, editedAt: now };
    return { message: body.cards ? { ...edited, cards: body.cards } : edited, seq };
  }

  /**
   * Gives `message` the file `posted` brings, in place of any it had, or takes its file away with null,
   * as a bot's edit does, marking it edited, as a change to its text does, and the file it had deleted,
   * for the room to purge. Its text and cards stay, and so does its plain text, unless it has neither,
   * when that's its file's name, as a file message's is, and then its thread's replies, which show it,
   * are logged for the search index with it.
   */
  async updateAttachment(message: Message, posted: PostedFile | null, now: string): Promise<{ message: Message; seq: number }> {
    const plainText = message.body === "" && !message.cards ? (posted?.file.name ?? "") : message.plainText;
    const seq = await this.change((seq) => [
      // First, while the message still names the file it had.
      deletingFilesOf(this.roomId, JSON.stringify([message.id]), now),
      statement(
        `UPDATE messages SET attachment = ?, plain_text = ?, updated_at = ?, edited_at = ?, change_seq = ? WHERE room_id = ? AND id = ?`,
        posted ? JSON.stringify(posted.file) : null,
        plainText,
        now,
        now,
        seq,
        this.roomId,
        message.id,
      ),
      logIndexing(this.roomId, message.id),
      ...logIndexingRepliesTo(this.roomId, message, plainText),
      ...(posted ? [posted.finished(message.id)] : []),
    ]);
    const { attachment: _, ...rest } = message;
    const attachment = posted && (await shownFile(posted.file, await this.sign()));
    return { message: { ...rest, ...(attachment && { attachment }), plainText, updatedAt: now, editedAt: now }, seq };
  }

  /** The ids of up to `limit` of `creatorId`'s messages here, only those written by `until` unless it's null. */
  async messageIdsBy(creatorId: UserId, limit: number, until: string | null): Promise<string[]> {
    const rows =
      until === null
        ? await this.db.all<{ id: string }>(MESSAGES_BY, this.roomId, creatorId, limit)
        : await this.db.all<{ id: string }>(MESSAGES_BY_UNTIL, this.roomId, creatorId, until, limit);
    return rows.map((row) => row.id);
  }

  /**
   * Deletes the messages `ids` names, each a change of its own, numbered in the order they're named, but
   * for a message whose thread has replies left, which is kept for them without its text, file, cards or
   * boosts, and a message kept that way already. One kept that way goes once its last reply does, and the
   * parents whose threads lose replies change too, each change numbered after the deletions. Boosts go
   * with their messages, through ON DELETE CASCADE, so a failure keeps both, and the messages' files are
   * marked deleted first, for the room to purge. The ids deleted stay with their deletions' numbers, and
   * the deletions that fall out of the latest `CHANGES_KEPT` go, and the messages deleted, kept or changed
   * are logged for the search index, with the replies to those kept, whose results show none of their
   * text now. The ids go as JSON values, which a page of them can fill.
   */
  async delete(ids: string[]): Promise<Deletion> {
    const listed = JSON.stringify(ids);
    const named = await this.db.all<DeletingRow>(REPLIES_LEFT, this.roomId, listed, listed);
    const kept = named.filter((row) => row.replies_left === 1 && row.deleted === 0).map((row) => row.id);
    const deletedIds = named.filter((row) => row.replies_left === 0).map((row) => row.id);
    // The threads that lose replies, but for those whose messages are deleted or kept here themselves.
    const handled = new Set([...kept, ...deletedIds]);
    const parentIds = [...new Set(named.flatMap((row) => (row.replies_left === 0 && row.parent_id !== null && !handled.has(row.parent_id) ? [row.parent_id] : [])))];
    const parents = parentIds.length === 0 ? [] : await this.db.all<DeletingRow>(REPLIES_LEFT, this.roomId, JSON.stringify(deletedIds), JSON.stringify(parentIds));
    const emptied = parents.filter((row) => row.deleted === 1 && row.replies_left === 0).map((row) => row.id);
    deletedIds.push(...emptied);
    const changedIds = [...kept, ...parents.map((row) => row.id).filter((id) => !emptied.includes(id))];
    const count = deletedIds.length + changedIds.length;
    if (count === 0) return { deletedIds, changed: [], seq: (await this.latestChange()) + 1 };
    const [deletedList, keptList, changedList] = [deletedIds, kept, changedIds].map((list) => JSON.stringify(list)) as [string, string, string];
    const goneOrKept = JSON.stringify([...deletedIds, ...kept]);
    const unindexed = JSON.stringify([...deletedIds, ...changedIds]);
    const now = new Date().toISOString();
    const seq = await this.change(
      (seq) => [
        // First, while the messages kept still name their files.
        deletingFilesOf(this.roomId, goneOrKept, now),
        statement(`DELETE FROM messages WHERE room_id = ? AND id IN (SELECT value FROM json_each(?))`, this.roomId, deletedList),
        statement(`INSERT INTO message_deletions (room_id, seq, message_id) SELECT ?, ? + key, value FROM json_each(?)`, this.roomId, seq, deletedList),
        statement(`DELETE FROM message_deletions WHERE room_id = ? AND seq <= ?`, this.roomId, seq + count - 1 - CHANGES_KEPT),
        statement(KEEP_FOR_THREADS, this.roomId, keptList, now),
        statement(`DELETE FROM boosts WHERE room_id = ? AND message_id IN (SELECT value FROM json_each(?))`, this.roomId, keptList),
        statement(NUMBER_CHANGES, this.roomId, changedList, seq + deletedIds.length),
        logIndexingEach(this.roomId, unindexed),
        logIndexingReplies(this.roomId, keptList),
      ],
      count,
    );
    const changed = new Map((await this.withIds(changedIds)).map((message) => [message.id, message]));
    return { deletedIds, changed: changedIds.map((id, index) => ({ message: changed.get(id)!, seq: seq + deletedIds.length + index })), seq };
  }

  /**
   * Deletes up to `limit` of the messages here, the oldest first, and through ON DELETE CASCADE their
   * boosts, as deleting the room does a batch at a time, marking their files deleted, for the room to
   * purge, and answers whether any are left. The last batch also deletes the deletions it kept, since no
   * tab can connect to the room again, and marks deleted every file it has left, uploads under way too.
   */
  async deleteMessages(limit: number): Promise<boolean> {
    const ids = (await this.db.all<{ id: string }>(OLDEST_MESSAGES, this.roomId, limit + 1)).map(({ id }) => id);
    const listed = JSON.stringify(ids.slice(0, limit));
    const left = ids.length > limit;
    const now = new Date().toISOString();
    await this.changingMessages(() =>
      this.db.batch([
        deletingFilesOf(this.roomId, listed, now),
        statement(`DELETE FROM messages WHERE room_id = ? AND id IN (SELECT value FROM json_each(?))`, this.roomId, listed),
        ...(left ? [] : [deletingAllFiles(this.roomId, now), statement(`DELETE FROM message_deletions WHERE room_id = ?`, this.roomId)]),
      ]),
    );
    this.seq = null;
    return left;
  }

  async addBoost(id: string, messageId: string, booster: User, content: string, now: string): Promise<{ boost: Boost; seq: number }> {
    const seq = await this.change((seq) => [
      statement(
        `INSERT INTO boosts (id, room_id, message_id, booster_id, booster_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        this.roomId,
        messageId,
        booster.id,
        booster.name,
        content,
        now,
      ),
      this.numbered(messageId, seq),
      // Search results show a message's boosts, as the index keeps it.
      logIndexing(this.roomId, messageId),
    ]);
    return { boost: { id, messageId, booster, content, createdAt: now }, seq };
  }

  async findBoost(id: string): Promise<Boost | null> {
    const [row] = await this.db.all<BoostRow>(`SELECT * FROM boosts WHERE room_id = ? AND id = ?`, this.roomId, id);
    return row ? toBoost(row) : null;
  }

  async removeBoost(boost: Boost): Promise<number> {
    return this.change((seq) => [
      statement(`DELETE FROM boosts WHERE room_id = ? AND id = ?`, this.roomId, boost.id),
      this.numbered(boost.messageId, seq),
      logIndexing(this.roomId, boost.messageId),
    ]);
  }

  /**
   * Makes `count` changes to the room's messages, numbered from the next after its latest, with the
   * statements `making` gives for the first number, in one batch, and answers that number.
   */
  private async change(making: (seq: number) => Statement[], count = 1): Promise<number> {
    const seq = (await this.latestChange()) + 1;
    try {
      await this.changingMessages(() => this.db.batch(making(seq)));
    } catch (error) {
      this.seq = null;
      throw error;
    }
    this.seq = seq + count - 1;
    return seq;
  }

  /** Runs `write`, which changes the room's messages, forgetting the newest page before and after it. */
  private async changingMessages<T>(write: () => Promise<T>): Promise<T> {
    this.newest.clear();
    this.changes++;
    this.changing++;
    try {
      return await write();
    } finally {
      this.changing--;
      this.changes++;
      this.newest.clear();
    }
  }

  /** Gives message `messageId` the number of a change to its reactions. */
  private numbered(messageId: string, seq: number): Statement {
    return statement(`UPDATE messages SET change_seq = ? WHERE room_id = ? AND id = ?`, seq, this.roomId, messageId);
  }

  private async latestChange(): Promise<number> {
    this.seq ??= (await this.db.all<{ seq: number }>(LATEST_CHANGE, this.roomId, this.roomId))[0]!.seq;
    return this.seq;
  }

  /** Rows read newest first, one more than `limit` if there are more, as a page oldest first. */
  private async toPage(rows: MessageRow[], limit: number): Promise<Page> {
    return { messages: await this.messagesOf(rows.slice(0, limit).reverse()), hasMore: rows.length > limit };
  }
}

/**
 * The messages `ids` names in any room, in no particular order, for search results: one query, where
 * every room keeps its messages in D1. Their files' addresses are signed under `secret`.
 */
export async function messagesAnywhereWithIds(db: Db, ids: string[], secret: string): Promise<Message[]> {
  return toMessages(await db.all<MessageRow>(MESSAGES_ANYWHERE_WITH_IDS, JSON.stringify(ids)), () => fileSigner(secret));
}

/** The messages whose rows the search index keeps (`indexable`), their files' addresses signed under `secret`. */
export function indexedMessages(rows: string[], secret: string): Promise<Message[]> {
  return toMessages(rows.map((row) => JSON.parse(row) as MessageRow), () => fileSigner(secret));
}

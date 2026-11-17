import type { RoomId, UserId } from "@ember/protocol";
import { statement, type Db, type Statement } from "./db";

// Each room's change log (migrations/0010_room_events.sql), kept in the room's Durable Object SQLite
// storage or in D1 (see db.ts): what has happened in the room that the Workspace marks it unread and
// read by, and has yet to hear of. Beside it, the log of the messages the search index has yet to hear
// of (migrations/0021_unindexed_messages.sql).

/** Something that happened in a room that the Workspace keeps track of. */
export interface RoomEvent {
  /** Its place in the room's log, whose numbers only grow. */
  seq: number;
  /**
   * A new message, a reply, which is a new message that's never delivered to bots' webhooks in turn, nor
   * answered by @ember or an agent, as a bot's to a webhook delivery is, and what an AI app sends as the
   * person who connected it, or someone opening the room in a shown tab.
   */
  kind: "message" | "reply" | "read";
  /** Who wrote the message, or read the room. */
  userId: UserId;
  /** When, as an ISO time: a message's is its `createdAt`. */
  at: string;
  /** Set for a reply sent only to its thread, which marks the room unread for nobody and isn't its activity. */
  threadOnly?: true;
  /**
   * For a reply sent only to its thread, who the room says is viewing the thread as it sends the event,
   * and for a message in the room, who was viewing the room as it came or is as the room sends it, when
   * the room knows, with who was viewing its thread as it came, for a reply sent to the room too.
   */
  viewerIds?: UserId[];
  /**
   * A new message as it is when the room sends the event, for its pushes, unless it has been deleted
   * since, even if its thread keeps its place, or was logged before events named it.
   */
  message?: PushedMessage;
}

/** What a new message's pushes say, and whom they go to at @mentions. */
export interface PushedMessage {
  id: string;
  plainText: string;
  /** Everyone it mentions, once each. */
  mentionIds: UserId[];
  /** The message it replies to, for a reply in a thread. */
  parentId?: string;
  /**
   * For a reply in a thread, everyone following the thread, once each: who wrote the message it replies
   * to, who has replied, and who the thread mentions.
   */
  followerIds?: UserId[];
}

/**
 * The oldest events a room's log holds, up to a number of them, which are the ones the Workspace hasn't
 * applied, with each new message's text and mentions as they are now, by the message's key, unless it's
 * been deleted, and for a reply in a thread, who wrote and who's mentioned in each message of the thread.
 */
export const UNDELIVERED_EVENTS = `SELECT room_events.seq, room_events.kind, room_events.user_id AS userId, room_events.at, room_events.in_room AS inRoom,
    messages.id AS messageId, messages.plain_text AS plainText, messages.mentions, messages.parent_id AS parentId,
    CASE WHEN messages.parent_id IS NULL THEN NULL ELSE (
      SELECT json_group_array(json_array(thread.creator_id, json(thread.mentions))) FROM messages AS thread
        WHERE thread.id = messages.parent_id OR thread.parent_id = messages.parent_id
    ) END AS thread
  FROM room_events LEFT JOIN messages ON messages.id = room_events.message_id AND messages.deleted = 0
  WHERE room_events.room_id = ? ORDER BY room_events.seq LIMIT ?`;

/** A JSON array of the people a message mentions, each `{ "id", "name" }`, or an id alone in a row from before mentions kept names. */
type StoredMentions = Array<{ id: UserId } | UserId>;

interface EventRow extends Omit<RoomEvent, "message" | "threadOnly"> {
  inRoom: number;
  messageId: string | null;
  plainText: string | null;
  mentions: string | null;
  parentId: string | null;
  /** A JSON array of who wrote each message of a reply's thread, with its mentions, as `[id, mentions]`. */
  thread: string | null;
}

const mentionedIds = (mentions: StoredMentions): UserId[] => mentions.map((person) => (typeof person === "string" ? person : person.id));

function followersOf(thread: string): UserId[] {
  const followers = (JSON.parse(thread) as Array<[UserId, StoredMentions]>).flatMap(([creatorId, mentions]) => [creatorId, ...mentionedIds(mentions)]);
  return [...new Set(followers)];
}

function eventOf({ messageId, plainText, mentions, parentId, thread, inRoom, ...logged }: EventRow): RoomEvent {
  const event: RoomEvent = { ...logged, ...(inRoom === 0 && { threadOnly: true }) };
  if (messageId === null) return event;
  const message: PushedMessage = { id: messageId, plainText: plainText!, mentionIds: [...new Set(mentionedIds(JSON.parse(mentions!) as StoredMentions))] };
  return { ...event, message: parentId === null ? message : { ...message, parentId, followerIds: followersOf(thread!) } };
}

/**
 * Logs an event, for the batch that makes the change it records, naming the message a new message's is
 * for, and whether that's in the room, as all but a reply in a thread not also sent to it are.
 */
export const logEvent = (roomId: RoomId, kind: RoomEvent["kind"], userId: UserId, at: string, messageId: string | null = null, inRoom = true): Statement =>
  statement(`INSERT INTO room_events (room_id, kind, user_id, at, message_id, in_room) VALUES (?, ?, ?, ?, ?, ?)`, roomId, kind, userId, at, messageId, inRoom ? 1 : 0);

/** A message written, edited, boosted or deleted that the search index has yet to hear of. */
export interface UnindexedMessage {
  /** Its place in the room's log of them, whose numbers only grow. */
  seq: number;
  messageId: string;
}

/** The oldest messages the search index has yet to hear of, up to a number of them. */
export const UNINDEXED_MESSAGES = `SELECT seq, message_id AS messageId FROM unindexed_messages WHERE room_id = ? ORDER BY seq LIMIT ?`;

/** Logs that a message was written, edited, boosted or deleted, for the search index, in the batch that makes the change. */
export const logIndexing = (roomId: RoomId, messageId: string): Statement =>
  statement(`INSERT INTO unindexed_messages (room_id, message_id) VALUES (?, ?)`, roomId, messageId);

/** The same for each of the messages whose ids a JSON array lists. */
export const logIndexingEach = (roomId: RoomId, listed: string): Statement =>
  statement(`INSERT INTO unindexed_messages (room_id, message_id) SELECT ?, value FROM json_each(?)`, roomId, listed);

/** The same for the replies in the threads of the messages whose ids a JSON array lists, which search results show the start of over them. */
export const logIndexingReplies = (roomId: RoomId, listed: string): Statement =>
  statement(`INSERT INTO unindexed_messages (room_id, message_id) SELECT ?1, id FROM messages WHERE room_id = ?1 AND parent_id IN (SELECT value FROM json_each(?2))`, roomId, listed);

export class RoomLog {
  constructor(
    private readonly db: Db,
    readonly roomId: RoomId,
  ) {}

  /** Logs that `userId` has read the room. */
  async read(userId: UserId, at: string): Promise<void> {
    const { query, params } = logEvent(this.roomId, "read", userId, at);
    await this.db.run(query, ...params);
  }

  /** The oldest `limit` events the Workspace hasn't applied, oldest first. */
  async undelivered(limit: number): Promise<RoomEvent[]> {
    return (await this.db.all<EventRow>(UNDELIVERED_EVENTS, this.roomId, limit)).map(eventOf);
  }

  /** Forgets the events up to `seq`, which the Workspace has applied. */
  async delivered(seq: number): Promise<void> {
    await this.db.run(`DELETE FROM room_events WHERE room_id = ? AND seq <= ?`, this.roomId, seq);
  }

  /** The oldest `limit` messages the search index has yet to hear of, oldest first. */
  async unindexed(limit: number): Promise<UnindexedMessage[]> {
    return this.db.all<UnindexedMessage>(UNINDEXED_MESSAGES, this.roomId, limit);
  }

  /** Forgets the messages up to `seq`, which the search index has taken. */
  async indexed(seq: number): Promise<void> {
    await this.db.run(`DELETE FROM unindexed_messages WHERE room_id = ? AND seq <= ?`, this.roomId, seq);
  }

  /** Logs every message the room has, oldest first, for the search index to take them all afresh. */
  async reindex(): Promise<void> {
    await this.db.run(`INSERT INTO unindexed_messages (room_id, message_id) SELECT room_id, id FROM messages WHERE room_id = ? ORDER BY id`, this.roomId);
  }

  /** Forgets every event, and every message the search index has yet to hear of, as deleting the room does. */
  async forget(): Promise<void> {
    await this.db.batch([statement(`DELETE FROM room_events WHERE room_id = ?`, this.roomId), statement(`DELETE FROM unindexed_messages WHERE room_id = ?`, this.roomId)]);
  }
}

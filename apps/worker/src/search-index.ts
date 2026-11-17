import { SEARCH_LIMIT, type RoomId, type SearchSort, type UserId } from "@ember/protocol";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { migrate } from "./migrations";

// The search index (search-migrations/): every message's plain text in one FTS5 table, what search
// results show of it and what search filters narrow a search by, which rooms keep up to date from their
// logs of the messages written, edited and deleted, and of their boosts (room-log.ts).

/** What search filters narrow a search by, of a message (store.ts `searchFactsOf`). */
export interface SearchFacts {
  creatorId: UserId;
  /** The id of the message whose thread it's in, its own for a message with replies, or null for one in none. */
  threadId: string | null;
  hasLink: boolean;
  hasFile: boolean;
  /** Everyone it mentions, once each. */
  mentionIds: UserId[];
}

/**
 * What the index keeps of a message: when it was written, which orders the index, its plain text, what
 * search results show of it, and what search filters narrow a search by.
 */
export interface IndexedMessage extends SearchFacts {
  id: string;
  createdAt: string;
  text: string;
  /** The message's row as its room keeps it, boosts and all, as JSON, or null for one too big to keep (store.ts `indexable`). */
  message: string | null;
}

/** What a search asks the index for: messages with its words that meet its filters, a page at a time. */
export interface IndexSearch {
  /** The FTS5 query of its words (`searchTerms`), or "" for a search of filters alone. */
  terms: string;
  /** The rooms whose messages it can find. */
  roomIds: RoomId[];
  /** Only messages this person wrote. */
  creatorId?: UserId;
  /** Only messages that include this person: that mention them, are in the rooms `directIds` lists, their DMs, or are in threads they've written in. */
  includes?: { userId: UserId; directIds: RoomId[] };
  hasLink?: boolean;
  hasFile?: boolean;
  inThread?: boolean;
  sort: SearchSort;
  /** Only the matches past this one's number, in the order sorted, for the page after the one it ends. */
  after: number | null;
}

/**
 * A message that has every word searched for and meets its filters, in a room, with what search results
 * show of it as the index last took it, or null when the index took it before it kept that, or it was too
 * big to keep, and the words it matched, as its text has them.
 */
export interface SearchHit {
  number: number;
  messageId: string;
  roomId: RoomId;
  message: string | null;
  words: string[];
}

/** A page of hits, and the number of the last when there are more after it. */
export interface SearchPage {
  hits: SearchHit[];
  next: number | null;
}

/** How many messages of a millisecond the index can number apart (search-migrations/0001_search_index.sql). */
const PER_MILLISECOND = 1024;

/** What a deleted room's place in its log becomes, past any call it made before. */
const FORGOTTEN = Number.MAX_SAFE_INTEGER;

/** A statement's SQL and the values it binds, in order. */
export interface SearchStatement {
  sql: string;
  values: SqlStorageValue[];
}

/** A condition on a message, `search_messages`, with the values it binds, in order. */
type Condition = [sql: string, ...values: SqlStorageValue[]];

/**
 * A message that includes someone, ?1, ?2 and ?3 by turns: it mentions them, it's in a room the JSON
 * array ?2 lists, or it's in a thread they've written in.
 */
const INCLUDES = `(EXISTS (SELECT 1 FROM search_mentions WHERE search_mentions.id = search_messages.id AND search_mentions.user_id = ?)
    OR search_messages.room_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM search_messages AS theirs WHERE theirs.thread_id = search_messages.thread_id AND theirs.creator_id = ?))`;

/** What a search's filters say a message it finds is like: each condition, one a filter, so no statement has to skip one it doesn't have. */
function filtersOf({ creatorId, includes, hasLink, hasFile, inThread }: IndexSearch): Condition[] {
  const conditions: Condition[] = [];
  if (creatorId !== undefined) conditions.push(["search_messages.creator_id = ?", creatorId]);
  if (includes !== undefined) conditions.push([INCLUDES, includes.userId, JSON.stringify(includes.directIds), includes.userId]);
  if (hasLink) conditions.push(["search_messages.has_link = 1"]);
  if (hasFile) conditions.push(["search_messages.has_file = 1"]);
  if (inThread) conditions.push(["search_messages.thread_id IS NOT NULL"]);
  return conditions;
}

/** `conditions` as one, which a message meets when it meets them all, with the values they bind, in order. */
const allOf = (conditions: Condition[]) => ({ met: conditions.map(([sql]) => sql).join(" AND "), values: conditions.flatMap(([, ...values]) => values) });

/**
 * The index a search of filters alone reads a room's messages by, in the order of their numbers, and the
 * filter whose messages are all it holds, if it has one: someone's messages in the room, or the room's
 * with files, with links or in threads (search migration 0004), for the first of those filters the search
 * has, or else all the room's (0001). Each starts with the room, so reading one room's messages by it
 * reads none of another's, as an index of someone's messages in every room would.
 */
function walkOf({ creatorId, hasLink, hasFile, inThread }: IndexSearch): { index: string; holds: Condition[] } {
  if (creatorId !== undefined) return { index: "index_search_messages_on_room_id_and_creator_id_and_id", holds: [["search_messages.creator_id = ?", creatorId]] };
  if (hasFile) return { index: "index_search_messages_with_files_on_room_id_and_id", holds: [["search_messages.has_file = 1"]] };
  if (hasLink) return { index: "index_search_messages_with_links_on_room_id_and_id", holds: [["search_messages.has_link = 1"]] };
  if (inThread) return { index: "index_search_messages_in_threads_on_room_id_and_id", holds: [["search_messages.thread_id IS NOT NULL"]] };
  return { index: "index_search_messages_on_room_id_and_id", holds: [] };
}

const ORDERS = { newest: { direction: "DESC", past: "<" }, oldest: { direction: "ASC", past: ">" } } as const;

/** A message a search finds, before what results show of it is read. */
const FOUND = `search_messages.id AS number, search_messages.message_id AS messageId, search_messages.room_id AS roomId`;

/**
 * The statement a search runs to find a page of messages and one more, which says there's another page,
 * newest or oldest first, past the number it starts after, if any. It's the one statement whatever the
 * rooms it doesn't look in hold: were another to run when their messages left the page short, the time
 * a search took would tell the searcher what's written in rooms they can't read.
 */
export function searchStatement(search: IndexSearch): SearchStatement {
  return search.terms === "" ? filtersStatement(search) : wordsStatement(search);
}

/**
 * A search with words walks the messages that have them in order, with nothing to sort, and keeps the
 * ones in its rooms that meet its filters. The index of words doesn't tell rooms apart, so it passes over
 * the matches in other rooms on its way, each a row's read.
 */
function wordsStatement(search: IndexSearch): SearchStatement {
  const { met, values } = allOf([["search_messages.room_id IN (SELECT value FROM json_each(?))", JSON.stringify(search.roomIds)], ...filtersOf(search)]);
  const { direction, past } = ORDERS[search.sort];
  const startingAfter = search.after === null ? "" : ` AND search_index.rowid ${past} ?`;
  return {
    // A CROSS JOIN is read in the order written, so SQLite can't start from someone's messages instead, which it would have to sort.
    sql: `SELECT ${FOUND} FROM search_index CROSS JOIN search_messages ON search_messages.id = search_index.rowid
      WHERE ${met} AND search_index MATCH ?${startingAfter} ORDER BY search_index.rowid ${direction} LIMIT ${SEARCH_LIMIT + 1}`,
    values: [...values, search.terms, ...(search.after === null ? [] : [search.after])],
  };
}

/**
 * A search of filters alone reads its rooms' messages in order and keeps the ones that meet its filters,
 * each room's through an index that starts with the room (`walkOf`). So it reads no message of a room it
 * doesn't look in, none of which has a say in how long it takes, and its own rooms' only as far as its
 * page goes, with nothing to sort. A recursive query puts the rooms' messages in one order: its queue,
 * ordered by number, starts with each room's first message, and whichever it takes, the next of that room
 * takes its place. Each is looked up on its own, since reading on through a room's messages would end on
 * the one after its last, another room's.
 */
function filtersStatement(search: IndexSearch): SearchStatement {
  const { direction, past } = ORDERS[search.sort];
  const { index, holds } = walkOf(search);
  /** The number of the first message the index holds that meets `conditions`, which say which room's and past which. */
  const firstOf = (...conditions: Condition[]) => {
    const { met, values } = allOf([...conditions, ...holds]);
    return { sql: `(SELECT search_messages.id FROM search_messages INDEXED BY ${index} WHERE ${met} ORDER BY search_messages.id ${direction} LIMIT 1)`, values };
  };
  const startingAfter: Condition[] = search.after === null ? [] : [[`search_messages.id ${past} ?`, search.after]];
  const first = firstOf(["search_messages.room_id = rooms.value"], ...startingAfter);
  const next = firstOf(["search_messages.room_id = walked.room_id"], [`search_messages.id ${past} walked.id`]);
  const filters = allOf(filtersOf(search));
  return {
    // A room with no message left has no number, which ends its walk. The CROSS JOIN keeps the walk's order.
    sql: `WITH RECURSIVE walked AS (
        SELECT ${first.sql} AS id, rooms.value AS room_id FROM json_each(?) AS rooms
        UNION ALL
        SELECT ${next.sql}, walked.room_id FROM walked WHERE walked.id IS NOT NULL
        ORDER BY id ${direction}
      )
      SELECT ${FOUND} FROM walked CROSS JOIN search_messages ON search_messages.id = walked.id${filters.met && ` WHERE ${filters.met}`}
      LIMIT ${SEARCH_LIMIT + 1}`,
    // Each room once, or its messages would be found as often as it's listed.
    values: [...first.values, JSON.stringify([...new Set(search.roomIds)]), ...next.values, ...filters.values],
  };
}

/**
 * What results show of each of the messages whose numbers the JSON array ?2 lists, with their text as the
 * index has it, each word that matches the FTS5 query ?1 between the control characters U+0001 and U+0002.
 */
const MARKED_PAGE = `SELECT search_index.rowid AS number, search_messages.message, highlight(search_index, 0, char(1), char(2)) AS marked
  FROM search_index JOIN search_messages ON search_messages.id = search_index.rowid
  WHERE search_index MATCH ?1 AND search_index.rowid IN (SELECT value FROM json_each(?2))`;

/** What results show of each of the messages whose numbers the JSON array ?1 lists, for a search of filters alone. */
const PAGE = `SELECT id AS number, message, NULL AS marked FROM search_messages WHERE id IN (SELECT value FROM json_each(?1))`;

/** The most words a hit says it matched. */
const MOST_WORDS = 20;

/** The marks `MARKED_PAGE` has each matching word between. */
const OPENING_MARK = "\u0001";
const CLOSING_MARK = "\u0002";

/**
 * What `marked` has between each opening mark and the first closing mark after it, where that's anything,
 * in order. A message's own text can have the marks too, as many as it likes, so each is looked for from
 * where the last was found, and an opening mark that nothing closes ends the walk: a regular expression
 * would read on to the end of the text from every opening mark after it as well.
 */
function* betweenMarks(marked: string): Generator<string> {
  let closing = -1;
  for (let opening = marked.indexOf(OPENING_MARK); opening !== -1; opening = marked.indexOf(OPENING_MARK, closing + 1)) {
    closing = marked.indexOf(CLOSING_MARK, opening + 1);
    if (closing === -1) return;
    if (closing > opening + 1) yield marked.slice(opening + 1, closing);
  }
}

/** The words `marked` has between marks, as its text has them, once each however they're cased. */
function wordsMarked(marked: string | null): string[] {
  const words = new Map<string, string>();
  for (const word of betweenMarks(marked ?? "")) {
    if (words.size === MOST_WORDS) break;
    if (!words.has(word.toLowerCase())) words.set(word.toLowerCase(), word);
  }
  return [...words.values()];
}

/**
 * The largest number given yet to a message of each millisecond the JSON array ?1 lists as its first
 * number, if any has one.
 */
const LATEST_NUMBERS = `SELECT firsts.value AS first, (SELECT max(id) FROM search_messages WHERE id BETWEEN firsts.value AND firsts.value + ${PER_MILLISECOND - 1}) AS latest
  FROM json_each(?1) AS firsts`;

/** The first number a message of the millisecond of `createdAt` can have. */
const firstNumber = (createdAt: string) => Date.parse(createdAt) * PER_MILLISECOND;

const byTime = (a: IndexedMessage, b: IndexedMessage) => firstNumber(a.createdAt) - firstNumber(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Searches every room's messages at once, so a search costs one query however many rooms someone is in.
 * It has an object of its own, as an FTS5 query over a large index can take milliseconds, which nothing
 * else should wait for, and its tables live in its own storage even when everyone else's are in D1
 * (`SEARCH_MIGRATIONS`). So it reads and writes them through the storage's own SQL, whose queries run at
 * once and whose results can be read a row at a time.
 */
export class SearchIndex extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, "search");
    this.sql = ctx.storage.sql;
  }

  /**
   * Takes room `roomId`'s log up to its change `seq`: `messages`, as they are now, and the messages
   * `deletedIds` names, which are gone. A message keeps its number when it's edited. A call the room made
   * before one the index has taken, or after the room was deleted, changes nothing. It's one transaction,
   * and nothing can run between its reads and its writes, which never wait.
   */
  apply(roomId: RoomId, seq: number, messages: IndexedMessage[], deletedIds: string[]): void {
    this.ctx.storage.transactionSync(() => {
      const [taken] = this.sql.exec<{ seq: number }>(`SELECT seq FROM search_rooms WHERE room_id = ?`, roomId).toArray();
      if (taken && taken.seq >= seq) return;
      const listed = JSON.stringify(messages.map(({ id }) => id));
      const indexed = this.sql.exec<{ id: number; message_id: string }>(`SELECT id, message_id FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?))`, listed);
      const known = new Map(indexed.toArray().map((row) => [row.message_id, row.id]));
      const added = this.numbered(messages.filter(({ id }) => !known.has(id)));
      const replaced = JSON.stringify([...known.keys(), ...deletedIds]);
      this.sql.exec(`DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?)))`, replaced);
      this.sql.exec(`DELETE FROM search_mentions WHERE id IN (SELECT id FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?)))`, replaced);
      this.sql.exec(`DELETE FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?))`, JSON.stringify(deletedIds));
      // A message each, since a JSON array of them all could pass the 2 MB a value can take.
      for (const { id, text, message, creatorId, threadId, hasLink, hasFile, mentionIds } of messages) {
        const number = known.get(id) ?? added.get(id);
        if (number === undefined) continue;
        const facts = [creatorId, threadId, hasLink ? 1 : 0, hasFile ? 1 : 0];
        if (known.has(id)) this.sql.exec(`UPDATE search_messages SET message = ?, creator_id = ?, thread_id = ?, has_link = ?, has_file = ? WHERE id = ?`, message, ...facts, number);
        else this.sql.exec(`INSERT INTO search_messages (id, message_id, room_id, message, creator_id, thread_id, has_link, has_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, number, id, roomId, message, ...facts);
        this.sql.exec(`INSERT INTO search_index (rowid, body) VALUES (?, ?)`, number, text);
        this.sql.exec(`INSERT OR IGNORE INTO search_mentions (id, user_id) SELECT ?, value FROM json_each(?)`, number, JSON.stringify(mentionIds));
      }
      this.sql.exec(`INSERT INTO search_rooms (room_id, seq) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET seq = excluded.seq`, roomId, seq);
    });
  }

  /**
   * Numbers each of `messages` after the latest number of its millisecond, or as its first, oldest first,
   * by id. A millisecond can number 1,024 apart; one with more leaves the rest out, as it does a message
   * whose time can't be read.
   */
  private numbered(messages: IndexedMessage[]): Map<string, number> {
    const firsts = JSON.stringify([...new Set(messages.map(({ createdAt }) => firstNumber(createdAt)))]);
    const numbers = this.sql.exec<{ first: number; latest: number | null }>(LATEST_NUMBERS, firsts).toArray();
    const latest = new Map(numbers.map(({ first, latest }) => [first, latest]));
    const added = new Map<string, number>();
    for (const message of messages.sort(byTime)) {
      const first = firstNumber(message.createdAt);
      if (Number.isNaN(first)) {
        console.warn(`Left message ${message.id} out of the search index: its time, ${message.createdAt}, can't be read`);
        continue;
      }
      const previous = latest.get(first);
      const number = previous === null || previous === undefined ? first : previous + 1;
      if (number >= first + PER_MILLISECOND) {
        console.warn(`Left message ${message.id} out of the search index: more than ${PER_MILLISECOND} were written in its millisecond`);
        continue;
      }
      latest.set(first, number);
      added.set(message.id, number);
    }
    return added;
  }

  /**
   * Forgets up to `limit` of room `roomId`'s messages, as deleting the room has it do a batch at a time,
   * so that no call holds up the other rooms' for long, and answers whether any are left. The first keeps
   * any call the room made before from putting them back.
   */
  forget(roomId: RoomId, limit: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO search_rooms (room_id, seq) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET seq = excluded.seq`, roomId, FORGOTTEN);
      const ids = this.sql.exec<{ id: number }>(`SELECT id FROM search_messages WHERE room_id = ? LIMIT ?`, roomId, limit + 1).toArray();
      const forgotten = JSON.stringify(ids.slice(0, limit).map(({ id }) => id));
      this.sql.exec(`DELETE FROM search_index WHERE rowid IN (SELECT value FROM json_each(?))`, forgotten);
      this.sql.exec(`DELETE FROM search_mentions WHERE id IN (SELECT value FROM json_each(?))`, forgotten);
      this.sql.exec(`DELETE FROM search_messages WHERE id IN (SELECT value FROM json_each(?))`, forgotten);
      return ids.length > limit;
    });
  }

  /**
   * A page of the messages `search` finds, up to `SEARCH_LIMIT`, newest or oldest first, each with what
   * results show of it and the words it matched: what its statement finds, which is one more than the
   * page holds when there's another.
   */
  search(search: IndexSearch): SearchPage {
    const { sql, values } = searchStatement(search);
    const hits = this.sql.exec<Pick<SearchHit, "number" | "messageId" | "roomId">>(sql, ...values).toArray();
    const page = hits.slice(0, SEARCH_LIMIT);
    const numbers = JSON.stringify(page.map(({ number }) => number));
    const shown = search.terms === "" ? this.sql.exec<PageRow>(PAGE, numbers) : this.sql.exec<PageRow>(MARKED_PAGE, search.terms, numbers);
    const rows = new Map(shown.toArray().map((row) => [row.number, row]));
    return {
      hits: page.map((hit) => ({ ...hit, message: rows.get(hit.number)?.message ?? null, words: wordsMarked(rows.get(hit.number)?.marked ?? null) })),
      next: hits.length > SEARCH_LIMIT ? page.at(-1)!.number : null,
    };
  }
}

/** What results show of a message, and its text with the words it matched marked, if its search has words. */
type PageRow = {
  number: number;
  message: string | null;
  marked: string | null;
};

export const searchIndex = (env: Env) => env.SEARCH_INDEX.getByName("search");

import {
  MAX_MESSAGE_LENGTH,
  MAX_SEARCH_LENGTH,
  SEARCH_LIMIT,
  SEARCH_TOO_LONG,
  searchQuery,
  searchTerms,
  type Me,
  type Message,
  type NewWorkspace,
  type RoomId,
  type Search,
  type SearchResults,
  type SearchSort,
  type User,
  type UserId,
} from "@ember/protocol";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { MIGRATIONS } from "../src/migrations";
import { searchStatement, type IndexedMessage, type IndexSearch, type SearchFacts, type SearchIndex } from "../src/search-index";
import type { Workspace } from "../src/workspace";
import {
  api,
  connect,
  cookieOf,
  createRoom,
  direct,
  freshDeploy,
  freshRoom,
  post,
  recordedImage,
  roomSql,
  roomStub,
  searchIndexStub,
  searchSql,
  shown,
  signIn,
  standInForRooms,
  upload,
  workspaceSql,
  workspaceStub,
  type Session,
  type Socket,
} from "./support";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until room `room` has nothing left in its log for the search index, which it forgets once the index has taken it. */
async function caughtUp(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/** What `GET /api/searches` answers `session` for `search`, its words alone when it's a string, sorted as `sort` says, from `cursor` on. */
const searchAs = (session: Session | null, search: Search | string, sort?: SearchSort, cursor?: number) =>
  api(`/api/searches?${searchQuery(typeof search === "string" ? { q: search } : search, sort, cursor)}`, { headers: session ? { Cookie: session.cookie } : {} });

/** What `POST /api/searches` answers `session` for `body`, sent as JSON unless it's a string. */
const record = (session: Session | null, body: unknown) =>
  api("/api/searches", { method: "POST", headers: session ? { Cookie: session.cookie } : {}, body: typeof body === "string" ? body : JSON.stringify(body) });

/** What `DELETE /api/searches` answers `session`. */
const clear = (session: Session | null) => api("/api/searches", { method: "DELETE", headers: session ? { Cookie: session.cookie } : {} });

/** What `session` finds searching for `search`. */
async function resultsFor(session: Session, search: Search | string, sort?: SearchSort, cursor?: number): Promise<SearchResults> {
  const response = await searchAs(session, search, sort, cursor);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** The messages `session` finds searching for `search`, in order. */
const messagesFound = async (session: Session, search: Search | string, sort?: SearchSort) => (await resultsFor(session, search, sort)).matches.map(({ message }) => message);

/** The ids of the messages `session` finds searching for `search`, in order. */
const found = async (session: Session, search: Search | string, sort?: SearchSort) => (await messagesFound(session, search, sort)).map(({ id }) => id);

/** `session`'s recent searches, as the search box lists them. */
const recentOf = async (session: Session) => (await resultsFor(session, "")).recent;

/** The words of `session`'s recent searches. */
const recentWordsOf = async (session: Session) => (await recentOf(session)).map(({ q }) => q);

/** The keys of the searches stored for `userId`, newest first. */
const storedSearches = async (userId: UserId) =>
  ((await workspaceSql("SELECT search FROM recent_searches WHERE user_id = ? ORDER BY position DESC", userId)) as Array<{ search: string }>).map(({ search }) => search);

/** A mention of `person`, as the composer writes one. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** Posts a reply to `parent` in its thread as `client`. */
async function reply(client: Socket, parent: Pick<Message, "id">, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id, alsoSend: false });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** What the index is asked for a search of `terms` in `roomIds`, newest first, from the start, and anything else `search` says. */
const indexSearch = (terms: string, roomIds: RoomId[], search: Partial<IndexSearch> = {}): IndexSearch => ({ terms, roomIds, sort: "newest", after: null, ...search });

/** A message as a room sends it to the index, written by nobody in particular, with no thread, link, file or mention. */
const indexed = (message: Omit<IndexedMessage, keyof SearchFacts> & Partial<SearchFacts>): IndexedMessage => ({
  creatorId: "someone",
  threadId: null,
  hasLink: false,
  hasFile: false,
  mentionIds: [],
  ...message,
});

/** Edits `message` as `client`. */
async function edit(client: Socket, message: Message, body: string): Promise<void> {
  client.send({ type: "message.update", messageId: message.id, body });
  await client.next("message.updated");
}

/** Deletes `message` as `client`. */
async function remove(client: Socket, message: Message): Promise<void> {
  client.send({ type: "message.delete", messageId: message.id });
  await client.next("message.deleted");
}

/** Has the search index forget everything, as it is before it's first filled. */
async function emptyIndex(): Promise<void> {
  for (const table of ["search_index", "search_messages", "search_rooms"]) await searchSql(`DELETE FROM ${table}`);
}

/**
 * Makes the search index unreachable from room `room` until the function this answers is called, as the
 * index is while it's restarting.
 */
async function cutOff(room: RoomId): Promise<() => Promise<void>> {
  let original: Env | undefined;
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const object = instance as unknown as { env: Env };
    original = object.env;
    const unreachable = { apply: () => Promise.reject(new Error("The search index is unreachable")) };
    object.env = { ...original, SEARCH_INDEX: { getByName: () => unreachable } as unknown as Env["SEARCH_INDEX"] };
  });
  return () =>
    runInDurableObject(roomStub(room), (instance: ChatRoom) => {
      (instance as unknown as { env: Env }).env = original!;
    });
}

/** Runs room `room`'s alarm, as it goes off. */
const runRoomAlarm = (room: RoomId) => runInDurableObject(roomStub(room), (instance: ChatRoom) => instance.alarm());

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Search messages", () => {
  it("finds a message by its words, stemmed, as its text is now", async () => {
    const room = await freshRoom("eels");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "My hovercraft is full of eels");
    await caughtUp(room);
    expect(await found(ada.session, "eel")).toEqual([message.id]);
    expect(await found(ada.session, "HOVERCRAFT")).toEqual([message.id]);

    await edit(ada, message, "My hovercraft is full of sharks");
    await caughtUp(room);
    expect(await found(ada.session, "sharks")).toEqual([message.id]);
    expect(await found(ada.session, "eels")).toEqual([]);

    await remove(ada, message);
    await caughtUp(room);
    expect(await found(ada.session, "sharks")).toEqual([]);
    expect(await searchSql("SELECT count(*) AS n FROM search_messages")).toEqual([{ n: 0 }]);
  });

  it("searches every word as a word, never as FTS5's syntax", async () => {
    const room = await freshRoom("syntax");
    const jason = await connect(room, "Jason");
    const message = await post(jason, "Do NOT feed the eel OR the shark");
    await caughtUp(room);
    // Asking the index itself, quoting each word but not sanitizing them first.
    for (const query of ["NOT", "OR", "AND", "NEAR", "eel NOT", "NOT eel", "shark OR", '"', "*", "", "a\0b", "\0", "́"]) {
      await expect(searchIndexStub().search(indexSearch(searchTerms(query), [room])), JSON.stringify(query)).resolves.toMatchObject({ hits: expect.any(Array) });
      expect((await searchAs(jason.session, query)).status, JSON.stringify(query)).toBe(200);
    }
    expect(await found(jason.session, "NOT eel")).toEqual([message.id]);
    expect(await found(jason.session, "eel dolphin")).toEqual([]);
    expect(await found(jason.session, "eel\0shark")).toEqual([message.id]);
    expect(await found(jason.session, '"feed" OR (shark*)')).toEqual([message.id]);
    expect(await found(jason.session, "feed NEAR(shark)")).toEqual([]);
  });

  it("answers what it searched for, its spaces made one, with the words each match matched, and nothing for a search with no words or filters", async () => {
    const room = await freshRoom("queries");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "Hello world, hello all");
    await caughtUp(room);
    expect(await resultsFor(ada.session, "  hello,   world! ")).toMatchObject({ search: { q: "hello, world!" }, matches: [{ message: { id: message.id }, words: ["Hello", "world"] }], next: null });
    for (const q of ["", "   ", "!!!", "😀 ❤"]) expect(await resultsFor(ada.session, q), JSON.stringify(q)).toEqual({ search: null, matches: [], next: null, rooms: [], recent: [] });
    expect(await resultsFor(ada.session, "dolphin")).toEqual({ search: { q: "dolphin" }, matches: [], next: null, rooms: [], recent: [] });
  });

  it("answers the words each match matched as its text has them, stemmed", async () => {
    const room = await freshRoom("stems");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "Deploying the deploys, then DEPLOYED: deploy");
    await caughtUp(room);
    expect((await resultsFor(ada.session, "deploy")).matches).toEqual([{ message: expect.objectContaining({ id: message.id }), words: ["Deploying", "deploys", "DEPLOYED", "deploy"] }]);
  });

  it("answers the words each match matched when its text has the index's marks itself, however many", async () => {
    const index = searchIndexStub();
    const at = (second: number, text: string): IndexedMessage => indexed({ id: `message-${second}`, createdAt: new Date(Date.UTC(2026, 9, 16, 10, 0, second)).toISOString(), text, message: "{}" });
    const wordsOf = async (terms: string) => (await index.search(indexSearch(terms, ["room-a"]))).hits.map(({ words }) => words);
    // U+0001 and U+0002 are the marks the index has FTS5 put around each matching word.
    await index.apply("room-a", 1, [at(0, "\u0002 Pear \u0002"), at(1, "\u0001\u0002 PEAR")], []);
    expect(await wordsOf('"pear"')).toEqual([["PEAR"], ["Pear"]]);

    // A page of the longest messages a room takes, each all opening marks that nothing closes after its
    // word: read on to its end from every one of them, they'd keep the index long past the test's time.
    const unclosed = "plum 日 ".padEnd(MAX_MESSAGE_LENGTH, "\u0001");
    await index.apply("room-a", 2, Array.from({ length: SEARCH_LIMIT }, (_, second) => at(2 + second, unclosed)), []);
    expect(await wordsOf('"plum"')).toEqual(Array.from({ length: SEARCH_LIMIT }, () => ["plum"]));
  });

  it("finds a message by its plain text, not its markup", async () => {
    const room = await freshRoom("markup");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "<p><span>My hovercraft</span> is <strong>full</strong> of eels</p>");
    await caughtUp(room);
    expect(await found(ada.session, "span")).toEqual([]);
    expect(await found(ada.session, "strong")).toEqual([]);
    expect(await found(ada.session, "hovercraft full eels")).toEqual([message.id]);
  });

  it("finds a file message by its file's name, its plain text, and answers it with its file", async () => {
    const room = await freshRoom("files");
    const ada = await connect(room, "Ada");
    const message = await upload(ada.session, room, "Moon landing.jpg", recordedImage("moon-thumb.jpg"));
    await caughtUp(room);
    expect(await messagesFound(ada.session, "landing")).toEqual([message]);
  });

  it("lists its matches newest first, or oldest first, as they were written", async () => {
    const room = await freshRoom("cats");
    const ada = await connect(room, "Ada");
    const ids: string[] = [];
    for (const body of ["first cat", "second cat", "third cat", "cat cat cat"]) ids.push((await post(ada, body)).id);
    await caughtUp(room);
    expect(await found(ada.session, "cat")).toEqual(ids.toReversed());
    expect(await found(ada.session, "cat", "oldest")).toEqual(ids);
  });

  it("finds only messages in the rooms the searcher is in, the ones they've hidden and DMs too, and answers those rooms", async () => {
    const [ada, bender, cat] = [await signIn("Ada"), await signIn("Bender"), await signIn("Cat")];
    const open = await freshRoom("open");
    const closed = await createRoom("closed", { closedTo: [ada.user.id, cat.user.id] });
    const dm = await direct(ada, cat);
    const posted: Message[] = [];
    for (const [room, body] of [
      [open, "hovercraft in the open"],
      [closed.id, "hovercraft behind doors"],
      [dm.id, "hovercraft between us"],
    ] as const) {
      const client = await connect(room, ada);
      posted.push(await post(client, body));
      client.close();
      await caughtUp(room);
    }
    await workspaceSql("UPDATE memberships SET involvement = 'invisible' WHERE room_id = ? AND user_id = ?", closed.id, ada.user.id);

    const results = await resultsFor(ada, "hovercraft");
    expect(results.matches.map(({ message }) => message.id)).toEqual(posted.map(({ id }) => id).toReversed());
    expect(results.rooms.map(({ id }) => id).sort()).toEqual([open, closed.id, dm.id].sort());
    expect(results.rooms.find(({ id }) => id === dm.id)).toMatchObject({ kind: "direct", members: expect.arrayContaining([ada.user, cat.user]) });
    expect(results.rooms.find(({ id }) => id === closed.id)).toEqual({ id: closed.id, kind: "closed", name: "closed", icon: closed.icon });

    expect(await found(bender, "hovercraft")).toEqual([posted[0]!.id]);
    expect((await resultsFor(bender, "hovercraft")).rooms.map(({ id }) => id)).toEqual([open]);
  });

  it("finds 100 matches a page, newest first or oldest, and the next page from where one ends", async () => {
    const room = await freshRoom("aardvarks");
    const ada = await connect(room, "Ada");
    const ids: string[] = [];
    for (let n = 0; n < SEARCH_LIMIT + 5; n++) ids.push((await post(ada, `aardvark ${n}`)).id);
    await caughtUp(room);
    const first = await resultsFor(ada.session, "aardvark");
    expect(first.matches.map(({ message }) => message.id)).toEqual(ids.slice(5).toReversed());
    expect(first.next).toEqual(expect.any(Number));
    const second = await resultsFor(ada.session, "aardvark", "newest", first.next!);
    expect(second.matches.map(({ message }) => message.id)).toEqual(ids.slice(0, 5).toReversed());
    expect(second.next).toBeNull();

    const oldest = await resultsFor(ada.session, "aardvark", "oldest");
    expect(oldest.matches.map(({ message }) => message.id)).toEqual(ids.slice(0, SEARCH_LIMIT));
    expect((await resultsFor(ada.session, "aardvark", "oldest", oldest.next!)).matches.map(({ message }) => message.id)).toEqual(ids.slice(SEARCH_LIMIT));

    // A search stops reading matches once its page is full, which keeps nothing from the next change or search.
    const newest = await post(ada, "aardvark 105");
    await caughtUp(room);
    expect(await found(ada.session, "aardvark")).toEqual([newest.id, ...ids.slice(6).toReversed()]);
  });

  it("pages through a search of filters alone, newest first or oldest", async () => {
    const room = await freshRoom("pages");
    const ada = await connect(room, "Ada");
    const ids: string[] = [];
    for (let n = 0; n < SEARCH_LIMIT + 3; n++) ids.push((await post(ada, `page ${n}`)).id);
    await caughtUp(room);
    const first = await resultsFor(ada.session, { q: "", in: room });
    expect(first.matches.map(({ message }) => message.id)).toEqual(ids.slice(3).toReversed());
    expect(first.matches[0]!.words).toEqual([]);
    expect((await resultsFor(ada.session, { q: "", in: room }, "newest", first.next!)).matches.map(({ message }) => message.id)).toEqual(ids.slice(0, 3).toReversed());
    const oldest = await resultsFor(ada.session, { q: "", in: room }, "oldest");
    expect(oldest.matches.map(({ message }) => message.id)).toEqual(ids.slice(0, SEARCH_LIMIT));
    expect((await resultsFor(ada.session, { q: "", in: room }, "oldest", oldest.next!)).next).toBeNull();
  });

  it("reads the first matches off the index in order, with nothing to sort, whatever its filters", async () => {
    await searchIndexStub().search(indexSearch('"aardvark"', []));
    const filters: Array<Partial<IndexSearch>> = [
      {},
      { sort: "oldest", after: 5 },
      { creatorId: "ada", includes: { userId: "ada", directIds: ["dm"] }, hasLink: true, hasFile: true, inThread: true },
      { creatorId: "ada", sort: "oldest", after: 5 },
    ];
    for (const terms of ['"aardvark"', ""]) {
      for (const filter of filters) {
        const { sql, values } = searchStatement(indexSearch(terms, ["room"], filter));
        const plan = (await searchSql(`EXPLAIN QUERY PLAN ${sql}`, ...(values as Array<string | number>))).map((row) => (row as { detail: string }).detail).join("; ");
        expect(plan, `${terms} ${JSON.stringify(filter)}`).not.toContain("TEMP B-TREE");
      }
    }
  });

  it("has nothing to sort in one room or several, whichever filters a search has and wherever it starts, and walks one with words from the index of words", async () => {
    await searchIndexStub().search(indexSearch('"aardvark"', []));
    const each: Array<Partial<IndexSearch>> = [{ creatorId: "ada" }, { includes: { userId: "ada", directIds: ["dm"] } }, { hasLink: true }, { hasFile: true }, { inThread: true }];
    const filters = Array.from({ length: 2 ** each.length }, (_, chosen): Partial<IndexSearch> => Object.assign({}, ...each.filter((_, at) => chosen & (1 << at))));
    const starts = (["newest", "oldest"] as const).flatMap((sort) => [null, 5].map((after) => ({ sort, after })));
    for (const terms of ['"aardvark"', ""]) {
      for (const roomIds of [["room"], ["room", "dm"]]) {
        for (const search of filters.flatMap((filter) => starts.map((start) => indexSearch(terms, roomIds, { ...filter, ...start })))) {
          const { sql, values } = searchStatement(search);
          const plan = (await searchSql(`EXPLAIN QUERY PLAN ${sql}`, ...(values as Array<string | number>))).map((row) => (row as { detail: string }).detail).join("; ");
          expect(plan, JSON.stringify(search)).not.toContain("TEMP B-TREE");
          // Never from someone's messages, say, which it would read in every room, and sort.
          if (terms !== "") expect(plan, JSON.stringify(search)).toMatch(/^SCAN search_index /);
        }
      }
    }
  });

  it("finds the searcher's matches past any number of newer ones in rooms they're not in", async () => {
    const room = await freshRoom("sparse");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "sparsekeyword");
    await caughtUp(room);
    // 1,100 newer matches in a room Ada isn't in.
    await searchSql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100)
       INSERT INTO search_messages (id, message_id, room_id) SELECT (SELECT max(id) FROM search_messages) + i, 'private-' || i, 'elsewhere' FROM n`,
    );
    await searchSql(`INSERT INTO search_index (rowid, body) SELECT id, 'sparsekeyword' FROM search_messages WHERE room_id = 'elsewhere'`);

    expect(await found(ada.session, "sparsekeyword")).toEqual([message.id]);
    expect(await searchIndexStub().search(indexSearch('"sparsekeyword"', []))).toEqual({ hits: [], next: null });
    // As a search of filters alone does, when the newest messages are elsewhere.
    expect(await found(ada.session, { q: "", in: room })).toEqual([message.id]);
  });

  it("runs the same statements whatever is in rooms a search isn't in, and reads none of their messages for a search of filters alone", async () => {
    const first = Date.UTC(2026, 9, 16) * 1024;
    /**
     * Puts `count` messages in room `room` of the index, numbered from `first`, a millisecond apart: each has
     * the word quokka, Ada and Grace write them by turns, and some are in a thread of the room's, have a
     * link or a file, or mention Ada.
     */
    const fill = async (room: RoomId, count: number, first: number) => {
      await searchSql(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
         INSERT INTO search_messages (id, message_id, room_id, message, creator_id, thread_id, has_link, has_file)
         SELECT ?2 + i * 1024, ?3 || '-' || (?2 + i * 1024), ?3, '{}', iif(i % 2, 'grace', 'ada'), iif(i % 4, NULL, ?3 || '-thread'), i % 3 = 0, i % 5 = 0 FROM n`,
        count,
        first,
        room,
      );
      const added = [room, first, first + count * 1024] as const;
      await searchSql("INSERT INTO search_index (rowid, body) SELECT id, 'quokka' FROM search_messages WHERE room_id = ?1 AND id >= ?2 AND id < ?3", ...added);
      await searchSql("INSERT INTO search_mentions (id, user_id) SELECT id, 'ada' FROM search_messages WHERE room_id = ?1 AND id >= ?2 AND id < ?3 AND id % 7 = 0", ...added);
    };
    /** What the index finds for each of `searches`, with the statements it runs and the rows each reads. */
    const searched = (searches: IndexSearch[]) =>
      runInDurableObject(searchIndexStub(), (index: SearchIndex) => {
        const object = index as unknown as { sql: SqlStorage };
        const sql = object.sql;
        try {
          return searches.map((search) => {
            const run: Array<{ statement: string; cursor: { rowsRead: number } }> = [];
            const counted = (statement: string, ...values: unknown[]) => {
              const cursor = sql.exec(statement, ...values);
              run.push({ statement, cursor });
              return cursor;
            };
            object.sql = { exec: counted } as unknown as SqlStorage;
            return { found: index.search(search), statements: run.map(({ statement }) => statement), rowsRead: run.map(({ cursor }) => cursor.rowsRead) };
          });
        } finally {
          object.sql = sql;
        }
      });
    const ada = { userId: "ada", directIds: [] };
    const filters: Array<Partial<IndexSearch>> = [{}, { creatorId: "ada" }, { includes: ada }, { hasLink: true }, { hasFile: true }, { inThread: true }, { creatorId: "ada", includes: ada, hasLink: true, inThread: true }];
    const starts = (["newest", "oldest"] as const).flatMap((sort) => [null, first + 150 * 1024].map((after) => ({ sort, after })));
    // In her room alone, in it and one with no messages, and in none, as a search in a room she isn't in is.
    const alone = [["hers"], ["hers", "nowhere"], []].flatMap((roomIds) => filters.flatMap((filter) => starts.map((start) => indexSearch("", roomIds, { ...filter, ...start }))));
    const words = [indexSearch('"quokka"', ["hers"]), indexSearch('"quokka"', ["hers"], { creatorId: "ada", sort: "oldest", after: first + 150 * 1024 })];

    await fill("hers", 300, first);
    const [before, beforeWords] = [await searched(alone), await searched(words)];
    expect(before.map(({ found }) => found.hits.length > 0)).toEqual(alone.map(({ roomIds }) => roomIds.length > 0));

    // Elsewhere, more than a search once read before it looked in its own rooms alone: older than hers, among them
    // and newer, in rooms the index has before hers, between the two she searches, and after them.
    for (const [room, from] of [["elsewhere", first - 2_000 * 1024], ["lobby", first + 512], ["other", first + 2_000 * 1024]] as const) await fill(room, 1_100, from);
    expect(await searched(alone)).toEqual(before);
    // A search with words still passes over the matches elsewhere, a row's read each, but runs nothing more for them.
    const withWords = await searched(words);
    expect(withWords.map(({ found, statements }) => ({ found, statements }))).toEqual(beforeWords.map(({ found, statements }) => ({ found, statements })));

    // Nor does a full page read further into its own rooms than it goes.
    await fill("hers", 1_100, first - 5_000 * 1024);
    const deeper = await searched(alone);
    const newestFull = alone.flatMap(({ sort }, at) => (sort === "newest" && before[at]!.found.next !== null ? [at] : []));
    expect(newestFull.length).toBeGreaterThan(0);
    expect(newestFull.map((at) => deeper[at])).toEqual(newestFull.map((at) => before[at]));
  });

  it("leaves out a match whose message its room no longer has", async () => {
    const room = await freshRoom("stale");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "quince jam");
    await caughtUp(room);
    await searchSql("INSERT INTO search_messages (id, message_id, room_id) VALUES ((SELECT max(id) + 1 FROM search_messages), 'gone', ?)", room);
    await searchSql("INSERT INTO search_index (rowid, body) SELECT id, 'quince tart' FROM search_messages WHERE message_id = 'gone'");
    expect(await resultsFor(ada.session, "quince")).toMatchObject({ matches: [{ message: { id: message.id } }], rooms: [{ id: room }] });
    expect(await resultsFor(ada.session, "tart")).toEqual({ search: { q: "tart" }, matches: [], next: null, rooms: [], recent: [] });
  });

  it("shows each match as the index last took it, boosts and all, asking no room", async () => {
    const room = await freshRoom("kept");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "elderflower cordial");
    ada.send({ type: "boost.create", messageId: message.id, content: "🍋" });
    const { boost } = await ada.next("boost.created");
    await caughtUp(room);
    expect((await messagesFound(ada.session, "elderflower"))).toMatchObject([{ id: message.id, body: message.body, boosts: [{ id: boost.id, content: "🍋" }] }]);

    // Its room's copy changed behind its back, so the index hasn't heard of it.
    await roomSql(room, "UPDATE messages SET body = '<p>changed</p>' WHERE id = ?", message.id);
    expect((await messagesFound(ada.session, "elderflower"))).toMatchObject([{ body: message.body }]);

    // Taking the boost away sends the message again, as its room has it now.
    ada.send({ type: "boost.delete", boostId: boost.id });
    await ada.next("boost.deleted");
    await caughtUp(room);
    expect((await messagesFound(ada.session, "elderflower"))).toMatchObject([{ body: "<p>changed</p>", boosts: [] }]);
  });

  it("reads a match the index took before it kept messages from its room, as it is now", async () => {
    const room = await freshRoom("unkept");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "damson preserve");
    await caughtUp(room);
    await searchSql("UPDATE search_messages SET message = NULL");
    await roomSql(room, "UPDATE messages SET body = '<p>damson preserve, now</p>' WHERE id = ?", message.id);
    expect((await messagesFound(ada.session, "damson"))).toMatchObject([{ id: message.id, body: "<p>damson preserve, now</p>" }]);
  });

  it("keeps no message too big for the index's row, and reads that one from its room", async () => {
    const room = await freshRoom("big");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "quince paste");
    await caughtUp(room);
    // Bigger than a message's text may be, as a bot's cards can make one.
    const big = `<p>quince paste${" and more".repeat(70_000)}</p>`;
    await roomSql(room, "UPDATE messages SET body = ? WHERE id = ?", big, message.id);
    await roomStub(room).reindex(room);
    await runRoomAlarm(room);
    await caughtUp(room);
    expect(await searchSql("SELECT message IS NULL AS unkept FROM search_messages WHERE message_id = ?", message.id)).toEqual([{ unkept: 1 }]);
    expect((await messagesFound(ada.session, "quince"))).toMatchObject([{ id: message.id, body: big }]);
  });

  it("has every room index its messages again once the index keeps what results show", async () => {
    const room = await freshRoom("again");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "medlar jelly");
    await caughtUp(room);
    await searchSql("UPDATE search_messages SET message = NULL");

    await workspaceSql(MIGRATIONS.find(({ name }) => name === "0040_search_results.sql")!.sql);
    expect(await workspaceSql("SELECT room_id FROM pending_reindexes")).toContainEqual({ room_id: room });
    await runInDurableObject(workspaceStub(), (instance: Workspace) => instance.alarm());
    await runRoomAlarm(room);
    await caughtUp(room);
    expect(await searchSql("SELECT message IS NOT NULL AS kept FROM search_messages WHERE message_id = ?", message.id)).toEqual([{ kept: 1 }]);
  });

  it("has every room index its messages again once the index keeps what filters need, which no filter finds until then", async () => {
    const room = await freshRoom("filters-again");
    const ada = await connect(room, "Ada");
    const message = await post(ada, `<p>medlar jelly for ${mention(ada.me)} at https://example.com</p>`);
    await caughtUp(room);
    // As a message the index took before it kept them is.
    await searchSql("UPDATE search_messages SET creator_id = NULL, has_link = 0");
    await searchSql("DELETE FROM search_mentions");
    for (const filter of [{ from: ada.me.id }, { hasLink: true }, { withMe: true }] as const) expect(await found(ada.session, { q: "medlar", ...filter }), JSON.stringify(filter)).toEqual([]);
    expect(await found(ada.session, "medlar")).toEqual([message.id]);

    await workspaceSql(MIGRATIONS.find(({ name }) => name === "0047_search_filters.sql")!.sql);
    expect(await workspaceSql("SELECT room_id FROM pending_reindexes")).toContainEqual({ room_id: room });
    await runInDurableObject(workspaceStub(), (instance: Workspace) => instance.alarm());
    await runRoomAlarm(room);
    await caughtUp(room);
    for (const filter of [{ from: ada.me.id }, { hasLink: true }, { withMe: true }] as const) expect(await found(ada.session, { q: "medlar", ...filter }), JSON.stringify(filter)).toEqual([message.id]);
  });

  it("has every room index its messages again on its own once the update that asks for it restarts the Workspace", async () => {
    const errors = vi.spyOn(console, "error");
    const room = await freshRoom("updated");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "quince cheese");
    await caughtUp(room);
    // As a message the index took before it kept what filters need is, in the search that missed it.
    await searchSql("UPDATE search_messages SET creator_id = NULL");
    const fromAda = { q: "", in: room, from: ada.me.id };
    expect(await found(ada.session, fromAda)).toEqual([]);

    // The update's migration queues every room due at once, and the deploy restarts the Workspace.
    await workspaceSql(MIGRATIONS.find(({ name }) => name === "0047_search_filters.sql")!.sql);
    await evictDurableObject(workspaceStub());
    await vi.waitFor(async () => expect(await found(ada.session, fromAda)).toEqual([message.id]), { timeout: 5_000 });
    expect(await workspaceSql("SELECT count(*) AS n FROM pending_reindexes")).toEqual([{ n: 0 }]);
    expect(errors).not.toHaveBeenCalledWith("Could not schedule the outbox's deliveries", expect.anything());
  });

  it("asks the rooms one run of the alarm leaves to index their messages again right after", async () => {
    const asked: RoomId[] = [];
    const giveBack = await standInForRooms({ reindex: async (roomId) => void asked.push(roomId) });
    try {
      // More rooms than a run asks, all due at once, as the update's migration queues them in a busy workspace.
      const rooms = Array.from({ length: 45 }, (_, i) => `room-${i}`);
      await workspaceSql("INSERT INTO pending_reindexes (room_id, due_at) SELECT value, 0 FROM json_each(?)", JSON.stringify(rooms));

      await runInDurableObject(workspaceStub(), (instance: Workspace) => instance.alarm());
      await vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_reindexes")).toEqual([{ n: 0 }]), { timeout: 5_000 });
      expect(asked.toSorted()).toEqual(rooms.toSorted());
    } finally {
      await giveBack();
    }
  });

  it("takes each room's changes in order, so a call that arrives late changes nothing, and numbers messages by when they were written", async () => {
    const index = searchIndexStub();
    const at = (time: string, id: string, text: string): IndexedMessage => indexed({ id, createdAt: `2026-10-16T${time}Z`, text, message: JSON.stringify({ text }) });
    const hits = async (terms: string, roomIds: RoomId[]) => (await index.search(indexSearch(terms, roomIds))).hits.map(({ messageId, roomId }) => ({ messageId, roomId }));
    await index.apply("room-a", 2, [at("10:00:01.000", "later", "pear newer")], []);
    await index.apply("room-a", 1, [at("10:00:01.000", "later", "pear older")], []);
    expect(await index.search(indexSearch('"newer"', ["room-a"]))).toEqual({
      hits: [{ number: Date.parse("2026-10-16T10:00:01.000Z") * 1024, messageId: "later", roomId: "room-a", message: JSON.stringify({ text: "pear newer" }), words: ["newer"] }],
      next: null,
    });
    expect(await hits('"older"', ["room-a"])).toEqual([]);

    // Heard of after the later one, and from another room, but written before it, as in the same millisecond.
    await index.apply("room-b", 1, [at("10:00:00.000", "earlier", "pear"), at("10:00:01.000", "same-b", "pear"), at("10:00:01.000", "same-a", "pear")], []);
    expect(await hits('"pear"', ["room-a", "room-b"])).toEqual([
      { messageId: "same-b", roomId: "room-b" },
      { messageId: "same-a", roomId: "room-b" },
      { messageId: "later", roomId: "room-a" },
      { messageId: "earlier", roomId: "room-b" },
    ]);

    // An edit keeps its number, and what results show of it, and a deletion takes it out.
    await index.apply("room-b", 2, [at("10:00:00.000", "earlier", "pear edited")], ["same-a"]);
    expect(await hits('"pear"', ["room-a", "room-b"])).toEqual([
      { messageId: "same-b", roomId: "room-b" },
      { messageId: "later", roomId: "room-a" },
      { messageId: "earlier", roomId: "room-b" },
    ]);
    expect((await index.search(indexSearch('"edited"', ["room-b"]))).hits[0]?.message).toBe(JSON.stringify({ text: "pear edited" }));
  });

  it("forgets a deleted room's messages, and takes nothing more from it", async () => {
    const ada = await signIn("Ada");
    const room = (await createRoom("doomed", { as: ada })).id;
    const client = await connect(room, ada);
    const message = await post(client, "kumquat");
    await caughtUp(room);
    expect(await found(ada, "kumquat")).toEqual([message.id]);

    const response = await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } });
    expect(response.status).toBe(204);
    await vi.waitFor(async () => expect(await searchSql("SELECT seq FROM search_rooms WHERE room_id = ?", room)).toEqual([{ seq: Number.MAX_SAFE_INTEGER }]), {
      timeout: 5_000,
    });
    expect(await searchSql("SELECT count(*) AS n FROM search_messages WHERE room_id = ?", room)).toEqual([{ n: 0 }]);
    expect(await searchSql("SELECT count(*) AS n FROM search_index WHERE search_index MATCH 'kumquat'")).toEqual([{ n: 0 }]);

    // A call the room made before it was deleted, arriving after.
    await searchIndexStub().apply(room, 1_000, [indexed({ id: message.id, createdAt: message.createdAt, text: "kumquat", message: "{}" })], []);
    expect(await searchSql("SELECT count(*) AS n FROM search_messages WHERE room_id = ?", room)).toEqual([{ n: 0 }]);
  });

  it("forgets a deleted room's messages a batch at a time, taking nothing more from the room from the first", async () => {
    const indexing = (seq: number, ids: string[]) =>
      searchIndexStub().apply(
        "doomed",
        seq,
        ids.map((id, i) => indexed({ id, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), text: "kumquat", message: "{}", mentionIds: ["ada"] })),
        [],
      );
    const left = async () => ((await searchSql("SELECT count(*) AS n FROM search_messages WHERE room_id = 'doomed'")) as [{ n: number }])[0].n;
    await indexing(1, ["a", "b", "c", "d", "e"]);

    expect(await searchIndexStub().forget("doomed", 2)).toBe(true);
    expect(await left()).toBe(3);
    // A call the room made before it was deleted, arriving between batches.
    await indexing(2, ["f"]);
    expect(await left()).toBe(3);
    expect(await searchIndexStub().forget("doomed", 2)).toBe(true);
    expect(await searchIndexStub().forget("doomed", 2)).toBe(false);
    expect(await left()).toBe(0);
    expect(await searchSql("SELECT count(*) AS n FROM search_index WHERE search_index MATCH 'kumquat'")).toEqual([{ n: 0 }]);
    expect(await searchSql("SELECT count(*) AS n FROM search_mentions")).toEqual([{ n: 0 }]);
  });

  it("drops a banned person's messages as their room deletes them", async () => {
    const room = await freshRoom("purged");
    const ada = await connect(room, "Ada");
    const bender = await connect(room, "Bender");
    const kept = await post(ada, "bite my shiny metal");
    await post(bender, "bite my shiny metal");
    await caughtUp(room);
    expect(await found(ada.session, "shiny")).toHaveLength(2);

    expect(await roomStub(room).removeMessagesBy(room, bender.me.id, 100, null)).toBe(false);
    await caughtUp(room);
    expect(await found(ada.session, "shiny")).toEqual([kept.id]);
  });

  it("keeps a room's messages for the index while it can't be reached, without holding up its unread marks, and sends them once it can", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await freshRoom("index-away");
    const ada = await connect(room, "Ada");
    const hopper = await signIn("Hopper");
    const reconnect = await cutOff(room);
    const message = await post(ada, "while the index is away");

    await vi.waitFor(async () => expect(await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm())).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("search index; trying again later"), expect.any(Error));
    // The Workspace heard of the message meanwhile, and marked the room unread.
    await vi.waitFor(async () => expect(await workspaceSql("SELECT unread_at FROM memberships WHERE room_id = ? AND user_id = ?", room, hopper.user.id)).not.toEqual([{ unread_at: null }]));
    expect(await found(ada.session, "away")).toEqual([]);

    await reconnect();
    await runRoomAlarm(room);
    await caughtUp(room);
    expect(await found(ada.session, "away")).toEqual([message.id]);
  });

  it("indexes the messages rooms had before the index once the Workspace asks, each by when it was written", async () => {
    const room = await freshRoom("before");
    const ada = await connect(room, "Ada");
    const newer = await post(ada, "persimmon today");
    await caughtUp(room);
    // A message from long ago, and an index that has never heard of either.
    await roomSql(
      room,
      `INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, plain_text, created_at, updated_at)
       VALUES ('old', ?, 'c-old', ?, 'Ada', '<p>persimmon long ago</p>', 'persimmon long ago', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      room,
      ada.me.id,
    );
    await emptyIndex();
    await workspaceSql("INSERT INTO pending_reindexes (room_id, due_at) VALUES (?, 0)", room);

    await runInDurableObject(workspaceStub(), (instance: Workspace) => instance.alarm());
    expect(await workspaceSql("SELECT count(*) AS n FROM pending_reindexes")).toEqual([{ n: 0 }]);
    await runRoomAlarm(room);
    await caughtUp(room);
    expect(await found(ada.session, "persimmon")).toEqual([newer.id, "old"]);
  });

  it("asks a room that can't be reached to index its messages again later", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await freshRoom("unreachable");
    await workspaceSql("INSERT INTO pending_reindexes (room_id, due_at) VALUES (?, 0)", room);
    await runInDurableObject(workspaceStub(), async (instance: Workspace) => {
      const object = instance as unknown as { env: Env };
      const original = object.env;
      const unreachable = { reindex: () => Promise.reject(new Error("The room is unreachable")) };
      object.env = { ...original, CHAT_ROOM: { getByName: () => unreachable } as unknown as Env["CHAT_ROOM"] };
      try {
        await instance.alarm();
      } finally {
        object.env = original;
      }
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("trying again later"), expect.any(Error));
    const [row] = (await workspaceSql("SELECT attempts, due_at FROM pending_reindexes WHERE room_id = ?", room)) as Array<{ attempts: number; due_at: number }>;
    expect(row!.attempts).toBe(1);
    expect(row!.due_at).toBeGreaterThan(Date.now());
  });

  it("is only for people signed in, and takes searches of up to 1,000 characters", async () => {
    expect((await searchAs(null, "eel")).status).toBe(401);
    const ada = await signIn("Ada");
    expect((await searchAs(ada, "e".repeat(MAX_SEARCH_LENGTH))).status).toBe(200);
    const tooLong = await searchAs(ada, "e".repeat(MAX_SEARCH_LENGTH + 1));
    expect(tooLong.status).toBe(422);
    expect(await tooLong.json()).toEqual({ error: SEARCH_TOO_LONG });
    expect((await searchAs(ada, "eel")).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("Search filters", () => {
  it("finds only messages in the room a search is in, and none in a room the searcher isn't in", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const here = await freshRoom("here");
    const there = await freshRoom("there");
    const closed = await createRoom("closed", { closedTo: [grace.user.id] });
    const posted: Message[] = [];
    for (const room of [here, there]) {
      const client = await connect(room, ada);
      posted.push(await post(client, "walrus"));
      client.close();
      await caughtUp(room);
    }
    const hidden = await connect(closed.id, grace);
    await post(hidden, "walrus");
    await caughtUp(closed.id);

    expect(await found(ada, { q: "walrus", in: here })).toEqual([posted[0]!.id]);
    expect(await found(ada, { q: "walrus", in: there })).toEqual([posted[1]!.id]);
    expect(await found(ada, { q: "walrus", in: closed.id })).toEqual([]);
    expect(await found(ada, { q: "walrus", in: "nowhere" })).toEqual([]);
    expect((await resultsFor(ada, { q: "walrus", in: here })).rooms.map(({ id }) => id)).toEqual([here]);
  });

  it("finds only messages someone wrote", async () => {
    const room = await freshRoom("authors");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const hers = await post(grace, "narwhal sighting");
    const his = await post(ada, "narwhal report");
    await caughtUp(room);
    expect(await found(ada.session, { q: "narwhal", from: grace.me.id })).toEqual([hers.id]);
    expect(await found(ada.session, { q: "narwhal", from: ada.me.id })).toEqual([his.id]);
    expect(await found(ada.session, { q: "", from: grace.me.id })).toEqual([hers.id]);
    expect(await found(ada.session, { q: "narwhal", from: "nobody" })).toEqual([]);
  });

  it("finds only messages that include you: that mention you, in your DMs, or in threads you've written in", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("includes");
    const [inRoomAda, inRoomGrace] = [await connect(room, ada), await connect(room, grace)];
    const mentioned = await post(inRoomGrace, `<p>otter for ${mention(ada.user)}</p>`);
    await post(inRoomGrace, "<p>otter for nobody</p>");
    const theirs = await post(inRoomGrace, "<p>otter thread</p>");
    const answer = await reply(inRoomAda, theirs, "<p>otter reply</p>");
    const unanswered = await post(inRoomGrace, "<p>otter thread of her own</p>");
    await reply(inRoomGrace, unanswered, "<p>otter talking to herself</p>");
    await caughtUp(room);
    const dm = await direct(grace, ada);
    const inDm = await connect(dm.id, grace);
    const between = await post(inDm, "<p>otter between us</p>");
    await caughtUp(dm.id);
    const elsewhere = await direct(grace, linus);
    await post(await connect(elsewhere.id, grace), "<p>otter between others</p>");
    await caughtUp(elsewhere.id);

    expect(new Set(await found(ada, { q: "otter", withMe: true }))).toEqual(new Set([mentioned.id, theirs.id, answer.id, between.id]));
    expect(await found(linus, { q: "otter", withMe: true })).toHaveLength(1);
    expect(await found(ada, { q: "", withMe: true })).toHaveLength(4);
  });

  it("finds only messages with links: written as links, or addresses that show as them", async () => {
    const room = await freshRoom("links");
    const ada = await connect(room, "Ada");
    const linked = [
      await post(ada, '<p>puffin <a href="https://example.com/puffins">field guide</a></p>'),
      await post(ada, "puffin pictures at https://example.com/pictures"),
      await post(ada, "puffin www.example.com"),
      await post(ada, "puffin sightings to ada@example.com"),
      await post(ada, "puffin burrows on ssh://puffins.example.com"),
    ];
    for (const body of ["puffin, no link", "puffin http: and www.", "puffin @ the cliffs, ada@ them"]) await post(ada, body);
    await upload(ada.session, room, "puffin www.example.com.jpg", recordedImage("moon-thumb.jpg"));
    await caughtUp(room);
    expect(await found(ada.session, { q: "puffin", hasLink: true })).toEqual(linked.map(({ id }) => id).toReversed());
    expect(await found(ada.session, { q: "", hasLink: true })).toHaveLength(5);
  });

  it("finds only file messages", async () => {
    const room = await freshRoom("files-only");
    const ada = await connect(room, "Ada");
    await post(ada, "Moon landing was today");
    const file = await upload(ada.session, room, "Moon landing.jpg", recordedImage("moon-thumb.jpg"));
    await caughtUp(room);
    expect(await found(ada.session, { q: "landing", hasFile: true })).toEqual([file.id]);
    expect(await found(ada.session, { q: "", hasFile: true })).toEqual([file.id]);
  });

  it("finds only messages in threads, the replies and the messages they reply to, until a thread has no replies", async () => {
    const room = await freshRoom("threads-only");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>seal colony</p>");
    await post(ada, "<p>seal alone</p>");
    const answer = await reply(ada, parent, "<p>seal pups</p>");
    await caughtUp(room);
    expect(await found(ada.session, { q: "seal", inThread: true })).toEqual([answer.id, parent.id]);

    ada.send({ type: "message.delete", messageId: answer.id });
    await ada.next("message.deleted");
    await caughtUp(room);
    expect(await found(ada.session, { q: "seal", inThread: true })).toEqual([]);
  });

  it("finds messages that meet every filter a search has", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await freshRoom("every");
    const other = await freshRoom("every-other");
    const [inRoomAda, inRoomGrace] = [await connect(room, ada), await connect(room, grace)];
    const wanted = await post(inRoomGrace, `<p>beaver dam https://example.com for ${mention(ada.user)}</p>`);
    await post(inRoomGrace, "<p>beaver dam https://example.com</p>");
    await post(inRoomAda, `<p>beaver dam https://example.com for ${mention(ada.user)}</p>`);
    await caughtUp(room);
    await post(await connect(other, grace), `<p>beaver dam https://example.com for ${mention(ada.user)}</p>`);
    await caughtUp(other);
    expect(await found(ada, { q: "beaver", in: room, from: grace.user.id, withMe: true, hasLink: true })).toEqual([wanted.id]);
    expect(await found(ada, { q: "beaver", in: room, from: grace.user.id, withMe: true, hasLink: true, hasFile: true })).toEqual([]);
  });

  it("keeps whom a message mentions as it's edited, and forgets them as it's deleted", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await freshRoom("mentions-kept");
    const client = await connect(room, grace);
    const message = await post(client, `<p>heron for ${mention(ada.user)}</p>`);
    await caughtUp(room);
    expect(await found(ada, { q: "", withMe: true })).toEqual([message.id]);
    await edit(client, message, "<p>heron for nobody</p>");
    await caughtUp(room);
    expect(await found(ada, { q: "", withMe: true })).toEqual([]);
    await edit(client, message, `<p>heron for ${mention(ada.user)} and ${mention(ada.user)}</p>`);
    await caughtUp(room);
    expect(await searchSql("SELECT user_id FROM search_mentions")).toEqual([{ user_id: ada.user.id }]);
    await remove(client, message);
    await caughtUp(room);
    expect(await searchSql("SELECT count(*) AS n FROM search_mentions")).toEqual([{ n: 0 }]);
  });

  it("takes filters from a search's address, leaving out what it doesn't know", async () => {
    const room = await freshRoom("address");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "<p>lynx https://example.com</p>");
    await caughtUp(room);
    const asked = (query: string) => api(`/api/searches?${query}`, { headers: { Cookie: ada.session.cookie } }).then((response) => response.json() as Promise<SearchResults>);
    expect(await asked(`q=lynx&has=link&has=file`)).toMatchObject({ search: { q: "lynx", hasLink: true, hasFile: true }, matches: [] });
    expect(await asked(`q=lynx&has=link&has=pin&is=starred&with=you&sort=best&cursor=soon`)).toMatchObject({ search: { q: "lynx", hasLink: true }, matches: [{ message: { id: message.id } }] });
    expect(await asked(`q=&in=${room}&from=${ada.me.id}&with=me&is=thread`)).toMatchObject({ search: { q: "", in: room, from: ada.me.id, withMe: true, inThread: true }, matches: [] });
  });
});

describe("Recent searches", () => {
  it("records a search, its spaces made one, and answers what it finds with your recent searches, newest first", async () => {
    const room = await freshRoom("greetings");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "hello world");
    await caughtUp(room);
    const response = await record(ada.session, { q: " hello,  world " });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ search: { q: "hello, world" }, matches: [{ message: { id: message.id } }], rooms: [{ id: room }], recent: [{ q: "hello, world" }] });
    expect(await (await record(ada.session, { q: "dolphin" })).json()).toEqual({ search: { q: "dolphin" }, matches: [], next: null, rooms: [], recent: [{ q: "dolphin" }, { q: "hello, world" }] });
    // Searching other than with the search box, as following a recent search does, records nothing.
    expect(await resultsFor(ada.session, "hello, world")).toMatchObject({ matches: [{ message: { id: message.id } }], recent: [{ q: "dolphin" }, { q: "hello, world" }] });
  });

  it("records a search with its filters, telling searches for the same words with other filters apart, and answers its results sorted as asked", async () => {
    const room = await freshRoom("filtered");
    const ada = await connect(room, "Ada");
    const older = await post(ada, "eel pie");
    const newer = await post(ada, "eel soup");
    await caughtUp(room);
    const response = await record(ada.session, { q: "eel", in: room, from: ada.me.id, withMe: false, hasLink: false, inThread: false, sort: "oldest" });
    expect(await response.json()).toMatchObject({ search: { q: "eel", in: room, from: ada.me.id }, matches: [{ message: { id: older.id } }, { message: { id: newer.id } }] });
    await record(ada.session, { q: "eel", hasFile: true });
    await record(ada.session, { q: "eel" });
    // A filter alone is a search.
    await record(ada.session, { q: "", from: ada.me.id });
    await record(ada.session, { q: "eel", from: ada.me.id, in: room });
    expect(await recentOf(ada.session)).toEqual([{ q: "eel", in: room, from: ada.me.id }, { q: "", from: ada.me.id }, { q: "eel" }, { q: "eel", hasFile: true }]);
    expect(await storedSearches(ada.me.id)).toEqual([
      JSON.stringify({ q: "eel", in: room, from: ada.me.id }),
      JSON.stringify({ q: "", from: ada.me.id }),
      JSON.stringify({ q: "eel" }),
      JSON.stringify({ q: "eel", hasFile: true }),
    ]);
  });

  it("keeps your newest 10, moving a search made again to the front, and tells searches that differ in case apart", async () => {
    const ada = await signIn("Ada");
    for (let n = 1; n <= 12; n++) expect((await record(ada, { q: `search ${n}` })).status).toBe(200);
    const newest = Array.from({ length: 10 }, (_, i) => `search ${12 - i}`);
    expect(await recentWordsOf(ada)).toEqual(newest);
    expect(await storedSearches(ada.user.id)).toEqual(newest.map((q) => JSON.stringify({ q })));

    await record(ada, { q: "search 5" });
    expect(await recentWordsOf(ada)).toEqual(["search 5", ...newest.filter((q) => q !== "search 5")]);
    await record(ada, { q: "Search 5" });
    expect(await recentWordsOf(ada)).toEqual(["Search 5", "search 5", ...newest.filter((q) => q !== "search 5").slice(0, 8)]);
    expect(await storedSearches(ada.user.id)).toHaveLength(10);
  });

  it("doesn't record a search with no words or filters, nor one it refuses", async () => {
    const ada = await signIn("Ada");
    for (const q of ["", "   ", "!!!"]) expect(await (await record(ada, { q })).json(), JSON.stringify(q)).toEqual({ search: null, matches: [], next: null, rooms: [], recent: [] });
    for (const body of [{ q: 5 }, { q: null }, { q: ["eel"] }, {}, [], "eel", "{"]) {
      const response = await record(ada, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json()).toEqual({ error: "Searches have to be text" });
    }
    for (const [body, error] of [
      [{ q: "eel", in: 5 }, "A search can only be in a room"],
      [{ q: "eel", in: "" }, "A search can only be in a room"],
      [{ q: "eel", from: "x".repeat(65) }, "A search can only be from a person"],
      [{ q: "eel", hasLink: "yes" }, "A search's filters are on or off"],
      [{ q: "eel", sort: "best" }, "Search results are sorted by newest or oldest"],
    ] as const) {
      const response = await record(ada, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json()).toEqual({ error });
    }
    const tooLong = await record(ada, { q: "e".repeat(MAX_SEARCH_LENGTH + 1) });
    expect(tooLong.status).toBe(422);
    expect(await tooLong.json()).toEqual({ error: SEARCH_TOO_LONG });
    expect(await storedSearches(ada.user.id)).toEqual([]);
    expect((await record(ada, { q: "e".repeat(MAX_SEARCH_LENGTH) })).status).toBe(200);
    expect(await recentWordsOf(ada)).toEqual(["e".repeat(MAX_SEARCH_LENGTH)]);
  });

  it("keeps each person's own, and clears them", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    await record(ada, { q: "eels" });
    await record(grace, { q: "sharks" });
    // One from before searches had filters.
    await workspaceSql("INSERT INTO searches (user_id, query, position) VALUES (?, 'old eels', 1)", ada.user.id);
    expect(await recentWordsOf(ada)).toEqual(["eels"]);
    expect(await recentWordsOf(grace)).toEqual(["sharks"]);

    const cleared = await clear(ada);
    expect(cleared.status).toBe(204);
    expect(await cleared.text()).toBe("");
    expect(await recentOf(ada)).toEqual([]);
    expect(await workspaceSql("SELECT count(*) AS n FROM searches WHERE user_id = ?", ada.user.id)).toEqual([{ n: 0 }]);
    expect(await recentWordsOf(grace)).toEqual(["sharks"]);
    expect((await clear(ada)).status).toBe(204);
  });

  it("starts with the searches kept before searches had filters, in order, with their spaces as searching for them again leaves them", async () => {
    const ada = await signIn("Ada");
    // As 0023 kept "eels", " café,  au lait!", "café au lait" and "sea  otters".
    const kept = [["eels", 1], [" café   au lait ", 2], ["café au lait", 3], ["sea  otters", 4]] as const;
    for (const [query, position] of kept) await workspaceSql("INSERT INTO searches (user_id, query, position) VALUES (?, ?, ?)", ada.user.id, query, position);
    await workspaceSql(MIGRATIONS.find(({ name }) => name === "0048_recent_searches.sql")!.sql);
    expect(await recentOf(ada)).toEqual([{ q: "sea otters" }, { q: "café au lait" }, { q: "eels" }]);
    await record(ada, { q: "eels" });
    await record(ada, { q: "café au lait" });
    expect(await recentWordsOf(ada)).toEqual(["café au lait", "eels", "sea otters"]);
    expect(await storedSearches(ada.user.id)).toEqual(["café au lait", "eels", "sea otters"].map((q) => JSON.stringify({ q })));
  });

  it("is only for people signed in, which it checks first", async () => {
    expect((await record(null, { q: "eels" })).status).toBe(401);
    expect((await record(null, { q: 5 })).status).toBe(401);
    expect((await record(null, { q: "e".repeat(MAX_SEARCH_LENGTH + 1) })).status).toBe(401);
    expect((await clear(null)).status).toBe(401);
    expect(await workspaceSql("SELECT count(*) AS n FROM recent_searches")).toEqual([{ n: 0 }]);
  });

  it("forgets a removed person's searches, and keeps a banned person's", async () => {
    const setUp = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada", emailAddress: "ada@example.com", password: "analytical engine" }) });
    expect(setUp.status).toBe(201);
    const administrator = { user: shown(((await setUp.json()) as NewWorkspace).user), cookie: cookieOf(setUp) };
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const join = async (name: string) => {
      const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name, emailAddress: `${name}@example.com`, password: "compiler design" }) });
      expect(response.status, await response.clone().text()).toBe(201);
      return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
    };
    const grace = await join("grace");
    const linus = await join("linus");
    for (const session of [administrator, grace, linus]) await record(session, { q: "eels" });
    await workspaceSql("INSERT INTO searches (user_id, query, position) VALUES (?, 'old eels', 1)", grace.user.id);

    expect((await api(`/api/account/users/${grace.user.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(200);
    expect((await api(`/api/users/${linus.user.id}/ban`, { method: "POST", headers: { Cookie: administrator.cookie } })).status).toBe(200);
    expect(await storedSearches(grace.user.id)).toEqual([]);
    expect(await workspaceSql("SELECT count(*) AS n FROM searches WHERE user_id = ?", grace.user.id)).toEqual([{ n: 0 }]);
    expect(await storedSearches(linus.user.id)).toEqual([JSON.stringify({ q: "eels" })]);
    expect(await recentWordsOf(administrator)).toEqual(["eels"]);
  });
});

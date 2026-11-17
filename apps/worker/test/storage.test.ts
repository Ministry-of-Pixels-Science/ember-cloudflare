import { bodyFromPlainText, prepareBody } from "@ember/richtext";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { openDb, statement } from "../src/db";
import type { Env } from "../src/env";
import { MIGRATIONS, migrate, SEARCH_MIGRATIONS, type Scope } from "../src/migrations";
import { searchStatement, type IndexSearch } from "../src/search-index";
import { WorkspaceStore } from "../src/workspace-store";
import { apiWith, connect, freshRoom, objectSql, post, roomSql, roomStub, searchIndexStub, sharedD1, workspaceStub } from "./support";

/** The tables each kind of object keeps. A migration's new tables go under the scope it names. */
const TABLES: Record<Exclude<Scope, "search">, string[]> = {
  room: ["blobs", "boosts", "message_deletions", "messages", "revocations", "room_events", "unindexed_messages", "waiting_calls"],
  workspace: [
    "accounts",
    "agent_tools",
    "agents",
    "app_sign_ins",
    "apps",
    "bans",
    "deleted_rooms",
    "email_link_requests",
    "email_links",
    "favorites",
    "identities",
    "membership_catch_ups",
    "membership_checks",
    "memberships",
    "outside_clients",
    "outside_connections",
    "outside_spent_tokens",
    "own_app_sign_ins",
    "password_resets",
    "pending_identities",
    "pending_picture_deletions",
    "pending_purges",
    "pending_reindexes",
    "pending_revocations",
    "push_subscriptions",
    "recent_searches",
    "rooms",
    "searches",
    "sessions",
    "users",
    "webhooks",
  ],
};

/** The tables the search index keeps in its own storage, on either backend: the FTS5 table, the tables it keeps itself in, and the index's own. */
const SEARCH_TABLES = [
  "search_index",
  "search_index_config",
  "search_index_content",
  "search_index_data",
  "search_index_docsize",
  "search_index_idx",
  "search_mentions",
  "search_messages",
  "search_rooms",
];

/** The tables migrations made, leaving out SQLite's, Cloudflare's and the record of migrations. */
const MIGRATED_TABLES = `SELECT name FROM sqlite_master WHERE type = 'table'
  AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY name`;

const roomMigrations = MIGRATIONS.filter((migration) => migration.scope === "room");

// The whole worker suite runs twice, once per STORAGE_BACKEND (see vitest.config.ts).
describe("Durable Object SQLite or D1", () => {
  it("keeps messages in the backend STORAGE_BACKEND names", async () => {
    // /api/health tells whoever sends the recovery token which storage that is.
    const token = "ab".repeat(32);
    const health = await apiWith({ EMBER_RECOVERY_TOKEN: token }, "/api/health", { headers: { Authorization: `Bearer ${token}` } });
    const { storage } = (await health.json()) as { storage: string };
    const db = sharedD1();
    expect(storage).toBe(db ? "d1" : "do-sqlite");
    if (!db) return;

    const room = await freshRoom("d1");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "stored in D1");
    ada.send({ type: "boost.create", messageId: message.id, content: "👍" });
    await ada.next("boost.created");

    expect(await db.prepare("SELECT body FROM messages WHERE room_id = ?").bind(room).all()).toMatchObject({ results: [{ body: "stored in D1" }] });
    expect(await db.prepare("SELECT content FROM boosts WHERE room_id = ?").bind(room).all()).toMatchObject({ results: [{ content: "👍" }] });
  });

  it("lists every migration file, oldest first", () => {
    // vitest.config.ts reads them from the migrations and search-migrations directories.
    const { TEST_MIGRATIONS, TEST_SEARCH_MIGRATIONS } = env as unknown as Record<string, Array<{ name: string }>>;
    expect(MIGRATIONS.map((m) => m.name)).toEqual(TEST_MIGRATIONS!.map((m) => m.name));
    expect(SEARCH_MIGRATIONS.map((m) => m.name)).toEqual(TEST_SEARCH_MIGRATIONS!.map((m) => m.name));
  });

  it("gives each kind of object only its own tables, and D1 every kind's", async () => {
    const names = (tables: string[]) => tables.map((name) => ({ name }));
    expect(await objectSql(searchIndexStub(), MIGRATED_TABLES)).toEqual(names(SEARCH_TABLES));
    const db = sharedD1();
    if (db) {
      expect((await db.prepare(MIGRATED_TABLES).all()).results).toEqual(names(Object.values(TABLES).flat().sort()));
      return;
    }
    const room = await freshRoom("tables");
    await connect(room, "Ada");
    expect(await objectSql(roomStub(room), MIGRATED_TABLES)).toEqual(names(TABLES.room));
    expect(await objectSql(workspaceStub(), MIGRATED_TABLES)).toEqual(names(TABLES.workspace));
  });

  it("applies each migration once: all of them to D1, and each object's own to its storage", async () => {
    const room = await freshRoom("migrated");
    await connect(room, "Ada");
    const db = sharedD1();
    const recorded = (db ? MIGRATIONS : roomMigrations).map(({ name }) => ({ name }));
    expect(await roomSql(room, "SELECT name FROM d1_migrations ORDER BY id")).toEqual(recorded);
    expect(await objectSql(searchIndexStub(), "SELECT name FROM d1_migrations ORDER BY id")).toEqual(SEARCH_MIGRATIONS.map(({ name }) => ({ name })));
    if (!db) {
      await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => migrate(state.storage, "room"));
      expect(await roomSql(room, "SELECT name FROM d1_migrations ORDER BY id")).toEqual(recorded);
      const workspaceMigrations = MIGRATIONS.filter((migration) => migration.scope === "workspace").map(({ name }) => ({ name }));
      expect(await objectSql(workspaceStub(), "SELECT name FROM d1_migrations ORDER BY id")).toEqual(workspaceMigrations);
    }
  });

  it("records the first migration in rooms that ran it before migrations were tracked", async () => {
    if (sharedD1()) return;
    const room = await freshRoom("untracked");
    const messages = await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      // What every room did on opening before migrate() existed.
      state.storage.sql.exec(MIGRATIONS[0]!.sql);
      state.storage.sql.exec(
        `INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, created_at, updated_at)
         VALUES ('m1', 'untracked', 'c1', 'u1', 'Ada', 'from before', 'now', 'now')`,
      );
      migrate(state.storage, "room");
      return state.storage.sql.exec("SELECT body FROM messages").toArray();
    });
    expect(messages).toEqual([{ body: "<p>from before</p>" }]);
    expect(await roomSql(room, "SELECT name FROM d1_migrations ORDER BY id")).toEqual(roomMigrations.map(({ name }) => ({ name })));
  });

  it("stores the plain text messages had before rich text as the paragraph Lexxy sends for it, as the room would store that now", async () => {
    // D1 runs the same SQL, at setup, with no messages from before to convert.
    if (sharedD1()) return;
    const room = await freshRoom("plain-text-before");
    const texts = ["Hello", "Fish & chips <3 >_< &amp;", "Two\nlines\n\nand a gap", "Windows\r\nline", "Old Mac\rline", "No\u00a0break", "Tab\tand  spaces", "😄🤘"];
    const rows = await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      // A room's storage as it was before rich text, and the messages it kept then.
      state.storage.sql.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
      for (const { name, sql } of roomMigrations.filter(({ name }) => name < "0012")) {
        state.storage.sql.exec(sql);
        state.storage.sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
      }
      texts.forEach((text, i) => {
        // Only the first was edited.
        const updatedAt = i === 0 ? "2026-10-14T00:01:00.000Z" : "2026-10-14T00:00:00.000Z";
        state.storage.sql.exec(
          `INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, created_at, updated_at)
           VALUES (?, ?, ?, 'u1', 'Ada', ?, '2026-10-14T00:00:00.000Z', ?)`,
          `m${i}`,
          room,
          `c${i}`,
          text,
          updatedAt,
        );
      });
      migrate(state.storage, "room");
      return state.storage.sql.exec("SELECT body, plain_text, mentions, edited_at FROM messages ORDER BY id").toArray();
    });
    expect(rows).toEqual(
      texts.map((text, i) => {
        const { html, plainText } = prepareBody(bodyFromPlainText(text), () => undefined)!;
        return { body: html, plain_text: plainText, mentions: "[]", edited_at: i === 0 ? "2026-10-14T00:01:00.000Z" : null };
      }),
    );
    expect(rows[1]).toMatchObject({ body: "<p>Fish &amp; chips &lt;3 &gt;_&lt; &amp;amp;</p>", plain_text: "Fish & chips <3 >_< &amp;" });
    expect(rows[3]).toMatchObject({ body: "<p>Windows<br>line</p>", plain_text: "Windows\nline" });
  });

  it("keeps the push subscriptions saved before they were numbered with AUTOINCREMENT, and never numbers another as one deleted", async () => {
    // D1 runs the same SQL, at setup, with no subscriptions from before to keep.
    if (sharedD1()) return;
    // A new room's storage stands in for a Workspace's from before, since a Workspace migrates as it opens.
    const room = await freshRoom("push-subscriptions-before");
    const rows = await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      state.storage.sql.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
      for (const { name, sql } of MIGRATIONS.filter(({ scope, name }) => scope === "workspace" && name < "0026")) {
        state.storage.sql.exec(sql);
        state.storage.sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
      }
      const subscribe = (label: string, id: number | null = null) =>
        state.storage.sql.exec(
          `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh_key, auth_key, user_agent, created_at, updated_at)
           VALUES (?, 'u1', ?, 'p256dh', 'auth', 'Firefox', 'now', 'now')`,
          id,
          `https://updates.push.services.mozilla.com/wpush/v2/${label}`,
        );
      state.storage.sql.exec("INSERT INTO users (id, name, created_at, updated_at) VALUES ('u1', 'Grace', 'now', 'now')");
      subscribe("phone", 1);
      subscribe("laptop", 3);
      migrate(state.storage, "workspace");
      // Without AUTOINCREMENT, SQLite would number the next one past the highest left, 3 again.
      state.storage.sql.exec("DELETE FROM push_subscriptions WHERE id = 3");
      subscribe("tablet");
      return state.storage.sql.exec("SELECT id, endpoint FROM push_subscriptions ORDER BY id").toArray();
    });
    expect(rows).toEqual([
      { id: 1, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/phone" },
      { id: 4, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/tablet" },
    ]);
  });

  it("keeps the push subscription saved most recently at each endpoint, then each person's ten saved most recently, from before a person had each endpoint once", async () => {
    // D1 runs the same SQL, at setup, with no subscriptions from before to keep.
    if (sharedD1()) return;
    // A new room's storage stands in for a Workspace's from before, since a Workspace migrates as it opens.
    const room = await freshRoom("push-subscriptions-per-browser");
    const { rows, again } = await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      state.storage.sql.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
      for (const { name, sql } of MIGRATIONS.filter(({ scope, name }) => scope === "workspace" && name < "0035")) {
        state.storage.sql.exec(sql);
        state.storage.sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
      }
      state.storage.sql.exec("INSERT INTO users (id, name, created_at, updated_at) VALUES ('u1', 'Grace', 'now', 'now'), ('u2', 'Lin', 'now', 'now')");
      const subscribe = (userId: string, label: string, authKey: string, savedAt: string) =>
        state.storage.sql.exec(
          `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent, created_at, updated_at)
           VALUES (?, ?, 'p256dh', ?, 'Firefox', ?, ?)`,
          userId,
          `https://updates.push.services.mozilla.com/wpush/v2/${label}`,
          authKey,
          savedAt,
          savedAt,
        );
      // Grace's laptop saved other keys, then its first ones again; Lin's has the same endpoint.
      subscribe("u1", "laptop", "first", "2026-03-01T00:00:00.000Z");
      subscribe("u1", "laptop", "second", "2026-02-01T00:00:00.000Z");
      for (let day = 1; day <= 10; day++) subscribe("u1", `phone-${day}`, "phone", `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`);
      subscribe("u2", "laptop", "lin", "2026-01-01T00:00:00.000Z");
      migrate(state.storage, "workspace");
      let again = "saved";
      try {
        subscribe("u1", "laptop", "third", "2026-04-01T00:00:00.000Z");
      } catch (error) {
        again = String(error);
      }
      return { rows: state.storage.sql.exec("SELECT user_id, endpoint, auth_key FROM push_subscriptions ORDER BY id").toArray(), again };
    });
    const row = (userId: string, label: string, auth_key: string) => ({ user_id: userId, endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${label}`, auth_key });
    expect(rows).toEqual([
      row("u1", "laptop", "first"),
      ...Array.from({ length: 9 }, (_, i) => row("u1", `phone-${i + 2}`, "phone")),
      row("u2", "laptop", "lin"),
    ]);
    expect(again).toMatch(/UNIQUE constraint failed: push_subscriptions.user_id, push_subscriptions.endpoint/);
  });

  it("puts each active person in the open rooms made or opened while they were banned, before lifting a ban did, leaving bots and anyone not active out", async () => {
    // D1 runs the same SQL, at setup, with nobody to put anywhere.
    if (sharedD1()) return;
    // A new room's storage stands in for a Workspace's from before, since a Workspace migrates as it opens.
    const room = await freshRoom("unbanned-open-rooms");
    const memberships = await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      state.storage.sql.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
      for (const { name, sql } of MIGRATIONS.filter(({ scope, name }) => scope === "workspace" && name < "0053")) {
        state.storage.sql.exec(sql);
        state.storage.sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
      }
      // Grace's ban was lifted once Launch was made, and so was Visitor's, a guest's. Lin is suspended,
      // Linus banned and Former removed; Recap is an agent kept to general, and Build Bot a bot.
      state.storage.sql.exec(`INSERT INTO users (id, name, role, status, guest, created_at, updated_at) VALUES
        ('ada', 'Ada', 1, 0, 0, 'now', 'now'), ('grace', 'Grace', 0, 0, 0, 'now', 'now'), ('visitor', 'Visitor', 0, 0, 1, 'now', 'now'),
        ('lin', 'Lin', 0, 3, 0, 'now', 'now'), ('linus', 'Linus', 0, 2, 0, 'now', 'now'), ('former', 'Former', 0, 1, 0, 'now', 'now'),
        ('recap', 'Recap', 2, 0, 0, 'now', 'now'), ('robot', 'Build Bot', 2, 0, 0, 'now', 'now')`);
      state.storage.sql.exec(`INSERT INTO agents (user_id, description, instructions, model, model_name, format, thinking,
          answer_length, every_open_room, created_by, updated_by, created_at, updated_at)
        VALUES ('recap', 'Recaps', '', 'model', 'Model', 'messages', 'off', 'short', 0, 'ada', 'ada', 'now', 'now')`);
      state.storage.sql.exec(`INSERT INTO rooms (id, kind, name, created_at, updated_at) VALUES
        ('general', 'open', 'general', 'now', 'now'), ('launch', 'open', 'Launch', 'now', 'now'), ('leads', 'closed', 'Leads', 'now', 'now')`);
      const join = (roomId: string, userId: string) =>
        state.storage.sql.exec("INSERT INTO memberships (room_id, user_id, created_at, updated_at) VALUES (?, ?, 'before', 'before')", roomId, userId);
      for (const userId of ["ada", "grace", "visitor", "lin", "linus", "recap"]) join("general", userId);
      join("launch", "ada");
      join("leads", "ada");
      migrate(state.storage, "workspace");
      return state.storage.sql.exec("SELECT room_id, user_id, created_at, updated_at FROM memberships ORDER BY user_id, room_id").toArray();
    });
    const kept = (room_id: string, user_id: string) => ({ room_id, user_id, created_at: "before", updated_at: "before" });
    const now = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string;
    expect(memberships).toEqual([
      kept("general", "ada"),
      kept("launch", "ada"),
      kept("leads", "ada"),
      kept("general", "grace"),
      { room_id: "launch", user_id: "grace", created_at: now, updated_at: now },
      kept("general", "lin"),
      kept("general", "linus"),
      kept("general", "recap"),
      kept("general", "visitor"),
      { room_id: "launch", user_id: "visitor", created_at: now, updated_at: now },
    ]);
  });

  it("keeps the sessions from before they said when their sign-in links ended, whose links go on working, and takes one as the release before saves it", async () => {
    // D1 runs the same SQL, at setup, with no sessions from before to keep.
    if (sharedD1()) return;
    // A new room's storage stands in for a Workspace's from before, since a Workspace migrates as it opens.
    const room = await freshRoom("sessions-before");
    const { sessions, linked } = await runInDurableObject(roomStub(room), async (_room, state: DurableObjectState) => {
      state.storage.sql.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
      for (const { name, sql } of MIGRATIONS.filter(({ scope, name }) => scope === "workspace" && name < "0064")) {
        state.storage.sql.exec(sql);
        state.storage.sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
      }
      state.storage.sql.exec("INSERT INTO users (id, name, created_at, updated_at) VALUES ('u1', 'Grace', 'now', 'now')");
      // A session as it was saved before, and as the release before saves one still.
      const signIn = (id: string) =>
        state.storage.sql.exec(
          `INSERT INTO sessions (id, user_id, token_digest, ip_address, user_agent, last_active_at, created_at, updated_at)
           VALUES (?, 'u1', ?, '203.0.113.7', 'Firefox', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`,
          id,
          `digest of ${id}`,
        );
      signIn("laptop");
      // What a Workspace does as it opens.
      const store = new WorkspaceStore(openDb(env as unknown as Env, state.storage, "workspace"));
      signIn("phone");
      // A link the laptop showed an hour before the update signs a tablet in after it.
      const hourAgo = Date.now() - 60 * 60_000;
      const linked = await store.startTransferredSession("u1", "laptop", hourAgo, false, "tablet", "digest of tablet", { ip: null, userAgent: null }, new Date().toISOString());
      return { sessions: state.storage.sql.exec("SELECT id, transfers_since FROM sessions ORDER BY id").toArray(), linked };
    });
    expect(sessions).toEqual([
      { id: "laptop", transfers_since: 0 },
      { id: "phone", transfers_since: 0 },
      { id: "tablet", transfers_since: 0 },
    ]);
    expect(linked).toMatchObject({ id: "tablet", user: { id: "u1", name: "Grace" } });
  });

  it("gives a search index from before its indexes by room those, so a search of filters alone finds what it held", async () => {
    // A new room's storage stands in for the search index's from before, since the index migrates as it opens, on either backend.
    const room = await freshRoom("search-index-before");
    const { early, indexes, found } = await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      const { sql } = state.storage;
      sql.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
      for (const { name, sql: migration } of SEARCH_MIGRATIONS.filter(({ name }) => name < "0004")) {
        sql.exec(migration);
        sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
      }
      // Twelve messages, by turns in general and leads: Ada's and Grace's two at a time, every fourth with
      // a link, every third with a file, and each room's first a thread's.
      for (let i = 0; i < 12; i++) {
        sql.exec(
          `INSERT INTO search_messages (id, message_id, room_id, message, creator_id, thread_id, has_link, has_file) VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`,
          i + 1,
          `m${i + 1}`,
          i % 2 === 0 ? "general" : "leads",
          i % 4 < 2 ? "ada" : "grace",
          i < 2 ? `m${i + 1}` : null,
          i % 4 === 0 ? 1 : 0,
          i % 3 === 0 ? 1 : 0,
        );
      }
      /** The numbers of general's messages that meet `filters`, newest first. */
      const numbers = (filters: Partial<IndexSearch> = {}) => {
        const { sql: query, values } = searchStatement({ terms: "", roomIds: ["general"], sort: "newest", after: null, ...filters });
        return sql
          .exec<{ number: number }>(query, ...values)
          .toArray()
          .map(({ number }) => number);
      };
      // Before the index has them, a search that reads by one of its new indexes can't run.
      let early = "found";
      try {
        numbers({ creatorId: "ada" });
      } catch (error) {
        early = String(error);
      }
      migrate(state.storage, "search");
      const indexes = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'search_messages' AND name GLOB '*room_id*' ORDER BY name");
      return {
        early,
        indexes: indexes.toArray().map(({ name }) => name),
        found: { all: numbers(), from: numbers({ creatorId: "ada" }), links: numbers({ hasLink: true }), files: numbers({ hasFile: true }), threads: numbers({ inThread: true }) },
      };
    });
    expect(early).toMatch(/no such index/);
    expect(indexes).toEqual([
      "index_search_messages_in_threads_on_room_id_and_id",
      "index_search_messages_on_room_id_and_creator_id_and_id",
      "index_search_messages_on_room_id_and_id",
      "index_search_messages_with_files_on_room_id_and_id",
      "index_search_messages_with_links_on_room_id_and_id",
    ]);
    expect(found).toEqual({ all: [11, 9, 7, 5, 3, 1], from: [9, 5, 1], links: [9, 5, 1], files: [7, 1], threads: [1] });
  });

  it("runs a batch as one transaction: if a statement fails, the ones before it are undone", async () => {
    const room = await freshRoom("batch");
    // D1 keeps every room's messages in one table, so the ids are the room's own.
    const insert = (id: string, body: string) =>
      statement(
        `INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, created_at, updated_at)
         VALUES (?, ?, ?, 'u1', 'Ada', ?, 'now', 'now')`,
        `${room}-${id}`,
        room,
        id,
        body,
      );
    const { rows, failure, empty, bodies } = await runInDurableObject(roomStub(room), async (_room, state: DurableObjectState) => {
      const db = openDb(env as unknown as Env, state.storage, "room");
      const rows = await db.batch([insert("m1", "first"), statement("SELECT body FROM messages WHERE room_id = ?", room)]);
      // The second insert reuses m1's id, so the first one mustn't stay behind either.
      const failure = await db.batch([insert("m2", "second"), insert("m1", "again")]).catch((error: unknown) => error);
      return { rows, failure, empty: await db.batch([]), bodies: await db.all("SELECT body FROM messages WHERE room_id = ? ORDER BY id", room) };
    });
    expect(rows).toEqual([[], [{ body: "first" }]]);
    expect(empty).toEqual([]);
    expect(String(failure)).toMatch(/UNIQUE constraint failed: messages\.id/);
    expect(bodies).toEqual([{ body: "first" }]);
  });
});

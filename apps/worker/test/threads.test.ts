import { HISTORY_PAGE_SIZE, threadPath, type BotAnswer, type BotSettings, type Message, type NewWorkspace, type RoomId, type SearchResults, type ServerFrame, type Upload, type User } from "@ember/protocol";
import { botMessagesPath } from "@ember/protocol/bots";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_GONE } from "../src/chat-room";
import type { Env } from "../src/env";
import {
  api,
  connect,
  cookieOf,
  cutOff,
  freshDeploy,
  freshRoom,
  origin,
  post,
  pushBrowser,
  reconnect,
  recordedImage,
  roomSql,
  roomStub,
  searchSql,
  sendPart,
  settle,
  shown,
  signIn,
  startUpload,
  workspaceSql,
  workspaceStub,
  type Client,
  type PushBrowser,
  type Session,
  type Socket,
} from "./support";

// Slack's threads: a reply in a message's thread, sent only there or to the room too, its summary under
// the message, and whom it marks unread, pushes to and delivers to.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replies in `parent`'s thread as `client`, sending the reply to the room too if `alsoSend` says so, and waits for the room to confirm it. */
async function reply(client: Socket, parent: Pick<Message, "id">, body: string, alsoSend = false): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id, alsoSend });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** The next frame changing message `id` that `client` hears. */
async function updated(client: Socket, id: string): Promise<Extract<ServerFrame, { type: "message.updated" }>> {
  for (;;) {
    const frame = await client.next("message.updated");
    if (frame.message.id === id) return frame;
  }
}

/** Lets everything sent before arrive at `clients`, and reads it, so that what each reads next comes after. */
async function caughtUp(...clients: Socket[]): Promise<void> {
  await settle(...clients);
  const types = ["message.created", "message.updated", "message.deleted", "boost.created", "boost.deleted", "presence.joined", "presence.left", "typing"] as const;
  for (const client of clients) for (const type of types) while (client.pending(type).length > 0) await client.next(type);
}

/** The thread of `parentId` as `client` opens it. */
async function openThread(client: Socket, parentId: string) {
  client.send({ type: "thread.open", parentId });
  return client.next("thread.opened");
}

/** The ids of `messages`, in order. */
const idsOf = (messages: Message[]) => messages.map(({ id }) => id);

/** The keys of the files R2 keeps. */
const storedFiles = async () => (await (env as unknown as Env).FILES!.list({ prefix: "files/" })).objects.map(({ key }) => key);

/** How a message mentioning `person` is written. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** Waits until room `room` has nothing left in its log, which it forgets once the Workspace has applied it. */
async function delivered(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM room_events WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/** Who room `room` is marked unread for, by name. */
const marked = async (room: RoomId) =>
  (
    await workspaceSql(
      "SELECT users.name FROM memberships JOIN users ON users.id = memberships.user_id WHERE room_id = ? AND unread_at IS NOT NULL ORDER BY users.name",
      room,
    )
  ).map((row) => (row as { name: string }).name);

/** When room `room` was last active, as the sidebar orders DMs by it. */
const lastMessageAt = async (room: RoomId) => ((await workspaceSql("SELECT last_message_at FROM rooms WHERE id = ?", room)) as [{ last_message_at: string | null }])[0].last_message_at;

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Replies in threads", () => {
  it("keeps a reply in its thread, out of the room's timeline, telling everyone of it and then of its message's summary", async () => {
    const room = await freshRoom("threads");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const parent = await post(ada, "<p>Shall we ship it?</p>");
    await grace.next("message.created");

    grace.send({ type: "message.create", clientMessageId: "first-reply", body: "<p>Yes</p>", parentId: parent.id });
    for (const client of [ada, grace]) {
      const { message, seq } = await client.next("message.created");
      expect(message).toMatchObject({ clientMessageId: "first-reply", plainText: "Yes", parentId: parent.id, alsoSent: false, parentText: "Shall we ship it?" });
      expect(message.thread).toBeUndefined();
      const summary = { count: 1, latestAt: message.createdAt, people: [shown(grace.me)] };
      expect(await client.next("message.updated")).toEqual({ type: "message.updated", message: { ...parent, thread: summary }, seq: seq + 1 });
    }

    const lin = await connect(room, "Lin");
    expect(idsOf(lin.welcome.messages)).toEqual([parent.id]);
    expect(lin.welcome.messages[0]!.thread).toMatchObject({ count: 1, people: [shown(grace.me)] });
    const thread = await openThread(lin, parent.id);
    expect(thread).toMatchObject({ parentId: parent.id, parent: { id: parent.id, thread: { count: 1 } }, hasMore: false });
    expect(thread.messages.map(({ clientMessageId }) => clientMessageId)).toEqual(["first-reply"]);
  });

  it("shows a reply also sent to the room in its timeline and its thread, with the start of its message's text", async () => {
    const room = await freshRoom("also-sent");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, `<p>${"Long ".repeat(40)}plan</p>`);
    const sent = await reply(ada, parent, "<p>Agreed</p>", true);
    expect(sent).toMatchObject({ parentId: parent.id, alsoSent: true, parentText: [..."Long ".repeat(40)].slice(0, 150).join("") });

    const grace = await connect(room, "Grace");
    expect(idsOf(grace.welcome.messages)).toEqual([parent.id, sent.id]);
    expect(grace.welcome.messages[1]).toMatchObject({ parentId: parent.id, alsoSent: true });
    expect(idsOf((await openThread(grace, parent.id)).messages)).toEqual([sent.id]);
  });

  it("sums a thread up with its count, its newest reply's time, and up to four repliers, the latest first, each by the name they last wrote with", async () => {
    const room = await freshRoom("summaries");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Who's in?</p>");
    const people = await Promise.all(["Bo", "Cy", "Di", "Ed"].map((name) => connect(room, name)));
    const [bo, cy, di, ed] = people as [Client, Client, Client, Client];
    for (const client of [bo, cy, bo, di, ed]) await reply(client, parent, "<p>Me</p>");
    await caughtUp(ada);
    // Ada's own reply makes her the latest.
    const last = await reply(ada, parent, "<p>Great</p>");

    const { message } = await updated(ada, parent.id);
    expect(message.thread).toEqual({ count: 6, latestAt: last.createdAt, people: [ada.me, ed.me, di.me, bo.me].map(shown) });
  });

  it("refuses a reply to a message the room doesn't have, or to a reply, which has no thread, and opens neither's thread", async () => {
    const room = await freshRoom("refusals");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Hi</p>");
    const answer = await reply(ada, parent, "<p>Hello</p>");

    for (const parentId of ["nothing-here", answer.id]) {
      ada.send({ type: "message.create", clientMessageId: `to-${parentId}`, body: "<p>Hey</p>", parentId });
      expect(await ada.next("error")).toEqual({ type: "error", message: MESSAGE_GONE, clientMessageId: `to-${parentId}`, failed: "message.create" });
      expect(await openThread(ada, parentId)).toEqual({ type: "thread.opened", parentId, parent: null, messages: [], hasMore: false });
    }
    expect(await roomSql(room, "SELECT count(*) AS n FROM messages WHERE room_id = ?", room)).toEqual([{ n: 2 }]);
  });

  it("pages back through a thread's replies, oldest first", async () => {
    const room = await freshRoom("thread-pages");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Count off</p>");
    const replies: Message[] = [];
    for (let n = 1; n <= HISTORY_PAGE_SIZE + 2; n++) replies.push(await reply(ada, parent, `<p>${n}</p>`));

    const newest = await openThread(ada, parent.id);
    expect(idsOf(newest.messages)).toEqual(idsOf(replies.slice(2)));
    expect(newest.hasMore).toBe(true);
    ada.send({ type: "thread.before", parentId: parent.id, before: replies[2]!.id });
    expect(await ada.next("thread.history")).toEqual({ type: "thread.history", parentId: parent.id, before: replies[2]!.id, messages: replies.slice(0, 2), hasMore: false });
    // The room's own pages never hold them.
    ada.send({ type: "history.before", before: parent.id });
    expect((await ada.next("history")).messages).toEqual([]);
  });

  it("catches a tab up on the room's changes alone, its thread summaries included, leaving out replies sent only to threads", async () => {
    const room = await freshRoom("thread-catch-up");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Plan</p>");
    const seen = (await roomSql(room, "SELECT max(change_seq) AS seq FROM messages WHERE room_id = ?", room)) as [{ seq: number }];
    const grace = await signIn("Grace");

    const hidden = await reply(ada, parent, "<p>Only here</p>");
    const shownToo = await reply(ada, parent, "<p>Everywhere</p>", true);
    const { opening } = await reconnect(room, grace, seen[0].seq);
    expect(opening).toMatchObject({ type: "resumed", deletedIds: [] });
    const messages = (opening as Extract<ServerFrame, { type: "resumed" }>).messages;
    expect(idsOf(messages).sort()).toEqual([parent.id, shownToo.id].sort());
    expect(idsOf(messages)).not.toContain(hidden.id);
    expect(messages.find(({ id }) => id === parent.id)!.thread).toMatchObject({ count: 2 });
  });
});

describe("Deleting messages with threads", () => {
  it("keeps a message deleted while its thread has replies, without its text or boosts, until its last reply goes too", async () => {
    const room = await freshRoom("tombstones");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const parent = await post(ada, "<p>Delete me later</p>");
    ada.send({ type: "boost.create", messageId: parent.id, content: "👍" });
    await ada.next("boost.created");
    const [first, second] = [await reply(grace, parent, "<p>One</p>"), await reply(grace, parent, "<p>Two</p>")];
    await caughtUp(ada, grace);

    ada.send({ type: "message.delete", messageId: parent.id });
    const kept = await updated(grace, parent.id);
    expect(kept.message).toMatchObject({ id: parent.id, deleted: true, body: "", plainText: "", mentions: [], boosts: [], thread: { count: 2 } });
    expect(grace.pending("message.deleted")).toEqual([]);
    expect(idsOf((await connect(room, "Lin")).welcome.messages)).toEqual([parent.id]);

    // Nobody changes what's left of it, but its thread still takes replies.
    ada.send({ type: "message.update", messageId: parent.id, body: "<p>Back</p>" });
    expect(await ada.next("error")).toMatchObject({ message: "You can only edit your own messages" });
    ada.send({ type: "boost.create", messageId: parent.id, content: "🎉" });
    expect(await ada.next("error")).toMatchObject({ message: "That message no longer exists" });
    const third = await reply(ada, parent, "<p>Three</p>");
    await caughtUp(ada, grace);

    for (const answer of [first, second]) {
      grace.send({ type: "message.delete", messageId: answer.id });
      const { seq } = await grace.next("message.deleted");
      expect(await updated(grace, parent.id)).toMatchObject({ message: { deleted: true, thread: { count: answer === first ? 2 : 1 } }, seq: seq + 1 });
    }
    ada.send({ type: "message.delete", messageId: third.id });
    const gone = [await grace.next("message.deleted"), await grace.next("message.deleted")];
    expect(gone.map(({ messageId }) => messageId)).toEqual([third.id, parent.id]);
    expect(gone[1]!.seq).toBe(gone[0]!.seq + 1);
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([]);
  });

  it("deletes a banned person's messages, keeping those whose threads others replied in, and changes the threads their replies leave", async () => {
    const room = await freshRoom("purged-threads");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const answered = await post(grace, "<p>Answered</p>");
    const alone = await post(grace, "<p>Alone</p>");
    await reply(ada, answered, "<p>Ada answers</p>");
    const adas = await post(ada, "<p>Ada's</p>");
    const graces = await reply(grace, adas, "<p>Grace answers</p>");
    await caughtUp(ada, grace);

    expect(await roomStub(room).removeMessagesBy(room, grace.me.id, 100, null)).toBe(false);
    const deleted = new Set<string>();
    const changed = new Map<string, Message>();
    for (let frame = await ada.next("message.deleted", "message.updated"); ; frame = await ada.next("message.deleted", "message.updated")) {
      if (frame.type === "message.deleted") deleted.add(frame.messageId);
      if (frame.type === "message.updated") changed.set(frame.message.id, frame.message);
      if (deleted.size === 2 && changed.size === 2) break;
    }
    expect([...deleted].sort()).toEqual([alone.id, graces.id].sort());
    expect(changed.get(answered.id)).toMatchObject({ deleted: true, thread: { count: 1 } });
    expect(changed.get(adas.id)!.thread).toBeUndefined();
    // What's kept is never counted as theirs again, so the purge ends.
    expect(await roomStub(room).removeMessagesBy(room, grace.me.id, 100, null)).toBe(false);
  });

  it("has the search index forget a message kept for its thread, as it does one deleted, but find a thread's replies", async () => {
    const room = await freshRoom("thread-search");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Zeppelin schedule</p>");
    const answer = await reply(ada, parent, "<p>Zeppelin moved to noon</p>");
    ada.send({ type: "message.delete", messageId: parent.id });
    await updated(ada, parent.id);
    await vi.waitFor(async () => expect(await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).toEqual([]), { timeout: 5_000 });

    const response = await api(`/api/searches?q=zeppelin`, { headers: { Cookie: ada.session.cookie } });
    const messages = ((await response.json()) as SearchResults).matches.map(({ message }) => message);
    expect(idsOf(messages)).toEqual([answer.id]);
    expect(messages[0]).toMatchObject({ parentId: parent.id });
    expect(await searchSql("SELECT count(*) AS n FROM search_messages WHERE message_id = ?", parent.id)).toEqual([{ n: 0 }]);
  });

  it("keeps what search results show of a thread as it is: its message's summary, and the start of the message over its replies, edited or deleted", async () => {
    const room = await freshRoom("thread-results");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Zeppelin schedule</p>");
    const answer = await reply(ada, parent, "<p>Zeppelin moved to noon</p>");
    await caughtUp(ada);
    const found = async () => {
      await vi.waitFor(async () => expect(await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).toEqual([]), { timeout: 5_000 });
      const response = await api(`/api/searches?q=zeppelin&sort=oldest`, { headers: { Cookie: ada.session.cookie } });
      return ((await response.json()) as SearchResults).matches.map(({ message }) => message);
    };
    expect(await found()).toMatchObject([
      { id: parent.id, thread: { count: 1 } },
      { id: answer.id, parentText: "Zeppelin schedule" },
    ]);

    ada.send({ type: "message.update", messageId: parent.id, body: "<p>Zeppelin timetable</p>" });
    await updated(ada, parent.id);
    expect((await found())[1]).toMatchObject({ id: answer.id, parentText: "Zeppelin timetable" });

    ada.send({ type: "message.delete", messageId: parent.id });
    await updated(ada, parent.id);
    expect(await found()).toMatchObject([{ id: answer.id, parentText: "" }]);
  });
});

describe("Whom a reply reaches", () => {
  it("marks nobody's room unread for a reply sent only to its thread, nor makes it the room's latest activity, but marks it for one also sent", async () => {
    const room = await freshRoom("thread-unread");
    const ada = await connect(room, "Ada", { visible: true });
    const parent = await post(ada, "<p>Plan</p>");
    await delivered(room);
    const grace = await connect(room, "Grace", { visible: true });
    await settle(grace);
    await delivered(room);
    const active = await lastMessageAt(room);
    grace.close();
    await sleep(5);

    await reply(ada, parent, "<p>Just us</p>");
    await delivered(room);
    expect(await marked(room)).not.toContain("Grace");
    expect(await lastMessageAt(room)).toBe(active);

    const sent = await reply(ada, parent, "<p>Everyone</p>", true);
    await delivered(room);
    expect(await marked(room)).toContain("Grace");
    expect(await lastMessageAt(room)).toBe(sent.createdAt);
  });
});

describe("Pushing replies", () => {
  /** Saves a subscription for `session` at Chrome's push service, at `/fcm/send/<label>`, for `browser`'s keys. */
  async function subscribe(session: Session, label: string, browser: PushBrowser): Promise<void> {
    const { p256dh, auth } = browser;
    const endpoint = `https://fcm.googleapis.com/fcm/send/${label}`;
    const response = await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ endpoint, p256dhKey: p256dh, authKey: auth }) });
    expect(response.status).toBe(204);
  }

  /** Stands in for every push service, keeping what was pushed where, in the order it came. */
  function pushServices() {
    const pushed: Array<{ label: string; body: Uint8Array }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      pushed.push({ label: String(input instanceof Request ? input.url : input).split("/").at(-1)!, body: init!.body as Uint8Array });
      return new Response(null, { status: 201 });
    });
    return pushed;
  }

  it("pushes a reply sent only to its thread to those who follow it, at @mentions or all messages: who wrote its message, replied or was mentioned", async () => {
    const pushed = pushServices();
    const room = await freshRoom("Launch");
    const tabs = await Promise.all(["Ada", "Grace", "Lin", "Max", "Kay"].map((name) => connect(room, name, { visible: false })));
    const [ada, grace, lin, max, kay] = tabs as [Client, Client, Client, Client, Client];
    const browsers = new Map<string, PushBrowser>();
    for (const tab of tabs) {
      const browser = await pushBrowser();
      browsers.set(tab.me.name.toLowerCase(), browser);
      await subscribe(tab.session, tab.me.name.toLowerCase(), browser);
    }
    for (const [tab, involvement] of [[max, "everything"], [kay, "nothing"]] as const) {
      const response = await api(`/api/rooms/${room}/involvement`, { method: "PUT", headers: { Cookie: tab.session.cookie }, body: JSON.stringify({ involvement }) });
      expect(response.status).toBe(200);
    }
    const parent = await post(ada, "<p>Launch day?</p>");
    await vi.waitFor(() => expect(pushed.map(({ label }) => label)).toEqual(["max"]), { timeout: 5_000 });
    pushed.length = 0;

    // Kay follows by replying, but is pushed nothing in a room she's turned off.
    await reply(kay, parent, "<p>Following</p>");
    await vi.waitFor(() => expect(pushed.map(({ label }) => label).sort()).toEqual(["ada"]), { timeout: 5_000 });
    pushed.length = 0;
    const answer = await reply(grace, parent, `<p>Friday, ${mention(lin.me)}?</p>`);
    await vi.waitFor(() => expect(pushed.map(({ label }) => label).sort()).toEqual(["ada", "lin"]), { timeout: 5_000 });
    const opened = JSON.parse(await browsers.get("lin")!.open(pushed.find(({ label }) => label === "lin")!.body));
    expect(opened).toMatchObject({ title: "Thread in Launch", options: { body: "Grace: Friday, @Lin?", data: { path: threadPath(room, parent.id, answer.id) } } });
    pushed.length = 0;

    // One also sent to the room is pushed to those at all messages too.
    await reply(lin, parent, "<p>Friday works</p>", true);
    await vi.waitFor(() => expect(pushed.map(({ label }) => label).sort()).toEqual(["ada", "grace", "max"]), { timeout: 5_000 });
  });

  it("pushes a reply sent only to its thread to followers viewing the room, who don't see it, but not to those viewing the thread", async () => {
    const pushed = pushServices();
    const room = await freshRoom("Launch");
    const [ada, grace, lin] = [await connect(room, "Ada"), await connect(room, "Grace"), await connect(room, "Lin", { visible: false })];
    for (const tab of [ada, grace]) await subscribe(tab.session, tab.me.name.toLowerCase(), await pushBrowser());
    const labels = () => pushed.map(({ label }) => label).sort();
    const parent = await post(ada, "<p>Launch day?</p>");
    await reply(grace, parent, "<p>Friday</p>");
    await vi.waitFor(() => expect(labels()).toEqual(["ada"]), { timeout: 5_000 });

    await openThread(grace, parent.id);
    await reply(lin, parent, "<p>Friday works</p>");
    await vi.waitFor(() => expect(labels()).toEqual(["ada", "ada"]), { timeout: 5_000 });
    grace.send({ type: "thread.close", parentId: parent.id });
    await settle(grace);
    await reply(lin, parent, "<p>See you there</p>");
    await vi.waitFor(() => expect(labels()).toEqual(["ada", "ada", "ada", "grace"]), { timeout: 5_000 });
  });

  it("pushes nothing for a message deleted before the room tells the Workspace of it, though its thread keeps its place", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pushed = pushServices();
    const room = await freshRoom("Launch");
    const [ada, grace] = [await connect(room, "Ada", { visible: false }), await connect(room, "Grace", { visible: false })];
    const browser = await pushBrowser();
    await subscribe(grace.session, "grace", browser);
    const response = await api(`/api/rooms/${room}/involvement`, { method: "PUT", headers: { Cookie: grace.session.cookie }, body: JSON.stringify({ involvement: "everything" }) });
    expect(response.status).toBe(200);
    const bodies = () => Promise.all(pushed.map(async ({ body }) => (JSON.parse(await browser.open(body)) as { options: { body: string } }).options.body));

    const reconnect = await cutOff(room);
    const parent = await post(ada, "<p>Oops</p>");
    await reply(ada, parent, "<p>Never mind</p>");
    await caughtUp(ada);
    ada.send({ type: "message.delete", messageId: parent.id });
    expect((await updated(ada, parent.id)).message.deleted).toBe(true);
    await vi.waitFor(async () => expect(await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm())).not.toBeNull(), { timeout: 5_000 });
    await reconnect();
    await runDurableObjectAlarm(roomStub(room));
    await delivered(room);

    await post(ada, "<p>Last</p>");
    await vi.waitFor(async () => expect(await bodies()).toEqual(["Ada: Last"]), { timeout: 5_000 });
  });
});

describe("Bots in threads", () => {
  /** Sets Ember up with Ada as its administrator, signed in, answering her session and first run's general room. */
  async function setUp(): Promise<{ ada: Session; general: RoomId }> {
    const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
    expect(response.status).toBe(201);
    const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
    const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
    return { ada, general };
  }

  async function addBot(administrator: Session, name: string, webhookUrl: string): Promise<BotSettings> {
    const response = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name, webhookUrl }) });
    expect(response.status).toBe(201);
    return ((await response.json()) as BotAnswer).bot;
  }

  it("delivers a reply in a thread to the bots it mentions with the thread's address, and posts what the bot says back in the thread alone", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      bodies.push(init!.body as string);
      return new Response("On it", { headers: { "Content-Type": "text/plain" } });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await connect(general, ada);
    const parent = await post(client, "<p>Release notes</p>");

    const asked = await reply(client, parent, `<p>${mention(bot)} build it</p>`);
    const answered = await client.next("message.created");
    expect(answered.message).toMatchObject({ creator: { id: bot.id }, plainText: "On it", parentId: parent.id, alsoSent: false });
    expect(JSON.parse(bodies[0]!).message.path).toBe(threadPath(general, parent.id, asked.id));
    expect(idsOf((await openThread(client, parent.id)).messages)).toEqual([asked.id, answered.message.id]);
  });

  /** What Ember delivers to a webhook that says nothing back, as one that answers later doesn't, each by the message it delivers. */
  function deliveredLater(): Map<string, { room: { path: string } }> {
    const delivered = new Map<string, { room: { path: string } }>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(init!.body as string) as { room: { path: string }; message: { id: string } };
      delivered.set(body.message.id, body);
      return new Response(null, { status: 204 });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    return delivered;
  }

  it("delivers a reply in a thread with an address that posts in the thread alone, for a bot that answers later, and a message in the room with the room's", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const delivered = deliveredLater();
    const client = await connect(general, ada);
    const parent = await post(client, `<p>${mention(bot)} release notes</p>`);
    const asked = await reply(client, parent, `<p>${mention(bot)} build it</p>`);
    await vi.waitFor(() => expect(delivered.size).toBe(2));
    const { key } = (await workspaceStub().botWebhook(general, bot.id))!;
    expect(delivered.get(parent.id)!.room.path).toBe(botMessagesPath(general, key));
    expect(delivered.get(asked.id)!.room.path).toBe(botMessagesPath(general, key, parent.id));

    const posted = await api(delivered.get(asked.id)!.room.path, { method: "POST", body: "Built" });
    expect(posted.status).toBe(201);
    const answered = await client.next("message.created");
    expect(answered.message).toMatchObject({ creator: { id: bot.id }, plainText: "Built", parentId: parent.id, alsoSent: false });
    expect(posted.headers.get("Location")).toBe(`${origin}${threadPath(general, parent.id, answered.message.id)}`);
    expect(idsOf((await openThread(client, parent.id)).messages)).toEqual([asked.id, answered.message.id]);

    expect((await api(delivered.get(parent.id)!.room.path, { method: "POST", body: "Noted" })).status).toBe(201);
    const inRoom = await client.next("message.created");
    expect(inRoom.message.plainText).toBe("Noted");
    expect(inRoom.message.parentId).toBeUndefined();
  });

  it("posts a file a bot sends later to a thread's address in the thread", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const client = await connect(general, ada);
    const parent = await post(client, "<p>Release notes</p>");

    const form = new FormData();
    form.set("attachment", new File([recordedImage("moon-thumb.jpg")], "moon.jpg", { type: "image/jpeg" }));
    expect((await api(botMessagesPath(general, bot.key, parent.id), { method: "POST", body: form })).status).toBe(201);
    const { message } = await client.next("message.created");
    expect(message).toMatchObject({ creator: { id: bot.id }, plainText: "moon.jpg", parentId: parent.id, alsoSent: false });
    expect(idsOf((await openThread(client, parent.id)).messages)).toEqual([message.id]);
  });

  it("answers 404 to a bot posting to a thread the room doesn't have, or to a reply, which has no thread, posting nothing and keeping none of its file", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const client = await connect(general, ada);
    const parent = await post(client, "<p>Release notes</p>");
    const asked = await reply(client, parent, "<p>Build it</p>");

    for (const threadId of ["nothing", asked.id]) {
      expect((await api(botMessagesPath(general, bot.key, threadId), { method: "POST", body: "Built" })).status).toBe(404);
      const form = new FormData();
      form.set("attachment", new File([recordedImage("moon-thumb.jpg")], "moon.jpg", { type: "image/jpeg" }));
      expect((await api(botMessagesPath(general, bot.key, threadId), { method: "POST", body: form })).status).toBe(404);
      expect(await storedFiles()).toEqual([]);
    }
    await settle(client);
    expect(await roomSql(general, "SELECT id FROM messages WHERE room_id = ? AND id NOT IN (?, ?)", general, parent.id, asked.id)).toEqual([]);
  });
});

describe("Files in threads", () => {
  it("posts a file uploaded into a thread as a reply there, and refuses one for a thread the room doesn't have", async () => {
    const room = await freshRoom("thread-files");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Mockups?</p>");
    const bytes = recordedImage("moon-thumb.jpg");
    const file = { name: "moon.jpg", type: "image/jpeg", size: bytes.length, clientMessageId: crypto.randomUUID() };

    expect((await startUpload(ada.session, room, { ...file, parentId: "nothing-here" })).status).toBe(422);
    const started = await startUpload(ada.session, room, { ...file, parentId: parent.id, alsoSend: true });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as Upload;
    const last = await sendPart(ada.session, room, id, 1, bytes);
    expect(last.status).toBe(201);
    expect(await last.json()).toMatchObject({ clientMessageId: file.clientMessageId, parentId: parent.id, alsoSent: true, attachment: { name: "moon.jpg" } });
    expect((await updated(ada, parent.id)).message.thread).toMatchObject({ count: 1 });
  });
});

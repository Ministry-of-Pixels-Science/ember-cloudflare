import type { BotAnswer, BotSettings, NewWorkspace, RoomId, User, UserId } from "@ember/protocol";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "../src/at-once";
import { postWebhook, WebhookError, webhookPayload, type Keep } from "../src/bots/webhooks";
import type { ChatRoom } from "../src/chat-room";
import type { WebhookAccess } from "../src/workspace";
import type { Env } from "../src/env";
import { objectKey } from "../src/files/blobs";
import { imageSize } from "../src/files/images";
import type { RoomEvent } from "../src/room-log";
import { BOT_WEBHOOK, MESSAGE_BOTS, type MessageWebhook } from "../src/workspace-store";
import { storedPng } from "./png-files";
import {
  api,
  closeOf,
  connect,
  cookieOf,
  createRoom,
  direct,
  freshDeploy,
  post,
  pushBrowser,
  recordedImage,
  roomSql,
  roomStub,
  settle,
  shown,
  signIn,
  upload,
  workspaceSql,
  workspaceStub,
  type Session,
} from "./support";

// Which bots' webhooks a new message is delivered to, and how, as Campfire's `Webhook#deliver` does
// (app/models/webhook.rb, test/models/webhook_test.rb).

/** Sets Ember up with Ada as its administrator, signed in, answering her session and first run's general room. */
async function setUp(): Promise<{ ada: Session; general: RoomId }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada, general };
}

/** Adds a bot as `administrator`, delivering to `webhookUrl` if it's given, answering it as its edit page shows it. */
async function addBot(administrator: Session, name: string, webhookUrl?: string): Promise<BotSettings> {
  const response = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name, webhookUrl }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** Renames `bot`, or has its webhook deliver elsewhere, or nowhere with "", as `administrator`. */
async function changeBot(administrator: Session, bot: BotSettings, changes: { name?: string; webhookUrl?: string }): Promise<void> {
  const response = await api(`/api/account/bots/${bot.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify(changes) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Deletes `bot` as `administrator`, which leaves it in its DMs. */
async function deleteBot(administrator: Session, bot: BotSettings): Promise<void> {
  const response = await api(`/api/account/bots/${bot.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } });
  expect(response.status).toBe(204);
}

/** Leaves just `memberIds` in the private room `room`, as `administrator`, taking everyone else out, and waits for the room to hear. */
async function keepOnly(administrator: Session, room: RoomId, memberIds: UserId[]): Promise<void> {
  const response = await api(`/api/rooms/${room}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ kind: "closed", memberIds }) });
  expect(response.status).toBe(200);
  await vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]), { timeout: 5_000 });
}

/** The key a delivery to `bot`'s webhook gives it in room `room`'s address now, as the Workspace finds it. */
async function webhookKeyIn(room: RoomId, bot: Pick<BotSettings, "id">): Promise<string> {
  const webhook = await workspaceStub().botWebhook(room, bot.id);
  expect(webhook).not.toBeNull();
  return webhook!.key;
}

/** `bot` as `direct` takes the people it starts a DM with. */
const asSession = (bot: Pick<BotSettings, "id" | "name">): Session => ({ user: { id: bot.id, name: bot.name }, cookie: "" });

/** How a message mentioning `person` is written. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** Posts `body` to `room` as the bot whose key is `key`, answering the new message's id. */
async function postAs(key: string, room: RoomId, body: string): Promise<string> {
  const response = await api(`/rooms/${room}/${key}/messages`, { method: "POST", body, headers: { "Content-Type": "text/html" } });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.headers.get("Location")!.split("/@")[1]!;
}

/** A request a webhook got: where it went, and how it was sent. */
interface Delivery {
  url: string;
  init: RequestInit;
}

/**
 * Stands in for every webhook, answering each request with `answer`, by default an empty 204, which
 * says nothing back, and keeps the requests, in the order they came.
 */
function bots(answer: (delivery: Delivery) => Promise<Response> = async () => new Response(null, { status: 204 })) {
  const delivered: Delivery[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const delivery = { url: input instanceof Request ? input.url : String(input), init: init! };
    delivered.push(delivery);
    return answer(delivery);
  });
  return delivered;
}

/**
 * Stands in for every webhook, answering with an image it sends only once `send` is called, waiting in
 * the room's own I/O context. `reading` says whether the room has begun reading it.
 */
function sendingFileWhenLet(file = recordedImage("moon-thumb.jpg"), type = "image/jpeg"): { reading: () => boolean; send: () => void } {
  let [reading, sending] = [false, false];
  bots(async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading = true;
        while (!sending) await new Promise((resolve) => setTimeout(resolve, 10));
        controller.enqueue(file);
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": type } });
  });
  return { reading: () => reading, send: () => (sending = true) };
}

/**
 * Waits until room `room` has nothing left in its log, which it forgets once the Workspace has applied
 * it, queuing each message's deliveries. The room gathers what it logs for a moment between calls, and
 * a message deleted, or a bot taken away, before its call goes out has no delivery queued at all.
 */
const applied = (room: RoomId) =>
  vi.waitFor(async () => expect(await roomSql(room, "SELECT seq FROM room_events WHERE room_id = ?", room)).toEqual([]), { timeout: 5_000 });

/** The R2 bucket that keeps files. */
const files = () => (env as unknown as Env).FILES!;

/** Stands in for keeping a file, where the answer brings none. */
const noFile: Keep<never> = () => expect.unreachable("The answer brings no file");

/** What the request `delivery` sent, read as JSON. */
const payloadOf = (delivery: Delivery) =>
  JSON.parse(delivery.init.body as string) as {
    user: User;
    room: { id: RoomId; name: string | null; path: string };
    message: { id: string; body: { html: string | null; plain: string }; attachment?: { filename: string; content_type: string; byte_size: number; path: string }; path: string };
  };

/** `text` as ActiveSupport::JSON escapes it: `<`, `>` and `&` as JSON's escapes for them. */
const escaped = (text: string) => text.replace(/[<>&]/g, (c) => `${"\\"}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** What a delivery logs when the Workspace finds no webhook for its bot as its turn comes. */
const NO_WEBHOOK = "the bot has been deleted, has left the room or has no webhook";

/** What a delivery logs when the room posts nothing of what its bot says back, which changed while it ran. */
const REPLY_REFUSED = "its reply wasn't posted: the bot has been deleted, has left the room or its webhook has changed";

/** Each room's events are numbered from where the Workspace has applied them, which starts at 0. */
let seq = 0;

/** A new message by `author`, as its room's log sends it to the Workspace, mentioning `mentioned`. */
const message = (author: Pick<User, "id">, ...mentioned: Array<Pick<User, "id">>): RoomEvent => ({
  seq: ++seq,
  kind: "message",
  userId: author.id,
  at: new Date().toISOString(),
  message: { id: crypto.randomUUID(), plainText: "Hey", mentionIds: mentioned.map(({ id }) => id) },
});

/** A bot's reply to a delivery, as its room's log sends it to the Workspace, mentioning `mentioned`. */
const reply = (bot: Pick<User, "id">, ...mentioned: Array<Pick<User, "id">>): RoomEvent => ({ ...message(bot, ...mentioned), kind: "reply" });

/** What the Workspace answers room `room` sending it `events`: the bots' webhooks to deliver to. */
const webhooksFor = async (room: RoomId, events: RoomEvent[]): Promise<MessageWebhook[]> => (await workspaceStub().applyRoomEvents(room, events, [])).webhooks;

/** The ids of the bots `webhooks` go to, in order. */
const botsOf = (webhooks: MessageWebhook[]) => webhooks.map(({ botId }) => botId);

beforeEach(async () => {
  seq = 0;
  await freshDeploy();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Webhooks", () => {
  it("delivers a message to the webhooks of the bots in the room it mentions, as Campfire's JSON, with Net::HTTP's headers", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/hooks/build?team=ops");
    const delivered = bots();
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}, ship <strong>it</strong> &amp; tell ${mention(bot)} &lt;3</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const [{ url, init }] = delivered as [Delivery];
    expect(url).toBe("https://bots.example.com/hooks/build?team=ops");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect([...new Headers(init.headers)]).toEqual([
      ["accept", "*/*"],
      ["content-type", "application/json"],
      ["user-agent", "Ruby"],
    ]);
    // Campfire's keys, in its order, with HTML's characters escaped. `plain` is the plain text without the bot's mentions.
    const expected = {
      user: { id: ada.user.id, name: "Ada Lovelace" },
      room: { id: general, name: "general", path: `/rooms/${general}/${await webhookKeyIn(general, bot)}/messages` },
      message: { id: sent.id, body: { html: sent.body, plain: "Hey , ship it & tell  <3" }, path: `/rooms/${general}/@${sent.id}` },
    };
    expect(init.body).toBe(escaped(JSON.stringify(expected)));
    expect(init.body).not.toMatch(/[<>&]/);
    client.close();
  });

  it("delivers a message in a DM to every bot in it with a webhook, mentioned or not, but its author", async () => {
    const { ada } = await setUp();
    const [builder, deployer] = [await addBot(ada, "Build Bot", "https://bots.example.com/build"), await addBot(ada, "Deploy Bot", "https://bots.example.com/deploy")];
    const room = await direct(ada, asSession(builder), asSession(deployer));

    expect(botsOf(await webhooksFor(room.id, [message(ada.user)]))).toEqual([builder.id, deployer.id]);
    expect(botsOf(await webhooksFor(room.id, [message(builder, builder)]))).toEqual([deployer.id]);
    const [delivery] = await webhooksFor(room.id, [message(ada.user)]);
    expect(delivery).toMatchObject({ author: { id: ada.user.id, name: "Ada Lovelace" }, roomName: null, botId: builder.id });
    // The bot's webhook is read as the delivery runs, with a key of its own for the room, not the bot's.
    const webhook = await workspaceStub().botWebhook(room.id, builder.id);
    expect(webhook).toMatchObject({ bot: { id: builder.id, name: "Build Bot" }, url: "https://bots.example.com/build" });
    expect(webhook!.key).toMatch(new RegExp(`^${builder.id}-[0-9a-f]{32}$`));
  });

  it("delivers a file message with no HTML and its file's name as its plain text, as Campfire delivers a message without rich text, and its file", async () => {
    const { ada } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const room = await direct(ada, asSession(bot));
    const delivered = bots();

    const message = await upload(ada, room.id, "moon.jpg", recordedImage("moon-thumb.jpg"));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const body = delivered[0]!.init.body as string;
    expect(payloadOf(delivered[0]!).message).toEqual({
      id: message.id,
      body: { html: null, plain: "moon.jpg" },
      attachment: { filename: "moon.jpg", content_type: "image/jpeg", byte_size: message.attachment.byteSize, path: message.attachment.url },
      path: `/rooms/${room.id}/@${message.id}`,
    });
    expect(body.indexOf('"attachment"')).toBeGreaterThan(body.indexOf('"body"'));

    // Its path opens the file for the bot, which has no session, and needs no key.
    const file = await api(payloadOf(delivered[0]!).message.attachment!.path);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(recordedImage("moon-thumb.jpg"));
  });

  it("delivers to none but the active bots with webhooks that a message mentions in its room: never a person, a bot without one, a deleted bot or one outside the room", async () => {
    const { ada, general } = await setUp();
    const grace = await signIn("Grace Hopper");
    const [mentioned, unmentioned, quiet, deleted] = [
      await addBot(ada, "Build Bot", "https://bots.example.com/build"),
      await addBot(ada, "Lint Bot", "https://bots.example.com/lint"),
      await addBot(ada, "Quiet Bot"),
      await addBot(ada, "Old Bot", "https://bots.example.com/old"),
    ];
    await deleteBot(ada, deleted);
    const board = await createRoom("Board", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const outside = await addBot(ada, "Outside Bot", "https://bots.example.com/outside");
    await workspaceSql("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", general, outside.id);

    expect(botsOf(await webhooksFor(general, [message(grace.user, mentioned, grace.user, quiet, deleted, outside, ada.user)]))).toEqual([mentioned.id]);
    expect(botsOf(await webhooksFor(board.id, [message(grace.user, mentioned, unmentioned)]))).toEqual([]);
    expect(botsOf(await webhooksFor(general, [message(grace.user)]))).toEqual([]);
    expect(unmentioned.webhookUrl).not.toBeNull();
  });

  it("never delivers a bot's own message to it, whether it mentions itself or writes in its DM", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const room = await direct(ada, asSession(bot));

    expect(await webhooksFor(general, [message(bot, bot)])).toEqual([]);
    expect(await webhooksFor(room.id, [message(bot)])).toEqual([]);
  });

  it("delivers each message once, however often its room sends it, and nothing for a read", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");

    const events = [message(ada.user, bot, bot), message(ada.user, bot)];
    expect((await webhooksFor(general, events)).map(({ messageId }) => messageId)).toEqual(events.map((event) => event.message!.id));
    expect(await webhooksFor(general, events)).toEqual([]);
    expect(await webhooksFor(general, [{ seq: ++seq, kind: "read", userId: ada.user.id, at: new Date().toISOString() }])).toEqual([]);
  });

  it("delivers what a bot posts through its key to the other bots it mentions, the room's path in the payload being each one's own", async () => {
    const { ada, general } = await setUp();
    const [builder, deployer] = [await addBot(ada, "Build Bot"), await addBot(ada, "Deploy Bot", "https://bots.example.com/deploy")];
    const delivered = bots();

    const id = await postAs(builder.key, general, `Build passed, ${mention(deployer)}`);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]!.url).toBe("https://bots.example.com/deploy");
    expect(payloadOf(delivered[0]!)).toMatchObject({
      user: { id: builder.id, name: "Build Bot" },
      room: { path: `/rooms/${general}/${await webhookKeyIn(general, deployer)}/messages` },
      message: { id, body: { plain: "Build passed," } },
    });
  });

  it("delivers nothing when a message is edited or boosted", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const delivered = bots();
    // A hidden tab, so the room's log holds only the messages: one shown would log that it read the room.
    const client = await connect(general, ada, { visible: false });
    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));

    client.send({ type: "message.update", messageId: sent.id, body: `<p>Hi ${mention(bot)}</p>` });
    await client.next("message.updated");
    client.send({ type: "boost.create", messageId: sent.id, content: "🎉" });
    await client.next("boost.created");
    await post(client, "<p>Anyone else?</p>");
    // The next message reaches the Workspace after the edit and boost, and goes to nobody.
    await vi.waitFor(async () => expect(((await workspaceSql("SELECT applied_seq FROM rooms WHERE id = ?", general)) as [{ applied_seq: number }])[0].applied_seq).toBe(2));
    expect(delivered).toHaveLength(1);
    client.close();
  });

  it("takes only the bot's own @mentions out of the plain text, case for case, then whitespace at either end", () => {
    const space = String.fromCodePoint(0xa0, 0x2003, 0x3000);
    const delivery: MessageWebhook = { messageId: "m1", author: { id: "u1", name: "Ada" }, roomName: "general", botId: "b1" };
    const webhook = { bot: { id: "b1", name: "Build Bot" }, key: "b1-AbC123" };
    const plain = (plainText: string, mentions: User[] = []) =>
      (JSON.parse(webhookPayload("r1", delivery, webhook, { id: "m1", body: "", plainText, mentions })) as { message: { body: { plain: string } } }).message.body.plain;

    expect(plain(`${space}@Build Bot deploy @build bot and @Build Botty${space}`)).toBe("deploy @build bot and ty");
    expect(plain("@Build Bot")).toBe("");
    // Its mentions go by the name the message gives it, which is newer where it was renamed then the message edited.
    expect(plain("@Deploy Bot ship it", [{ id: "b1", name: "Deploy Bot" }])).toBe("ship it");
  });

  it("trims the plain text in a moment, however long a run of whitespace it holds", () => {
    const delivery: MessageWebhook = { messageId: "m1", author: { id: "u1", name: "Ada" }, roomName: "general", botId: "b1" };
    const webhook = { bot: { id: "b1", name: "Build Bot" }, key: "b1-AbC123" };
    const plainText = `a${" ".repeat(300_000)}b`;
    const started = Date.now();
    const payload = JSON.parse(webhookPayload("r1", delivery, webhook, { id: "m1", body: "", plainText, mentions: [] })) as { message: { body: { plain: string } } };
    expect(payload.message.body.plain).toBe(plainText);
    // A pattern for the whitespace at the text's end would try to end each run inside it there: some 18 seconds for this.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("writes the payload as Campfire does, with HTML's characters escaped, and a DM's name null", () => {
    const delivery: MessageWebhook = { messageId: "m1", author: { id: "u1", name: "Ada <3" }, roomName: null, botId: "b1" };
    const webhook = { bot: { id: "b1", name: "Build Bot" }, key: "b1-AbC123" };
    const payload = webhookPayload("r1", delivery, webhook, { id: "m1", body: "<p>A &amp; B</p>", plainText: "A & B", mentions: [] });

    expect(payload).toBe(
      escaped('{"user":{"id":"u1","name":"Ada <3"},"room":{"id":"r1","name":null,"path":"/rooms/r1/b1-AbC123/messages"},"message":{"id":"m1","body":{"html":"<p>A &amp; B</p>","plain":"A & B"},"path":"/rooms/r1/@m1"}}'),
    );
  });

  it("posts to the URL as it is, any port, and answers a redirect without following it", async () => {
    const sent: string[] = [];
    const send = (async (input: URL | string, init?: RequestInit) => {
      sent.push(`${init!.method} ${String(input)} ${init!.redirect}`);
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.com/" } });
    }) as typeof fetch;

    expect(await postWebhook("https://bots.example.com:8443/hook?x=1#here", "{}", noFile, { send })).toEqual({ status: 302, reply: null });
    expect(sent).toEqual(["POST https://bots.example.com:8443/hook?x=1#here manual"]);
  });

  it("sends nothing to a URL that isn't an http or https URL with a host", async () => {
    const send = vi.fn() as unknown as typeof fetch;
    for (const url of ["", "ftp://bots.example.com/hook", "bots.example.com/hook", "http://", "mailto:bots@example.com", "https://bots.example.com:99999/"]) {
      await expect(postWebhook(url, "{}", noFile, { send })).rejects.toThrow(new WebhookError("bad URI"));
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing over plain http but to localhost, where Campfire sends to any http URL, since the payload holds the bot's key", async () => {
    const sent: string[] = [];
    const send = (async (input: URL | string) => {
      sent.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    for (const url of ["http://bots.example.com/hook", "http://10.0.0.7:8080/hook", "http://127.0.0.1.example.com/hook"]) {
      await expect(postWebhook(url, "{}", noFile, { send })).rejects.toThrow(new WebhookError("its URL is http, which only a webhook on localhost may use"));
    }
    expect(sent).toEqual([]);

    const local = ["http://localhost:4567/hook", "http://bots.localhost/hook", "http://127.0.0.1:4567/hook", "http://[::1]:4567/hook"];
    for (const url of local) expect(await postWebhook(url, "{}", noFile, { send })).toEqual({ status: 204, reply: null });
    expect(sent).toEqual(local);
  });

  it("fails without the URL in its reason when the request does", async () => {
    const url = "https://bots.example.com/hook?token=secret";
    const send = (async () => {
      throw new TypeError(`Fetch failed: ${url} refused the connection`);
    }) as typeof fetch;

    await expect(postWebhook(url, "{}", noFile, { send })).rejects.toThrow(new WebhookError("TypeError: Fetch failed: [FILTERED] refused the connection"));
  });
});

describe("Webhook replies", () => {
  it("posts what a bot says back as its message, which the room shows at once, as Campfire's receive_text_reply_to does", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    bots(async () => new Response("<b>Hi</b> & bye", { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    // The text is the message's rich text, as a bot's post is.
    expect((await client.next("message.created")).message).toMatchObject({ creator: { id: bot.id, name: "Build Bot" }, body: "<b>Hi</b> &amp; bye", plainText: "Hi & bye" });
    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} performed: 200`));
    client.close();
  });

  it("marks a reply's room unread and pushes it as any new message, but delivers it to no webhook, though it's in a DM with bots and mentions one", async () => {
    const { ada } = await setUp();
    const [builder, deployer] = [await addBot(ada, "Build Bot", "https://bots.example.com/build"), await addBot(ada, "Deploy Bot", "https://bots.example.com/deploy")];
    const room = await direct(ada, asSession(builder), asSession(deployer));
    const { p256dh, auth } = await pushBrowser();
    const endpoint = "https://fcm.googleapis.com/fcm/send/ada";
    const subscribed = await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ endpoint, p256dhKey: p256dh, authKey: auth }) });
    expect(subscribed.status).toBe(204);

    const { pushes, webhooks } = await workspaceStub().applyRoomEvents(room.id, [reply(builder, deployer)], []);
    expect(webhooks).toEqual([]);
    expect(pushes.flatMap(({ deliveries }) => deliveries.map((delivery) => delivery.endpoint))).toEqual([endpoint]);
    const marked = await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? AND unread_at IS NOT NULL", room.id);
    expect(marked).toContainEqual({ user_id: ada.user.id });
    expect(marked).not.toContainEqual({ user_id: builder.id });
  });

  it("posts nothing a bot says back once it's deleted while its delivery runs, where Campfire posts it", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    // The webhook answers once the test lets it, waiting in the room's own I/O context.
    let answering = false;
    const delivered = bots(async () => {
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("Still here", { headers: { "Content-Type": "text/plain" } });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await deleteBot(ada, bot);
    answering = true;
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, REPLY_REFUSED));
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    client.close();
  });

  it("posts nothing a bot says back once it's taken out of the room, or its webhook delivers elsewhere, while its delivery runs", async () => {
    const { ada } = await setUp();
    const [builder, deployer] = [await addBot(ada, "Build Bot", "https://bots.example.com/build"), await addBot(ada, "Deploy Bot", "https://bots.example.com/deploy")];
    const room = await createRoom("Launch", { closedTo: [ada.user.id, builder.id, deployer.id], as: ada });
    let answering = false;
    const delivered = bots(async () => {
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("Done", { headers: { "Content-Type": "text/plain" } });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(room.id, ada);

    const sent = await post(client, `<p>Ship it, ${mention(builder)} and ${mention(deployer)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await keepOnly(ada, room.id, [ada.user.id, deployer.id]);
    await changeBot(ada, deployer, { webhookUrl: "https://bots.example.com/deploy-v2" });
    answering = true;
    for (const bot of [builder, deployer]) {
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, REPLY_REFUSED));
    }
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    client.close();
  });

  it("posts nothing a bot says back once the room has heard it was taken out after the Workspace found its webhook, as it refuses the bot's posts then", async () => {
    const { ada } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const room = await createRoom("Launch", { closedTo: [ada.user.id, bot.id], as: ada });
    const found = (await workspaceStub().botWebhook(room.id, bot.id))!;
    await keepOnly(ada, room.id, [ada.user.id]);
    const client = await connect(room.id, ada);

    const refused = await runInDurableObject(roomStub(room.id), (chatRoom: ChatRoom) =>
      (chatRoom as unknown as { reply(roomId: RoomId, access: WebhookAccess, text: string): Promise<string | null> }).reply(room.id, found, "Too late"),
    );
    expect(`its reply wasn't posted: ${refused}`).toBe(REPLY_REFUSED);
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    client.close();
  });

  it("posts a file a bot says back as its message, which R2 keeps as it arrives, as Campfire's receive_attachment_reply_to does", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    bots(async () => new Response(recordedImage("moon-thumb.jpg"), { headers: { "Content-Type": "image/jpeg" } }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    const { message } = await client.next("message.created");
    expect(message).toMatchObject({
      creator: { id: bot.id, name: "Build Bot" },
      body: "",
      plainText: "attachment.jpeg",
      attachment: { name: "attachment.jpeg", contentType: "image/jpeg", byteSize: recordedImage("moon-thumb.jpg").length, width: 640, height: 640 },
    });
    const kept = await files().get(objectKey(message.attachment!.id));
    expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(recordedImage("moon-thumb.jpg"));
    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} performed: 200`));
    client.close();
  });

  it("posts a picture a bot says back that's too large to show by itself with the preview Cloudflare Images makes of it", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    bots(async () => new Response(storedPng(1600, 1200), { headers: { "Content-Type": "image/png" } }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await connect(general, ada);

    await post(client, `<p>Hey ${mention(bot)}</p>`);
    const { attachment } = (await client.next("message.created")).message;
    expect(attachment).toMatchObject({ name: "attachment.png", contentType: "image/png", width: 1600, height: 1200, previewUrl: expect.stringMatching(/^\/previews\//) });
    const preview = await api(attachment!.previewUrl!);
    expect(preview.headers.get("Content-Type")).toBe("image/webp");
    expect(imageSize(new Uint8Array(await preview.arrayBuffer()), "image/webp")).toEqual({ width: 1067, height: 800 });
    client.close();
  });

  it("posts nothing for an error page a bot's webhook answers, keeping nothing in R2, as Campfire 1.5.2 doesn't", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    bots(async () => new Response("<h1>Internal Server Error</h1>", { status: 500, headers: { "Content-Type": "text/html" } }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} performed: 500`));
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    expect((await files().list({ prefix: "files/" })).objects).toEqual([]);
    client.close();
  });

  it("posts nothing for text with nothing in it, logging why", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    bots(async () => new Response(" <p> </p> ", { headers: { "Content-Type": "text/html" } }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, "its reply wasn't posted: Your message is empty."));
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    client.close();
  });

  it("posts no file without an R2 bucket, logging why", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    bots(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "Content-Type": "image/jpeg" } }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);
    await runInDurableObject(roomStub(general), (room: ChatRoom) => {
      const object = room as unknown as { env: Env };
      object.env = { ...object.env, FILES: undefined };
    });

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, "its reply, attachment.jpeg (image/jpeg), is a file, and Ember isn't set up to store files"),
    );
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    client.close();
  });

  it("keeps none of a file a bot says back once its room is deleted while it arrives", async () => {
    const { ada } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const room = await createRoom("Launch", { as: ada });
    const file = sendingFileWhenLet();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(room.id, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(file.reading()).toBe(true));
    expect((await api(`/api/rooms/${room.id}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    // Once the room has heard.
    await vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]), { timeout: 5_000 });
    file.send();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, "its reply wasn't posted: the room is gone"));
    expect((await files().list({ prefix: "files/" })).objects).toEqual([]);
  });

  it("sends nothing waiting its turn once its room is deleted, and makes nothing again in a room the alarm has erased meanwhile", async () => {
    const { ada } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const room = await createRoom("Launch", { as: ada });
    // The bot's webhook holds both the room's places until the test lets it answer.
    let answering = false;
    const delivered = bots(async () => {
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, { status: 204 });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(room.id, ada);
    const closed = closeOf(client.ws);

    await post(client, `<p>One ${mention(bot)}</p>`);
    await post(client, `<p>Two ${mention(bot)}</p>`);
    const waiting = await post(client, `<p>Three ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await applied(room.id);
    expect((await api(`/api/rooms/${room.id}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    await closed;
    await vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]), { timeout: 5_000 });
    expect(await runDurableObjectAlarm(roomStub(room.id))).toBe(true);

    answering = true;
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${waiting.id} to bot ${bot.id} failed:`, "the message is gone"));
    expect(delivered).toHaveLength(2);
    const left = await runInDurableObject(roomStub(room.id), async (_room, state: DurableObjectState) => ({
      tables: state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).toArray(),
      keys: [...(await state.storage.list()).keys()],
      alarm: await state.storage.getAlarm(),
    }));
    expect(left).toEqual({ tables: [], keys: [], alarm: null });
  });

  it("keeps none of a file a bot says back once the bot is deleted while it arrives, nor its preview", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const file = sendingFileWhenLet(storedPng(1600, 1200), "image/png");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(file.reading()).toBe(true));
    await deleteBot(ada, bot);
    file.send();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, REPLY_REFUSED));
    expect((await files().list({ prefix: "files/" })).objects).toEqual([]);
    expect((await files().list({ prefix: "previews/" })).objects).toEqual([]);
    await settle(client);
    expect(client.pending("message.created")).toEqual([]);
    client.close();
  });

  it("keeps none of a file a bot says back when the Workspace can't be asked about the bot once it has arrived, nor its preview", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const file = sendingFileWhenLet(storedPng(1600, 1200), "image/png");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(file.reading()).toBe(true));
    const unreachable = new Error("The Workspace can't be reached");
    await runInDurableObject(roomStub(general), (room: ChatRoom) => {
      const object = room as unknown as { env: Env };
      const workspace = { getByName: () => ({ botWebhook: () => Promise.reject(unreachable) }) };
      object.env = { ...object.env, WORKSPACE: workspace as unknown as Env["WORKSPACE"] };
    });
    file.send();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, unreachable));
    expect((await files().list({ prefix: "files/" })).objects).toEqual([]);
    expect((await files().list({ prefix: "previews/" })).objects).toEqual([]);
    client.close();
  });
});

describe("Generate a new bot key", () => {
  it("gives the room's path a new key once it's reset, the old one opening nothing", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const before = await webhookKeyIn(general, bot);
    const reset = await api(`/api/account/bots/${bot.id}/key`, { method: "PUT", headers: { Cookie: ada.cookie } });
    const { key } = ((await reset.json()) as BotAnswer).bot;
    const delivered = bots();
    const client = await connect(general, ada);

    await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(key).not.toBe(bot.key);
    const { path } = payloadOf(delivered[0]!).room;
    expect(path).toBe(`/rooms/${general}/${await webhookKeyIn(general, bot)}/messages`);
    expect(path).not.toContain(before);
    expect((await api(`/rooms/${general}/${before}/messages`, { method: "POST", body: "Stale" })).status).toBe(401);
    expect((await api(path, { method: "POST", body: "Fresh" })).status).toBe(201);
    client.close();
  });
});

/** Posts `body` at `path`, a room's address for bots, answering the status: 201 once posted, 401 for a key that opens nothing. */
const postedAt = async (path: string, body: string) => (await api(path, { method: "POST", body, headers: { "Content-Type": "text/plain" } })).status;

describe("A webhook's own key", () => {
  it("is what a delivery gives the bot in the room's address, never the bot's own key, and posts and reads as the bot there", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const delivered = bots();
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]!.init.body).not.toContain(bot.key);
    const { path } = payloadOf(delivered[0]!).room;
    expect(path).toMatch(new RegExp(`^/rooms/${general}/${bot.id}-[0-9a-f]{32}/messages$`));

    expect(await postedAt(path, "On it")).toBe(201);
    expect((await client.next("message.created")).message).toMatchObject({ creator: { id: bot.id, name: "Build Bot" }, plainText: "On it" });
    const read = await api(path);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Array<{ id: string }>).map(({ id }) => id)).toContain(sent.id);
    client.close();
  });

  it("stays the same while the webhook does, and opens the bot API in its own room alone", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const ops = await createRoom("ops", { as: ada });
    const delivered = bots();
    const client = await connect(general, ada);

    for (const n of ["One", "Two"]) await post(client, `<p>${n} ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    const [first, second] = delivered.map((delivery) => payloadOf(delivery).room.path);
    expect(second).toBe(first);
    // The bot is in ops too, where its own key posts, but general's key opens nothing there.
    const key = first!.split("/")[3]!;
    expect(await webhookKeyIn(ops.id, bot)).not.toBe(key);
    expect(await postedAt(`/rooms/${ops.id}/${key}/messages`, "Wrong room")).toBe(401);
    expect(await postedAt(`/rooms/${ops.id}/${bot.key}/messages`, "Right key")).toBe(201);
    client.close();
  });

  it("opens nothing once the webhook delivers elsewhere or is removed, even once it's added again with the same URL, while the bot's own key goes on working", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    const first = await webhookKeyIn(general, bot);
    expect(await postedAt(`/rooms/${general}/${first}/messages`, "Before")).toBe(201);

    await changeBot(ada, bot, { webhookUrl: "https://bots.example.com/deploy" });
    const second = await webhookKeyIn(general, bot);
    expect(second).not.toBe(first);
    expect(await postedAt(`/rooms/${general}/${first}/messages`, "From the old server")).toBe(401);
    expect(await postedAt(`/rooms/${general}/${second}/messages`, "From the new one")).toBe(201);

    await changeBot(ada, bot, { webhookUrl: "" });
    expect(await workspaceStub().botWebhook(general, bot.id)).toBeNull();
    expect(await postedAt(`/rooms/${general}/${second}/messages`, "After it was removed")).toBe(401);

    await changeBot(ada, bot, { webhookUrl: "https://bots.example.com/deploy" });
    expect(await webhookKeyIn(general, bot)).not.toBe(second);
    expect(await postedAt(`/rooms/${general}/${second}/messages`, "From before it was removed")).toBe(401);
    expect(await postedAt(`/rooms/${general}/${bot.key}/messages`, "Still the bot")).toBe(201);
  });

  it("opens the bot API as its own bot alone, and nothing once that bot is deleted", async () => {
    const { ada, general } = await setUp();
    const [builder, deployer] = [await addBot(ada, "Build Bot", "https://bots.example.com/build"), await addBot(ada, "Deploy Bot", "https://bots.example.com/build")];
    const key = await webhookKeyIn(general, builder);
    // Both bots deliver to the same server, but what it's given for one doesn't open the other.
    expect(await postedAt(`/rooms/${general}/${deployer.id}-${key.split("-")[1]}/messages`, "Borrowed")).toBe(401);

    await deleteBot(ada, builder);
    expect(await postedAt(`/rooms/${general}/${key}/messages`, "Deleted")).toBe(401);
  });
});

describe("Webhooks run in the background", () => {
  it("runs a room's deliveries two at a time, in turn, reading each message as it is when its turn comes", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    // The webhooks answer once the test lets them, in the order they were asked. They wait for it
    // in the room's own I/O context, since workerd won't let the test settle a promise made there.
    let answered = 0;
    const delivered = bots(async (delivery) => {
      while (answered <= delivered.indexOf(delivery)) await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, { status: 204 });
    });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const [first, second, third, fourth] = [
      await post(client, `<p>One ${mention(bot)}</p>`),
      await post(client, `<p>Two ${mention(bot)}</p>`),
      await post(client, `<p>Three ${mention(bot)}</p>`),
      await post(client, `<p>Four ${mention(bot)}</p>`),
    ];
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await applied(general);
    // The third and fourth wait their turn, by which time the bot is renamed, the third edited, which
    // mentions it by its new name, and the fourth deleted.
    await changeBot(ada, bot, { name: "Deploy Bot" });
    client.send({ type: "message.update", messageId: third!.id, body: `<p>Three, edited ${mention(bot)}</p>` });
    await client.next("message.updated");
    client.send({ type: "message.delete", messageId: fourth!.id });
    await client.next("message.deleted");
    expect(delivered).toHaveLength(2);

    answered = 1;
    await vi.waitFor(() => expect(delivered).toHaveLength(3));
    answered = 3;
    const performed = () => logs.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("Bot::WebhookJob"));
    await vi.waitFor(() => expect(performed()).toHaveLength(3));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${fourth!.id} to bot ${bot.id} failed:`, "the message is gone"));
    expect(delivered.map((delivery) => payloadOf(delivery).message.id)).toEqual([first!.id, second!.id, third!.id]);
    expect(payloadOf(delivered[2]!).message.body.plain).toBe("Three, edited");
    // The second and third are answered together, so either may finish first.
    expect(performed().sort()).toEqual([first, second, third].map((sent) => `Bot::WebhookJob of message ${sent!.id} to bot ${bot.id} performed: 204`).sort());
    client.close();
  });

  it("sends nothing waiting its turn to a bot deleted, taken out of the room or left without a webhook by then, logging why", async () => {
    const { ada } = await setUp();
    const [busy, deleted, removed, unhooked] = [
      await addBot(ada, "Busy Bot", "https://bots.example.com/busy"),
      await addBot(ada, "Old Bot", "https://bots.example.com/old"),
      await addBot(ada, "Lint Bot", "https://bots.example.com/lint"),
      await addBot(ada, "Quiet Bot", "https://bots.example.com/quiet"),
    ];
    const room = await createRoom("Launch", { closedTo: [ada.user.id, busy.id, deleted.id, removed.id, unhooked.id], as: ada });
    // Busy Bot's webhook holds both the room's places until the test lets it answer.
    let answering = false;
    const delivered = bots(async () => {
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, { status: 204 });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(room.id, ada);

    await post(client, `<p>One ${mention(busy)}</p>`);
    await post(client, `<p>Two ${mention(busy)}</p>`);
    const sent = await post(client, `<p>Three ${mention(deleted)} ${mention(removed)} ${mention(unhooked)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await applied(room.id);
    await deleteBot(ada, deleted);
    await keepOnly(ada, room.id, [ada.user.id, busy.id, unhooked.id]);
    await changeBot(ada, unhooked, { webhookUrl: "" });

    answering = true;
    for (const bot of [deleted, removed, unhooked]) {
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, NO_WEBHOOK));
    }
    expect(delivered.map(({ url }) => url)).toEqual(["https://bots.example.com/busy", "https://bots.example.com/busy"]);
    client.close();
  });

  it("delivers what waits its turn to the bot's webhook as it is then, at its new URL with its new key, and posts its reply by its new name", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    // The webhooks answer once the test lets them, in the order they were asked, and only the third says anything.
    let answered = 0;
    const delivered = bots(async (delivery) => {
      const index = delivered.indexOf(delivery);
      while (answered <= index) await new Promise((resolve) => setTimeout(resolve, 10));
      return index < 2 ? new Response(null, { status: 204 }) : new Response("On it", { headers: { "Content-Type": "text/plain" } });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = await connect(general, ada);

    for (const n of ["One", "Two", "Three"]) await post(client, `<p>${n} ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    // The third waits its turn, by which time the bot has a new name, URL and key.
    await changeBot(ada, bot, { name: "Deploy Bot", webhookUrl: "https://bots.example.com/deploy" });
    const reset = await api(`/api/account/bots/${bot.id}/key`, { method: "PUT", headers: { Cookie: ada.cookie } });
    const { key } = ((await reset.json()) as BotAnswer).bot;

    answered = 3;
    expect((await client.next("message.created")).message).toMatchObject({ creator: { id: bot.id, name: "Deploy Bot" }, plainText: "On it" });
    expect(delivered.map(({ url }) => url)).toEqual(["https://bots.example.com/build", "https://bots.example.com/build", "https://bots.example.com/deploy"]);
    expect(key).not.toBe(bot.key);
    expect(payloadOf(delivered[2]!).room.path).toBe(`/rooms/${general}/${await webhookKeyIn(general, bot)}/messages`);
    client.close();
  });

  it("stops delivering to a webhook saved before with an http URL elsewhere than localhost, saying why in its log", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    // As Ember once saved it.
    await workspaceSql("UPDATE webhooks SET url = 'http://bots.example.com/build' WHERE user_id = ?", bot.id);
    const delivered = bots();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    const why = "its URL is http, which only a webhook on localhost may use";
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, why));
    expect(delivered).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("bots.example.com");
    client.close();
  });

  it("logs a delivery that fails, never with the webhook's URL or the bot's key", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    await workspaceSql("UPDATE webhooks SET url = 'not a url' WHERE user_id = ?", bot.id);
    const delivered = bots();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(general, ada);

    const sent = await post(client, `<p>Hey ${mention(bot)}</p>`);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Bot::WebhookJob of message ${sent.id} to bot ${bot.id} failed:`, "bad URI"));
    expect(delivered).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(bot.key);
    client.close();
  });

  it("queries webhooks first, with @ember, finding each one's bot and membership by their keys, and a delivery's webhook by its bot's", async () => {
    const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${MESSAGE_BOTS}`, "room", "user", "[]", 1)).map((row) => (row as { detail: string }).detail);
    expect(plan).toContainEqual(expect.stringMatching(/^SCAN webhooks\b/));
    expect(plan.filter((step) => /^SCAN (users|memberships|rooms)\b/.test(step))).toEqual([]);
    const found = (await workspaceSql(`EXPLAIN QUERY PLAN ${BOT_WEBHOOK}`, "room", "bot")).map((row) => (row as { detail: string }).detail);
    expect(found.filter((step) => /^SCAN\b/.test(step))).toEqual([]);
  });

  it("runs jobs a few at a time as they come, keeps some more waiting, and drops any beyond", async () => {
    const queue = new JobQueue(2, 1);
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const job = (name: string) => () =>
      new Promise<void>((resolve) => {
        started.push(name);
        finish.set(name, resolve);
      });

    const ran = ["a", "b", "c"].map((name) => queue.run(job(name)));
    expect(started).toEqual(["a", "b"]);
    expect(queue.full).toBe(true);
    ran.push(queue.run(job("d")));
    expect(await ran[3]).toBe(false);

    finish.get("b")!();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    expect(queue.full).toBe(false);
    finish.get("a")!();
    finish.get("c")!();
    expect(await Promise.all(ran.slice(0, 3))).toEqual([true, true, true]);
    // With nothing running, the next starts at once.
    const last = queue.run(job("e"));
    expect(started).toEqual(["a", "b", "c", "e"]);
    finish.get("e")!();
    expect(await last).toBe(true);
  });
});

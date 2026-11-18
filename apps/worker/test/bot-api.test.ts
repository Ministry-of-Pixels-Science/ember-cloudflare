import {
  HISTORY_PAGE_SIZE,
  MAX_BOOST_LENGTH,
  MAX_MESSAGE_HTML_LENGTH,
  MAX_MESSAGE_LENGTH,
  MESSAGE_TOO_LONG,
  type BotAnswer,
  type BotSettings,
  type DirectRoom,
  type Directory,
  type Me,
  type NewWorkspace,
  type RoomId,
  type SearchResults,
} from "@ember/protocol";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withoutBotKeys } from "../src/bots/api";
import { NOT_FOUND } from "../src/chat-room";
import type { Env } from "../src/env";
import { AUTHORIZATION_TTL_MS } from "../src/revocations";
import { COUNT_MESSAGES } from "../src/store";
import { env } from "cloudflare:workers";
import {
  api,
  apiWith,
  connect,
  cookieOf,
  createRoom,
  freshDeploy,
  objectSql,
  origin,
  post,
  recordedImage,
  roomSql,
  roomStub,
  settle,
  sharedD1,
  shown,
  startDirect,
  upload,
  workspaceSql,
  type Session,
} from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Adds a bot as `administrator`, answering it as its edit page shows it, key and all. */
async function addBot(administrator: Session, name = "Build Bot"): Promise<BotSettings> {
  const response = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** Gives `bot` a new key, as `administrator` can on its edit page, answering it as the page then shows it. */
async function newKeyFor(administrator: Session, bot: BotSettings): Promise<BotSettings> {
  const response = await api(`/api/account/bots/${bot.id}/key`, { method: "PUT", headers: { Cookie: administrator.cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as BotAnswer).bot;
}

/** Sets Ember up with a bot, which is in first run's general room. */
async function withBot() {
  const administrator = await setUp();
  const bot = await addBot(administrator);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { administrator, bot, general };
}

/** A room's address for the bot whose key is `key`. */
const botPath = (room: RoomId, key: string, query = "") => `/rooms/${room}/${key}/messages${query}`;

/** Posts `body` to `room` as the bot whose key is `key`, as `curl -d` does unless `headers` say otherwise. */
const postAs = (key: string, room: RoomId, body: BodyInit | null, headers: Record<string, string> = {}) =>
  api(botPath(room, key), { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers } });

/** Resolves once rooms have heard every revocation, as they do just after the change that queued it. */
const revocationsDelivered = () =>
  vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]), { timeout: 5_000 });

/** A body its sender holds back until `meanwhile` has run, once the Worker has begun to read it. */
const heldBack = (text: string, meanwhile: () => Promise<unknown>) =>
  new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await meanwhile();
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );

/** Reads `room` as the bot whose key is `key`. */
const readAs = (key: string, room: RoomId, query = "", init: RequestInit = {}) => api(botPath(room, key, query), init);

/** Message `id`'s address in `room` for the bot whose key is `key`, followed by `rest`. */
const messagePath = (room: RoomId, key: string, id: string, rest = "") => `/rooms/${room}/${key}/messages/${id}${rest}`;

/** As `curl -d` sends a body. */
const FORM_TYPE = { "Content-Type": "application/x-www-form-urlencoded" };

/** Replaces the text of message `id` with `body` as the bot whose key is `key`, with PATCH unless `method` says otherwise. */
const editAs = (key: string, room: RoomId, id: string, body: BodyInit | null, method = "PATCH", headers: Record<string, string> = {}) =>
  api(messagePath(room, key, id), { method, body, headers: { ...FORM_TYPE, ...headers } });

/** Deletes message `id` as the bot whose key is `key`. */
const deleteAs = (key: string, room: RoomId, id: string, headers: Record<string, string> = {}) => api(messagePath(room, key, id), { method: "DELETE", headers });

/** Boosts message `id` with `content` as the bot whose key is `key`. */
const boostAs = (key: string, room: RoomId, id: string, content: BodyInit | null, headers: Record<string, string> = {}) =>
  api(messagePath(room, key, id, "/boosts"), { method: "POST", body: content, headers: { ...FORM_TYPE, ...headers } });

/** Removes boost `boostId` from message `id` as the bot whose key is `key`. */
const unboostAs = (key: string, room: RoomId, id: string, boostId: string, headers: Record<string, string> = {}) =>
  api(messagePath(room, key, id, `/boosts/${boostId}`), { method: "DELETE", headers });

/** Everything a bot can ask of a message and its boosts, as the bot whose key is `key`. */
const changesAs = (key: string, room: RoomId, id: string, headers: Record<string, string> = {}) => ({
  edit: editAs(key, room, id, "Edited", "PATCH", headers),
  delete: deleteAs(key, room, id, headers),
  boost: boostAs(key, room, id, "👀", headers),
  unboost: unboostAs(key, room, id, "0noboost000000", headers),
});

/** Posts `body` as the bot whose key is `key`, answering the new message's id. */
async function posted(key: string, room: RoomId, body: string): Promise<string> {
  const response = await postAs(key, room, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.headers.get("Location")!.split("/@")[1]!;
}

/** Whether room `room`'s object has opened a database of its own, as it does on DO SQLite once it's used. */
const opened = async (room: RoomId) => (await objectSql(roomStub(room), "SELECT name FROM sqlite_master WHERE name = 'messages'")).length > 0;

/** The messages `room` has, oldest first, as its database holds them: on DO SQLite, none until its object has opened one. */
async function storedIn(room: RoomId): Promise<Array<{ id: string; creator_id: string; body: string }>> {
  if (!sharedD1() && !(await opened(room))) return [];
  return (await roomSql(room, "SELECT id, creator_id, body FROM messages WHERE room_id = ? ORDER BY id", room)) as Array<{ id: string; creator_id: string; body: string }>;
}

/** The boosts `room` has, oldest first, as its database holds them. */
const boostsIn = async (room: RoomId) =>
  (await roomSql(room, "SELECT id, message_id, booster_id, content FROM boosts WHERE room_id = ? ORDER BY id", room)) as Array<{
    id: string;
    message_id: string;
    booster_id: string;
    content: string;
  }>;

/** The page of messages a bot reads, parsed. */
interface ListedMessage {
  id: string;
  created_at: string;
  body: { plain_text: string; html: string };
  attachment?: { filename: string; content_type: string; byte_size: number; url: string };
  creator: { id: string; name: string; role: string; avatar_url: string };
  room: { id: RoomId };
  url: string;
}

async function listedBy(key: string, room: RoomId, query = ""): Promise<ListedMessage[]> {
  const response = await readAs(key, room, query);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** Someone's avatar's address, as the people directory gives it to `viewer`. */
async function avatarOf(viewer: Session, userId: string): Promise<string> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!.avatarUrl;
}

const tokenOf = (bot: BotSettings) => bot.key.slice(bot.id.length + 1);

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bot keys", () => {
  it("posts as the bot whose key is in the address, with or without .json, spaces around the key and anything after a second '-' ignored", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    for (const key of [bot.key, `%20${bot.key}%0A`, `${bot.key}-ignored`]) {
      expect((await postAs(key, general, `Hello from ${key}`)).status).toBe(201);
      const { message } = await inRoom.next("message.created");
      expect(message.creator).toEqual({ id: bot.id, name: "Build Bot" });
    }
    const json = await api(`/rooms/${general}/${bot.key}/messages.json`, { method: "POST", body: "As JSON" });
    expect(json.status).toBe(201);
    expect((await storedIn(general)).map(({ creator_id }) => creator_id)).toEqual([bot.id, bot.id, bot.id, bot.id]);
  });

  it("answers 401 to a key that isn't an active bot's, posting and reading nothing", async () => {
    const { administrator, bot, general } = await withBot();
    const keys = [
      `${bot.id}-wrongwrongxx`,
      `${bot.id}-${tokenOf(bot)}x`,
      `${bot.id}-${tokenOf(bot).slice(1)}`,
      `0nobody0000000-${tokenOf(bot)}`,
      // Someone who isn't a bot has no token, so a key with an empty one can't be theirs.
      `${administrator.user.id}-`,
      `${administrator.user.id}--${tokenOf(bot)}`,
      `${bot.id}-`,
      bot.id,
      `-${tokenOf(bot)}`,
      "%E0%A4%A",
    ];
    const id = await posted(bot.key, general, "Deploying...");
    for (const key of keys) {
      const post = await postAs(key, general, "Hello!");
      expect([key, post.status, await post.json()]).toEqual([key, 401, { error: "Unknown bot key" }]);
      const read = await readAs(key, general);
      expect([key, read.status]).toEqual([key, 401]);
      for (const [asked, response] of Object.entries(changesAs(key, general, id))) expect([key, asked, (await response).status]).toEqual([key, asked, 401]);
    }
    expect(await storedIn(general)).toMatchObject([{ id, body: "Deploying..." }]);
    expect(await boostsIn(general)).toEqual([]);
  });

  it("stops taking a key once its bot is deleted, or given a new one", async () => {
    const { administrator, bot, general } = await withBot();
    const renewed = await newKeyFor(administrator, bot);
    expect((await postAs(bot.key, general, "Old key")).status).toBe(401);
    expect((await postAs(renewed.key, general, "New key")).status).toBe(201);

    expect((await api(`/api/account/bots/${bot.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
    expect((await postAs(renewed.key, general, "Deleted")).status).toBe(401);
    expect((await readAs(renewed.key, general)).status).toBe(401);
    expect((await storedIn(general)).map(({ body }) => body)).toEqual(["New key"]);
  });

  it("checks the key again once the body has arrived, so a bot given a new key or taken out of the room while it sends posts nothing", async () => {
    const { administrator, bot, general } = await withBot();
    let renewed = bot;
    const reset = await postAs(bot.key, general, heldBack("Old key", async () => {
      renewed = await newKeyFor(administrator, bot);
    }));
    expect([reset.status, await reset.json()]).toEqual([401, { error: "Unknown bot key" }]);

    const room = await createRoom("Launch", { closedTo: [administrator.user.id, bot.id], as: administrator });
    const takeBotOut = JSON.stringify({ kind: "closed", memberIds: [administrator.user.id] });
    const out = await postAs(renewed.key, room.id, heldBack("Taken out", async () => {
      expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: takeBotOut })).status).toBe(200);
    }));
    expect([out.status, await out.text()]).toEqual([404, ""]);

    expect(await storedIn(general)).toEqual([]);
    expect(await storedIn(room.id)).toEqual([]);
    expect((await postAs(renewed.key, general, "New key")).status).toBe(201);
  });

  it("posts nothing for a bot that the room has heard was taken out since its key was checked, as a socket would be turned away", async () => {
    const { administrator, bot, general } = await withBot();
    const room = await createRoom("Launch", { closedTo: [administrator.user.id, bot.id], as: administrator });
    const letThrough = { bot: { id: bot.id, name: bot.name }, authorizedAt: Date.now() };
    const takeBotOut = JSON.stringify({ kind: "closed", memberIds: [administrator.user.id] });
    expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: takeBotOut })).status).toBe(200);
    await revocationsDelivered();
    expect(await roomStub(room.id).createBotMessage(room.id, letThrough, "Too late")).toBeNull();
    expect(await storedIn(room.id)).toEqual([]);
    // Nor after a check older than a socket's authorization can be, in a room it's still in.
    const stale = { bot: { id: bot.id, name: bot.name }, authorizedAt: Date.now() - AUTHORIZATION_TTL_MS - 1 };
    expect(await roomStub(general).createBotMessage(general, stale, "Too old")).toBeNull();
    expect(await storedIn(general)).toEqual([]);
  });

  it("posts nothing for a bot kept to open rooms that leave this one out since its key was checked, which the room hears before the change answers", async () => {
    const { administrator, bot, general } = await withBot();
    const room = await createRoom("Launch", { as: administrator });
    const letThrough = { bot: { id: bot.id, name: bot.name }, authorizedAt: Date.now() };
    const keepToGeneral = JSON.stringify({ rooms: [general] });
    expect((await api(`/api/account/bots/${bot.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: keepToGeneral })).status).toBe(200);
    expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]);
    expect(await roomStub(room.id).createBotMessage(room.id, letThrough, "Too late")).toBeNull();
    expect(await storedIn(room.id)).toEqual([]);
    expect((await postAs(bot.key, room.id, "Too late")).status).toBe(404);
    expect((await postAs(bot.key, general, "Still here")).status).toBe(201);
  });

  it("changes nothing for a bot that the room has heard was taken out since its key was checked, as it posts nothing", async () => {
    const { administrator, bot } = await withBot();
    const room = await createRoom("Launch", { closedTo: [administrator.user.id, bot.id], as: administrator });
    const id = await posted(bot.key, room.id, "Deploying...");
    const boost = (await (await boostAs(bot.key, room.id, id, "👀")).json()) as { id: string };
    const letThrough = { bot: { id: bot.id, name: bot.name }, authorizedAt: Date.now() };
    const takeBotOut = JSON.stringify({ kind: "closed", memberIds: [administrator.user.id] });
    expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: takeBotOut })).status).toBe(200);
    await revocationsDelivered();
    const inRoom = roomStub(room.id);
    expect(await inRoom.editBotMessage(room.id, letThrough, id, "Deployed.")).toBe(NOT_FOUND);
    expect(await inRoom.deleteBotMessage(room.id, letThrough, id)).toBe(NOT_FOUND);
    expect(await inRoom.addBotBoost(room.id, letThrough, id, "🎉")).toBe(NOT_FOUND);
    expect(await inRoom.removeBotBoost(room.id, letThrough, id, boost.id)).toBe(false);
    expect(await storedIn(room.id)).toMatchObject([{ id, body: "Deploying..." }]);
    expect(await boostsIn(room.id)).toMatchObject([{ id: boost.id, content: "👀" }]);
  });

  it("answers an empty 404 for a room the bot isn't in, once the key is checked, and never wakes it", async () => {
    const { administrator, bot, general } = await withBot();
    const secrets = await createRoom("Secrets", { closedTo: [administrator.user.id], as: administrator });
    for (const room of [secrets.id, "0nowhere000000", "%E0%A4%A"]) {
      const post = await postAs(bot.key, room, "Hello!");
      expect([room, post.status, post.headers.get("Content-Type"), await post.text()]).toEqual([room, 404, "text/html", ""]);
      const read = await readAs(bot.key, room);
      expect([room, read.status, await read.text()]).toEqual([room, 404, ""]);
      for (const [asked, response] of Object.entries(changesAs(bot.key, room, "0nothing000000"))) {
        const answer = await response;
        expect([room, asked, answer.status, await answer.text()]).toEqual([room, asked, 404, ""]);
      }
    }
    expect((await postAs(`${bot.id}-wrongwrongxx`, secrets.id, "Hello!")).status).toBe(401);
    expect(await opened(secrets.id)).toBe(false);
    expect(await storedIn(secrets.id)).toEqual([]);
    expect((await postAs(bot.key, general, "Hello!")).status).toBe(201);
  });

  it("posts in a DM the bot is in, which the bots page doesn't list", async () => {
    const { administrator, bot } = await withBot();
    const response = await startDirect(administrator, [bot.id]);
    expect(response.status).toBe(201);
    const { room } = (await response.json()) as { room: DirectRoom };
    expect((await postAs(bot.key, room.id, "Hello, Ada")).status).toBe(201);
    expect(await listedBy(bot.key, room.id)).toMatchObject([{ body: { plain_text: "Hello, Ada" }, creator: { id: bot.id } }]);
  });

  it("never reads a session, so a cookie makes no difference and posts from other sites are taken", async () => {
    const { administrator, bot, general } = await withBot();
    const fromElsewhere = { Cookie: administrator.cookie, "Sec-Fetch-Site": "cross-site", Origin: "https://elsewhere.example" };
    expect((await postAs(bot.key, general, "From CI", fromElsewhere)).status).toBe(201);
    expect((await postAs(`${bot.id}-wrongwrongxx`, general, "As Ada?", fromElsewhere)).status).toBe(401);
    expect(await storedIn(general)).toMatchObject([{ creator_id: bot.id, body: "From CI" }]);
  });

  it("isn't taken anywhere else: other addresses never read a bot key, and answer as they do to anyone signed out", async () => {
    const { bot } = await withBot();
    for (const path of [`/api/sidebar?bot_key=${bot.key}`, `/api/users?bot_key=${bot.key}`]) expect((await api(path)).status).toBe(401);
  });

  it("refuses posts from a banned IP address with 429, which can still read", async () => {
    const { administrator, bot, general } = await withBot();
    const member = await joinAsGrace();
    const signedIn = await api("/api/session", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ emailAddress: grace.emailAddress, password: grace.password }),
    });
    expect(signedIn.status).toBe(201);
    expect((await api(`/api/users/${member.user.id}/ban`, { method: "POST", headers: { Cookie: administrator.cookie } })).status).toBe(200);

    const id = await posted(bot.key, general, "Deploying...");
    const fromBanned = { "CF-Connecting-IP": "203.0.113.9" };
    const refused = await postAs(bot.key, general, "Hello!", fromBanned);
    expect([refused.status, await refused.text()]).toEqual([429, ""]);
    for (const [asked, response] of Object.entries(changesAs(bot.key, general, id, fromBanned))) expect([asked, (await response).status]).toEqual([asked, 429]);
    expect((await readAs(bot.key, general, "", { headers: fromBanned })).status).toBe(200);
    expect(await storedIn(general)).toMatchObject([{ id, body: "Deploying..." }]);
    expect(await boostsIn(general)).toEqual([]);
  });
});

describe("Bots post messages", () => {
  it("posts the request's body, whatever its type, as the bot's message, which reaches everyone in the room at once", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);

    const response = await postAs(bot.key, general, "Hello!");
    expect(response.status).toBe(201);
    const { message } = await inRoom.next("message.created");
    expect(message).toMatchObject({ roomId: general, creator: { id: bot.id, name: "Build Bot" }, body: "Hello!", plainText: "Hello!", mentions: [] });

    await postAs(bot.key, general, '{"status":"passed"}', { "Content-Type": "application/json" });
    expect((await inRoom.next("message.created")).message.plainText).toBe('{"status":"passed"}');
    await postAs(bot.key, general, "Deploy finished 🚀 ünïcödé", { "Content-Type": "text/plain; charset=utf-8" });
    expect((await inRoom.next("message.created")).message.plainText).toBe("Deploy finished 🚀 ünïcödé");
  });

  it("answers 201 with an empty body and the message's permalink, on the host it was asked at", async () => {
    const { bot, general } = await withBot();
    const response = await postAs(bot.key, general, "Hello!");
    const [stored] = await storedIn(general);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Location")).toBe(`${origin}/rooms/${general}/@${stored!.id}`);

    const elsewhere = await apiWith({}, `https://chat.example.org${botPath(general, bot.key)}`, { method: "POST", body: "Hello again" });
    expect(elsewhere.headers.get("Location")).toMatch(new RegExp(`^https://chat\\.example\\.org/rooms/${general}/@`));
  });

  it("replaces bytes that aren't UTF-8", async () => {
    const { bot, general } = await withBot();
    expect((await postAs(bot.key, general, new Uint8Array([0x48, 0x69, 0xff, 0x21]), { "Content-Type": "application/octet-stream" })).status).toBe(201);
    expect((await listedBy(bot.key, general))[0]!.body.plain_text).toBe("Hi\uFFFD!");
  });

  it("posts rich text: its formatting shows and its mentions mention people", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    const mention = `<action-text-attachment sgid="${mentionSgid(administrator.user.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;
    await postAs(bot.key, general, `<p><strong>Build 42</strong> passed, ${mention}</p>`);
    const { message } = await inRoom.next("message.created");
    expect(message.body).toContain("<strong>Build 42</strong>");
    expect(message.mentions).toEqual([administrator.user]);
    expect(message.plainText).toMatch(/^Build 42 passed, @Ada/);
  });

  it("counts as unread for the room's people and can be searched for, as anyone's message can", async () => {
    const { bot, general } = await withBot();
    const member = await joinAsGrace();
    const id = await posted(bot.key, general, "Nightly deploy finished");

    while ((await roomSql(general, "SELECT seq FROM room_events WHERE room_id = ?", general)).length > 0) await sleep(5);
    const unread = await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? AND unread_at IS NOT NULL", general);
    expect(unread).toContainEqual({ user_id: member.user.id });
    expect(unread).not.toContainEqual({ user_id: bot.id });

    while ((await roomSql(general, "SELECT seq FROM unindexed_messages WHERE room_id = ?", general)).length > 0) await sleep(5);
    const found = (await (await api("/api/searches?q=deploy", { headers: { Cookie: member.cookie } })).json()) as SearchResults;
    expect(found.matches.map(({ message }) => message.id)).toEqual([id]);
  });

  it("answers an empty 422 for a body that's empty or only spaces, posting nothing", async () => {
    const { bot, general } = await withBot();
    for (const body of [null, "", " \n\t "]) {
      const response = await postAs(bot.key, general, body);
      expect([JSON.stringify(body), response.status, await response.text()]).toEqual([JSON.stringify(body), 422, ""]);
    }
    expect(await storedIn(general)).toEqual([]);
  });

  it("refuses markup that shows nothing, or more text than a message can have, with 422 and why", async () => {
    const { bot, general } = await withBot();
    const empty = await postAs(bot.key, general, "<p> </p><p><br></p>");
    expect([empty.status, await empty.json()]).toEqual([422, { error: "Your message is empty." }]);
    const long = await postAs(bot.key, general, "x".repeat(MAX_MESSAGE_LENGTH + 1));
    expect([long.status, await long.json()]).toEqual([422, { error: MESSAGE_TOO_LONG }]);
    expect(await storedIn(general)).toEqual([]);
    expect((await postAs(bot.key, general, "x".repeat(MAX_MESSAGE_LENGTH))).status).toBe(201);
  });

  it("answers 413 to more markup than a message can arrive as, sent whole or in pieces", async () => {
    const { bot, general } = await withBot();
    const whole = await postAs(bot.key, general, "x".repeat(MAX_MESSAGE_HTML_LENGTH + 1));
    expect([whole.status, await whole.json()]).toEqual([413, { status: 413, error: "Content Too Large" }]);

    // Without a length, read only until it's too long.
    const piece = new TextEncoder().encode("x".repeat(MAX_MESSAGE_HTML_LENGTH));
    const pieces = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(piece);
        controller.close();
      },
    });
    expect((await postAs(bot.key, general, pieces)).status).toBe(413);
    expect(await storedIn(general)).toEqual([]);
  });

  it("posts nothing once the room has been deleted, which a post let through just before can find", async () => {
    const { administrator, bot, general } = await withBot();
    const room = await createRoom("Launch", { as: administrator });
    const letThrough = { bot: { id: bot.id, name: bot.name }, authorizedAt: Date.now() };
    expect((await api(`/api/rooms/${room.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
    await revocationsDelivered();
    expect(await roomStub(room.id).createBotMessage(room.id, letThrough, "Too late")).toBeNull();
    expect(await storedIn(room.id)).toEqual([]);
    expect((await postAs(bot.key, room.id, "Too late")).status).toBe(404);
    expect((await postAs(bot.key, general, "Still here")).status).toBe(201);
  });
});

describe("Bots read messages", () => {
  /** Posts `count` messages as the bot, numbered from 1, answering their ids in order. */
  async function postMany(key: string, room: RoomId, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 1; n <= count; n++) ids.push(await posted(key, room, `Message ${n}`));
    return ids;
  }

  it("answers the newest 40 messages, oldest first, with how many the room has and a Link to the older ones", async () => {
    const { bot, general } = await withBot();
    const ids = await postMany(bot.key, general, HISTORY_PAGE_SIZE + 5);

    const response = await readAs(bot.key, general);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("X-Total-Count")).toBe("45");
    expect(response.headers.get("Link")).toBe(`<${origin}/rooms/${general}/${bot.key}/messages?before=${ids[5]}>; rel="next"`);
    const page = (await response.json()) as ListedMessage[];
    expect(page.map(({ id }) => id)).toEqual(ids.slice(5));

    // The first page has nothing older, so no Link.
    const before = await readAs(bot.key, general, `?before=${ids[5]}`);
    expect(((await before.json()) as ListedMessage[]).map(({ id }) => id)).toEqual(ids.slice(0, 5));
    expect(before.headers.get("Link")).toBeNull();
    expect(before.headers.get("X-Total-Count")).toBe("45");
  });

  it("answers the 40 after ?after, with a Link to newer ones only while there are some", async () => {
    const { bot, general } = await withBot();
    const ids = await postMany(bot.key, general, HISTORY_PAGE_SIZE + 5);

    const after = await readAs(bot.key, general, `?after=${ids[0]}`);
    expect(((await after.json()) as ListedMessage[]).map(({ id }) => id)).toEqual(ids.slice(1, 41));
    expect(after.headers.get("Link")).toBe(`<${origin}/rooms/${general}/${bot.key}/messages?after=${ids[40]}>; rel="next"`);
    const last = await readAs(bot.key, general, `?after=${ids[40]}`);
    expect(((await last.json()) as ListedMessage[]).map(({ id }) => id)).toEqual(ids.slice(41));
    expect(last.headers.get("Link")).toBeNull();
  });

  it("reads before ?before when ?after is given too, with a Link after the page's last message", async () => {
    const { bot, general } = await withBot();
    const ids = await postMany(bot.key, general, 10);
    const both = await readAs(bot.key, general, `?after=${ids[0]}&before=${ids[5]}`);
    expect(((await both.json()) as ListedMessage[]).map(({ id }) => id)).toEqual(ids.slice(0, 5));
    expect(both.headers.get("Link")).toBe(`<${origin}/rooms/${general}/${bot.key}/messages?after=${ids[4]}>; rel="next"`);

    // A blank cursor is no cursor.
    const blank = await readAs(bot.key, general, "?before=&after=%20");
    expect(((await blank.json()) as ListedMessage[]).map(({ id }) => id)).toEqual(ids);
    expect(blank.headers.get("Link")).toBeNull();
  });

  it("answers 404 JSON for a cursor that isn't one of the room's messages", async () => {
    const { administrator, bot, general } = await withBot();
    const elsewhere = await createRoom("Elsewhere", { as: administrator });
    const theirs = await posted(bot.key, elsewhere.id, "Over here");
    await posted(bot.key, general, "Here");
    for (const query of [`?before=${theirs}`, `?after=${theirs}`, "?before=0nothing000000", "?after=x"]) {
      const response = await readAs(bot.key, general, query);
      expect([query, response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([
        query,
        404,
        "application/json; charset=UTF-8",
        '{"status":404,"error":"Not Found"}',
      ]);
    }
  });

  it("answers a thread for ?thread: its message, then its replies oldest first, and 404 for a reply or a stranger", async () => {
    const { bot, general } = await withBot();
    const parent = await posted(bot.key, general, "Question");
    const reply = async (body: string) => {
      const response = await api(botPath(general, bot.key, `?thread=${parent}`), { method: "POST", body, headers: FORM_TYPE });
      expect(response.status, await response.clone().text()).toBe(201);
      return response.headers.get("Location")!.split("/@")[1]!;
    };
    const first = await reply("Answer");
    const second = await reply("Follow-up");
    const after = await posted(bot.key, general, "Elsewhere");

    const thread = await readAs(bot.key, general, `?thread=${parent}`);
    expect(thread.status).toBe(200);
    expect(thread.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const messages = (await thread.json()) as ListedMessage[];
    expect(messages.map(({ id }) => id)).toEqual([parent, first, second]);
    expect(messages[2]!.url).toBe(`${origin}/rooms/${general}/threads/${parent}/@${second}`);

    // The room's timeline still leaves the replies out.
    expect(((await (await readAs(bot.key, general)).json()) as ListedMessage[]).map(({ id }) => id)).toEqual([parent, after]);
    for (const query of [`?thread=${first}`, "?thread=0nothing000000"]) {
      expect([query, (await readAs(bot.key, general, query)).status]).toEqual([query, 404]);
    }
  });

  it("answers [] for a room without messages, with a count of 0 and no Link", async () => {
    const { bot, general } = await withBot();
    const response = await readAs(bot.key, general);
    expect([response.status, await response.text()]).toEqual([200, "[]"]);
    expect(response.headers.get("X-Total-Count")).toBe("0");
    expect(response.headers.get("Link")).toBeNull();
  });

  it("writes each message as Campfire's JSON does, in its order, with its writer as they are now and absolute addresses", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    inRoom.send({ type: "message.create", clientMessageId: "ada-1", body: "<p>Ship it &amp; <em>tell</em> me</p>" });
    const { message: adas } = await inRoom.next("message.created");
    await posted(bot.key, general, "Shipped 🚀");
    await api(`/api/account/bots/${bot.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name: "Deploy Bot" }) });

    const response = await readAs(bot.key, general);
    const text = await response.text();
    const [first, second] = JSON.parse(text) as ListedMessage[];
    expect(Object.keys(first!)).toEqual(["id", "created_at", "body", "creator", "room", "url"]);
    expect(Object.keys(first!.creator)).toEqual(["id", "name", "role", "avatar_url"]);
    expect(first).toEqual({
      id: adas.id,
      created_at: adas.createdAt,
      body: { plain_text: "Ship it & tell me", html: `<div class="lexxy-content">\n  ${adas.body}\n</div>\n` },
      creator: { id: administrator.user.id, name: "Ada Lovelace", role: "administrator", avatar_url: `${origin}${await avatarOf(administrator, administrator.user.id)}` },
      room: { id: general },
      url: `${origin}/rooms/${general}/@${adas.id}`,
    });
    expect(first!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(second).toMatchObject({ body: { plain_text: "Shipped 🚀" }, creator: { id: bot.id, name: "Deploy Bot", role: "bot", avatar_url: `${origin}${await avatarOf(administrator, bot.id)}` } });

    // `<`, `>` and `&` are escaped, as Rails escapes them, and emoji written as they are.
    expect(text).not.toMatch(/[<>&]/);
    expect(text).toContain("\\u003cdiv class=\\\"lexxy-content\\\"\\u003e");
    expect(text).toContain("Ship it \\u0026 tell me");
    expect(text).toContain("Shipped 🚀");
  });

  it("writes a file message with its file's name as its plain text and no HTML, as Campfire writes a message without rich text", async () => {
    const { administrator, bot, general } = await withBot();
    const message = await upload(administrator, general, "moon.jpg", recordedImage("moon-thumb.jpg"));
    expect(await listedBy(bot.key, general)).toMatchObject([{ id: message.id, body: { plain_text: "moon.jpg", html: "" } }]);
  });

  it("writes a file message's file after its body, at an address that opens it without a session or the bot's key, and nothing for a message without one", async () => {
    const { administrator, bot, general } = await withBot();
    const text = await posted(bot.key, general, "Here's the moon");
    const message = await upload(administrator, general, "moon.jpg", recordedImage("moon-thumb.jpg"));

    const response = await readAs(bot.key, general);
    const body = await response.clone().text();
    const [first, second] = (await response.json()) as ListedMessage[];
    expect(first!.id).toBe(text);
    expect(first).not.toHaveProperty("attachment");
    expect(second).toMatchObject({
      id: message.id,
      attachment: { filename: "moon.jpg", content_type: "image/jpeg", byte_size: message.attachment.byteSize, url: `${origin}${message.attachment.url}` },
    });
    expect(Object.keys(second!)).toEqual(["id", "created_at", "body", "attachment", "creator", "room", "url"]);
    expect(second!.attachment!.url).not.toContain(bot.key);
    expect(body).not.toContain(bot.key);

    const file = await apiWith({}, second!.attachment!.url);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(recordedImage("moon-thumb.jpg"));

    // A bot reads no file in a room it isn't in, as it reads nothing there.
    const secrets = await createRoom("Secrets", { closedTo: [administrator.user.id], as: administrator });
    await upload(administrator, secrets.id, "plans.jpg", recordedImage("moon-thumb.jpg"));
    const refused = await readAs(bot.key, secrets.id);
    expect([refused.status, await refused.text()]).toEqual([404, ""]);
  });

  it("gives addresses on the host each request came to", async () => {
    const { bot, general } = await withBot();
    await postMany(bot.key, general, HISTORY_PAGE_SIZE + 1);
    const response = await apiWith({}, `https://chat.example.org${botPath(general, bot.key)}`);
    const [message] = (await response.json()) as ListedMessage[];
    expect(message!.url).toMatch(/^https:\/\/chat\.example\.org\/rooms\//);
    expect(message!.creator.avatar_url).toMatch(/^https:\/\/chat\.example\.org\/users\//);
    expect(response.headers.get("Link")).toMatch(/^<https:\/\/chat\.example\.org\/rooms\//);
  });

  it("answers HEAD with the same headers and no body, and 304 to a copy that's current", async () => {
    const { bot, general } = await withBot();
    await postMany(bot.key, general, HISTORY_PAGE_SIZE + 1);
    const got = await readAs(bot.key, general);
    const etag = got.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(got.headers.get("Cache-Control")).toBe("max-age=0, private, must-revalidate");

    const head = await readAs(bot.key, general, "", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const name of ["Content-Type", "X-Total-Count", "Link", "ETag", "Cache-Control"]) expect([name, head.headers.get(name)]).toEqual([name, got.headers.get(name)]);

    const current = await readAs(bot.key, general, "", { headers: { "If-None-Match": etag } });
    expect([current.status, await current.text()]).toEqual([304, ""]);
    expect(current.headers.get("X-Total-Count")).toBe("41");
    expect(current.headers.get("Link")).toBe(got.headers.get("Link"));

    await posted(bot.key, general, "One more");
    expect((await readAs(bot.key, general, "", { headers: { "If-None-Match": etag } })).status).toBe(200);
  });

  it("counts a room's messages from an index, as it reads every one", async () => {
    const { bot, general } = await withBot();
    await posted(bot.key, general, "Hello!");
    const plan = (await roomSql(general, `EXPLAIN QUERY PLAN ${COUNT_MESSAGES}`, general)).map((row) => (row as { detail: string }).detail).join("; ");
    expect(plan).toBe("SEARCH messages USING COVERING INDEX index_messages_on_room_id_and_in_room_and_id (room_id=? AND in_room=?)");
  });
});

describe("Bots edit and delete their messages", () => {
  it("replaces the text of the bot's own message, with PATCH or PUT, live, answering 200 with the message as the list has it", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    const id = await posted(bot.key, general, "Deploying...");
    await inRoom.next("message.created");

    const response = await editAs(bot.key, general, id, "Deployed.");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(response.headers.get("Cache-Control")).toBe("max-age=0, private, must-revalidate");
    const edited = (await response.json()) as ListedMessage;
    expect(edited).toEqual((await listedBy(bot.key, general))[0]);
    expect(edited).toMatchObject({ id, body: { plain_text: "Deployed." }, creator: { id: bot.id, role: "bot" }, url: `${origin}/rooms/${general}/@${id}` });
    const { message } = await inRoom.next("message.updated");
    expect(message).toMatchObject({ id, plainText: "Deployed.", creator: { id: bot.id } });
    expect(message.editedAt).not.toBeNull();

    const put = await editAs(bot.key, general, id, "Deployed 🚀 & <em>done</em>", "PUT");
    const text = await put.text();
    expect(JSON.parse(text)).toMatchObject({ body: { plain_text: "Deployed 🚀 & done" } });
    expect(text).not.toMatch(/[<>&]/);
    expect((await inRoom.next("message.updated")).message.plainText).toBe("Deployed 🚀 & done");

    const json = await api(messagePath(general, bot.key, id, ".json"), { method: "PATCH", body: "Shipped." });
    expect([json.status, ((await json.json()) as ListedMessage).body.plain_text]).toEqual([200, "Shipped."]);
  });

  it("leaves a message saved as it was as it was, its update time included", async () => {
    const { administrator, bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deploying...");
    const inRoom = await connect(general, administrator);
    expect((await editAs(bot.key, general, id, "Deploying...")).status).toBe(200);
    await settle(inRoom);
    expect(inRoom.pending("message.updated")).toEqual([]);
    expect(await roomSql(general, "SELECT edited_at, updated_at = created_at AS untouched FROM messages WHERE id = ?", id)).toEqual([{ edited_at: null, untouched: 1 }]);
  });

  it("answers 403 to someone else's message, cookie or not, and 404 JSON to one outside the room, changing nothing", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    const adas = await post(inRoom, "Ada's plan");
    const elsewhere = await createRoom("Elsewhere", { as: administrator });
    const outside = await posted(bot.key, elsewhere.id, "Over here");

    // Ada is an administrator, but the request acts as the bot, which isn't.
    for (const headers of [{}, { Cookie: administrator.cookie }] as Array<Record<string, string>>) {
      for (const response of [await editAs(bot.key, general, adas.id, "Hijacked!", "PATCH", headers), await deleteAs(bot.key, general, adas.id, headers)]) {
        expect([response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([403, "text/html", ""]);
      }
    }
    for (const id of [outside, "0nothing000000"]) {
      for (const response of [await editAs(bot.key, general, id, "Hijacked!"), await deleteAs(bot.key, general, id)]) {
        expect([id, response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([
          id,
          404,
          "application/json; charset=UTF-8",
          '{"status":404,"error":"Not Found"}',
        ]);
      }
    }
    expect(await storedIn(general)).toMatchObject([{ id: adas.id, body: "Ada's plan" }]);
    expect(await storedIn(elsewhere.id)).toMatchObject([{ id: outside, body: "Over here" }]);
  });

  it("checks the key again once an edit's body has arrived, as it does a post's", async () => {
    const { administrator, bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deploying...");
    const edit = await editAs(bot.key, general, id, heldBack("Deployed.", () => newKeyFor(administrator, bot)));
    expect([edit.status, await edit.json()]).toEqual([401, { error: "Unknown bot key" }]);
    expect(await storedIn(general)).toMatchObject([{ id, body: "Deploying..." }]);
  });

  it("refuses text that shows nothing, or too much, with 422 and why", async () => {
    const { bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deploying...");
    for (const body of [null, "", " \n ", "<p> </p>"]) {
      const response = await editAs(bot.key, general, id, body);
      expect([JSON.stringify(body), response.status, await response.json()]).toEqual([JSON.stringify(body), 422, { error: "Your message is empty." }]);
    }
    const long = await editAs(bot.key, general, id, "x".repeat(MAX_MESSAGE_LENGTH + 1));
    expect([long.status, await long.json()]).toEqual([422, { error: MESSAGE_TOO_LONG }]);
    const tooMuch = await editAs(bot.key, general, id, "x".repeat(MAX_MESSAGE_HTML_LENGTH + 1));
    expect([tooMuch.status, await tooMuch.json()]).toEqual([413, { status: 413, error: "Content Too Large" }]);
    expect(await storedIn(general)).toMatchObject([{ id, body: "Deploying..." }]);
  });

  it("deletes the bot's own message, with its boosts, live, answering 204", async () => {
    const { administrator, bot, general } = await withBot();
    const kept = await posted(bot.key, general, "Deployed.");
    const id = await posted(bot.key, general, "Deploying...");
    const inRoom = await connect(general, administrator);
    inRoom.send({ type: "boost.create", messageId: id, content: "👀" });
    await inRoom.next("boost.created");
    expect((await boostAs(bot.key, general, id, "🚀")).status).toBe(201);
    await inRoom.next("boost.created");

    const response = await deleteAs(bot.key, general, id);
    expect([response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([204, null, ""]);
    expect((await inRoom.next("message.deleted")).messageId).toBe(id);
    expect((await storedIn(general)).map((message) => message.id)).toEqual([kept]);
    expect(await boostsIn(general)).toEqual([]);

    const again = await api(messagePath(general, bot.key, id, ".json"), { method: "DELETE" });
    expect([again.status, await again.json()]).toEqual([404, { status: 404, error: "Not Found" }]);
  });

  it("has search find an edited message by its new text, and a deleted one no more", async () => {
    const { bot, general } = await withBot();
    const member = await joinAsGrace();
    const id = await posted(bot.key, general, "Nightly deploy started");
    const searched = async (query: string) => {
      while ((await roomSql(general, "SELECT seq FROM unindexed_messages WHERE room_id = ?", general)).length > 0) await sleep(5);
      const found = (await (await api(`/api/searches?q=${query}`, { headers: { Cookie: member.cookie } })).json()) as SearchResults;
      return found.matches.map(({ message }) => message.id);
    };

    expect((await editAs(bot.key, general, id, "Nightly rollback started")).status).toBe(200);
    expect(await searched("rollback")).toEqual([id]);
    expect(await searched("deploy")).toEqual([]);
    expect((await deleteAs(bot.key, general, id)).status).toBe(204);
    expect(await searched("rollback")).toEqual([]);
  });
});

describe("Bots boost messages", () => {
  /** A boost as the bot API answers it, parsed. */
  interface BoostAnswer {
    id: string;
    content: string;
    created_at: string;
    booster: { id: string; name: string; role: string; avatar_url: string };
    message: { id: string; url: string };
  }

  it("boosts a message in the room with the request's body, live, answering 201 with the boost", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    const adas = await post(inRoom, "Ship it?");

    const response = await boostAs(bot.key, general, adas.id, "👀");
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(response.headers.get("Cache-Control")).toBe("max-age=0, private, must-revalidate");
    const answered = (await response.json()) as BoostAnswer;
    expect(Object.keys(answered)).toEqual(["id", "content", "created_at", "booster", "message"]);
    expect(Object.keys(answered.booster)).toEqual(["id", "name", "role", "avatar_url"]);
    const [stored] = await boostsIn(general);
    expect(answered).toEqual({
      id: stored!.id,
      content: "👀",
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      booster: { id: bot.id, name: "Build Bot", role: "bot", avatar_url: `${origin}${await avatarOf(administrator, bot.id)}` },
      message: { id: adas.id, url: `${origin}/rooms/${general}/@${adas.id}` },
    });
    const { boost } = await inRoom.next("boost.created");
    expect(boost).toEqual({ id: stored!.id, messageId: adas.id, booster: { id: bot.id, name: "Build Bot" }, content: "👀", createdAt: answered.created_at });

    const text = await boostAs(bot.key, general, adas.id, "<&> ok");
    const raw = await text.text();
    expect(JSON.parse(raw)).toMatchObject({ content: "<&> ok" });
    expect(raw).toContain('"content":"\\u003c\\u0026\\u003e ok"');
    const json = await api(messagePath(general, bot.key, adas.id, "/boosts.json"), { method: "POST", body: "Nice!" });
    expect([json.status, ((await json.json()) as BoostAnswer).content]).toEqual([201, "Nice!"]);
  });

  it("boosts any message in the room, its own included, and adds the same boost again", async () => {
    const { bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deployed.");
    const first = (await (await boostAs(bot.key, general, id, "🎉")).json()) as BoostAnswer;
    const second = (await (await boostAs(bot.key, general, id, "🎉")).json()) as BoostAnswer;
    expect(second.id).not.toBe(first.id);
    expect(await boostsIn(general)).toEqual([
      { id: first.id, message_id: id, booster_id: bot.id, content: "🎉" },
      { id: second.id, message_id: id, booster_id: bot.id, content: "🎉" },
    ]);
  });

  it(`trims a boost, and refuses one with more than ${MAX_BOOST_LENGTH} characters with 422 and why`, async () => {
    const { bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deployed.");
    expect(((await (await boostAs(bot.key, general, id, "  🎉\n")).json()) as BoostAnswer).content).toBe("🎉");
    const long = await boostAs(bot.key, general, id, "x".repeat(MAX_BOOST_LENGTH + 1));
    expect([long.status, await long.json()]).toEqual([422, { error: `Boosts can be up to ${MAX_BOOST_LENGTH} characters.` }]);
    expect((await boostAs(bot.key, general, id, ` ${"x".repeat(MAX_BOOST_LENGTH)} `)).status).toBe(201);
    expect((await boostsIn(general)).map(({ content }) => content)).toEqual(["🎉", "x".repeat(MAX_BOOST_LENGTH)]);
  });

  it("answers an empty 404 for a message outside the room, before an empty 422 for a blank boost", async () => {
    const { administrator, bot, general } = await withBot();
    const elsewhere = await createRoom("Elsewhere", { as: administrator });
    const outside = await posted(bot.key, elsewhere.id, "Over here");
    const id = await posted(bot.key, general, "Deployed.");
    for (const [message, content] of [[outside, "👀"], [outside, ""], ["0nothing000000", " "]] as const) {
      const response = await boostAs(bot.key, general, message, content);
      expect([message, response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([message, 404, "text/html", ""]);
    }
    for (const content of [null, "", " \n\t "]) {
      const response = await boostAs(bot.key, general, id, content);
      expect([JSON.stringify(content), response.status, await response.text()]).toEqual([JSON.stringify(content), 422, ""]);
    }
    expect(await boostsIn(general)).toEqual([]);
    expect(await boostsIn(elsewhere.id)).toEqual([]);
  });

  it("checks the key again once a boost's body has arrived, as it does a post's", async () => {
    const { administrator, bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deployed.");
    const boost = await boostAs(bot.key, general, id, heldBack("🎉", () => newKeyFor(administrator, bot)));
    expect([boost.status, await boost.json()]).toEqual([401, { error: "Unknown bot key" }]);
    expect(await boostsIn(general)).toEqual([]);
  });

  it("removes the bot's own boost on the message, live, answering 204", async () => {
    const { administrator, bot, general } = await withBot();
    const id = await posted(bot.key, general, "Deployed.");
    const { id: boostId } = (await (await boostAs(bot.key, general, id, "🎉")).json()) as BoostAnswer;
    const inRoom = await connect(general, administrator);

    const response = await unboostAs(bot.key, general, id, boostId);
    expect([response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([204, null, ""]);
    expect(await inRoom.next("boost.deleted")).toMatchObject({ boostId, messageId: id });
    expect(await boostsIn(general)).toEqual([]);

    const again = await unboostAs(bot.key, general, id, boostId);
    expect([again.status, await again.text()]).toEqual([404, ""]);
  });

  it("answers an empty 404 to removing someone else's boost, or its own on another message, removing nothing", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    const adas = await post(inRoom, "Ship it?");
    inRoom.send({ type: "boost.create", messageId: adas.id, content: "👍" });
    const { boost: adasBoost } = await inRoom.next("boost.created");
    const other = await posted(bot.key, general, "Deployed.");
    const { id: botsBoost } = (await (await boostAs(bot.key, general, adas.id, "🎉")).json()) as BoostAnswer;

    for (const [message, boostId] of [[adas.id, adasBoost.id], [other, botsBoost], [adas.id, "0noboost000000"]]) {
      const response = await unboostAs(bot.key, general, message!, boostId!);
      expect([boostId, response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([boostId, 404, "text/html", ""]);
    }
    expect((await boostsIn(general)).map(({ id }) => id)).toEqual([adasBoost.id, botsBoost]);
  });
});

describe("Bot keys in logs", () => {
  it("filters bot keys out of addresses, as Campfire's log does, and leaves other addresses alone", () => {
    expect(withoutBotKeys("POST /rooms/0mgk3x2a9b4c5a/0mgk3x2a9b4c5e-Ab3xK9mQz1Rt/messages")).toBe("POST /rooms/0mgk3x2a9b4c5a/[FILTERED]/messages");
    expect(withoutBotKeys('Link: <https://ember.example/rooms/42/7-Zt9QmK1xz3Ab/messages?before=99>; rel="next"')).toBe(
      'Link: <https://ember.example/rooms/42/[FILTERED]/messages?before=99>; rel="next"',
    );
    const twice = withoutBotKeys("/rooms/1/5-Ab3xK9mQz1Rt/messages and /rooms/2/6-Cd4yL0nR2St7/messages.json");
    expect(twice).toBe("/rooms/1/[FILTERED]/messages and /rooms/2/[FILTERED]/messages.json");
    expect(withoutBotKeys("DELETE /rooms/1/5-Ab3xK9mQz1Rt/messages/9/boosts/11")).toBe("DELETE /rooms/1/[FILTERED]/messages/9/boosts/11");
    for (const path of ["/rooms/1", "/rooms/1/@5", "/api/rooms/1/socket", "/rooms/1/messages"]) expect(withoutBotKeys(path)).toBe(path);
  });

  it("logs a bot request that fails with its key filtered out, answering 500 JSON", async () => {
    const { bot, general } = await withBot();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { getByName: () => ({ botInRoom: () => Promise.reject(new Error("Workspace unavailable")) }) } as unknown as Env["WORKSPACE"];
    const response = await apiWith({ WORKSPACE: broken }, botPath(general, bot.key), { method: "POST", body: "Hello!" });
    expect([response.status, response.headers.get("Content-Type"), await response.text()]).toEqual([
      500,
      "application/json; charset=UTF-8",
      '{"status":500,"error":"Internal Server Error"}',
    ]);
    expect(errors).toHaveBeenCalledWith(`POST /rooms/${general}/[FILTERED]/messages failed:`, expect.any(Error));
    expect(JSON.stringify(errors.mock.calls)).not.toContain(tokenOf(bot));
  });
});

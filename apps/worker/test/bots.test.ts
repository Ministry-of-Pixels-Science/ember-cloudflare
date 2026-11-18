import type {
  BotAnswer,
  BotRoom,
  Bots,
  BotSettings,
  DirectRoom,
  Directory,
  DirectoryUser,
  Me,
  NewRoomForm,
  NewWorkspace,
  PersonAnswer,
  RoomChanges,
  RoomId,
  RoomSettings,
  UserId,
} from "@ember/protocol";
import { BOT_ROOMS_REFUSED, botMessagesPath, WEBHOOK_URL_REFUSED } from "@ember/protocol/bots";
import { beforeEach, describe, expect, it } from "vitest";
import notFoundPage from "../../web/public/404.html";
import { DEFAULT_BOT_AVATAR } from "../src/default-bot-avatar";
import { api, apiWith, builtPages, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, shown, startDirect, workspaceSql, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

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

const signedInAs = (session: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});
const asJson = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));

const listBots = (session: Session | null) => api("/api/account/bots", { headers: signedInAs(session) });
const addBot = (session: Session | null, body: unknown) => api("/api/account/bots", { method: "POST", headers: signedInAs(session), body: asJson(body) });
const showBot = (session: Session | null, id: UserId) => api(`/api/account/bots/${id}`, { headers: signedInAs(session) });
const changeBot = (session: Session | null, id: UserId, body: unknown) =>
  api(`/api/account/bots/${id}`, { method: "PATCH", headers: signedInAs(session), body: asJson(body) });
const deleteBot = (session: Session | null, id: UserId) => api(`/api/account/bots/${id}`, { method: "DELETE", headers: signedInAs(session) });
const resetKey = (session: Session | null, id: UserId) => api(`/api/account/bots/${id}/key`, { method: "PUT", headers: signedInAs(session) });
/** A page at `path`, from a Worker whose built app answers each path with its own name. */
const page = (session: Session | null, path: string) => apiWith({ ASSETS: builtPages }, path, { headers: signedInAs(session), redirect: "manual" });

/** The bot an answer gives, once it's checked to have succeeded with `status`. */
async function botOf(response: Response, status = 200): Promise<BotSettings> {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as BotAnswer).bot;
}

/** Adds a bot as `administrator`, answering it as its edit page shows it. */
const added = async (administrator: Session, body: { name: string; webhookUrl?: string; rooms?: RoomId[] | null }) => botOf(await addBot(administrator, body), 201);

/** The active bots, as the bots page lists them to `administrator`. */
async function listed(administrator: Session): Promise<Bots["bots"]> {
  const response = await listBots(administrator);
  expect(response.status).toBe(200);
  return ((await response.json()) as Bots).bots;
}

/** Someone as the people directory lists them, as `viewer` sees it. */
async function inDirectory(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

const stored = async (id: UserId) =>
  ((await workspaceSql("SELECT name, role, status, bot_token, updated_at FROM users WHERE id = ?", id)) as Array<{
    name: string;
    role: number;
    status: number;
    bot_token: string | null;
    updated_at: string;
  }>)[0]!;

const webhookOf = async (id: UserId) =>
  ((await workspaceSql("SELECT url, updated_at FROM webhooks WHERE user_id = ?", id)) as Array<{ url: string; updated_at: string }>)[0] ?? null;

const roomIdsOf = async (userId: UserId) =>
  ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", userId)) as Array<{ room_id: string }>).map(({ room_id }) => room_id);

/** First run's rooms, general then random. */
const firstRooms = async () => (await workspaceSql("SELECT id, name FROM rooms WHERE kind = 'open' ORDER BY name")) as BotRoom[];

/** Starts a DM between `administrator` and a bot, answering it. */
async function directWith(administrator: Session, bot: BotSettings): Promise<DirectRoom> {
  const response = await startDirect(administrator, [bot.id]);
  expect(response.status).toBe(201);
  return ((await response.json()) as { room: DirectRoom }).room;
}

/** A bot as the bots page lists it, in `rooms`. */
const listedAs = ({ webhookUrl: _, pickedRooms: __, ...bot }: BotSettings, rooms: BotRoom[]) => ({ ...bot, rooms });

/** Posts `text` to room `roomId` as the bot whose key is `key`, as curl does. */
const postAs = (key: string, roomId: RoomId, text: string) =>
  api(botMessagesPath(roomId, key), { method: "POST", body: text, headers: { "Content-Type": "application/x-www-form-urlencoded" } });

const tokenOf = (bot: BotSettings) => bot.key.slice(bot.id.length + 1);

/** What `session` is answered for `path`, once it's checked to have succeeded. */
async function answered<T>(session: Session, path: string): Promise<T> {
  const response = await api(path, { headers: signedInAs(session) });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

const changeRoom = (session: Session, roomId: RoomId, changes: RoomChanges) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: signedInAs(session), body: JSON.stringify(changes) });

/** The rooms someone is in, by id, each with how much it notifies them. */
const involvementsOf = async (userId: UserId) =>
  Object.fromEntries(
    ((await workspaceSql("SELECT room_id, involvement FROM memberships WHERE user_id = ?", userId)) as Array<{ room_id: string; involvement: string }>).map(
      ({ room_id, involvement }) => [room_id, involvement],
    ),
  );

/** The names of the people the @-mention prompt offers `viewer` in room `roomId` for `filter`, in order. */
async function mentionable(viewer: Session, roomId: RoomId, filter: string): Promise<string[]> {
  const response = await api(`/api/autocompletable/users?room_id=${roomId}&filter=${filter}`, { headers: signedInAs(viewer) });
  expect(response.status, await response.clone().text()).toBe(200);
  return [...(await response.text()).matchAll(/<lexxy-prompt-item search="([^"]*)"/g)].map((match) => match[1]!);
}

beforeEach(freshDeploy);

describe("Add and edit a bot", () => {
  it("adds a bot with a key of its id and 12 random letters and digits, in every open room, answering it as its edit page shows it", async () => {
    const administrator = await setUp();
    const [general, random] = await firstRooms();
    await createRoom("Secrets", { closedTo: [administrator.user.id], as: administrator });

    const bot = await added(administrator, { name: "Build Bot", webhookUrl: "https://ci.example.com/hooks/ember" });
    expect(bot).toEqual({
      id: expect.any(String),
      name: "Build Bot",
      bio: null,
      role: "bot",
      status: "active",
      avatarUrl: expect.stringMatching(/^\/users\/[^/]+\/avatar\?v=\d{14}$/),
      key: expect.any(String),
      rooms: [general, random],
      webhookUrl: "https://ci.example.com/hooks/ember",
      pickedRooms: null,
    });
    expect(bot.key).toMatch(new RegExp(`^${bot.id}-[A-Za-z0-9]{12}$`));
    expect(await stored(bot.id)).toMatchObject({ name: "Build Bot", role: 2, status: 0, bot_token: tokenOf(bot) });
    expect(await webhookOf(bot.id)).toMatchObject({ url: "https://ci.example.com/hooks/ember" });
    expect(await inDirectory(administrator, bot.id)).toEqual({ id: bot.id, name: "Build Bot", bio: null, role: "bot", status: "active", avatarUrl: bot.avatarUrl });
    expect(await showBot(administrator, bot.id).then(botOf)).toEqual(bot);

    // Open rooms made later take it in, as they do everyone active.
    const later = await createRoom("Later", { as: administrator });
    expect((await showBot(administrator, bot.id).then(botOf)).rooms).toEqual([general, { id: later.id, name: "Later" }, random]);
  });

  it("keeps a bot to the open rooms picked, which open rooms made or opened later leave it out of, and its key with it", async () => {
    const administrator = await setUp();
    const [general] = await firstRooms();
    const support = await createRoom("Support", { as: administrator });
    const leads = await createRoom("Leads", { closedTo: [administrator.user.id], as: administrator });

    // A private room can't be picked, so it isn't joined.
    const bot = await added(administrator, { name: "Build Bot", rooms: [support.id, leads.id] });
    const picked = [{ id: support.id, name: "Support" }];
    expect(bot).toMatchObject({ rooms: picked, pickedRooms: picked });
    expect(await roomIdsOf(bot.id)).toEqual([support.id]);
    expect((await postAs(bot.key, support.id, "Deployed")).status).toBe(201);
    expect((await postAs(bot.key, general!.id, "Deployed")).status).toBe(404);

    const later = await createRoom("Later", { as: administrator });
    expect((await changeRoom(administrator, leads.id, { kind: "open" })).status).toBe(200);
    expect(await roomIdsOf(bot.id)).toEqual([support.id]);
    expect((await postAs(bot.key, later.id, "Deployed")).status).toBe(404);
    // One in every open room joins them, as before.
    const everywhere = await added(administrator, { name: "Deploy Bot", rooms: null });
    expect(everywhere.pickedRooms).toBeNull();
    expect((await listed(administrator)).map(({ name, rooms }) => [name, rooms.map(({ name }) => name)])).toEqual([
      ["Build Bot", ["Support"]],
      ["Deploy Bot", ["general", "Later", "Leads", "random", "Support"]],
    ]);
  });

  it("moves a bot between every open room and the ones picked, keeping the private rooms it was put in", async () => {
    const administrator = await setUp();
    const [general, random] = await firstRooms();
    const support = await createRoom("Support", { as: administrator });
    const bot = await added(administrator, { name: "Build Bot" });
    const leads = await createRoom("Leads", { closedTo: [administrator.user.id, bot.id], as: administrator });
    const inLeads = { id: leads.id, name: "Leads" };

    const kept = await botOf(await changeBot(administrator, bot.id, { rooms: [support.id] }));
    expect(kept).toMatchObject({ rooms: [inLeads, { id: support.id, name: "Support" }], pickedRooms: [{ id: support.id, name: "Support" }] });
    expect((await postAs(bot.key, general!.id, "Deployed")).status).toBe(404);
    const later = await createRoom("Later", { as: administrator });
    expect(await roomIdsOf(bot.id)).not.toContain(later.id);

    // None at all keeps it to its private rooms and DMs.
    expect(await botOf(await changeBot(administrator, bot.id, { rooms: [] }))).toMatchObject({ rooms: [inLeads], pickedRooms: [] });

    const everywhere = await botOf(await changeBot(administrator, bot.id, { rooms: null }));
    expect(everywhere).toMatchObject({ pickedRooms: null, rooms: [general, { id: later.id, name: "Later" }, inLeads, random, { id: support.id, name: "Support" }] });
    const latest = await createRoom("Latest", { as: administrator });
    expect(await roomIdsOf(bot.id)).toContain(latest.id);
  });

  it("refuses rooms that aren't a list of rooms' IDs, each once, saving nothing", async () => {
    const administrator = await setUp();
    const [general] = await firstRooms();
    for (const rooms of [general!.id, [general!.id, general!.id], ["Launch!"]]) {
      const refused = await addBot(administrator, { name: "Build Bot", rooms });
      expect([refused.status, await refused.json()]).toEqual([422, { error: BOT_ROOMS_REFUSED }]);
    }
    expect(await listed(administrator)).toEqual([]);
    const bot = await added(administrator, { name: "Build Bot" });
    const refused = await changeBot(administrator, bot.id, { name: "Deploy Bot", rooms: "everywhere" });
    expect([refused.status, await refused.json()]).toEqual([422, { error: BOT_ROOMS_REFUSED }]);
    expect(await showBot(administrator, bot.id).then(botOf)).toEqual(bot);
  });

  it("gives every bot a token of its own", async () => {
    const administrator = await setUp();
    const tokens = new Set<string>();
    for (const name of ["One", "Two", "Three"]) tokens.add(tokenOf(await added(administrator, { name })));
    expect(tokens.size).toBe(3);
  });

  it("gives a bot no webhook without a URL, and trims the URL it's given", async () => {
    const administrator = await setUp();
    const withoutUrl = await added(administrator, { name: "Quiet Bot" });
    const withBlankUrl = await added(administrator, { name: "Blank Bot", webhookUrl: "  " });
    expect([withoutUrl.webhookUrl, withBlankUrl.webhookUrl]).toEqual([null, null]);
    expect([await webhookOf(withoutUrl.id), await webhookOf(withBlankUrl.id)]).toEqual([null, null]);

    const padded = await added(administrator, { name: "Padded Bot", webhookUrl: " https://example.com/hook\n" });
    expect(padded.webhookUrl).toBe("https://example.com/hook");
  });

  it("takes an http webhook URL only on localhost, as a bot run beside `wrangler dev` has", async () => {
    const administrator = await setUp();
    const local = ["http://localhost:4567/hook", "http://bots.localhost/hook", "http://127.0.0.1:4567/hook", "http://127.1.2.3/hook", "http://[::1]:4567/hook"];
    for (const [n, webhookUrl] of local.entries()) expect((await added(administrator, { name: `Local Bot ${n}`, webhookUrl })).webhookUrl).toBe(webhookUrl);
  });

  it("changes a bot's webhook first, then its name: a URL adds or replaces the webhook, a blank one removes it, and what's left out stays", async () => {
    const administrator = await setUp();
    const bot = await added(administrator, { name: "Build Bot" });

    expect(await changeBot(administrator, bot.id, { webhookUrl: "https://example.com/one" }).then(botOf)).toEqual({ ...bot, webhookUrl: "https://example.com/one" });
    const renamed = await changeBot(administrator, bot.id, { name: "Deploy Bot" }).then(botOf);
    expect(renamed).toEqual({ ...bot, name: "Deploy Bot", avatarUrl: expect.any(String), webhookUrl: "https://example.com/one" });
    expect(await stored(bot.id)).toMatchObject({ name: "Deploy Bot", bot_token: tokenOf(bot) });

    expect(await changeBot(administrator, bot.id, { name: "Deploy Bot", webhookUrl: "https://example.com/two" }).then(botOf)).toMatchObject({
      name: "Deploy Bot",
      webhookUrl: "https://example.com/two",
    });
    expect(await changeBot(administrator, bot.id, { webhookUrl: " " }).then(botOf)).toMatchObject({ name: "Deploy Bot", webhookUrl: null });
    expect(await webhookOf(bot.id)).toBeNull();
    expect(await changeBot(administrator, bot.id, {}).then(botOf)).toEqual(await showBot(administrator, bot.id).then(botOf));
  });

  it("writes only what changes", async () => {
    const administrator = await setUp();
    const bot = await added(administrator, { name: "Build Bot", webhookUrl: "https://example.com/hook" });
    await workspaceSql("UPDATE users SET updated_at = 'before' WHERE id = ?", bot.id);
    await workspaceSql("UPDATE webhooks SET updated_at = 'before' WHERE user_id = ?", bot.id);

    await changeBot(administrator, bot.id, { name: "Build Bot", webhookUrl: "https://example.com/hook" }).then(botOf);
    expect((await stored(bot.id)).updated_at).toBe("before");
    expect((await webhookOf(bot.id))!.updated_at).toBe("before");

    await changeBot(administrator, bot.id, { name: "Build Bot", webhookUrl: "https://example.com/elsewhere" }).then(botOf);
    expect((await stored(bot.id)).updated_at).toBe("before");
    expect((await webhookOf(bot.id))!.updated_at).not.toBe("before");
  });

  it("tells everyone's workspace sockets of a new bot, as the people directory lists it, without its key", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const workspace = await openWorkspaceSocket(member);

    const bot = await added(administrator, { name: "Build Bot" });
    expect(await workspace.next()).toEqual({ type: "user.updated", user: await inDirectory(member, bot.id) });
  });

  it("tells everyone's workspace sockets of a new name, as for anyone, without the bot's key", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot" });
    const workspace = await openWorkspaceSocket(member);

    await changeBot(administrator, bot.id, { webhookUrl: "https://example.com/hook" }).then(botOf);
    expect(await workspace.answers()).toBe(true);

    const renamed = await changeBot(administrator, bot.id, { name: "Deploy Bot" }).then(botOf);
    expect(await workspace.next()).toEqual({
      type: "user.updated",
      user: { id: bot.id, name: "Deploy Bot", bio: null, role: "bot", status: "active", avatarUrl: renamed.avatarUrl },
    });
    expect(await inDirectory(member, bot.id)).toMatchObject({ name: "Deploy Bot", avatarUrl: renamed.avatarUrl });
  });

  it("refuses a blank name, and a webhook URL that isn't https, or http on localhost, saving nothing", async () => {
    const administrator = await setUp();
    const refusals: Array<[unknown, string]> = [
      [{}, "Name can't be blank"],
      [{ name: "" }, "Name can't be blank"],
      [{ name: " \t" }, "Name can't be blank"],
      [{ name: 7 }, "Name must be text"],
      [{ name: "Bot", webhookUrl: 7 }, "Webhook URL must be text"],
      [{ name: "Bot", webhookUrl: "ftp://files.example.com/inbox" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: "javascript:alert(1)" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: "example.com/hook" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: "https://" }, WEBHOOK_URL_REFUSED],
      // Plain http, which would show anyone on the way the bot's key.
      [{ name: "Bot", webhookUrl: "http://ci.example.com/hooks/ember" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: "http://127.0.0.1.example.com/hook" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: "http://localhost.example.com/hook" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: "http://10.0.0.7:8080/hook" }, WEBHOOK_URL_REFUSED],
      [{ name: "Bot", webhookUrl: `https://example.com/${"a".repeat(2029)}` }, "Webhook URL can't be longer than 2048 characters"],
      [null, "Expected a JSON object"],
      [["Bot"], "Expected a JSON object"],
      ["not JSON", "Expected a JSON object"],
    ];
    for (const [body, error] of refusals) {
      const response = await addBot(administrator, body);
      expect([response.status, await response.json()]).toEqual([422, { error }]);
    }
    expect(await listed(administrator)).toEqual([]);

    const bot = await added(administrator, { name: "Build Bot", webhookUrl: "https://example.com/hook" });
    // A change can leave the name out.
    for (const [body, error] of refusals.slice(1)) {
      const response = await changeBot(administrator, bot.id, body);
      expect([response.status, await response.json()]).toEqual([422, { error }]);
    }
    expect(await showBot(administrator, bot.id).then(botOf)).toEqual(bot);
  });

  it("is only for administrators: members get 403 and signed-out visitors 401 before what they sent is checked, and anyone but an active bot is 404", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot" });
    const deleted = await added(administrator, { name: "Old Bot" });
    expect((await deleteBot(administrator, deleted.id)).status).toBe(204);

    for (const [session, status] of [
      [null, 401],
      [member, 403],
    ] as const) {
      expect((await listBots(session)).status).toBe(status);
      expect((await addBot(session, { name: "Sneaky Bot" })).status).toBe(status);
      expect((await addBot(session, {})).status).toBe(status);
      expect((await showBot(session, bot.id)).status).toBe(status);
      expect((await changeBot(session, bot.id, { name: "Sneaky Bot" })).status).toBe(status);
      expect((await changeBot(session, bot.id, { name: "" })).status).toBe(status);
    }
    expect(await stored(bot.id)).toMatchObject({ name: "Build Bot" });
    expect((await listed(administrator)).map(({ name }) => name)).toEqual(["Build Bot"]);

    for (const id of [deleted.id, member.user.id, administrator.user.id, "nobody", encodeURIComponent(bot.id + "/")]) {
      expect((await showBot(administrator, id)).status).toBe(404);
      expect((await changeBot(administrator, id, { name: "Renamed" })).status).toBe(404);
      expect((await changeBot(administrator, id, { name: "" })).status).toBe(404);
    }
    expect(await stored(member.user.id)).toMatchObject({ name: "Grace Hopper" });
    expect(await stored(deleted.id)).toMatchObject({ name: "Old Bot" });
  });

  it("answers Campfire's 404 page for the settings page of anyone but an active bot", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot" });
    const settings = await page(administrator, `/account/bots/${bot.id}/edit`);
    expect(settings.status).toBe(200);
    expect(await settings.text()).toBe("page /");

    expect((await deleteBot(administrator, bot.id)).status).toBe(204);
    for (const id of [bot.id, member.user.id, "nobody", "new"]) {
      const missing = await page(administrator, `/account/bots/${id}/edit`);
      expect(missing.status, id).toBe(404);
      expect(await missing.text()).toBe(notFoundPage);
    }
    // The app sends a member to workspace settings, and anyone signed out to sign in, whatever the page names.
    for (const viewer of [member, null]) expect(await (await page(viewer, "/account/bots/nobody/edit")).text()).toBe("page /");
  });
});

describe("Chat bots page", () => {
  it("lists the active bots by name, ignoring case, each with its key and its rooms but DMs, by name, and never people", async () => {
    const administrator = await setUp();
    const [general, random] = await firstRooms();
    const beta = await added(administrator, { name: "beta" });
    const alpha = await added(administrator, { name: "Alpha" });
    const gamma = await added(administrator, { name: "Gamma", webhookUrl: "https://example.com/hook" });
    const zebra = await createRoom("Zebra", { closedTo: [administrator.user.id, alpha.id], as: administrator });
    const apples = await createRoom("apples", { as: administrator });
    await directWith(administrator, alpha);

    const shared = [{ id: apples.id, name: "apples" }, general!, random!];
    expect(await listed(administrator)).toEqual([
      listedAs(alpha, [...shared, { id: zebra.id, name: "Zebra" }]),
      listedAs(beta, shared),
      listedAs(gamma, shared),
    ]);
  });

  it("keeps the keys out of caches", async () => {
    const administrator = await setUp();
    await added(administrator, { name: "Build Bot" });
    expect((await listBots(administrator)).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("Delete a bot", () => {
  it("deactivates a bot: it leaves the bots page and every room but its DMs, keeping its token and webhook, and everyone hears of it", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot", webhookUrl: "https://example.com/hook" });
    const dm = await directWith(administrator, bot);
    const workspace = await openWorkspaceSocket(member);

    const response = await deleteBot(administrator, bot.id);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    const removed = await workspace.next();
    expect(removed).toEqual({
      type: "user.updated",
      user: { id: bot.id, name: "Build Bot", bio: null, role: "bot", status: "deactivated", avatarUrl: expect.any(String) },
    });
    expect(await inDirectory(member, bot.id)).toEqual((removed as { user: DirectoryUser }).user);
    expect(await listed(administrator)).toEqual([]);
    expect((await showBot(administrator, bot.id)).status).toBe(404);
    expect(await roomIdsOf(bot.id)).toEqual([dm.id]);
    expect(await stored(bot.id)).toMatchObject({ role: 2, status: 1, bot_token: tokenOf(bot) });
    expect(await webhookOf(bot.id)).toMatchObject({ url: "https://example.com/hook" });

    expect((await deleteBot(administrator, bot.id)).status).toBe(404);
  });

  it("is only for administrators, and only for active bots", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot" });

    expect((await deleteBot(null, bot.id)).status).toBe(401);
    expect((await deleteBot(member, bot.id)).status).toBe(403);
    for (const id of [member.user.id, administrator.user.id, "nobody"]) expect((await deleteBot(administrator, id)).status).toBe(404);
    expect(await stored(member.user.id)).toMatchObject({ status: 0 });
    expect(await stored(bot.id)).toMatchObject({ status: 0 });
  });
});

describe("Generate a new bot key", () => {
  it("gives a bot a new token of 12 random letters and digits, so its key changes at once", async () => {
    const administrator = await setUp();
    const bot = await added(administrator, { name: "Build Bot", webhookUrl: "https://example.com/hook" });

    const reset = await resetKey(administrator, bot.id).then(botOf);
    expect(reset).toEqual({ ...bot, key: expect.any(String), avatarUrl: expect.any(String) });
    expect(reset.key).toMatch(new RegExp(`^${bot.id}-[A-Za-z0-9]{12}$`));
    expect(reset.key).not.toBe(bot.key);
    expect((await stored(bot.id)).bot_token).toBe(tokenOf(reset));
    expect((await listed(administrator))[0]!.key).toBe(reset.key);
  });

  it("is only for administrators, and only for active bots", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot" });
    const deleted = await added(administrator, { name: "Old Bot" });
    await deleteBot(administrator, deleted.id);

    expect((await resetKey(null, bot.id)).status).toBe(401);
    expect((await resetKey(member, bot.id)).status).toBe(403);
    for (const id of [deleted.id, member.user.id, "nobody"]) expect((await resetKey(administrator, id)).status).toBe(404);
    expect((await stored(bot.id)).bot_token).toBe(tokenOf(bot));
    expect((await stored(deleted.id)).bot_token).toBe(tokenOf(deleted));
  });
});

describe("Where bots show up", () => {
  it("puts a new bot in every open room at mentions, and in a private room once it's made open, as it does everyone active", async () => {
    const administrator = await setUp();
    const secrets = await createRoom("Secrets", { closedTo: [administrator.user.id], as: administrator });
    const bot = await added(administrator, { name: "Build Bot" });
    const [general, random] = await firstRooms();
    expect(await involvementsOf(bot.id)).toEqual({ [general!.id]: "mentions", [random!.id]: "mentions" });

    expect((await changeRoom(administrator, secrets.id, { kind: "open" })).status).toBe(200);
    expect(await involvementsOf(bot.id)).toEqual({ [general!.id]: "mentions", [random!.id]: "mentions", [secrets.id]: "mentions" });
  });

  it("lists an active bot with everyone else in rooms' member pickers, so it can be put in a private room, and anyone can start a DM with it", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await added(administrator, { name: "Build Bot" });
    const everyone = [administrator.user, shown(bot), member.user];
    expect(await answered<NewRoomForm>(administrator, "/api/rooms/new")).toEqual({ people: everyone });

    const builds = await createRoom("Builds", { closedTo: [administrator.user.id, bot.id], as: administrator });
    expect((await answered<RoomSettings>(administrator, `/api/rooms/${builds.id}/settings`)).people).toEqual(
      everyone.map((person) => ({ ...person, member: person.id !== member.user.id })),
    );

    const response = await startDirect(member, [bot.id]);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { room: DirectRoom }).room.members.map(({ id }) => id).sort()).toEqual([member.user.id, bot.id].sort());

    // Once it's deleted, nobody can pick it, as nobody can pick someone removed.
    expect((await deleteBot(administrator, bot.id)).status).toBe(204);
    expect(await answered<NewRoomForm>(administrator, "/api/rooms/new")).toEqual({ people: [administrator.user, member.user] });
  });

  it("offers an active bot to mention in the rooms it's in until it's deleted", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const secrets = await createRoom("Secrets", { closedTo: [administrator.user.id, member.user.id], as: administrator });
    const bot = await added(administrator, { name: "Build Bot" });
    const [general] = await firstRooms();

    expect(await mentionable(member, general!.id, "bot")).toEqual(["Build Bot"]);
    expect(await mentionable(member, secrets.id, "bot")).toEqual([]);

    expect((await deleteBot(administrator, bot.id)).status).toBe(204);
    expect(await mentionable(member, general!.id, "bot")).toEqual([]);
  });
});

describe("A bot's profile", () => {
  it("answers a bot's page without a sign-in link, even to administrators, with Campfire's bot picture for its avatar, until it's deleted", async () => {
    const administrator = await setUp();
    const bot = await added(administrator, { name: "Build Bot" });

    const person = { id: bot.id, name: "Build Bot", bio: null, role: "bot", status: "active", avatarUrl: bot.avatarUrl, emailAddress: null };
    expect(await answered<PersonAnswer>(administrator, `/api/users/${bot.id}`)).toEqual({ person });
    const avatar = await api(bot.avatarUrl, { headers: signedInAs(administrator) });
    expect(avatar.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await avatar.text()).toBe(DEFAULT_BOT_AVATAR);

    expect((await deleteBot(administrator, bot.id)).status).toBe(204);
    expect((await answered<PersonAnswer>(administrator, `/api/users/${bot.id}`)).person).toMatchObject({ name: "Build Bot", role: "bot", status: "deactivated" });
  });
});

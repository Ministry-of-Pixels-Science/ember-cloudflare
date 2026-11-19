import type { BotAnswer, BotSettings, Bootstrap, Me, NewWorkspace, RoomId, SharedRoom, User, WorkspaceSettings } from "@ember/protocol";
import { BLOCKED_WORDS_REFUSED, blockedWordUnmatchable } from "@ember/protocol/blocked-words";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKED_WORDS_KEPT_MS } from "../src/blocked-words";
import { api, connect, cookieOf, createRoom, cutOff, freshDeploy, post, roomSql, settle, shown, signIn, startUpload, stopTheClock, upload, workspaceSql, type Session } from "./support";

// Blocked words, which an administrator lists in Membership, as Apple asks of every app where people
// post: a message, a reaction, a file's or a room's name, or someone's name, username or bio with one of
// them isn't saved, and whoever wrote it is told why. Each room checks against the list it keeps, which
// it hears has changed with its next message saved, or asks for again after a minute, so that messages
// don't wait on the Workspace.

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in, answering her session and the general room. */
async function setUp(): Promise<{ ada: Session; general: RoomId }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada: { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) }, general };
}

const as = (session: Session) => ({ Cookie: session.cookie });

/** Saves `words` as the blocked words, as `session` does in Membership. */
const saveBlockedWords = (session: Session, words: unknown) => api("/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify({ blockedWords: words }) });

/** Blocks `words` as `administrator`. */
async function block(administrator: Session, ...words: string[]): Promise<void> {
  const saved = await saveBlockedWords(administrator, words);
  expect(saved.status, await saved.clone().text()).toBe(200);
}

const settingsOf = async (session: Session) => (await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings;

const storedSettings = async () => ((await workspaceSql("SELECT settings, updated_at FROM accounts")) as Array<{ settings: string; updated_at: string }>)[0]!;

/** How a message mentioning `person` is written. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** Sends `body` as a new message over `client`'s socket, answering the error the room refuses it with. */
async function refused(client: Awaited<ReturnType<typeof connect>>, body: string) {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body });
  return { clientMessageId, error: await client.next("error") };
}

/** The text of the messages room `room` keeps, oldest first. */
const bodies = async (room: RoomId) => ((await roomSql(room, "SELECT body FROM messages ORDER BY id")) as Array<{ body: string }>).map(({ body }) => body);

/** Changes `session`'s profile as their profile page saves it. */
const saveProfile = (session: Session, changes: unknown) =>
  api("/api/users/me/profile", { method: "PATCH", headers: { ...as(session), "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify(changes) });

/** As `curl -d` sends a body, as bots do. */
const FORM_TYPE = { "Content-Type": "application/x-www-form-urlencoded" };

/** Adds a bot as `administrator`, which joins the rooms open to everyone, answering it, key and all. */
async function addBot(administrator: Session, name: string): Promise<BotSettings> {
  const response = await api("/api/account/bots", { method: "POST", headers: as(administrator), body: JSON.stringify({ name }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** Waits until `room` has sent the Workspace every event it logged, whose answer gives the blocked words' version. */
const allApplied = (room: RoomId) => vi.waitFor(async () => expect(await roomSql(room, "SELECT count(*) AS n FROM room_events")).toEqual([{ n: 0 }]));

describe("the list", () => {
  it("keeps the words and phrases an administrator lists, trimmed and once each, and shows them to administrators alone", async () => {
    const { ada } = await setUp();
    const grace = await signIn("Grace");
    const { updated_at: before } = await storedSettings();

    await block(ada, " fudge ", "Darn  it", "FUDGE", "🖕");

    expect((await settingsOf(ada)).blockedWords).toEqual(["fudge", "Darn it", "🖕"]);
    expect((await settingsOf(grace)).blockedWords).toEqual([]);
    const { account } = (await (await api("/api/bootstrap", { headers: as(grace) })).json()) as Bootstrap;
    expect(account).not.toHaveProperty("blockedWords");
    // Pages don't show them, so the account doesn't count as changed, and its logo keeps its address.
    const stored = await storedSettings();
    expect(JSON.parse(stored.settings).blocked_words).toEqual(["fudge", "Darn it", "🖕"]);
    expect(stored.updated_at).toBe(before);

    await block(ada);
    expect((await settingsOf(ada)).blockedWords).toEqual([]);
  });

  it("is changed by administrators alone, and only to words and phrases it can match", async () => {
    const { ada } = await setUp();
    const grace = await signIn("Grace");

    expect((await saveBlockedWords(grace, ["fudge"])).status).toBe(403);
    const unmatchable = await saveBlockedWords(ada, ["fudge", "..."]);
    expect(unmatchable.status).toBe(422);
    expect(await unmatchable.json()).toEqual({ error: blockedWordUnmatchable("...") });
    expect((await saveBlockedWords(ada, "fudge")).status).toBe(422);
    expect((await settingsOf(ada)).blockedWords).toEqual([]);
  });
});

describe("messages", () => {
  it("refuses a message or an edit with a blocked word, saying why, and saves the rest", async () => {
    const { ada, general } = await setUp();
    await block(ada, "fudge", "darn it");
    const client = await connect(general, ada);

    const { clientMessageId, error } = await refused(client, "<p>Oh, FÚDGE!</p>");
    // The composer it came from gives it back, for its writer to change.
    expect(error).toEqual({ type: "error", message: BLOCKED_WORDS_REFUSED, clientMessageId, failed: "message.create", rewrite: true });
    expect((await refused(client, "<p>Darn, it melted.</p>")).error.message).toBe(BLOCKED_WORDS_REFUSED);
    // A word inside a longer one, or a phrase's words apart, isn't the word or the phrase.
    const kept = await post(client, "<p>Fudgesicles! Darn the heat, it melts them.</p>");

    client.send({ type: "message.update", messageId: kept.id, body: "<p>Fudge.</p>" });
    expect(await client.next("error")).toEqual({ type: "error", message: BLOCKED_WORDS_REFUSED, failed: "message.update" });
    await settle(client);
    expect(await bodies(general)).toEqual([kept.body]);
  });

  it("doesn't count the names of the people a message mentions as its words", async () => {
    const { ada, general } = await setUp();
    const fudge = await signIn("Fudge Smith");
    await block(ada, "fudge");
    const client = await connect(general, ada);

    const kept = await post(client, `<p>Thanks, ${mention(fudge.user)}!</p>`);
    expect(kept.mentions).toEqual([shown(fudge.user)]);
    expect((await refused(client, `<p>${mention(fudge.user)} loves fudge</p>`)).error.message).toBe(BLOCKED_WORDS_REFUSED);
    // Only the mentions are passed over: not their names written out, nor a word that starts as a name does.
    const fu = await signIn("Fu");
    for (const body of [`<p>${mention(fudge.user)} @Fudge Smith</p>`, `<p>${mention(fu.user)} @Fudge</p>`]) {
      expect((await refused(client, body)).error.message).toBe(BLOCKED_WORDS_REFUSED);
    }
  });

  it("refuses a bot's message or reaction with a blocked word, or a phrase split between its text and a card", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot");
    await block(ada, "fudge", "darn it");

    const message = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: "Build fudged", headers: FORM_TYPE });
    expect(message.status).toBe(201);
    const id = message.headers.get("Location")!.split("/@")[1]!;
    const fudged = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: "Fudge, the build broke", headers: FORM_TYPE });
    expect(fudged.status).toBe(422);
    expect(await fudged.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });
    const boosted = await api(`/rooms/${general}/${bot.key}/messages/${id}/boosts`, { method: "POST", body: "fudge", headers: FORM_TYPE });
    expect(boosted.status).toBe(422);
    expect(await boosted.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });

    // A card is checked with the text it's under, as one message.
    const sent = (payload: unknown) => api(`/rooms/${general}/${bot.key}/slack`, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
    expect((await sent({ text: "Darn", attachments: [{ text: "The build broke" }] })).status).toBe(200);
    const split = await sent({ text: "Darn", attachments: [{ text: "it broke the build" }] });
    expect([split.status, await split.text()]).toEqual([400, "invalid_payload"]);
  });
});

describe("reactions", () => {
  it("refuses a reaction with a blocked word or emoji, whatever its skin tone, and adds the rest", async () => {
    const { ada, general } = await setUp();
    await block(ada, "fudge", "🖕");
    const client = await connect(general, ada);
    const message = await post(client, "<p>Hello</p>");

    for (const content of ["Fudge!", "🖕🏽"]) {
      client.send({ type: "boost.create", messageId: message.id, content });
      expect(await client.next("error")).toEqual({ type: "error", message: BLOCKED_WORDS_REFUSED, failed: "boost.create" });
    }
    client.send({ type: "boost.create", messageId: message.id, content: "👍" });
    expect((await client.next("boost.created")).boost.content).toBe("👍");
  });
});

describe("rooms", () => {
  it("hear that the list has changed with their next message saved", async () => {
    const { ada, general } = await setUp();
    await block(ada, "fudge");
    const client = await connect(general, ada);
    await post(client, "<p>Hello</p>");
    await allApplied(general);

    await block(ada, "fudge", "heck");
    await post(client, "<p>Hello again</p>");
    await allApplied(general);

    expect((await refused(client, "<p>Heck!</p>")).error.message).toBe(BLOCKED_WORDS_REFUSED);
  });

  it("ask for the list again once the one they keep is a minute old", async () => {
    const { ada, general } = await setUp();
    await block(ada, "fudge", "heck");
    const client = await connect(general, ada);
    stopTheClock();
    expect((await refused(client, "<p>Heck!</p>")).error.message).toBe(BLOCKED_WORDS_REFUSED);

    await block(ada, "fudge");
    vi.setSystemTime(Date.now() + BLOCKED_WORDS_KEPT_MS);

    expect((await post(client, "<p>Heck!</p>")).plainText).toBe("Heck!");
  });

  it("go by the list they have while the Workspace can't be reached, or by none until they've had one", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ada, general } = await setUp();
    await block(ada, "fudge");
    const design = await createRoom("Design", { as: ada });
    const [client, elsewhere] = [await connect(general, ada), await connect(design.id, ada)];
    stopTheClock();
    expect((await refused(client, "<p>Fudge!</p>")).error.message).toBe(BLOCKED_WORDS_REFUSED);

    const reconnect = [await cutOff(general), await cutOff(design.id)];
    vi.setSystemTime(Date.now() + BLOCKED_WORDS_KEPT_MS);
    expect((await refused(client, "<p>Fudge!</p>")).error.message).toBe(BLOCKED_WORDS_REFUSED);
    expect((await post(elsewhere, "<p>Fudge!</p>")).plainText).toBe("Fudge!");
    expect(errors).toHaveBeenCalledWith("Could not ask for the blocked words; going by those the room had", expect.any(Error));
    for (const again of reconnect) await again();
  });

  it("go by the list they had while the Workspace can't be reached just after they hear it's changed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ada, general } = await setUp();
    await block(ada, "fudge");
    const client = await connect(general, ada);
    await post(client, "<p>Hello</p>");
    await allApplied(general);

    await block(ada, "fudge", "heck");
    await post(client, "<p>Hello again</p>");
    await allApplied(general);
    const reconnect = await cutOff(general);
    expect((await refused(client, "<p>Fudge!</p>")).error.message).toBe(BLOCKED_WORDS_REFUSED);
    expect(errors).toHaveBeenCalledWith("Could not ask for the blocked words; going by those the room had", expect.any(Error));
    await reconnect();
  });
});

describe("names of rooms and files", () => {
  it("refuses a room named or renamed with a blocked word, but keeps a name from before it was blocked", async () => {
    const { ada, general } = await setUp();
    const factory = await createRoom("Fudge factory", { as: ada });
    await block(ada, "fudge");

    for (const [path, method] of [["/api/rooms", "POST"], [`/api/rooms/${general}`, "PATCH"]] as const) {
      const response = await api(path, { method, headers: as(ada), body: JSON.stringify({ kind: "open", name: "Fudge" }) });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });
    }
    // Room settings send the name a room has with every change.
    const changed = await api(`/api/rooms/${factory.id}`, { method: "PATCH", headers: as(ada), body: JSON.stringify({ kind: "open", name: "Fudge factory", icon: "rocket" }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as { room: SharedRoom }).room).toMatchObject({ name: "Fudge factory", icon: "rocket" });
    expect(await workspaceSql("SELECT name FROM rooms WHERE id IN (?, ?) ORDER BY name", general, factory.id)).toEqual([{ name: "Fudge factory" }, { name: "general" }]);
  });

  it("refuses a file named with a blocked word, someone's or a bot's, and posts the rest", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Build Bot");
    await block(ada, "fudge");

    const started = await startUpload(ada, general, { name: "Fudge recipe.txt", type: "text/plain", size: 5, clientMessageId: crypto.randomUUID() });
    expect(started.status).toBe(422);
    expect(await started.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });
    const form = new FormData();
    form.set("attachment", new File(["fudge"], "fudge.txt", { type: "text/plain" }));
    const posted = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: form });
    expect(posted.status).toBe(422);
    expect(await posted.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });
    expect(await roomSql(general, "SELECT count(*) AS n FROM blobs")).toEqual([{ n: 0 }]);

    expect((await upload(ada, general, "Fudgesicles.txt", new TextEncoder().encode("fudge"), "text/plain")).attachment.name).toBe("Fudgesicles.txt");
  });
});

describe("people", () => {
  it("refuses a new name, username or bio with a blocked word, but keeps one from before it was blocked", async () => {
    const { ada } = await setUp();
    const grace = await signIn("Grace");
    expect((await saveProfile(grace, { bio: "Fudge maker" })).status).toBe(200);
    await block(ada, "fudge");

    for (const changes of [{ name: "Fudge Hopper" }, { username: "fudge" }, { bio: "I make fudge" }]) {
      const saved = await saveProfile(grace, changes);
      expect(saved.status, JSON.stringify(changes)).toBe(422);
      expect(await saved.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });
    }
    const renamed = await saveProfile(grace, { name: "Grace Hopper" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ profile: { name: "Grace Hopper", bio: "Fudge maker" } });
  });

  it("turns away someone joining, or signing in with just a name, with a blocked word in their name", async () => {
    const { ada } = await setUp();
    const [{ join_code: code }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    await block(ada, "fudge");

    const guest = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Fudge" }) });
    expect(guest.status).toBe(422);
    expect(await guest.json()).toEqual({ error: BLOCKED_WORDS_REFUSED });
    const grace = { name: "Grace Fudge", emailAddress: "grace@example.com", password: "compiler design" };
    const joined = await api(`/api/join/${code}`, { method: "POST", body: JSON.stringify(grace) });
    expect(joined.status).toBe(422);
    expect(await joined.json()).toEqual({ error: BLOCKED_WORDS_REFUSED, field: "name" });
    const renamed = await api(`/api/join/${code}`, { method: "POST", body: JSON.stringify({ ...grace, name: "Grace Hopper" }) });
    expect(renamed.status).toBe(201);
    expect(((await renamed.json()) as { user: Me }).user.name).toBe("Grace Hopper");
  });
});

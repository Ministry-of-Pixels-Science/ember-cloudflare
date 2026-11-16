import { ASSISTANT_ID, type BotAnswer, type BotSettings, type Directory, type DirectoryUser, type DirectRoom, type Me, type Message, type NewRoomForm, type NewWorkspace, type PersonAnswer, type PersonRole, type RoomId, type RoomSettings, type User, type UserId } from "@ember/protocol";
import { ACCESS_REFUSED, EMBER_DOES, type AgentAccess, type AgentAnswer, type AgentSettings, type AvailableAgent, type AvailableAgents, type NewAgent } from "@ember/protocol/agents";
import { THINKING_LEVELS } from "@ember/protocol/assistant";
import { botMessagesPath } from "@ember/protocol/bots";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWERING_AGENT, DIRECT_PEOPLE } from "../src/workspace-store";
import notFoundPage from "../../web/public/404.html";
import { agentWithKeptModel, answerWithKeptModel, api, apiWith, builtPages, connect, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, post, roomSql, settle, shown, startDirect, workspaceSql, workspaceStub, type Client, type KeptModel, type Session, type WorkspaceSocket } from "./support";

// Who can ask an AI agent, as Admin access on its page sets it: everyone, only administrators, or only
// administrators in their direct messages with it, when it's in no room and nobody else is told of it.
// And Available Agents, which lists everyone the agents they can ask.

const SETUP = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "an-api-token-with-ai-gateway-run_0123456" };
/** Workers AI's models, kept from before Ember stopped offering them, which take Chat Completions, and Anthropic's, which Ember offers. */
const [GLM, GEMMA, HAIKU, SONNET] = ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"];
const KEPT_GLM: KeptModel = { id: GLM, name: "GLM-4.7 Flash", format: "chat", thinkingLevels: [...THINKING_LEVELS] };
const KEPT_GEMMA: KeptModel = { id: GEMMA, name: "Gemma 4 26B", format: "chat", thinkingLevels: [...THINKING_LEVELS] };

/** An agent as New agent sends it: Scout, in every open room, which everyone can ask. */
const SCOUT: NewAgent = {
  name: "Scout",
  description: "Finds what's current",
  instructions: "Say what you know of the weather, and nothing else.",
  model: HAIKU,
  thinking: "off",
  length: "short",
  webSearch: false,
  rooms: null,
};

/** Another, Recap. */
const RECAP: NewAgent = { ...SCOUT, name: "Recap", description: "Sums up long threads", instructions: "Sum up the thread." };

/** A question AI Gateway was sent, with who asked and which agent answers, as its logs know it. */
interface Asked {
  url: string;
  metadata: string | null;
}

/** A model's answer saying `text`, in the format of the API at `url`. */
const answerTo = (url: string, text: string) =>
  url.endsWith("/messages")
    ? Response.json({ type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } })
    : Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });

/** Stands in for AI Gateway, whose models answer every question with `text`, keeping the questions in the order they came. */
function internet(text: string): Asked[] {
  const questions: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    questions.push({ url: request.url, metadata: request.headers.get("cf-aig-metadata") });
    return answerTo(request.url, text);
  });
  return questions;
}

/** Who asked each of `questions`, in order. */
const askers = (questions: Asked[]) => questions.map(({ metadata }) => (JSON.parse(metadata!) as { user_id: UserId }).user_id);

/**
 * Sets Ember up with Ada as its administrator, signed in, and Ember AI on with GLM, which it kept from
 * before Ember stopped offering it, answering her session and the general room.
 */
async function setUp(): Promise<{ ada: Session; general: RoomId }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  internet("Hello, team!");
  const saved = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: ada.cookie }, body: JSON.stringify({ ...SETUP, model: SONNET }) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  vi.restoreAllMocks();
  await answerWithKeptModel(KEPT_GLM);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada, general };
}

/** Someone called `name` joins with the join link, as a member, signed in. */
async function joinAs(name: string): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const person = { name, emailAddress: `${name.split(" ")[0]!.toLowerCase()}@example.com`, password: "compiler design" };
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(person) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Gives `person` `role` as `administrator`, as the people page does. */
async function giveRole(administrator: Session, person: Session, role: PersonRole): Promise<void> {
  const response = await api(`/api/account/users/${person.user.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ role }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

const sendAgent = (session: Session, body: unknown) => api("/api/account/agents", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });
const sendChanges = (session: Session, id: UserId, body: unknown) => api(`/api/account/agents/${id}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });

/** The agent an answer gives, once it's checked to have succeeded with `status`. */
async function agentOf(response: Response, status = 200): Promise<AgentSettings> {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as AgentAnswer).agent;
}

/**
 * Makes `agent` as `administrator`, its model answering its test question, then has it answer with
 * Gemma, as an agent made before Ember stopped offering it does, through Cloudflare's REST API.
 */
async function makeAgent(administrator: Session, agent: NewAgent): Promise<AgentSettings> {
  internet("Hello, team!");
  const made = await agentOf(await sendAgent(administrator, agent), 201);
  vi.restoreAllMocks();
  await agentWithKeptModel(made.id, KEPT_GEMMA);
  return made;
}

/** Changes agent `id` by `changes` as `administrator`, answering it as its page then shows it. */
const changeAgent = async (administrator: Session, id: UserId, changes: Partial<NewAgent>) => agentOf(await sendChanges(administrator, id, changes));

/** Deletes agent `id` as `administrator`, as its page's Delete agent does. */
async function deleteAgent(administrator: Session, id: UserId): Promise<void> {
  expect((await api(`/api/account/agents/${id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
}

/** Adds a bot as `administrator`, answering it as its edit page shows it, with the key its scripts read and write its rooms with. */
async function addBot(administrator: Session, name: string): Promise<BotSettings> {
  const response = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** What `key`, a bot's, reads in room `roomId`: who wrote each message there and what it says, oldest first. */
async function readWith(key: string, roomId: RoomId): Promise<Array<[UserId, string]>> {
  const response = await api(botMessagesPath(roomId, key));
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as Array<{ creator: { id: UserId }; body: { plain_text: string } }>).map(({ creator, body }) => [creator.id, body.plain_text]);
}

/** The rooms someone is in, by ID. */
const roomsOf = async (userId: UserId) => ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", userId)) as Array<{ room_id: RoomId }>).map(({ room_id }) => room_id);

/** The open rooms, by ID. */
const openRooms = async () => ((await workspaceSql("SELECT id FROM rooms WHERE kind = 'open' ORDER BY id")) as Array<{ id: RoomId }>).map(({ id }) => id);

/** The people directory, as it lists everyone to `viewer`. */
const directory = async (viewer: Session) => ((await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory).users;

/** Someone as the people directory lists them to `viewer`, if it does. */
const inDirectory = async (viewer: Session, userId: UserId): Promise<DirectoryUser | undefined> => (await directory(viewer)).find((user) => user.id === userId);

/** The names the mentions prompt offers `viewer` in room `roomId`, or anywhere without one. */
async function offered(viewer: Session, roomId?: RoomId): Promise<string[]> {
  const response = await api(`/api/autocompletable/users${roomId ? `?room_id=${roomId}` : ""}`, { headers: { Cookie: viewer.cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  return [...(await response.text()).matchAll(/<lexxy-prompt-item search="([^"]*)"/g)].map(([, name]) => name!);
}

/** What `path` answers `viewer` as JSON, once it's checked to have succeeded. */
async function answered<T>(viewer: Session, path: string): Promise<T> {
  const response = await api(path, { headers: { Cookie: viewer.cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

/** The agents Available Agents lists to `viewer`. */
const available = async (viewer: Session) => (await answered<AvailableAgents>(viewer, "/api/agents")).agents;

/** Starts the DM of `person` and `others`, or opens the one they have, answering its room. */
async function directWith(person: Session, others: Array<Pick<User, "id">>): Promise<DirectRoom> {
  const started = await startDirect(person, others.map(({ id }) => id));
  expect([200, 201], await started.clone().text()).toContain(started.status);
  return ((await started.json()) as { room: DirectRoom }).room;
}

/** How a message mentioning `person` is written. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** The next message `bot` posts that `client` hears of. */
async function nextFrom(client: Client, bot: Pick<User, "id">): Promise<Message> {
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.creator.id === bot.id) return message;
  }
}

/** Waits until `room` has sent the Workspace every event it logged, whose answer says whom each message goes to. */
const allApplied = (room: RoomId) => vi.waitFor(async () => expect(await roomSql(room, "SELECT count(*) AS n FROM room_events")).toEqual([{ n: 0 }]));

/** Waits until everything `clients` wrote in `room` has gone to whoever answers it. */
async function allAsked(room: RoomId, ...clients: Client[]): Promise<void> {
  await allApplied(room);
  await settle(...clients);
}

/** The next frame about someone that `tab` hears, past what else it hears of, such as rooms. */
async function nextAbout(tab: WorkspaceSocket) {
  for (;;) {
    const frame = await tab.next();
    if (frame.type === "user.updated" || frame.type === "user.gone") return frame;
  }
}

/** Whether nothing has reached `tab` since what was last read on it. */
const heardNothing = async (tab: WorkspaceSocket) => expect(await tab.answers()).toBe(true);

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("An AI agent only administrators can ask", () => {
  it("stays in its rooms, where everyone reads what it answers an administrator, and it answers no member", async () => {
    const { ada, general } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const scout = await makeAgent(ada, { ...SCOUT, access: "admins" });
    expect(scout).toMatchObject({ access: "admins", rooms: null, adminsOnly: true });
    expect(await roomsOf(scout.id)).toEqual(await openRooms());
    const questions = internet("Sunny.");
    const [adasTab, gracesTab] = [await connect(general, ada), await connect(general, grace)];

    // Ada's question follows, so Grace's would have been asked by then.
    await post(gracesTab, `<p>${mention(scout)} what's the forecast?</p>`);
    await post(adasTab, `<p>${mention(scout)} and for me?</p>`);
    expect(await nextFrom(gracesTab, scout)).toMatchObject({ creator: { id: scout.id, name: "Scout" }, plainText: "Sunny." });
    await allAsked(general, adasTab, gracesTab);
    expect(askers(questions)).toEqual([ada.user.id]);
    adasTab.close();
    gracesTab.close();
  });

  it("is listed to everyone as one for administrators, whom alone the mentions prompt and Available Agents offer it", async () => {
    const { ada, general } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const tab = await openWorkspaceSocket(grace);
    const scout = await makeAgent(ada, { ...SCOUT, access: "admins" });

    const listed = { id: scout.id, name: "Scout", bio: null, role: "bot", status: "active", avatarUrl: scout.avatarUrl, agent: true, adminsOnly: true };
    expect(await nextAbout(tab)).toEqual({ type: "user.updated", user: listed });
    for (const viewer of [ada, grace]) expect(await inDirectory(viewer, scout.id)).toEqual(listed);
    expect((await answered<PersonAnswer>(grace, `/api/users/${scout.id}`)).person).toEqual(listed);
    expect((await api(scout.avatarUrl, { headers: { Cookie: grace.cookie } })).status).toBe(200);

    expect(await offered(ada, general)).toContain("Scout");
    expect(await offered(grace, general)).not.toContain("Scout");
    expect(await offered(ada)).toContain("Scout");
    expect(await offered(grace)).not.toContain("Scout");
    expect((await available(ada)).map(({ name, access }) => [name, access])).toEqual([["Ember", "everyone"], ["Scout", "admins"]]);
    expect((await available(grace)).map(({ name }) => name)).toEqual(["Ember"]);
    // @ember is anyone's to mention, as before.
    expect(await offered(grace, general)).toContain("Ember");
  });

  it("starts a DM with an administrator, whom it answers there, and none with a member, nor answers in the one a member had", async () => {
    const { ada } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const scout = await makeAgent(ada, SCOUT);
    const had = await directWith(grace, [scout]);
    expect(had.members.map(({ id }) => id).sort()).toEqual([grace.user.id, scout.id].sort());
    expect(await changeAgent(ada, scout.id, { access: "admins" })).toMatchObject({ access: "admins", rooms: null });

    // Naming it names nobody, as an ID nobody has does, so it's her DM with herself.
    const alone = await directWith(grace, [scout]);
    expect(alone.members).toEqual([grace.user]);
    const recap = await makeAgent(ada, { ...RECAP, access: "admins" });
    expect((await directWith(grace, [recap])).id).toBe(alone.id);

    const questions = internet("Sunny.");
    const [gracesTab, adasTab] = [await connect(had.id, grace), await connect((await directWith(ada, [scout])).id, ada)];
    await post(gracesTab, "<p>What's the forecast?</p>");
    await allAsked(had.id, gracesTab);
    await post(adasTab, "<p>And for me?</p>");
    expect(await nextFrom(adasTab, scout)).toMatchObject({ plainText: "Sunny." });
    await allAsked(had.id, gracesTab);
    expect(askers(questions)).toEqual([ada.user.id]);
    gracesTab.close();
    adasTab.close();
  });

  it("answers whoever is an administrator when they ask, as they become one and until they're one no longer", async () => {
    const { ada, general } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const scout = await makeAgent(ada, { ...SCOUT, access: "admins" });
    const questions = internet("Sunny.");
    const client = await connect(general, grace);
    const access = (asker: Session) => workspaceStub().answererIn(general, scout.id, asker.user.id);

    expect(await access(grace)).toBeNull();
    await giveRole(ada, grace, "administrator");
    expect(await access(grace)).toMatchObject({ bot: { id: scout.id, name: "Scout" } });
    await post(client, `<p>${mention(scout)} what's the forecast?</p>`);
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: "Sunny." });
    expect(await offered(grace, general)).toContain("Scout");

    await giveRole(ada, grace, "member");
    expect(await access(grace)).toBeNull();
    await post(client, `<p>${mention(scout)} and tomorrow?</p>`);
    await allAsked(general, client);
    expect(askers(questions)).toEqual([grace.user.id]);
    client.close();
  });

  it("is anyone's to ask again once everyone can, and takes no access but the three there are", async () => {
    const { ada, general } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const scout = await makeAgent(ada, { ...SCOUT, access: "admins" });
    const tab = await openWorkspaceSocket(grace);

    for (const access of ["nobody", "", null, 1, ["admins"]]) {
      const refused = await sendChanges(ada, scout.id, { access });
      expect([refused.status, await refused.json()], JSON.stringify(access)).toEqual([422, { error: ACCESS_REFUSED, field: "access" }]);
    }
    const refused = await sendAgent(ada, { ...RECAP, access: "members" });
    expect([refused.status, await refused.json()]).toEqual([422, { error: ACCESS_REFUSED, field: "access" }]);
    await heardNothing(tab);

    expect(await changeAgent(ada, scout.id, { access: "everyone" })).toMatchObject({ access: "everyone" });
    const heard = await nextAbout(tab);
    expect(heard).toMatchObject({ type: "user.updated", user: { id: scout.id, agent: true } });
    expect(heard).not.toHaveProperty("user.adminsOnly");
    expect(await inDirectory(grace, scout.id)).not.toHaveProperty("adminsOnly");
    expect(await offered(grace, general)).toContain("Scout");
    expect(await workspaceSql("SELECT agent_access FROM users WHERE id = ?", scout.id)).toEqual([{ agent_access: null }]);
    // Saying what it is already changes nothing, so nobody hears of it.
    expect(await changeAgent(ada, scout.id, { access: "everyone" })).toMatchObject({ access: "everyone", changedAt: (await changeAgent(ada, scout.id, {})).changedAt });
    await heardNothing(tab);
  });
});

describe("An AI agent only available in administrators' DMs", () => {
  it("is made in no room, whatever rooms it's sent with, and leaves the ones it was in once it's changed to one, private ones too", async () => {
    const { ada } = await setUp();
    const hidden = await makeAgent(ada, { ...RECAP, access: "admin-dms", rooms: null });
    expect(hidden).toMatchObject({ access: "admin-dms", rooms: [], adminsOnly: true });
    expect(await roomsOf(hidden.id)).toEqual([]);

    const scout = await makeAgent(ada, SCOUT);
    const launch = await createRoom("launch", { closedTo: [ada.user.id, scout.id], as: ada });
    const dm = await directWith(ada, [scout]);
    expect(await roomsOf(scout.id)).toEqual([...(await openRooms()), launch.id, dm.id].sort());
    expect(await changeAgent(ada, scout.id, { access: "admin-dms" })).toMatchObject({ access: "admin-dms", rooms: [] });
    expect(await roomsOf(scout.id)).toEqual([dm.id]);

    // It stays in none, whatever rooms a change picks, and whoever makes or changes a room.
    expect(await changeAgent(ada, scout.id, { rooms: null })).toMatchObject({ access: "admin-dms", rooms: [] });
    expect(await changeAgent(ada, scout.id, { access: "admin-dms", rooms: await openRooms(), description: "Finds what's new" })).toMatchObject({ rooms: [], description: "Finds what's new" });
    const [open, closed] = [await createRoom("lounge", { as: ada }), await createRoom("board", { closedTo: [ada.user.id, scout.id, hidden.id], as: ada })];
    const changed = await api(`/api/rooms/${launch.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "closed", memberIds: [ada.user.id, scout.id] }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await roomsOf(scout.id)).toEqual([dm.id]);
    expect(await roomsOf(hidden.id)).toEqual([]);
    expect(await workspaceSql("SELECT user_id FROM memberships WHERE room_id IN (?, ?) AND user_id <> ? ORDER BY user_id", open.id, closed.id, ada.user.id)).toEqual([{ user_id: ASSISTANT_ID }]);
    for (const path of ["/api/rooms/new", `/api/rooms/${launch.id}/settings`]) {
      const { people } = await answered<NewRoomForm | RoomSettings>(ada, path);
      expect(people.map(({ name }) => name), path).toEqual(["Ada Lovelace", "Ember"]);
    }

    // Turning Ember AI off and on again puts it back in none.
    expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    internet("Hello, team!");
    const on = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: ada.cookie }, body: JSON.stringify({ ...SETUP, model: SONNET }) });
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await roomsOf(scout.id)).toEqual([dm.id]);

    // Once anyone can ask it in rooms again, it's in the ones picked for it then.
    expect(await changeAgent(ada, scout.id, { access: "admins", rooms: null })).toMatchObject({ access: "admins", rooms: null });
    expect(await roomsOf(scout.id)).toEqual([...(await openRooms()), dm.id].sort());
  });

  it("is told of to administrators alone: no one else's directory, mentions prompt or Available Agents lists it, nor is shown its page or its avatar", async () => {
    const { ada, general } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const scout = await makeAgent(ada, { ...SCOUT, access: "admin-dms" });

    const listed = { id: scout.id, name: "Scout", bio: null, role: "bot", status: "active", avatarUrl: scout.avatarUrl, agent: true, adminsOnly: true };
    expect(await inDirectory(ada, scout.id)).toEqual(listed);
    expect((await answered<PersonAnswer>(ada, `/api/users/${scout.id}`)).person).toEqual({ ...listed, emailAddress: null });
    expect((await api(scout.avatarUrl, { headers: { Cookie: ada.cookie } })).status).toBe(200);
    expect(await offered(ada)).toContain("Scout");
    expect((await available(ada)).map(({ name, access, rooms }) => [name, access, rooms])).toEqual([["Ember", "everyone", null], ["Scout", "admin-dms", []]]);

    expect((await directory(grace)).map(({ name }) => name).sort()).toEqual(["Ada Lovelace", "Ember", "Grace Hopper"]);
    expect((await api(`/api/users/${scout.id}`, { headers: { Cookie: grace.cookie } })).status).toBe(404);
    const page = await apiWith({ ASSETS: builtPages }, `/users/${scout.id}`, { headers: { Cookie: grace.cookie } });
    expect([page.status, await page.text()]).toEqual([404, notFoundPage]);
    const avatar = await api(scout.avatarUrl, { headers: { Cookie: grace.cookie } });
    expect([avatar.status, await avatar.text()]).toEqual([404, ""]);
    for (const names of [await offered(grace), await offered(grace, general)]) expect(names).not.toContain("Scout");
    expect((await available(grace)).map(({ name }) => name)).toEqual(["Ember"]);

    // Whoever becomes an administrator is told of it from then on, and no longer once they aren't one.
    await giveRole(ada, grace, "administrator");
    expect(await inDirectory(grace, scout.id)).toEqual(listed);
    expect((await api(scout.avatarUrl, { headers: { Cookie: grace.cookie } })).status).toBe(200);
    await giveRole(ada, grace, "member");
    expect(await inDirectory(grace, scout.id)).toBeUndefined();
  });

  it("starts a DM with administrators alone, whom it answers there, until someone in it is a member", async () => {
    const { ada } = await setUp();
    const [grace, edsger] = [await joinAs("Grace Hopper"), await joinAs("Edsger Dijkstra")];
    await giveRole(ada, edsger, "administrator");
    const scout = await makeAgent(ada, { ...SCOUT, access: "admin-dms" });

    // To a member it's nobody, and an administrator can't bring one a member would read.
    expect((await directWith(grace, [scout])).members).toEqual([grace.user]);
    expect((await directWith(ada, [scout, grace.user])).members.map(({ id }) => id).sort()).toEqual([ada.user.id, grace.user.id].sort());
    expect(await roomsOf(scout.id)).toEqual([]);

    const questions = internet("Sunny.");
    const dm = await directWith(ada, [scout]);
    expect(dm.members.map(({ id }) => id).sort()).toEqual([ada.user.id, scout.id].sort());
    const alone = await connect(dm.id, ada);
    await post(alone, "<p>What's the forecast?</p>");
    expect(await nextFrom(alone, scout)).toMatchObject({ creator: { id: scout.id, name: "Scout" }, plainText: "Sunny." });
    alone.close();

    const group = await directWith(ada, [scout, edsger.user]);
    expect(group.members.map(({ id }) => id).sort()).toEqual([ada.user.id, edsger.user.id, scout.id].sort());
    const together = await connect(group.id, edsger);
    await post(together, "<p>And tomorrow?</p>");
    expect(await nextFrom(together, scout)).toMatchObject({ plainText: "Sunny." });
    await allAsked(group.id, together);
    expect(askers(questions)).toEqual([ada.user.id, edsger.user.id]);

    // Edsger, a member now, still reads the DM, so it says nothing more there, to Ada neither.
    await giveRole(ada, edsger, "member");
    const adas = await connect(group.id, ada);
    await post(together, "<p>Still there?</p>");
    await post(adas, "<p>For me, then?</p>");
    await allAsked(group.id, together, adas);
    expect(await workspaceStub().answererIn(group.id, scout.id, ada.user.id)).toBeNull();
    expect(await workspaceStub().answererIn(dm.id, scout.id, ada.user.id)).toMatchObject({ bot: { id: scout.id } });
    expect(questions).toHaveLength(2);
    together.close();
    adas.close();
  });

  it("answers among administrators alone: nothing in a DM it shares with a bot, whose key reads it, and it's nobody to name with a bot or another agent", async () => {
    const { ada } = await setUp();
    const [scout, recap, bender] = [await makeAgent(ada, SCOUT), await makeAgent(ada, RECAP), await addBot(ada, "Bender")];

    // While anyone can ask Scout, it answers in a DM with a bot, where whoever has the bot's key reads it.
    const questions = internet("Sunny.");
    const shared = await directWith(ada, [scout, bender]);
    expect(shared.members.map(({ id }) => id).sort()).toEqual([ada.user.id, bender.id, scout.id].sort());
    const adas = await connect(shared.id, ada);
    await post(adas, "<p>What's the forecast?</p>");
    expect(await nextFrom(adas, scout)).toMatchObject({ plainText: "Sunny." });
    await allAsked(shared.id, adas);
    expect(questions).toHaveLength(1);

    // Kept to administrators' DMs, it says nothing more there, to Ada neither.
    await changeAgent(ada, scout.id, { access: "admin-dms" });
    await post(adas, "<p>And tomorrow?</p>");
    await allAsked(shared.id, adas);
    expect(await workspaceStub().answererIn(shared.id, scout.id, ada.user.id)).toBeNull();
    expect(questions).toHaveLength(1);
    expect(await readWith(bender.key, shared.id)).toEqual([
      [ada.user.id, "What's the forecast?"],
      [scout.id, "Sunny."],
      [ada.user.id, "And tomorrow?"],
    ]);
    adas.close();

    // Named with a bot, another agent or @ember, it's nobody, so none of them is in a DM with it.
    for (const other of [bender, recap, { id: ASSISTANT_ID }]) {
      const direct = await directWith(ada, [scout, other]);
      expect(direct.members.map(({ id }) => id).sort()).toEqual([ada.user.id, other.id].sort());
    }
    expect(await roomsOf(scout.id)).toEqual([shared.id]);

    // Alone with Ada, it answers.
    const alone = await directWith(ada, [scout]);
    const client = await connect(alone.id, ada);
    await post(client, "<p>Just us?</p>");
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: "Sunny." });
    client.close();
  });

  it("is heard of on administrators' sockets alone, and gone from everyone else's directory once it's kept for them", async () => {
    const { ada } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];

    const hidden = await makeAgent(ada, { ...RECAP, access: "admin-dms" });
    expect(await nextAbout(adasTab)).toMatchObject({ type: "user.updated", user: { id: hidden.id, name: "Recap", agent: true, adminsOnly: true } });
    await heardNothing(gracesTab);

    const scout = await makeAgent(ada, SCOUT);
    for (const tab of [adasTab, gracesTab]) expect(await nextAbout(tab)).toMatchObject({ type: "user.updated", user: { id: scout.id } });
    await changeAgent(ada, scout.id, { access: "admin-dms" });
    expect(await nextAbout(gracesTab)).toEqual({ type: "user.gone", userId: scout.id });
    expect(await nextAbout(adasTab)).toMatchObject({ type: "user.updated", user: { id: scout.id, adminsOnly: true } });
    await heardNothing(gracesTab);

    // A new name is its administrators' to hear, and it's everyone's again once anyone can ask it.
    await changeAgent(ada, scout.id, { name: "Lookout" });
    expect(await nextAbout(adasTab)).toMatchObject({ type: "user.updated", user: { id: scout.id, name: "Lookout" } });
    await heardNothing(gracesTab);
    await changeAgent(ada, scout.id, { access: "admins" });
    for (const tab of [adasTab, gracesTab]) expect(await nextAbout(tab)).toMatchObject({ type: "user.updated", user: { id: scout.id, name: "Lookout", adminsOnly: true } });

    // Deleted, it stays as it was listed: to administrators alone, as its answers to them stay.
    await deleteAgent(ada, hidden.id);
    expect(await nextAbout(adasTab)).toMatchObject({ type: "user.updated", user: { id: hidden.id, status: "deactivated", adminsOnly: true } });
    await heardNothing(gracesTab);
    expect(await inDirectory(grace, hidden.id)).toBeUndefined();
    expect(await inDirectory(ada, hidden.id)).toMatchObject({ status: "deactivated", agent: true });
    expect((await api(`/api/users/${hidden.id}`, { headers: { Cookie: grace.cookie } })).status).toBe(404);
  });

  it("is told of to administrators alone when Ember AI is turned off, and on again", async () => {
    const { ada } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const [scout, hidden] = [await makeAgent(ada, SCOUT), await makeAgent(ada, { ...RECAP, access: "admin-dms" })];
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];
    /** Whom `tab` hears of next, `count` of them, by ID. */
    const heard = async (tab: WorkspaceSocket, count: number) => {
      const ids: UserId[] = [];
      while (ids.length < count) {
        const frame = await nextAbout(tab);
        if (frame.type === "user.updated") ids.push(frame.user.id);
      }
      return ids.sort();
    };

    expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    expect(await heard(adasTab, 3)).toEqual([ASSISTANT_ID, scout.id, hidden.id].sort());
    expect(await heard(gracesTab, 2)).toEqual([ASSISTANT_ID, scout.id].sort());
    await heardNothing(gracesTab);
    expect(await available(ada)).toEqual([]);

    internet("Hello, team!");
    const on = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: ada.cookie }, body: JSON.stringify({ ...SETUP, model: SONNET }) });
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await heard(adasTab, 3)).toEqual([ASSISTANT_ID, scout.id, hidden.id].sort());
    expect(await heard(gracesTab, 2)).toEqual([ASSISTANT_ID, scout.id].sort());
    await heardNothing(gracesTab);
  });

  it("finds whoever asks, and the people a DM names, by their keys", async () => {
    const plan = async (query: string, ...params: string[]) => (await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail);
    expect((await plan(ANSWERING_AGENT, "room", "agent", "asker")).filter((step) => /^SCAN\b/.test(step))).toEqual([]);
    expect((await plan(DIRECT_PEOPLE, "[]", "asker")).filter((step) => /^SCAN (users|memberships|rooms)\b/.test(step))).toEqual([]);
  });
});

describe("Available Agents", () => {
  /** What Available Agents lists of each agent in `agents`: its name, what it does, who can ask it and the names of its rooms. */
  const shownOf = (agents: AvailableAgent[]) => agents.map(({ name, description, access, rooms }): [string, string, AgentAccess, string[] | null] => [name, description, access, rooms && rooms.map((room) => room.name)]);

  it("lists @ember first, then the agents whoever asks can ask, by name, each with what it does and the rooms they share", async () => {
    const { ada } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const [launch, board, lounge] = [
      await createRoom("launch", { as: ada }),
      await createRoom("board", { closedTo: [ada.user.id], as: ada }),
      await createRoom("lounge", { closedTo: [ada.user.id, grace.user.id], as: ada }),
    ];
    const scout = await makeAgent(ada, { ...SCOUT, rooms: [launch.id] });
    await makeAgent(ada, RECAP);
    await makeAgent(ada, { ...RECAP, name: "Auditor", description: "Checks the books", access: "admins", rooms: [] });
    await makeAgent(ada, { ...RECAP, name: "Zed", description: "Keeps secrets", access: "admin-dms" });
    for (const room of [board, lounge]) {
      const people = [ada.user.id, scout.id, ...(room === lounge ? [grace.user.id] : [])];
      const changed = await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "closed", memberIds: people }) });
      expect(changed.status, await changed.clone().text()).toBe(200);
    }

    // The private rooms an agent was put in are listed to whoever is in them too.
    expect(shownOf(await available(ada))).toEqual([
      ["Ember", EMBER_DOES, "everyone", null],
      ["Auditor", "Checks the books", "admins", []],
      ["Recap", "Sums up long threads", "everyone", null],
      ["Scout", "Finds what's current", "everyone", ["board", "launch", "lounge"]],
      ["Zed", "Keeps secrets", "admin-dms", []],
    ]);
    expect(shownOf(await available(grace))).toEqual([
      ["Ember", EMBER_DOES, "everyone", null],
      ["Recap", "Sums up long threads", "everyone", null],
      ["Scout", "Finds what's current", "everyone", ["launch", "lounge"]],
    ]);
    const [ember, , listed] = await available(grace);
    expect(ember).toEqual({ ...(await inDirectory(grace, ASSISTANT_ID)), description: EMBER_DOES, access: "everyone", rooms: null });
    expect(listed).toEqual({ ...(await inDirectory(grace, scout.id)), description: "Finds what's current", access: "everyone", rooms: [launch, lounge].map(({ id, name }) => ({ id, name })) });
  });

  it("is for anyone signed in, for no cache to keep, and lists nobody while Ember AI is off, or once an agent is deleted", async () => {
    const { ada } = await setUp();
    const grace = await joinAs("Grace Hopper");
    const scout = await makeAgent(ada, SCOUT);
    expect((await api("/api/agents")).status).toBe(401);
    const response = await api("/api/agents", { headers: { Cookie: grace.cookie } });
    expect([response.status, response.headers.get("Cache-Control")]).toEqual([200, "no-store"]);

    await deleteAgent(ada, scout.id);
    expect((await available(grace)).map(({ name }) => name)).toEqual(["Ember"]);
    expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    for (const viewer of [ada, grace]) expect(await available(viewer)).toEqual([]);
  });
});

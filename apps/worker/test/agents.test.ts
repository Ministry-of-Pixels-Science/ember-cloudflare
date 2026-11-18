import {
  ASSISTANT_ID,
  NAME_RESERVED,
  USERNAME_TAKEN,
  type Directory,
  type DirectoryUser,
  type Me,
  type NewWorkspace,
  type PersonAnswer,
  type RoomId,
  type UserId,
  type WorkspaceSettings,
} from "@ember/protocol";
import {
  AGENT_CHANGED,
  AGENT_SET_UP_AGAIN,
  agentCannotSearchWith,
  AGENTS_FORBIDDEN,
  AGENTS_FULL,
  agentsName,
  MAX_AGENTS,
  NAME_TAKEN,
  type AgentAnswer,
  type Agents,
  type AgentSettings,
  type NewAgent,
} from "@ember/protocol/agents";
import { ASSISTANT_FORBIDDEN, ASSISTANT_OFF, MODEL_REFUSED, THINKING_LEVELS, type AssistantChanged } from "@ember/protocol/assistant";
import { AGENT_TEMPLATE, EMBER_TEMPLATE, INSTRUCTIONS_PLACE_NEEDED } from "@ember/protocol/prompts";
import type { BotAnswer, Bots } from "@ember/protocol/bots";
import { mentionPromptItem } from "@ember/richtext";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAnsweredUnsearched } from "../src/assistant/agents";
import type { Db, Statement } from "../src/db";
import type { Workspace } from "../src/workspace";
import notFoundPage from "../../web/public/404.html";
import { agentWithKeptModel, api, apiWith, builtPages, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, origin, recordedImage, shown, workspaceSql, workspaceStub, type KeptModel, type Session, type WorkspaceSocket } from "./support";

// The AI agents administrators make beside @ember on the AI assistant tab, each a bot without a key that
// answers with its own instructions and model, and the instructions administrators add to @ember's own.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const OTHER_API_TOKEN = "another-api-token-with-ai-gateway-run_01";
/** Anthropic's models, which take Messages and can search the web, OpenAI's, which takes Responses, and one of Workers AI's, which takes Chat Completions and can't. */
const [SONNET, HAIKU, GPT, GLM] = ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "openai/gpt-6.1-sol", "@cf/zai-org/glm-4.7-flash"];
/** GLM as an agent made before Ember stopped offering Workers AI's models keeps it, asked through Cloudflare's REST API. */
const KEPT_GLM: KeptModel = { id: GLM, name: "GLM-4.7 Flash", format: "chat", thinkingLevels: [...THINKING_LEVELS] };
/** DeepSeek's, kept from before too, which has no tools for the web in Chat Completions, nor Ember's, as Workers AI's do. */
const KEPT_DEEPSEEK: KeptModel = { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", format: "chat", thinkingLevels: [...THINKING_LEVELS] };
/** xAI's Grok, which searches the web only in xAI's own Responses, through the default gateway's xAI endpoint there. */
const GROK = "xai/grok-4.7";
/** Where the account's default gateway passes requests on to each provider's own API, as Ember asks Claude and GPT, and Grok while it's to search. */
const PROVIDER_ENDPOINTS = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/default`;
const ANTHROPIC_ENDPOINT = `${PROVIDER_ENDPOINTS}/anthropic/v1/messages`;
const OPENAI_ENDPOINT = `${PROVIDER_ENDPOINTS}/openai/responses`;
/** Where Cloudflare's REST API takes requests in Chat Completions, as Ember asks Grok while it isn't to search. */
const CHAT_COMPLETIONS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
/** Cloudflare's Web Search API, which Ember searches with for a model given its own tool. */
const WEB_SEARCH = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/websearch/`;
const HELLO = "Hello, team!";

/** An agent as New agent sends it: Recap, on Claude Haiku, in every open room. */
const RECAP: NewAgent = {
  name: "Recap",
  description: "Sums up long threads",
  instructions: "Sum up the thread you're asked in, in five bullets at most.",
  model: HAIKU,
  thinking: "off",
  length: "short",
  webSearch: false,
  rooms: null,
};

/** A request the fake AI Gateway was sent, with the API token as Cloudflare's API takes it, or as AI Gateway's endpoints for each provider do. */
interface Asked {
  url: string;
  authorization: string | null;
  aigAuthorization: string | null;
  body: { model?: string; system?: string; tools?: Array<{ type?: string; function?: { name: string } }>; reasoning?: { effort?: string }; messages?: Array<{ role: string }> };
}

/** A page the model finds on the web, as Anthropic's Messages gives it, and its answer citing it. */
const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs" };
const SEARCHED = [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Cloudflare AI Gateway" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", ...DOCS, encrypted_content: "e", page_age: null }] },
  { type: "text", text: "AI Gateway is Cloudflare's proxy for AI models.", citations: [{ type: "web_search_result_location", ...DOCS, encrypted_index: "e", cited_text: "…" }] },
];

/** Whether `asked` gives the model a tool for searching the web, its provider's or Ember's own. */
const searches = ({ body }: Asked) => (body.tools ?? []).some(({ type, function: called }) => type?.startsWith("web_search") || called?.name === "web_search");

/** Whether `asked` tells the model how much to think, as the test question does when it's asked again at each level of thinking. */
const thinks = ({ body }: Asked) => "thinking" in body || "reasoning" in body || "reasoning_effort" in body;

/** What was asked of the models but for the test questions asked again at each level of thinking. */
const unthinking = () => asked.filter((sent) => !thinks(sent));

/** A model saying hello in the format of the API at `url`. */
function sayingHello(url: string): Response {
  if (url.endsWith("/messages")) return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: HELLO }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
  if (url.endsWith("/responses")) return Response.json({ object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: HELLO }] }] });
  return Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: HELLO }, finish_reason: "stop" }] });
}

/** A model that says hello, and searches the web whenever it's given a tool for it, as Anthropic's do. */
const answering = (asked: Asked): Response =>
  searches(asked) ? Response.json({ type: "message", role: "assistant", content: SEARCHED, stop_reason: "end_turn", usage: { input_tokens: 1_000, output_tokens: 100 } }) : sayingHello(asked.url);

/**
 * Grok, in Chat Completions through Cloudflare's REST API, calling Ember's own tool for searching the web
 * whenever it's given it, then saying what Cloudflare's Web Search API found, as models answer everything
 * else (`answering`).
 */
const grokAnswering = (asked: Asked): Response => {
  if (asked.url === WEB_SEARCH) return Response.json({ success: true, result: { items: [{ ...DOCS, description: "About AI Gateway." }] } });
  if (asked.url !== CHAT_COMPLETIONS || !asked.body.tools) return answering(asked);
  if (asked.body.messages?.at(-1)?.role === "tool") return sayingHello(asked.url);
  const call = { id: "call_0", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "Cloudflare AI Gateway" }) } };
  return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { completion_tokens: 20 } });
};

/** How the fake AI Gateway answers, which a test can change, and what it was asked. */
let answer: (asked: Asked) => Response | Promise<Response>;
let asked: Asked[];

beforeEach(async () => {
  await freshDeploy();
  answer = answering;
  asked = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { headers } = request;
    const sent = { url: request.url, authorization: headers.get("Authorization"), aigAuthorization: headers.get("cf-aig-authorization"), body: (await request.json()) as Asked["body"] };
    asked.push(sent);
    return answer(sent);
  });
});
afterEach(() => vi.restoreAllMocks());

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Turns Ember AI on as `administrator`, or sets it up again, through `apiToken`, with Claude Sonnet answering everyone. */
async function turnOn(administrator: Session, apiToken = API_TOKEN): Promise<void> {
  const response = await api("/api/account/assistant", { method: "PUT", headers: as(administrator), body: JSON.stringify({ accountId: ACCOUNT_ID, apiToken, model: SONNET }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Turns Ember AI off as `administrator`, as its card's switch does. */
async function turnOff(administrator: Session): Promise<void> {
  expect((await api("/api/account/assistant", { method: "DELETE", headers: as(administrator) })).status).toBe(200);
}

/** Sets Ember up with Ada as its administrator, signed in, and Ember AI on, forgetting what turning it on asked. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const administrator = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  await turnOn(administrator);
  asked.length = 0;
  return administrator;
}

/** Joins with the join link as `person`, answering how it went. */
async function join(person: { name: string; emailAddress: string; password: string }): Promise<Response> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  return api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(person) });
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const response = await join(grace);
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Makes `member` an administrator, as the people page does, as `administrator`. */
async function promote(administrator: Session, member: Session): Promise<void> {
  const response = await api(`/api/account/users/${member.user.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ role: "administrator" }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

const listAgents = (session: Session | null) => api("/api/account/agents", { headers: as(session) });
const makeAgent = (session: Session | null, body: unknown) => api("/api/account/agents", { method: "POST", headers: as(session), body: JSON.stringify(body) });
const showAgent = (session: Session | null, id: UserId) => api(`/api/account/agents/${id}`, { headers: as(session) });
const changeAgent = (session: Session | null, id: UserId, body: unknown) => api(`/api/account/agents/${id}`, { method: "PATCH", headers: as(session), body: JSON.stringify(body) });
const deleteAgent = (session: Session | null, id: UserId) => api(`/api/account/agents/${id}`, { method: "DELETE", headers: as(session) });
const removeAvatar = (session: Session | null, id: UserId) => api(`/api/account/agents/${id}/avatar`, { method: "DELETE", headers: as(session) });

/** The agent an answer gives, once it's checked to have succeeded with `status`, for no cache to keep. */
async function agentOf(response: Response, status = 200): Promise<AgentSettings> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as AgentAnswer).agent;
}

/** Makes Recap, as `changes` changes it, as `administrator`, answering it as its page shows it. */
const made = async (administrator: Session, changes: Partial<NewAgent> = {}) => agentOf(await makeAgent(administrator, { ...RECAP, ...changes }), 201);

/** Agent `id` as its page shows it to `administrator`. */
const shownAgent = async (administrator: Session, id: UserId) => agentOf(await showAgent(administrator, id));

/** The agents, as the AI assistant tab lists them to `administrator`. */
async function listed(administrator: Session): Promise<Agents["agents"]> {
  const response = await listAgents(administrator);
  expect(response.status).toBe(200);
  return ((await response.json()) as Agents).agents;
}

/** A refusal's status and what it says. */
const refusalOf = async (response: Response) => [response.status, await response.json()];

/** The rooms `userId` is in, by ID. */
const roomsOf = async (userId: UserId) => ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", userId)) as Array<{ room_id: RoomId }>).map(({ room_id }) => room_id);

/** The open rooms, by ID. */
const openRooms = async () => ((await workspaceSql("SELECT id FROM rooms WHERE kind = 'open' ORDER BY id")) as Array<{ id: RoomId }>).map(({ id }) => id);

/** Changes room `roomId` as its settings do, as `session`. */
async function changeRoom(session: Session, roomId: RoomId, changes: unknown): Promise<void> {
  const response = await api(`/api/rooms/${roomId}`, { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Someone as the people directory lists them to `viewer`. */
async function inDirectory(viewer: Session, userId: UserId): Promise<DirectoryUser | undefined> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === userId);
}

/** Someone's page, as it shows them to `viewer`. */
async function pageOf(viewer: Session, userId: UserId): Promise<PersonAnswer> {
  const response = await api(`/api/users/${userId}`, { headers: as(viewer) });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as PersonAnswer;
}

/** The next `count` people a workspace socket hears of, by ID, past what else it hears of, such as rooms. */
async function heardOf(socket: WorkspaceSocket, count: number): Promise<DirectoryUser[]> {
  const heard: DirectoryUser[] = [];
  while (heard.length < count) {
    const frame = await socket.next();
    if (frame.type === "user.updated") heard.push(frame.user);
  }
  return heard.sort((a, b) => a.id.localeCompare(b.id));
}

/** `form` as a browser sends it, with its length, signed in as `session`. */
async function sent(form: FormData, session: Session): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
  const request = new Request(origin, { method: "POST", body: form });
  const body = await request.arrayBuffer();
  return { body, headers: { ...as(session), "Content-Type": request.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) } };
}

/** Adds a bot named `name`, as the bots page does, as `administrator`. */
async function addBot(administrator: Session, name: string): Promise<BotAnswer["bot"]> {
  const response = await api("/api/account/bots", { method: "POST", headers: as(administrator), body: JSON.stringify({ name }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** Records from now on what the Workspace writes to its database, each batch with a write in it, or each write on its own. */
async function recordWrites(): Promise<Statement[][]> {
  const writes: Statement[][] = [];
  const writing = ({ query }: Statement) => !/^\s*SELECT\b/i.test(query);
  await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
    const db = (workspace as unknown as { db: Db }).db;
    const { run, batch } = db;
    db.run = async (query, ...params) => {
      if (writing({ query, params })) writes.push([{ query, params }]);
      return run.call(db, query, ...params);
    };
    db.batch = async (statements) => {
      if (statements.some(writing)) writes.push(statements);
      return batch.call(db, statements);
    };
  });
  return writes;
}

describe("AI agents", () => {
  describe("on the AI assistant tab", () => {
    it("are administrators' to list, make, change and delete, before anything they sent is read", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      const member = await joinAsGrace();
      asked.length = 0;
      for (const response of [
        await listAgents(member),
        await makeAgent(member, "not an agent"),
        await showAgent(member, recap.id),
        await changeAgent(member, recap.id, { name: 7 }),
        await removeAvatar(member, recap.id),
        await deleteAgent(member, recap.id),
      ]) {
        expect(await refusalOf(response)).toEqual([403, { error: AGENTS_FORBIDDEN }]);
      }
      for (const response of [await listAgents(null), await makeAgent(null, RECAP), await showAgent(null, recap.id), await changeAgent(null, recap.id, {}), await deleteAgent(null, recap.id)]) {
        expect(response.status).toBe(401);
      }
      expect(asked).toEqual([]);
      expect(await shownAgent(administrator, recap.id)).toEqual(recap);
    });

    it("say Ember AI is off while it's off", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      await turnOff(administrator);
      for (const response of [
        await listAgents(administrator),
        await makeAgent(administrator, RECAP),
        await showAgent(administrator, recap.id),
        await changeAgent(administrator, recap.id, { name: "Digest" }),
        await removeAvatar(administrator, recap.id),
        await deleteAgent(administrator, recap.id),
      ]) {
        expect(await refusalOf(response)).toEqual([409, { error: ASSISTANT_OFF }]);
      }
    });

    it("answer Campfire's 404 page for the settings page of anyone but an active agent, or @ember", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const recap = await made(administrator);
      /** The page at `path`, from a Worker whose built app answers each path with its own name. */
      const page = (session: Session | null, path: string) => apiWith({ ASSETS: builtPages }, path, { headers: as(session), redirect: "manual" });
      for (const id of [recap.id, ASSISTANT_ID]) {
        const settings = await page(administrator, `/account/agents/${id}/edit`);
        expect([settings.status, await settings.text()], id).toEqual([200, "page /"]);
      }
      expect(await (await page(administrator, "/account/agents/new")).text()).toBe("page /");

      expect((await deleteAgent(administrator, recap.id)).status).toBe(204);
      for (const id of [recap.id, member.user.id, "nobody"]) {
        const missing = await page(administrator, `/account/agents/${id}/edit`);
        expect(missing.status, id).toBe(404);
        expect(await missing.text()).toBe(notFoundPage);
      }
      // The app sends a member to workspace settings, anyone signed out to sign in, and anyone while Ember AI is off to the AI assistant tab.
      for (const viewer of [member, null]) expect(await (await page(viewer, "/account/agents/nobody/edit")).text()).toBe("page /");
      await turnOff(administrator);
      expect(await (await page(administrator, "/account/agents/nobody/edit")).text()).toBe("page /");
    });

    it("don't find an agent there isn't, nor @ember, nor anyone else", async () => {
      const administrator = await setUp();
      for (const response of [
        await showAgent(administrator, "0mgk3x2a9b4c5z"),
        await changeAgent(administrator, ASSISTANT_ID, { description: "The AI assistant" }),
        await deleteAgent(administrator, administrator.user.id),
      ]) {
        expect(await refusalOf(response)).toEqual([404, { error: "Not found" }]);
      }
    });
  });

  describe("New agent", () => {
    it("makes a bot without a key in every open room, once its model has answered a test question as it", async () => {
      const administrator = await setUp();
      const launch = await createRoom("Launch", { as: administrator });
      const tab = await openWorkspaceSocket(administrator);

      const recap = await made(administrator);
      expect(recap).toEqual({
        id: expect.any(String) as string,
        name: "Recap",
        bio: null,
        role: "bot",
        status: "active",
        avatarUrl: expect.stringMatching(/^\/users\/[^/]+\/avatar\?v=\d{14}$/) as string,
        agent: true,
        description: RECAP.description,
        model: HAIKU,
        modelName: "Claude Haiku 5.5",
        access: "everyone",
        rooms: null,
        instructions: RECAP.instructions,
        promptTemplate: null,
        format: "anthropic",
        levels: { thinking: "off", length: "short" },
        thinkingLevels: [...THINKING_LEVELS],
        webTools: [],
        avatar: false,
        changedBy: administrator.user,
        changedAt: expect.any(String) as string,
      } satisfies AgentSettings);

      // Its model answered as it, through Ember AI's account and API token, at the gateway's Anthropic endpoint, and then again at each level of thinking.
      expect(asked).toHaveLength(5);
      for (const sent of asked) expect(sent).toMatchObject({ url: ANTHROPIC_ENDPOINT, authorization: null, aigAuthorization: `Bearer ${API_TOKEN}`, body: { model: "claude-haiku-5-5" } });
      expect(asked.map(thinks)).toEqual([false, true, true, true, true]);
      expect(asked.map(({ body }) => body.system)).toEqual(Array(5).fill(expect.stringContaining("You are Recap, an AI agent")));

      expect(await roomsOf(recap.id)).toEqual(await openRooms());
      expect(await roomsOf(recap.id)).toContain(launch.id);
      expect(await workspaceSql("SELECT role, bot_token, email_address, password_digest FROM users WHERE id = ?", recap.id)).toEqual([
        { role: 2, bot_token: null, email_address: null, password_digest: null },
      ]);
      const { id, name, bio, role, status, avatarUrl, agent, description, model, modelName, webTools, access, rooms } = recap;
      expect(await listed(administrator)).toEqual([{ id, name, bio, role, status, avatarUrl, agent, description, model, modelName, webTools, access, rooms }]);
      expect(await shownAgent(administrator, recap.id)).toEqual(recap);
      const asListed = { id, name, bio, role, status, avatarUrl, agent };
      expect(await inDirectory(administrator, recap.id)).toEqual(asListed);
      expect(await tab.next()).toEqual({ type: "user.updated", user: asListed });
    });

    it("keeps an agent to the open rooms picked, which new open rooms leave it out of, unlike one in every open room", async () => {
      const administrator = await setUp();
      const [support, launch] = [await createRoom("Support", { as: administrator }), await createRoom("Launch", { as: administrator })];
      const leads = await createRoom("Leads", { closedTo: [administrator.user.id], as: administrator });

      // A closed room can't be picked, so it isn't joined.
      const juniper = await made(administrator, { name: "Juniper", model: GPT, rooms: [support.id, leads.id] });
      expect(juniper).toMatchObject({ rooms: [{ id: support.id, name: "Support" }], format: "openai", modelName: "GPT-6.1 Sol" });
      expect(await roomsOf(juniper.id)).toEqual([support.id]);
      const recap = await made(administrator);

      const later = await createRoom("Later", { as: administrator });
      await changeRoom(administrator, leads.id, { kind: "open" });
      expect(await roomsOf(juniper.id)).toEqual([support.id]);
      expect(await roomsOf(recap.id)).toEqual(await openRooms());
      expect(await roomsOf(recap.id)).toEqual(expect.arrayContaining([launch.id, later.id, leads.id]));
      expect((await listed(administrator)).map(({ name, rooms }) => [name, rooms])).toEqual([
        ["Juniper", [{ id: support.id, name: "Support" }]],
        ["Recap", null],
      ]);
    });

    it("has its model search the web while Search the web is on, keeping the tools it took", async () => {
      const administrator = await setUp();
      const scout = await made(administrator, { name: "Scout", model: SONNET, webSearch: true });
      expect(scout).toMatchObject({ format: "anthropic", webTools: ["search", "read"] });
      expect(unthinking().map(searches)).toEqual([false, true]);
      expect(unthinking()[1]!.body.system).toContain("You are Scout, an AI agent");
      // The AI assistant tab lists what it does on the web too.
      expect(await listed(administrator)).toEqual([expect.objectContaining({ name: "Scout", webTools: ["search", "read"] })]);
    });

    it("has Grok search the web with Ember's own tool in Chat Completions, through Cloudflare's REST API, where it's asked", async () => {
      const administrator = await setUp();
      asked.length = 0;
      answer = grokAnswering;
      const grok = await made(administrator, { name: "Grok", model: GROK, webSearch: true });
      expect(grok).toMatchObject({ model: GROK, format: "chat", webTools: ["search"] });
      // Its test question, then the one that searches, which Ember runs with Cloudflare's Web Search API, and nothing at AI Gateway's xAI endpoint.
      expect(unthinking().map(({ url }) => url)).toEqual([CHAT_COMPLETIONS, CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS]);
      expect(unthinking().map(searches)).toEqual([false, true, false, true]);
      expect(asked.every(({ url, authorization }) => new URL(url).hostname === "api.cloudflare.com" && authorization === `Bearer ${API_TOKEN}`)).toBe(true);
    });

    it("has a Grok agent made before search where it is once Search the web goes on, and moves one kept in xAI's own Responses into Chat Completions", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const administrator = await setUp();
      answer = grokAnswering;
      const { id } = await made(administrator, { name: "Grok", model: GROK });
      await agentWithKeptModel(id, { id: GROK, name: "Grok 4.7", format: "chat", thinkingLevels: ["low", "high"] });

      asked.length = 0;
      expect(await agentOf(await changeAgent(administrator, id, { webSearch: true }))).toMatchObject({ format: "chat", webTools: ["search"], thinkingLevels: ["low", "high"] });
      expect(asked.map(({ url }) => url)).toEqual([CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS]);

      // One searching in xAI's own Responses before is asked in Chat Completions from then on, at the levels it takes there.
      await agentWithKeptModel(id, { id: GROK, name: "Grok 4.7", format: "xai", thinkingLevels: ["low", "medium", "high"] });
      expect(await agentOf(await changeAgent(administrator, id, { webSearch: false }))).toMatchObject({ format: "xai", webTools: [] });
      asked.length = 0;
      expect(await agentOf(await changeAgent(administrator, id, { webSearch: true }))).toMatchObject({ format: "chat", webTools: ["search"], thinkingLevels: [...THINKING_LEVELS] });
      expect(asked.every(({ url }) => url === CHAT_COMPLETIONS || url === WEB_SEARCH)).toBe(true);
      expect(await workspaceSql("SELECT format, web_tools FROM agents WHERE user_id = ?", id)).toEqual([{ format: "chat", web_tools: '["search"]' }]);
    });

    it("refuses a model Ember doesn't offer, on its field, before AI Gateway is asked anything", async () => {
      const administrator = await setUp();
      for (const model of [GLM, "openai/gpt-5.5"]) {
        expect(await refusalOf(await makeAgent(administrator, { ...RECAP, model, webSearch: true }))).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
      }
      expect(asked).toEqual([]);
      expect(await workspaceSql("SELECT user_id FROM agents")).toEqual([]);
    });

    it("refuses Search the web for a model that answered without searching, on its field", async () => {
      const administrator = await setUp();
      answer = ({ url }) => sayingHello(url);
      expect(await refusalOf(await makeAgent(administrator, { ...RECAP, webSearch: true }))).toEqual([422, { error: agentAnsweredUnsearched("Claude Haiku 5.5"), field: "webSearch" }]);
      expect(await workspaceSql("SELECT user_id FROM agents")).toEqual([]);
    });

    it("refuses a model AI Gateway won't run, on its field, saving nothing", async () => {
      const administrator = await setUp();
      answer = () => Response.json({ success: false, errors: [{ code: 2003, message: "Forbidden" }], messages: [], result: null }, { status: 403 });
      const [status, refusal] = await refusalOf(await makeAgent(administrator, RECAP));
      expect([status, (refusal as { field?: string }).field]).toEqual([422, "model"]);
      expect(await workspaceSql("SELECT id FROM users WHERE name = 'Recap'")).toEqual([]);
    });

    it("refuses a name someone, a bot or another agent has, in any capitals, and @ember's, before its model is asked", async () => {
      const administrator = await setUp();
      await joinAsGrace();
      await addBot(administrator, "Build Bot");
      await made(administrator);
      asked.length = 0;
      for (const name of ["grace hopper", "BUILD BOT", "@recap", "Ada Lovelace"]) {
        expect(await refusalOf(await makeAgent(administrator, { ...RECAP, name })), name).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
      }
      expect(await refusalOf(await makeAgent(administrator, { ...RECAP, name: "Ember" }))).toEqual([422, { error: NAME_RESERVED, field: "name" }]);
      expect(asked).toEqual([]);
    });

    it("refuses the name of someone banned, or suspended till their membership's renewed, who'd come back with it, but not someone removed", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const taken = async () => expect(await refusalOf(await makeAgent(administrator, { ...RECAP, name: grace.name }))).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
      expect((await api(`/api/users/${member.user.id}/ban`, { method: "POST", headers: as(administrator) })).status).toBe(200);
      await taken();
      expect((await api(`/api/users/${member.user.id}/ban`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
      // As their Memberful membership's lapsing leaves them.
      await workspaceSql("UPDATE users SET status = 3 WHERE id = ?", member.user.id);
      await taken();
      expect((await api(`/api/account/users/${member.user.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
      expect(await made(administrator, { name: grace.name })).toMatchObject({ name: grace.name });
    });

    it(`makes at most ${MAX_AGENTS}, refusing more before the model is asked`, async () => {
      const administrator = await setUp();
      for (let n = 1; n <= MAX_AGENTS; n++) await made(administrator, { name: `Agent ${n}` });
      asked.length = 0;
      expect(await refusalOf(await makeAgent(administrator, { ...RECAP, name: "One more" }))).toEqual([409, { error: AGENTS_FULL }]);
      expect(asked).toEqual([]);
      expect(await listed(administrator)).toHaveLength(MAX_AGENTS);
    });

    it("saves nothing once Ember AI was set up again with another API token while the model answered", async () => {
      const administrator = await setUp();
      answer = async (question) => {
        answer = answering;
        await turnOn(administrator, OTHER_API_TOKEN);
        return answering(question);
      };
      expect(await refusalOf(await makeAgent(administrator, RECAP))).toEqual([409, { error: AGENT_SET_UP_AGAIN }]);
      expect(await listed(administrator)).toEqual([]);
    });

    it("saves nothing once Ember AI was turned off while the model answered", async () => {
      const administrator = await setUp();
      answer = async (question) => {
        await turnOff(administrator);
        return answering(question);
      };
      expect(await refusalOf(await makeAgent(administrator, RECAP))).toEqual([409, { error: ASSISTANT_OFF }]);
      expect(await workspaceSql("SELECT user_id FROM agents")).toEqual([]);
    });
  });

  describe("an agent's page", () => {
    it("changes what it does, its instructions, its levels and its name without asking its model, recording who changed it", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      const member = await joinAsGrace();
      await promote(administrator, member);
      const tab = await openWorkspaceSocket(administrator);
      asked.length = 0;

      const changes = { name: "Digest", description: "Sums up the week", instructions: "Sum up the week's threads.", thinking: "low", length: "medium" } as const;
      const changed = await agentOf(await changeAgent(member, recap.id, changes));
      expect(changed).toEqual({
        ...recap,
        name: "Digest",
        description: changes.description,
        instructions: changes.instructions,
        levels: { thinking: "low", length: "medium" },
        avatarUrl: expect.any(String) as string,
        changedBy: member.user,
        changedAt: expect.any(String) as string,
      });
      expect(changed.changedAt > recap.changedAt).toBe(true);
      expect(asked).toEqual([]);
      expect(await tab.next()).toMatchObject({ type: "user.updated", user: { id: recap.id, name: "Digest" } });

      // Its own name in other capitals is still its own.
      expect(await agentOf(await changeAgent(administrator, recap.id, { name: "DIGEST" }))).toMatchObject({ name: "DIGEST" });
    });

    it("changes what Ember adds around its instructions without asking its model, and puts back Ember's own, which then changes as Ember does", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      expect(recap.promptTemplate).toBeNull();
      asked.length = 0;

      const template = "You are {{name}}, who sums up threads in {{community}}.\n\n{{instructions}}\n\nToday is {{today}}.";
      const changed = await agentOf(await changeAgent(administrator, recap.id, { promptTemplate: `\n${template} ` }));
      expect(changed).toEqual({ ...recap, promptTemplate: template, changedAt: expect.any(String) as string });
      expect(await shownAgent(administrator, recap.id)).toEqual(changed);
      expect(asked).toEqual([]);

      expect(await agentOf(await changeAgent(administrator, recap.id, { promptTemplate: AGENT_TEMPLATE }))).toMatchObject({ promptTemplate: null });
      expect(await workspaceSql("SELECT prompt_template FROM agents")).toEqual([{ prompt_template: null }]);
      // As it's made, too.
      expect(await made(administrator, { name: "Scout", promptTemplate: template })).toMatchObject({ promptTemplate: template });
    });

    it("refuses what Ember adds around its instructions without a place for them, on its field, changing nothing", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      expect(await refusalOf(await changeAgent(administrator, recap.id, { promptTemplate: "You are {{name}}.", instructions: "Sum up." }))).toEqual([
        422,
        { error: INSTRUCTIONS_PLACE_NEEDED, field: "promptTemplate" },
      ]);
      expect(await shownAgent(administrator, recap.id)).toEqual(recap);
    });

    it("changes nothing when nothing's changed", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      asked.length = 0;
      expect(await agentOf(await changeAgent(administrator, recap.id, RECAP))).toEqual(recap);
      expect(await agentOf(await changeAgent(administrator, recap.id, {}))).toEqual(recap);
      expect(asked).toEqual([]);
    });

    it("keeps a model Ember no longer offers, without asking it again, while it isn't changed to one Ember offers", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      await agentWithKeptModel(recap.id, KEPT_GLM);
      asked.length = 0;

      const changed = await agentOf(await changeAgent(administrator, recap.id, { ...RECAP, model: GLM, description: "Sums up the week" }));
      expect(changed).toMatchObject({ model: GLM, modelName: "GLM-4.7 Flash", format: "chat", description: "Sums up the week" });
      expect(asked).toEqual([]);
      expect(await refusalOf(await changeAgent(administrator, recap.id, { model: "openai/gpt-5.5" }))).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
      expect(asked).toEqual([]);
      expect(await agentOf(await changeAgent(administrator, recap.id, { model: HAIKU }))).toMatchObject({ model: HAIKU, modelName: "Claude Haiku 5.5", format: "anthropic" });
      // Once it's changed, the model it kept can't be chosen again.
      expect(await refusalOf(await changeAgent(administrator, recap.id, { model: GLM }))).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
    });

    it("refuses a name someone else has, and @ember's", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      await made(administrator, { name: "Scout" });
      for (const name of ["scout", "ada lovelace"]) {
        expect(await refusalOf(await changeAgent(administrator, recap.id, { name })), name).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
      }
      expect(await refusalOf(await changeAgent(administrator, recap.id, { name: "EMBER" }))).toEqual([422, { error: NAME_RESERVED, field: "name" }]);
      // Nor is a new model asked before a name that's taken is refused.
      asked.length = 0;
      expect(await refusalOf(await changeAgent(administrator, recap.id, { name: "Scout", model: SONNET }))).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
      expect(asked).toEqual([]);
      expect(await shownAgent(administrator, recap.id)).toEqual(recap);
    });

    it("asks a new model its test question, and has it search the web while Search the web is to be on", async () => {
      const administrator = await setUp();
      const scout = await made(administrator, { name: "Scout", model: SONNET, webSearch: true });
      asked.length = 0;

      expect(await agentOf(await changeAgent(administrator, scout.id, { model: GPT, webSearch: false }))).toMatchObject({ model: GPT, modelName: "GPT-6.1 Sol", format: "openai", webTools: [] });
      expect(asked.map(({ url }) => url)).toEqual(Array(5).fill(OPENAI_ENDPOINT));
      expect(asked[0]!.body).toMatchObject({ model: "gpt-6.1-sol" });

      asked.length = 0;
      expect(await agentOf(await changeAgent(administrator, scout.id, { model: SONNET, webSearch: true }))).toMatchObject({
        model: SONNET,
        modelName: "Claude Sonnet 5.5",
        format: "anthropic",
        webTools: ["search", "read"],
      });
      expect(unthinking().map(searches)).toEqual([false, true]);
    });

    it("keeps the levels of thinking its model took its test question at, finding them again only for another model", async () => {
      const administrator = await setUp();
      // As a model that always thinks, and only a little or a lot: OpenAI's Responses asks for no thinking as none.
      answer = (sent) => {
        const effort = (sent.body as { reasoning?: { effort: string } }).reasoning?.effort;
        if (effort !== "none" && effort !== "medium") return answering(sent);
        return Response.json({ success: false, errors: [{ code: 7003, message: `Model execution failed (User Input Error): Unsupported value: '${effort}'` }], messages: [], result: null }, { status: 400 });
      };
      const recap = await made(administrator, { model: GPT });
      expect(recap).toMatchObject({ model: GPT, format: "openai", thinkingLevels: ["low", "high"] });
      expect(await workspaceSql("SELECT thinking_levels FROM agents WHERE user_id = ?", recap.id)).toEqual([{ thinking_levels: '["low","high"]' }]);

      // Kept while its model is, without asking it again.
      asked.length = 0;
      expect(await agentOf(await changeAgent(administrator, recap.id, { description: "Sums up the week", thinking: "medium" }))).toMatchObject({ thinkingLevels: ["low", "high"], levels: { thinking: "medium" } });
      expect(asked).toEqual([]);

      // Another model takes its test question at each level again.
      answer = answering;
      expect(await agentOf(await changeAgent(administrator, recap.id, { model: SONNET }))).toMatchObject({ model: SONNET, thinkingLevels: [...THINKING_LEVELS] });
      expect(asked.filter(thinks)).toHaveLength(4);

      // An agent given its model before Ember asked at each level has none.
      await workspaceSql("UPDATE agents SET thinking_levels = NULL");
      expect(await shownAgent(administrator, recap.id)).toMatchObject({ model: SONNET, thinkingLevels: null });
    });

    it("turns Search the web on by having the model search, and off without asking it", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      asked.length = 0;
      // Its model took its test question already, so it only searches.
      expect(await agentOf(await changeAgent(administrator, recap.id, { webSearch: true }))).toMatchObject({ webTools: ["search", "read"] });
      expect(asked.map(searches)).toEqual([true]);
      asked.length = 0;
      expect(await agentOf(await changeAgent(administrator, recap.id, { webSearch: false }))).toMatchObject({ webTools: [] });
      expect(asked).toEqual([]);

      // A model kept from before that can't search can't have it on.
      const juniper = await made(administrator, { name: "Juniper" });
      await agentWithKeptModel(juniper.id, KEPT_DEEPSEEK);
      expect(await refusalOf(await changeAgent(administrator, juniper.id, { webSearch: true }))).toEqual([422, { error: agentCannotSearchWith("DeepSeek V4 Pro"), field: "webSearch" }]);
      expect(await shownAgent(administrator, juniper.id)).toMatchObject({ model: KEPT_DEEPSEEK.id, webTools: [] });
    });

    it("moves it between every open room and the ones picked, keeping the closed rooms it was added to", async () => {
      const administrator = await setUp();
      const support = await createRoom("Support", { as: administrator });
      const recap = await made(administrator);
      const leads = await createRoom("Leads", { closedTo: [administrator.user.id, recap.id], as: administrator });
      expect(await roomsOf(recap.id)).toContain(leads.id);

      expect(await agentOf(await changeAgent(administrator, recap.id, { rooms: [support.id] }))).toMatchObject({ rooms: [{ id: support.id, name: "Support" }] });
      expect(await roomsOf(recap.id)).toEqual([support.id, leads.id].sort());
      const later = await createRoom("Later", { as: administrator });
      expect(await roomsOf(recap.id)).not.toContain(later.id);

      expect(await agentOf(await changeAgent(administrator, recap.id, { rooms: null }))).toMatchObject({ rooms: null });
      expect(await roomsOf(recap.id)).toEqual([...(await openRooms()), leads.id].sort());
    });

    it("saves nothing once the agent was changed while its new model answered", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      answer = async (question) => {
        answer = answering;
        await agentOf(await changeAgent(administrator, recap.id, { description: "Sums up the week" }));
        return answering(question);
      };
      expect(await refusalOf(await changeAgent(administrator, recap.id, { model: SONNET }))).toEqual([409, { error: AGENT_CHANGED }]);
      expect(await shownAgent(administrator, recap.id)).toMatchObject({ model: HAIKU, description: "Sums up the week" });
    });

    it("gives it the avatar an administrator uploads, and takes it away", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      const form = new FormData();
      form.append("user", JSON.stringify({ description: "Sums up threads" }));
      form.append("avatar", new File([recordedImage("moon-thumb.jpg")], "moon.jpg", { type: "image/jpeg" }));
      form.append("variant", new File([recordedImage("moon-avatar.webp")], "blob", { type: "image/webp" }));

      const pictured = await agentOf(await api(`/api/account/agents/${recap.id}`, { method: "PATCH", ...(await sent(form, administrator)) }));
      expect(pictured).toMatchObject({ avatar: true, description: "Sums up threads" });
      expect(pictured.avatarUrl).not.toBe(recap.avatarUrl);
      const picture = await api(pictured.avatarUrl, { headers: as(administrator) });
      expect(picture.headers.get("Content-Type")).toBe("image/webp");
      expect(new Uint8Array(await picture.arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));

      const plain = await agentOf(await removeAvatar(administrator, recap.id));
      expect(plain).toMatchObject({ avatar: false, description: "Sums up threads" });
      expect(plain.avatarUrl).not.toBe(pictured.avatarUrl);
      // Without one, there's nothing to take away.
      expect(await agentOf(await removeAvatar(administrator, recap.id))).toEqual(plain);
    });
  });

  describe("Delete agent", () => {
    it("deactivates it as deleting a bot does, taking it out of its rooms and freeing its name", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      const tab = await openWorkspaceSocket(administrator);
      expect((await deleteAgent(administrator, recap.id)).status).toBe(204);
      expect(await tab.next()).toMatchObject({ type: "user.updated", user: { id: recap.id, status: "deactivated" } });
      expect(await roomsOf(recap.id)).toEqual([]);
      expect(await listed(administrator)).toEqual([]);
      expect((await showAgent(administrator, recap.id)).status).toBe(404);
      expect((await deleteAgent(administrator, recap.id)).status).toBe(404);
      expect(await made(administrator)).toMatchObject({ name: "Recap" });
    });
  });

  describe("with Ember AI", () => {
    it("go when it's turned off, and come back as they were when it's on again, in the open rooms there are then", async () => {
      const administrator = await setUp();
      const [support, launch] = [await createRoom("Support", { as: administrator }), await createRoom("Launch", { as: administrator })];
      const recap = await made(administrator);
      const juniper = await made(administrator, { name: "Juniper", model: GPT, rooms: [support.id, launch.id] });
      const leads = await createRoom("Leads", { closedTo: [administrator.user.id, recap.id], as: administrator });
      const tab = await openWorkspaceSocket(administrator);
      const everyone = [ASSISTANT_ID, juniper.id, recap.id].sort();

      await turnOff(administrator);
      expect((await heardOf(tab, 3)).map(({ id, status }) => [id, status])).toEqual(everyone.map((id) => [id, "deactivated"]));
      // Nor does lifting a ban, as People can someone's, let one back.
      for (const { id } of [recap, juniper]) expect((await api(`/api/users/${id}/ban`, { method: "DELETE", headers: as(administrator) })).status).toBe(404);
      expect(await roomsOf(recap.id)).toEqual([]);
      expect(await roomsOf(juniper.id)).toEqual([]);
      expect(await inDirectory(administrator, recap.id)).toMatchObject({ status: "deactivated", agent: true });

      // Meanwhile, an open room is made, and one Juniper was in is closed.
      const later = await createRoom("Later", { as: administrator });
      await changeRoom(administrator, support.id, { kind: "closed", memberIds: [administrator.user.id] });

      await turnOn(administrator);
      expect((await heardOf(tab, 3)).map(({ id, status, agent }) => [id, status, agent])).toEqual(everyone.map((id) => [id, "active", true]));
      expect(await roomsOf(recap.id)).toEqual(await openRooms());
      expect(await roomsOf(recap.id)).toContain(later.id);
      expect(await roomsOf(recap.id)).not.toContain(leads.id);
      expect(await roomsOf(juniper.id)).toEqual([launch.id]);
      expect(await workspaceSql("SELECT kept_rooms FROM agents")).toEqual([{ kept_rooms: null }, { kept_rooms: null }]);
      expect(await shownAgent(administrator, recap.id)).toEqual({ ...recap, avatarUrl: expect.any(String) as string });
      expect(await shownAgent(administrator, juniper.id)).toEqual({ ...juniper, rooms: [{ id: launch.id, name: "Launch" }], avatarUrl: expect.any(String) as string });
    });
  });

  describe("names", () => {
    it("are kept from people and bots, whether Ember AI is on or off", async () => {
      const administrator = await setUp();
      await made(administrator);
      const member = await joinAsGrace();
      const bot = await addBot(administrator, "Build Bot");

      for (const on of [true, false]) {
        if (!on) await turnOff(administrator);
        const renamed = await api("/api/users/me/profile", { method: "PATCH", headers: as(member), body: JSON.stringify({ name: "recap" }) });
        expect(await refusalOf(renamed)).toEqual([422, { error: agentsName("recap") }]);
        expect(await refusalOf(await join({ name: "RECAP", emailAddress: `katherine.${on}@example.com`, password: "orbital mechanics" }))).toEqual([
          422,
          { error: agentsName("RECAP"), field: "name" },
        ]);
        expect(await refusalOf(await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Recap" }) }))).toEqual([422, { error: agentsName("Recap") }]);
        const named = await api("/api/account/bots", { method: "POST", headers: as(administrator), body: JSON.stringify({ name: "RECAP" }) });
        expect(await refusalOf(named)).toEqual([422, { error: agentsName("RECAP") }]);
        const botRenamed = await api(`/api/account/bots/${bot.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ name: "recap" }) });
        expect(await refusalOf(botRenamed)).toEqual([422, { error: agentsName("recap") }]);
      }
      expect(await inDirectory(administrator, member.user.id)).toMatchObject({ name: "Grace Hopper" });
      expect(await inDirectory(administrator, bot.id)).toMatchObject({ name: "Build Bot" });
    });

    it("are nobody's username, nor can an agent be called by someone's, as typing @ finds both", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      const member = await joinAsGrace();
      const renamed = await api("/api/users/me/profile", { method: "PATCH", headers: as(member), body: JSON.stringify({ username: "RECAP" }) });
      expect(await refusalOf(renamed)).toEqual([422, { error: USERNAME_TAKEN }]);

      const named = await api("/api/users/me/profile", { method: "PATCH", headers: as(member), body: JSON.stringify({ username: "scout" }) });
      expect(named.status, await named.clone().text()).toBe(200);
      expect(await refusalOf(await makeAgent(administrator, { ...RECAP, name: "Scout" }))).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
      expect(await refusalOf(await changeAgent(administrator, recap.id, { name: "SCOUT" }))).toEqual([422, { error: NAME_TAKEN, field: "name" }]);

      // Someone removed keeps their username, as lifting a ban lets back even them.
      expect((await api(`/api/account/users/${member.user.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
      expect(await refusalOf(await makeAgent(administrator, { ...RECAP, name: "Scout" }))).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
      expect(await refusalOf(await changeAgent(administrator, recap.id, { name: "SCOUT" }))).toEqual([422, { error: NAME_TAKEN, field: "name" }]);
    });
  });

  describe("beside bots and people", () => {
    it("aren't on the bots page, nor removed, banned or let back from the people page", async () => {
      const administrator = await setUp();
      const support = await createRoom("Support", { as: administrator });
      // Kept to a room picked, which lifting a ban would undo, as it puts whoever it lets back in every open room.
      const recap = await made(administrator, { rooms: [support.id] });
      expect(((await (await api("/api/account/bots", { headers: as(administrator) })).json()) as Bots).bots).toEqual([]);
      for (const response of [
        await api(`/api/account/bots/${recap.id}`, { headers: as(administrator) }),
        await api(`/api/account/bots/${recap.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ name: "Mine" }) }),
        await api(`/api/account/bots/${recap.id}/key`, { method: "PUT", headers: as(administrator) }),
        await api(`/api/account/bots/${recap.id}`, { method: "DELETE", headers: as(administrator) }),
        await api(`/api/account/users/${recap.id}`, { method: "DELETE", headers: as(administrator) }),
        await api(`/api/users/${recap.id}/ban`, { method: "POST", headers: as(administrator) }),
        await api(`/api/users/${recap.id}/ban`, { method: "DELETE", headers: as(administrator) }),
      ]) {
        expect(response.status).toBe(404);
      }
      expect(await shownAgent(administrator, recap.id)).toEqual(recap);
      expect(await roomsOf(recap.id)).toEqual([support.id]);
    });
  });

  describe("across the chat", () => {
    it("are agents to the people directory, as @ember is and no bot or person, and stay agents once deleted, as their answers stay", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const bot = await addBot(administrator, "Build Bot");
      const tab = await openWorkspaceSocket(member);
      const recap = await made(administrator);
      expect(await heardOf(tab, 1)).toEqual([expect.objectContaining({ id: recap.id, status: "active", agent: true })]);
      for (const id of [recap.id, ASSISTANT_ID]) expect(await inDirectory(member, id)).toHaveProperty("agent", true);
      for (const id of [administrator.user.id, member.user.id, bot.id]) expect(await inDirectory(member, id)).not.toHaveProperty("agent");

      expect((await deleteAgent(administrator, recap.id)).status).toBe(204);
      expect(await heardOf(tab, 1)).toEqual([expect.objectContaining({ id: recap.id, status: "deactivated", agent: true })]);
      expect(await inDirectory(member, recap.id)).toMatchObject({ status: "deactivated", agent: true });
      expect((await api(`/api/account/bots/${bot.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(204);
      expect(await inDirectory(member, bot.id)).toMatchObject({ status: "deactivated" });
      expect(await inDirectory(member, bot.id)).not.toHaveProperty("agent");
    });

    it("are offered in the mentions prompt badged as agents, as @ember is, and no bot or person", async () => {
      const administrator = await setUp();
      const recap = await made(administrator);
      const bot = await addBot(administrator, "Build Bot");
      const response = await api("/api/autocompletable/users", { headers: as(administrator) });
      expect(response.status, await response.clone().text()).toBe(200);
      const card = async (userId: UserId) => {
        const { id, name, avatarUrl } = (await inDirectory(administrator, userId))!;
        return { id, name, avatarUrl };
      };
      expect(await response.text()).toBe(
        mentionPromptItem(await card(administrator.user.id)) +
          mentionPromptItem(await card(bot.id)) +
          mentionPromptItem({ ...(await card(ASSISTANT_ID)), agent: true }) +
          mentionPromptItem({ ...(await card(recap.id)), agent: true }),
      );
    });

    it("show everyone what they do, the model they answer with and who set them up on their pages, but not their instructions", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const recap = await made(administrator);
      const profile = { description: RECAP.description, model: HAIKU, modelName: recap.modelName, setUpBy: { id: administrator.user.id, name: ada.name } };
      expect(await pageOf(member, recap.id)).toEqual({ person: await inDirectory(member, recap.id), agent: profile });
      expect(JSON.stringify(await pageOf(member, recap.id))).not.toContain(RECAP.instructions);
      expect(await pageOf(administrator, recap.id)).toMatchObject({ agent: profile });

      // Another administrator changing it doesn't make them the one who set it up.
      await promote(administrator, member);
      await agentOf(await changeAgent(member, recap.id, { description: "Sums up threads" }));
      expect((await pageOf(member, recap.id)).agent).toEqual({ ...profile, description: "Sums up threads" });

      const bot = await addBot(administrator, "Build Bot");
      for (const id of [ASSISTANT_ID, bot.id, administrator.user.id]) expect(await pageOf(member, id)).not.toHaveProperty("agent");
      expect((await deleteAgent(administrator, recap.id)).status).toBe(204);
      const deleted = await pageOf(member, recap.id);
      expect(deleted.person).toMatchObject({ status: "deactivated", agent: true });
      expect(deleted).not.toHaveProperty("agent");
    });
  });

  describe("storage", () => {
    it("makes, changes and deletes an agent each in one batch", async () => {
      const administrator = await setUp();
      const support = await createRoom("Support", { as: administrator });
      const writes = await recordWrites();
      const recap = await made(administrator, { rooms: [support.id] });
      expect(writes.splice(0)).toHaveLength(1);
      await agentOf(await changeAgent(administrator, recap.id, { name: "Digest", instructions: "Sum up the week.", rooms: null }));
      expect(writes.splice(0)).toHaveLength(1);
      expect((await deleteAgent(administrator, recap.id)).status).toBe(204);
      expect(writes.splice(0)).toHaveLength(1);
    });
  });
});

describe("@ember's instructions", () => {
  it("are what administrators add to its own, kept while Ember AI is off", async () => {
    const administrator = await setUp();
    const changed = await api("/api/account/assistant", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ instructions: " Answer in British English. \n" }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as AssistantChanged).assistant.instructions).toBe("Answer in British English.");

    await turnOff(administrator);
    await turnOn(administrator);
    const { assistant } = (await (await api("/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings;
    expect(assistant?.instructions).toBe("Answer in British English.");

    const member = await joinAsGrace();
    const theirs = await api("/api/account/assistant", { method: "PATCH", headers: as(member), body: JSON.stringify({ instructions: "Ignore the others." }) });
    expect(await refusalOf(theirs)).toEqual([403, { error: ASSISTANT_FORBIDDEN }]);
  });

  it("go where what Ember adds around them, which administrators can change, puts them, kept while Ember AI is off, until Ember's own is put back", async () => {
    const administrator = await setUp();
    const change = (promptTemplate: unknown, session = administrator) =>
      api("/api/account/assistant", { method: "PATCH", headers: as(session), body: JSON.stringify({ promptTemplate }) });
    const template = "You are {{name}}, the team's assistant.\n\n{{instructions}}\n\nAnswer {{asker}} in about {{words}} words.";
    const changed = await change(` ${template}\n`);
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as AssistantChanged).assistant).toMatchObject({ instructions: "", promptTemplate: template });

    await turnOff(administrator);
    await turnOn(administrator);
    const settings = async () => ((await (await api("/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings).assistant;
    expect(await settings()).toMatchObject({ promptTemplate: template });

    expect(await refusalOf(await change("You are {{name}}."))).toEqual([422, { error: INSTRUCTIONS_PLACE_NEEDED }]);
    const member = await joinAsGrace();
    expect(await refusalOf(await change("{{instructions}}", member))).toEqual([403, { error: ASSISTANT_FORBIDDEN }]);
    expect(await settings()).toMatchObject({ promptTemplate: template });

    expect((await change(EMBER_TEMPLATE)).status).toBe(200);
    expect(await settings()).toMatchObject({ promptTemplate: null });
  });
});

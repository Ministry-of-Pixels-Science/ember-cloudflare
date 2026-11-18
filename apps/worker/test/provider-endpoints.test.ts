import { ASSISTANT_ID, type Message, type NewWorkspace, type RoomId, type User } from "@ember/protocol";
import type { AgentAnswer, AgentSettings, NewAgent } from "@ember/protocol/agents";
import { providerFormatOf, THINKING_LEVELS, type ModelFormat } from "@ember/protocol/assistant";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS_PER_MOVE, providerMovesOf } from "../src/assistant/model-tests";
import type { Env } from "../src/env";
import type { Workspace } from "../src/workspace";
import { addKeptModels, agentWithKeptModel, answerWithKeptModel, api, connect, cookieOf, freshDeploy, post, shown, workspaceSql, workspaceStub, type Client, type KeptModel, type Session } from "./support";

// Moving the models Ember AI kept before it asked Claude and GPT through their providers' own
// endpoints on AI Gateway first, the agents' too, once, at the first answers after it's set up.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const CLOUDFLARE_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`;
/** Where the account's default gateway passes requests on to each provider's own API. */
const PROVIDER_ENDPOINTS = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/default`;
const ANTHROPIC_ENDPOINT = `${PROVIDER_ENDPOINTS}/anthropic/v1/messages`;
const OPENAI_ENDPOINT = `${PROVIDER_ENDPOINTS}/openai/responses`;
/** Claude and GPT, which their providers' endpoints take, and Grok and one of Workers AI's, which Ember asks through Cloudflare's REST API. */
const [SONNET, HAIKU, GPT, GROK, GLM] = ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "openai/gpt-6.1-sol", "xai/grok-4.7", "@cf/zai-org/glm-4.7-flash"];
const ALL_LEVELS = [...THINKING_LEVELS];
/** Claude and GPT models as Cloudflare's REST API takes them, one more than a move asks through their providers' endpoints. */
const REST_ASKED: Array<{ id: string; name: string; format: ModelFormat }> = [
  { id: SONNET, name: "Claude Sonnet 5.5", format: "messages" },
  { id: HAIKU, name: "Claude Haiku 5.5", format: "messages" },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", format: "messages" },
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5", format: "messages" },
  { id: "anthropic/claude-fable-5.2", name: "Claude Fable 5.2", format: "messages" },
  { id: GPT, name: "GPT-6.1 Sol", format: "responses" },
  { id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", format: "responses" },
  { id: "openai/gpt-6", name: "GPT-6", format: "responses" },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", format: "responses" },
];
/** The one of `REST_ASKED` a move has no room for, as it moves. */
const LAST_MOVED = { id: "openai/gpt-6-luna", from: "responses", format: "openai", thinkingLevels: ALL_LEVELS };
/** `model` as Ember AI kept it, at every level of thinking, as it did a model before it asked it through its provider's endpoint. */
const keptAs = (model: Omit<KeptModel, "thinkingLevels">): KeptModel => ({ ...model, thinkingLevels: ALL_LEVELS });
/** The model `id` of `REST_ASKED`, kept as Cloudflare's REST API takes it. */
const restAsked = (id: string) => keptAs(REST_ASKED.find((model) => model.id === id)!);
const KEPT_GLM = keptAs({ id: GLM, name: "GLM-4.7 Flash", format: "chat" });
/** Grok as Ember AI kept it, and keeps asking it, through Cloudflare's REST API. */
const KEPT_GROK = keptAs({ id: GROK, name: "Grok 4.7", format: "chat" });
/** What the test question asks a model, at each level of thinking too. */
const SAY_HELLO = "Say hello to the team in one short sentence.";

/** What `model`'s provider calls it, as AI Gateway's endpoint for the provider takes it. */
function providerNameOf(model: string): string {
  const name = model.slice(model.indexOf("/") + 1);
  return model.startsWith("anthropic/") ? name.replaceAll(".", "-") : name;
}

/** A request the fake AI Gateway was sent. */
interface Asked {
  url: string;
  aigAuthorization: string | null;
  body: { model?: string; tools?: Array<{ type?: string }>; thinking?: unknown; reasoning?: { effort?: string }; reasoning_effort?: string };
}

/** A page the model finds on the web, as Anthropic's Messages gives it, and its answer citing it. */
const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs" };
const SEARCHED = [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Cloudflare AI Gateway" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", ...DOCS, encrypted_content: "e", page_age: null }] },
  { type: "text", text: "AI Gateway is Cloudflare's proxy for AI models.", citations: [{ type: "web_search_result_location", ...DOCS, encrypted_index: "e", cited_text: "…" }] },
];

/** Whether the providers' endpoints take Ember AI's API token, as they do one with AI Gateway Run. */
let run: boolean;
/** The models, by their providers' names for them, that their providers' endpoints don't know. */
let unknownThere: string[];
/** What the answer to the next request to the providers' endpoints waits for, as the fake gave it when it was sent (see `holdNextThere`). */
let holding: Promise<void> | null;
let asked: Asked[];

/**
 * Stands in for AI Gateway, whose models say hello in the format of the API they're asked through, or,
 * as Anthropic's do, search the web whenever they're given a tool for it, but for Grok, which refuses
 * its thinking being turned off in xAI's own Responses, and the providers' endpoints, which refuse an
 * API token without AI Gateway Run while `run` is off, and the models `unknownThere` names.
 */
function answering({ url, body }: Asked): Response {
  if (url.startsWith(PROVIDER_ENDPOINTS) && !run) return Response.json({ success: false, result: [], messages: [], error: [{ code: 2009, message: "Unauthorized" }] }, { status: 401 });
  if (url.startsWith(PROVIDER_ENDPOINTS) && unknownThere.includes(body.model ?? "")) return Response.json({ type: "error", error: { type: "not_found_error", message: `model: ${body.model}` } }, { status: 404 });
  if (url.endsWith("/messages")) {
    const content = (body.tools ?? []).some(({ type }) => type?.startsWith("web_search")) ? SEARCHED : [{ type: "text", text: "Hello, team!" }];
    return Response.json({ type: "message", role: "assistant", content, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
  }
  if (url.endsWith("/responses")) return Response.json({ object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello, team!" }] }] });
  return Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello, team!" }, finish_reason: "stop" }] });
}

beforeEach(async () => {
  await freshDeploy();
  run = true;
  unknownThere = [];
  holding = null;
  asked = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const sent = { url: request.url, aigAuthorization: request.headers.get("cf-aig-authorization"), body: (await request.json()) as Asked["body"] };
    asked.push(sent);
    const answer = answering(sent);
    const held = sent.url.startsWith(PROVIDER_ENDPOINTS) ? holding : null;
    if (held) await ((holding = null), held);
    return answer;
  });
});

/** Has the fake AI Gateway hold its answer to the next request to the providers' endpoints, as it gave it then, until the function this answers is called. */
function holdNextThere(): () => void {
  let release!: () => void;
  holding = new Promise<void>((resolve) => (release = resolve));
  return release;
}
afterEach(() => vi.restoreAllMocks());

const as = (session: Session) => ({ Cookie: session.cookie });

/** Sets Ember up with Ada as its administrator, signed in, answering her session and the general room. */
async function setUp(): Promise<{ ada: Session; general: RoomId }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada, general };
}

/** Sets Ember AI up as `administrator`, with `model` answering everyone, which has to work. */
async function setUpAssistant(administrator: Session, model: string): Promise<void> {
  const response = await api("/api/account/assistant", { method: "PUT", headers: as(administrator), body: JSON.stringify({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Turns Search the web on as `administrator`, which has to work. */
async function turnOnWebSearch(administrator: Session): Promise<void> {
  const response = await api("/api/account/assistant/web_search", { method: "PUT", headers: as(administrator), body: JSON.stringify({ on: true }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Makes an agent called `name` on `model` as `administrator`, in every open room, as New agent does. */
async function makeAgent(administrator: Session, name: string, model: string): Promise<AgentSettings> {
  const agent: NewAgent = { name, description: "Helps out", instructions: "Help out.", model, thinking: "off", length: "short", webSearch: false, rooms: null };
  const response = await api("/api/account/agents", { method: "POST", headers: as(administrator), body: JSON.stringify(agent) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as AgentAnswer).agent;
}

/** Ember AI as the account's settings keep it. */
const storedAssistant = async () =>
  (JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as [{ settings: string }])[0].settings) as {
    assistant: { format: string; models: Array<{ id: string; format: string; thinking_levels?: string[] }>; web_tools: string[]; provider_endpoints_tried_at: string | null };
  }).assistant;

/** The format that answers everyone, and each model people can pick with its format and levels of thinking, as the account's settings keep them. */
async function storedModels(): Promise<[string, Array<[string, string, string[] | undefined]>]> {
  const { format, models } = await storedAssistant();
  return [format, models.map(({ id, format, thinking_levels }) => [id, format, thinking_levels])];
}

/** Each agent's model, format and levels of thinking, by its model. */
const agentModels = async () =>
  ((await workspaceSql("SELECT model, format, thinking_levels FROM agents ORDER BY model")) as Array<{ model: string; format: string; thinking_levels: string }>).map(
    ({ model, format, thinking_levels }) => [model, format, JSON.parse(thinking_levels) as string[]],
  );

/** Asks `bot` something in the room `client` is in, as `client`'s person, answering what it said. */
async function ask(client: Client, bot: Pick<User, "id">): Promise<Message> {
  await post(client, `<p><action-text-attachment sgid="${mentionSgid(bot.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment> what's new?</p>`);
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.creator.id === bot.id) return message;
  }
}

/** Waits for Ember to have asked Ember AI's models through their providers' endpoints, which it does in the background. */
const tried = () => vi.waitFor(async () => expect((await storedAssistant()).provider_endpoints_tried_at).toEqual(expect.any(String)), { timeout: 5_000 });

/** Waits for the move onto the providers' endpoints that the Workspace makes in the background, if it's making one, to end. */
const moveEnded = () => runInDurableObject(workspaceStub(), (workspace: Workspace) => (workspace as unknown as { movingToProviderEndpoints: Promise<void> | null }).movingToProviderEndpoints);

/** The test questions among the requests to the providers' endpoints, but for those asking again at each level of thinking, as `[endpoint, model]`. */
const testQuestionsThere = () =>
  asked
    .filter(({ url, body }) => url.startsWith(PROVIDER_ENDPOINTS) && JSON.stringify(body).includes(SAY_HELLO) && !("thinking" in body || "reasoning" in body || "reasoning_effort" in body))
    .map(({ url, body }) => [url, body.model]);

/** How many of the models people can pick are asked in their providers' formats, as the account's settings keep them. */
const movedCount = async () => (await storedModels())[1].filter(([id, format]) => format === providerFormatOf(id)).length;

const EMBER = { id: ASSISTANT_ID };

describe("Models Ember AI asked through Cloudflare's REST API", () => {
  it("move onto their providers' endpoints at the first answer after it's set up, the agents' too, at the levels they take there, keeping what they do on the web", async () => {
    const { ada, general } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setUpAssistant(ada, SONNET);
    const [recap, scout] = [await makeAgent(ada, "Recap", HAIKU), await makeAgent(ada, "Scout", GPT)];
    // Kept while Ember AI's API token had no AI Gateway Run, so they were asked through Cloudflare's REST API,
    // and Search the web turned on before Grok was added, as turning it on would ask Grok through xAI's endpoint.
    await answerWithKeptModel(restAsked(SONNET));
    await turnOnWebSearch(ada);
    expect((await storedAssistant()).web_tools).toEqual(["search", "read"]);
    await addKeptModels(restAsked(GPT), KEPT_GROK, KEPT_GLM);
    await agentWithKeptModel(recap.id, restAsked(HAIKU));
    await agentWithKeptModel(scout.id, restAsked(GPT));

    // @ember's first answer is in the format it's saved in, while each model is asked through its provider's endpoint behind it.
    asked.length = 0;
    const client = await connect(general, ada);
    expect((await ask(client, EMBER)).plainText).toContain("AI Gateway is Cloudflare's proxy for AI models.");
    await tried();
    expect(asked.filter(({ url }) => !url.startsWith(PROVIDER_ENDPOINTS)).map(({ url, body }) => [url, body.model])).toEqual([[`${CLOUDFLARE_API}/messages`, SONNET]]);
    // Each once, the agents' GPT with the GPT people pick, by the names their providers give them, with the API token as AI Gateway's alone.
    expect(testQuestionsThere().sort()).toEqual(
      [
        [ANTHROPIC_ENDPOINT, "claude-haiku-5-5"],
        [ANTHROPIC_ENDPOINT, "claude-sonnet-5-5"],
        [OPENAI_ENDPOINT, "gpt-6.1-sol"],
      ].sort(),
    );
    expect(asked.filter(({ url }) => url.startsWith(PROVIDER_ENDPOINTS)).every(({ aigAuthorization }) => aigAuthorization === `Bearer ${API_TOKEN}`)).toBe(true);
    expect(await storedModels()).toEqual([
      "anthropic",
      [
        [SONNET, "anthropic", ALL_LEVELS],
        [GPT, "openai", ALL_LEVELS],
        // Grok stays, as AI Gateway's credits pay for it only through the REST API.
        [GROK, "chat", ALL_LEVELS],
        [GLM, "chat", ALL_LEVELS],
      ],
    ]);
    // The provider's own endpoint takes the tools the REST API passed on to it.
    expect((await storedAssistant()).web_tools).toEqual(["search", "read"]);
    expect(await agentModels()).toEqual([
      [HAIKU, "anthropic", ALL_LEVELS],
      [GPT, "openai", ALL_LEVELS],
    ]);

    // From then on, through the Anthropic endpoint, and without asking any model again.
    asked.length = 0;
    expect((await ask(client, EMBER)).plainText).toContain("AI Gateway is Cloudflare's proxy for AI models.");
    expect(asked.map(({ url, body }) => [url, body.model])).toEqual([[ANTHROPIC_ENDPOINT, "claude-sonnet-5-5"]]);
    client.close();
  });

  it("stay where they are while their providers' endpoints don't take the API token, and are asked there again once Ember AI is set up again", async () => {
    const { ada, general } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await setUpAssistant(ada, SONNET);
    const recap = await makeAgent(ada, "Recap", HAIKU);
    // Kept while Ember AI's API token had no AI Gateway Run, as it still hasn't.
    await answerWithKeptModel(restAsked(SONNET), restAsked(GPT));
    await agentWithKeptModel(recap.id, restAsked(HAIKU));
    run = false;
    asked.length = 0;

    // An agent's first answer finds them, as @ember's does, and the first one's endpoint refusing the token says every endpoint does.
    const client = await connect(general, ada);
    await ask(client, recap);
    await tried();
    expect(asked.filter(({ url }) => url.startsWith(PROVIDER_ENDPOINTS)).map(({ url, body }) => [url, body.model])).toEqual([[ANTHROPIC_ENDPOINT, "claude-sonnet-5-5"]]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`Asking ${SONNET} through Cloudflare's REST API still, as AI Gateway's endpoint for its provider didn't answer it:`));
    expect(await storedModels()).toEqual([
      "messages",
      [
        [SONNET, "messages", ALL_LEVELS],
        [GPT, "responses", ALL_LEVELS],
      ],
    ]);
    expect(await agentModels()).toEqual([[HAIKU, "messages", ALL_LEVELS]]);

    // Not asked again at the next answer.
    asked.length = 0;
    await ask(client, EMBER);
    expect(asked.map(({ url }) => url)).toEqual([`${CLOUDFLARE_API}/messages`]);

    // Set up again once the token has AI Gateway Run, the model it chose goes through the Anthropic endpoint, and the next answer moves the rest.
    run = true;
    await setUpAssistant(ada, SONNET);
    expect((await storedAssistant()).provider_endpoints_tried_at).toBeNull();
    expect(await storedModels()).toEqual([
      "anthropic",
      [
        [SONNET, "anthropic", ALL_LEVELS],
        [GPT, "responses", ALL_LEVELS],
      ],
    ]);
    asked.length = 0;
    await ask(client, EMBER);
    await tried();
    expect(testQuestionsThere().sort()).toEqual(
      [
        [ANTHROPIC_ENDPOINT, "claude-haiku-5-5"],
        [OPENAI_ENDPOINT, "gpt-6.1-sol"],
      ].sort(),
    );
    expect(await storedModels()).toEqual([
      "anthropic",
      [
        [SONNET, "anthropic", ALL_LEVELS],
        [GPT, "openai", ALL_LEVELS],
      ],
    ]);
    expect(await agentModels()).toEqual([[HAIKU, "anthropic", ALL_LEVELS]]);
    client.close();
  });

  it("are asked there again at the next answer after Ember AI is set up again while a move asks them, whatever that move finds", async () => {
    const { ada, general } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setUpAssistant(ada, SONNET);
    // Kept while Ember AI's API token had no AI Gateway Run, as it still hasn't.
    await answerWithKeptModel(restAsked(SONNET), restAsked(GPT));
    run = false;
    const release = holdNextThere();

    // The first answer's move waits for the endpoint to refuse the token while the token gets AI Gateway Run and Ember AI is set up again with it.
    const client = await connect(general, ada);
    await ask(client, EMBER);
    await vi.waitFor(() => expect(holding).toBeNull(), { timeout: 5_000 });
    run = true;
    await setUpAssistant(ada, SONNET);
    release();
    await moveEnded();
    expect((await storedAssistant()).provider_endpoints_tried_at).toBeNull();
    expect(await storedModels()).toEqual([
      "anthropic",
      [
        [SONNET, "anthropic", ALL_LEVELS],
        [GPT, "responses", ALL_LEVELS],
      ],
    ]);

    asked.length = 0;
    await ask(client, EMBER);
    await tried();
    expect(testQuestionsThere()).toEqual([[OPENAI_ENDPOINT, "gpt-6.1-sol"]]);
    expect(await storedModels()).toEqual([
      "anthropic",
      [
        [SONNET, "anthropic", ALL_LEVELS],
        [GPT, "openai", ALL_LEVELS],
      ],
    ]);
    client.close();
  });

  it("move as many as a move has room for at an answer, and the rest at the next", async () => {
    const { ada, general } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setUpAssistant(ada, SONNET);
    await answerWithKeptModel(restAsked(SONNET), ...REST_ASKED.slice(1).map(keptAs));
    asked.length = 0;
    const client = await connect(general, ada);
    await ask(client, EMBER);
    await vi.waitFor(async () => expect(await movedCount()).toBeGreaterThanOrEqual(MODELS_PER_MOVE), { timeout: 5_000 });
    await ask(client, EMBER);
    await tried();
    expect((await storedModels())[1]).toEqual(REST_ASKED.map(({ id }) => [id, providerFormatOf(id), ALL_LEVELS]));
    // Each once.
    expect(testQuestionsThere()).toHaveLength(REST_ASKED.length);
    client.close();
  });
});

describe("A move onto the providers' endpoints", () => {
  const gateway = { accountId: ACCOUNT_ID, apiToken: API_TOKEN };
  const bindings = env as unknown as Env;
  beforeEach(() => void vi.spyOn(console, "log").mockImplementation(() => {}));

  it("asks as many of the models asked through Cloudflare's REST API as it has room for, each once, and leaves the rest to the next", async () => {
    expect(REST_ASKED).toHaveLength(MODELS_PER_MOVE + 1);
    // Workers AI's, Grok, and those asked through their providers' endpoints already, take no room.
    const saved = [{ id: GLM, format: "chat" as const }, { id: GROK, format: "chat" as const }, { id: "anthropic/claude-sonnet-5", format: "anthropic" as const }, ...REST_ASKED, { id: SONNET, format: "messages" as const }];
    const { moves, done } = await providerMovesOf(bindings, gateway, saved);
    expect(done).toBe(false);
    const asked = REST_ASKED.slice(0, MODELS_PER_MOVE);
    expect(moves.map(({ id, from, format }) => [id, from, format])).toEqual(asked.map(({ id, format }) => [id, format, providerFormatOf(id)]));
    expect(testQuestionsThere()).toHaveLength(MODELS_PER_MOVE);

    const left = REST_ASKED.map((model) => ({ ...model, format: moves.find(({ id }) => id === model.id)?.format ?? model.format }));
    expect(await providerMovesOf(bindings, gateway, left)).toEqual({ moves: [LAST_MOVED], done: true });
  });

  it("asks no more once the API token is refused, as every provider's endpoint refuses it alike", async () => {
    run = false;
    expect(await providerMovesOf(bindings, gateway, REST_ASKED)).toEqual({ moves: [], done: true });
    expect(asked.map(({ url, body }) => [url, body.model])).toEqual([[ANTHROPIC_ENDPOINT, "claude-sonnet-5-5"]]);
  });

  it("leaves a model where it is when its provider's endpoint doesn't know it, and asks the ones after it in the same move", async () => {
    unknownThere = [providerNameOf(HAIKU)];
    expect(await providerMovesOf(bindings, gateway, REST_ASKED.slice(0, 2))).toEqual({ moves: [{ id: SONNET, from: "messages", format: "anthropic", thinkingLevels: ALL_LEVELS }], done: true });

    // Each one the endpoints don't know takes one request, leaving room for the last.
    unknownThere = REST_ASKED.slice(0, MODELS_PER_MOVE).map(({ id }) => providerNameOf(id));
    asked.length = 0;
    expect(await providerMovesOf(bindings, gateway, REST_ASKED)).toEqual({ moves: [LAST_MOVED], done: true });
    expect(testQuestionsThere()).toHaveLength(REST_ASKED.length);
  });

  it("is done once a move without room for them all moved none, as the next would ask the same again", async () => {
    const unknown = Array.from({ length: 50 }, (_, index) => ({ id: `anthropic/claude-retired-${index}`, format: "messages" as const }));
    unknownThere = unknown.map(({ id }) => providerNameOf(id));
    expect(await providerMovesOf(bindings, gateway, unknown)).toEqual({ moves: [], done: true });
    expect(testQuestionsThere().length).toBeLessThan(unknown.length);
  });
});

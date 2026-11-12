import { ASSISTANT_ID, ASSISTANT_NAME, type Me, type Message, type NewWorkspace, type ProfileAnswer, type RoomId, type User, type WorkspaceSettings } from "@ember/protocol";
import {
  ACCOUNT_ID_REFUSED,
  ASSISTANT_FORBIDDEN,
  ASSISTANT_MODELS,
  ASSISTANT_OFF,
  DEFAULT_LEVELS,
  DEFAULT_MODEL_KEPT,
  MAX_ASSISTANT_MODELS,
  MODEL_NOT_LISTED,
  MODEL_REFUSED,
  MODELS_FULL,
  THINKING_LEVELS,
  TOP_LEVELS,
  type AssistantCatalog,
  type AssistantModel,
  type AssistantSaved,
  type AssistantSettings,
  type YourAssistant,
} from "@ember/protocol/assistant";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES, PICKED_MODEL_NOTES } from "../src/assistant/answers";
import { CATALOG_UNANSWERED, KEPT_CATALOG_FRESH_MS } from "../src/assistant/catalog";
import { API_TOKEN_NEEDED, SETUP_CHANGED } from "../src/assistant/settings";
import { api, connect, cookieOf, freshDeploy, post, shown, WITH_THE_FLAME, workspaceSql, workspaceStub, type Client, type Session } from "./support";

// The models @ember can answer with: the text models Cloudflare's catalog lists, which Set up Ember AI and
// Add a model list, the ones administrators let people pick on the Ember AI card, the one among them that
// answers everyone, and the one each person picks on their profile, which @ember answers them with.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-workers-ai-read_0123456";
const SETUP = { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "anthropic/claude-sonnet-5.5" };
const CLOUDFLARE_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const HELLO = "Hello, team!";

/** The models people can pick, as Ember AI lists them once they've answered their test questions, which they did at every level of thinking. */
const CLAUDE: AssistantModel = { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "messages", thinkingLevels: [...THINKING_LEVELS] };
const GPT: AssistantModel = { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "responses", thinkingLevels: [...THINKING_LEVELS] };
const DEEPSEEK: AssistantModel = { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", format: "chat", thinkingLevels: [...THINKING_LEVELS] };

/** `model` as Cloudflare's catalog lists it, which says nothing of the levels of thinking it takes, as Ember lists one it hasn't asked at each. */
const untested = ({ thinkingLevels: _, ...model }: AssistantModel): AssistantModel => model;

/** `model` as the account's settings keep it. */
const kept = ({ thinkingLevels, ...model }: AssistantModel) => ({ ...model, thinking_levels: thinkingLevels });

/** Rows of Cloudflare's catalog, as its API answers with them, of text models and others, and one twice. */
const ROWS = [
  {
    model_id: "anthropic/claude-sonnet-5.5",
    provider_id: "anthropic",
    name: "Claude Sonnet 5.5",
    task: "Text Generation",
    request_formats: ["anthropic-messages"],
    provider_details: [{ id: "anthropic", pricing: { input_tokens: 2, input_cached_tokens: 0.1, input_cache_creation_tokens: 2.5, output_tokens: 10 } }],
  },
  { model_id: "@cf/black-forest-labs/flux-2-dev", provider_id: "black-forest-labs", name: "FLUX.2 [dev]", task: "Text-to-Image", request_formats: null, provider_details: null },
  {
    model_id: "openai/gpt-6.1-sol",
    provider_id: "openai",
    name: "GPT-6.1 Sol",
    task: "Text Generation",
    request_formats: ["responses", "chat-completions"],
    provider_details: [
      {
        id: "openai",
        pricing: { long_context_threshold_tokens: 272_000, short_context_input_tokens: 2, short_context_output_tokens: 10, long_context_input_tokens: 4, long_context_output_tokens: 15 },
      },
    ],
  },
  // Workers AI's can be named as their IDs end.
  { model_id: "@cf/zai-org/glm-4.7-flash", provider_id: "zai-org", name: "glm-4.7-flash", task: "Text Generation", request_formats: null, provider_details: null },
  { model_id: "@cf/cloudflare/clef", provider_id: "cloudflare", name: "Clef", task: "Text Generation", request_formats: ["workers-ai-run"] },
  {
    model_id: "deepseek/deepseek-v4-pro",
    provider_id: "deepseek",
    name: "DeepSeek V4 Pro",
    task: "Text Generation",
    request_formats: ["chat-completions"],
    provider_details: [{ id: "fireworks", pricing: { input_tokens: 1.74, output_tokens: 3.48, input_cached_tokens: 0.145 } }],
  },
  { model_id: "@cf/meta/llama-4-scout-17b-16e-instruct", provider_id: "meta", name: "llama-4-scout-17b-16e-instruct", task: "Text Generation" },
  { model_id: "anthropic/claude-sonnet-5.5", provider_id: "anthropic", name: "Claude Sonnet 5.5, again", task: "Text Generation", request_formats: ["anthropic-messages"] },
  { model_id: "not a model", name: "Not a model", task: "Text Generation" },
];

/** The text models of `ROWS`, as Ember lists them: Workers AI's first, then by name, each once, with what they cost. */
const LISTED: AssistantModel[] = [
  { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "llama-4-scout-17b-16e-instruct", format: "chat" },
  { ...untested(CLAUDE), price: { input: 2, output: 10 } },
  { ...untested(DEEPSEEK), price: { input: 1.74, output: 3.48 } },
  { ...untested(GPT), price: { input: 2, output: 10 } },
];

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** A request Cloudflare was sent: how, where, with which API token, and what it asked a model, for one to AI Gateway. */
interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

/** A page of Cloudflare's catalog holding `rows`, the `page`th of those with `total` models in all. */
const catalogPage = (rows: unknown[], page = 1, total = rows.length) =>
  Response.json({ success: true, errors: [], messages: [], result: rows, result_info: { count: rows.length, page, per_page: 100, total_count: total } });

/** A model's answer saying `text`, in the format `sent` asked in. */
function answering(text: string): (sent: Sent) => Response {
  return ({ url }) => {
    if (url.endsWith("/messages")) return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" });
    if (url.endsWith("/responses")) return Response.json({ object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
    return Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  };
}

/** Cloudflare's answer to a request it refuses with `status`, in its own shape. */
const refusing = (status: number, code: number, message: string) => () => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

/**
 * Stands in for Cloudflare's API, whose catalog answers each page with what `catalog` makes of its
 * number, and whose models answer as `answer` says, saying hello unless it says otherwise. Keeps the
 * requests it's sent, in the order they came.
 */
function cloudflare({ catalog = () => catalogPage(ROWS), answer = answering(HELLO) }: { catalog?: (page: number) => Response | Promise<Response>; answer?: (sent: Sent) => Response | Promise<Response> } = {}): Sent[] {
  const requests: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : ((await request.json()) as Record<string, unknown>);
    const sent = { method: request.method, url: request.url, authorization: request.headers.get("Authorization"), body };
    requests.push(sent);
    return url.pathname.endsWith("/ai/catalog/models") ? catalog(Number(url.searchParams.get("page"))) : answer(sent);
  });
  return requests;
}

/** Sets Ember AI up as `administrator` with `setup`, as Set up Ember AI does, which has to work. */
async function turnOn(administrator: Session, setup: unknown = SETUP): Promise<AssistantSaved> {
  const response = await api("/api/account/assistant", { method: "PUT", headers: as(administrator), body: JSON.stringify(setup) });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as AssistantSaved;
}

/** Lists the models of the account `keys` gives as `session`, as Set up Ember AI and Add a model do. */
const listModels = (session: Session | null, keys: unknown) => api("/api/account/assistant/catalog", { method: "POST", headers: as(session), body: JSON.stringify(keys) });

/** Adds a model to those people can pick, as `session`, as Add a model does. */
const addModel = (session: Session | null, model: unknown) => api("/api/account/assistant/models", { method: "POST", headers: as(session), body: JSON.stringify(model) });

/** Takes a model out of those people can pick, as `session`, as its Remove does. */
const removeModel = (session: Session | null, model: unknown) => api("/api/account/assistant/models", { method: "DELETE", headers: as(session), body: JSON.stringify({ model }) });

/** Changes Ember AI as `session`, as the Ember AI card does. */
const change = (session: Session | null, changes: unknown) => api("/api/account/assistant", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

/** Changes what `session` picks of @ember's answers, as their profile does. */
const pick = (session: Session | null, changes: unknown) => api("/api/users/me/assistant", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

/** Adds `model` as `administrator`, which has to work. */
async function added(administrator: Session, model: AssistantModel): Promise<AssistantSaved> {
  const response = await addModel(administrator, { model: model.id, modelName: model.name });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as AssistantSaved;
}

/** Ember AI as the AI assistant tab shows it to `administrator`. */
const settingsShown = async (administrator: Session) => ((await (await api("/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings).assistant;

/** @ember's answers to `person` as their profile shows them. */
const yoursShown = async (person: Session) => ((await (await api("/api/users/me/profile", { headers: as(person) })).json()) as ProfileAnswer).profile.assistant;

/** Ember AI as the account's settings keep it. */
const storedAssistant = async () =>
  (JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>).assistant as Record<string, unknown> | null;

/** What a refusal says. */
const refusalOf = async (response: Response) => [response.status, ((await response.json()) as { error: string }).error];

/**
 * Ember AI as the AI assistant tab shows it with `models`, the first of them answering everyone, with
 * Search the web off, or null for a model that can't search.
 */
const settingsWith = (models: AssistantModel[], model = models[0]!.id): AssistantSettings => ({
  accountId: ACCOUNT_ID,
  model,
  models,
  most: TOP_LEVELS,
  webTools: models.find(({ id }) => id === model)?.format === "chat" ? null : [],
  instructions: "",
  promptTemplate: null,
  ...WITH_THE_FLAME,
});

/** @ember's answers to someone who picked `model`, or none, among `models`, the first of them answering everyone, at the levels everyone starts with. */
const yoursWith = (models: AssistantModel[], model: string | null = null): YourAssistant => ({ levels: DEFAULT_LEVELS, most: TOP_LEVELS, model, defaultModel: models[0]!.id, models });

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Cloudflare's model catalog", () => {
  it("lists its text models in a format Ember asks in, Workers AI's first, then by name, each once, with what they cost", async () => {
    const ada = await setUp();
    const requests = cloudflare();

    const response = await listModels(ada, { accountId: ACCOUNT_ID, apiToken: API_TOKEN });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ models: LISTED, refusal: null } satisfies AssistantCatalog);
    expect(requests).toEqual([{ method: "GET", url: `${CLOUDFLARE_API}/ai/catalog/models?page=1&per_page=100`, authorization: `Bearer ${API_TOKEN}`, body: null }]);
  });

  it("reads each of its pages, with the API token Ember has when none is given", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    vi.restoreAllMocks();
    const requests = cloudflare({ catalog: (page) => (page === 1 ? catalogPage(ROWS.slice(0, 3), 1, 150) : catalogPage(ROWS.slice(3), page, 150)) });

    const response = await listModels(ada, { accountId: ACCOUNT_ID, apiToken: "" });
    expect(((await response.json()) as AssistantCatalog).models).toEqual(LISTED);
    expect(requests.map(({ url, authorization }) => [url.slice(CLOUDFLARE_API.length), authorization])).toEqual([
      ["/ai/catalog/models?page=1&per_page=100", `Bearer ${API_TOKEN}`],
      ["/ai/catalog/models?page=2&per_page=100", `Bearer ${API_TOKEN}`],
    ]);
  });

  it("lists the models Ember knows when it can't be read, saying why", async () => {
    const ada = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listedWith = async (catalog: () => Response | Promise<Response>) => {
      cloudflare({ catalog });
      const response = await listModels(ada, { accountId: ACCOUNT_ID, apiToken: API_TOKEN });
      expect(response.status).toBe(200);
      const { models, refusal } = (await response.json()) as AssistantCatalog;
      expect(models).toEqual(ASSISTANT_MODELS);
      return refusal;
    };

    expect(await listedWith(refusing(401, 10000, "Authentication error"))).toMatch(/^Cloudflare didn't take that API token for this account\..* Cloudflare says: Authentication error$/);
    expect(await listedWith(refusing(404, 7003, "Could not route to /client/v4/accounts/…"))).toMatch(/^Cloudflare has no account with that ID/);
    expect(await listedWith(refusing(500, 1000, "Internal error"))).toBe(CATALOG_UNANSWERED);
    expect(await listedWith(() => Promise.reject(new TypeError("Network connection lost.")))).toBe(CATALOG_UNANSWERED);
    expect(await listedWith(() => new Response("Bad gateway", { status: 200 }))).toBe(CATALOG_UNANSWERED);
    expect(await listedWith(() => catalogPage(ROWS.filter(({ task }) => task !== "Text Generation")))).toBe(CATALOG_UNANSWERED);
  });

  it("is listed only for administrators, of an account that can be one, before Cloudflare is asked anything", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    const requests = cloudflare();

    expect((await listModels(null, { accountId: ACCOUNT_ID, apiToken: API_TOKEN })).status).toBe(401);
    expect(await refusalOf(await listModels(grace, { accountId: ACCOUNT_ID, apiToken: API_TOKEN }))).toEqual([403, ASSISTANT_FORBIDDEN]);
    const refused = await listModels(ada, { accountId: "my-account", apiToken: API_TOKEN });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: ACCOUNT_ID_REFUSED, field: "accountId" });
    expect(await (await listModels(ada, { accountId: ACCOUNT_ID })).json()).toEqual({ error: API_TOKEN_NEEDED, field: "apiToken" });
    expect(requests).toEqual([]);
  });
});

describe("The copy of the catalog Ember keeps", () => {
  afterEach(() => vi.useRealTimers());

  /** The catalog as it lists for `administrator` with the API token Ember has, as New agent, an agent's settings and Add a model list it. */
  const listedWithEmbers = async (administrator: Session) => (await (await listModels(administrator, { accountId: ACCOUNT_ID })).json()) as AssistantCatalog;

  /** What the Workspace keeps of the catalog for `accountId`. */
  const keptFor = (accountId: string) => workspaceStub().keptCatalog(accountId);

  /** Sets Ember AI up as `administrator`, then stops the clock, which moves only when a test moves it. */
  async function turnOnAndStopTheClock(administrator: Session): Promise<void> {
    cloudflare();
    await turnOn(administrator);
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  }

  it("answers with the last read at once, which is read again for the next listing once it's ten minutes old", async () => {
    const ada = await setUp();
    await turnOnAndStopTheClock(ada);
    // Cloudflare's catalog without the models it adds later.
    let rows = ROWS.slice(0, 3);
    const requests = cloudflare({ catalog: () => catalogPage(rows) });
    const before = [LISTED[2]!, LISTED[4]!];

    expect(await listedWithEmbers(ada)).toEqual({ models: before, refusal: null });
    expect(await keptFor(ACCOUNT_ID)).toEqual({ accountId: ACCOUNT_ID, models: before, readAt: Date.now() });
    rows = ROWS;
    vi.setSystemTime(Date.now() + KEPT_CATALOG_FRESH_MS - 1);
    expect(await listedWithEmbers(ada)).toEqual({ models: before, refusal: null });
    expect(requests).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1);
    expect(await listedWithEmbers(ada)).toEqual({ models: before, refusal: null });
    await vi.waitFor(async () => expect((await keptFor(ACCOUNT_ID))?.models).toEqual(LISTED));
    expect(await listedWithEmbers(ada)).toEqual({ models: LISTED, refusal: null });
    expect(requests).toHaveLength(2);
  });

  it("stays while the catalog doesn't answer, saying so in the log, and goes once Cloudflare refuses the API token, so the next listing says why", async () => {
    const ada = await setUp();
    await turnOnAndStopTheClock(ada);
    let catalog = () => catalogPage(ROWS);
    const requests = cloudflare({ catalog: () => catalog() });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const readAgainLogged = (refusal: RegExp) => vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringMatching(refusal)));
    expect(await listedWithEmbers(ada)).toEqual({ models: LISTED, refusal: null });

    catalog = refusing(500, 1000, "Internal error");
    vi.setSystemTime(Date.now() + KEPT_CATALOG_FRESH_MS);
    expect(await listedWithEmbers(ada)).toEqual({ models: LISTED, refusal: null });
    await readAgainLogged(new RegExp(`^Cloudflare's model catalog wasn't read again: ${CATALOG_UNANSWERED}$`));
    expect((await keptFor(ACCOUNT_ID))?.models).toEqual(LISTED);

    catalog = refusing(401, 10000, "Authentication error");
    expect(await listedWithEmbers(ada)).toEqual({ models: LISTED, refusal: null });
    await readAgainLogged(/^Cloudflare's model catalog wasn't read again: Cloudflare didn't take that API token/);
    expect(await keptFor(ACCOUNT_ID)).toBeNull();
    const { models, refusal } = await listedWithEmbers(ada);
    expect(models).toEqual(ASSISTANT_MODELS);
    expect(refusal).toMatch(/^Cloudflare didn't take that API token for this account\./);
    expect(requests).toHaveLength(4);
  });

  it("isn't what an API token that's given lists, as Set up Ember AI's does, nor another account, whose catalog it becomes", async () => {
    const ada = await setUp();
    await turnOnAndStopTheClock(ada);
    const requests = cloudflare();
    const otherAccountId = "fedcba9876543210fedcba9876543210";
    await listedWithEmbers(ada);

    expect((await listModels(ada, { accountId: ACCOUNT_ID, apiToken: API_TOKEN })).status).toBe(200);
    expect((await listModels(ada, { accountId: otherAccountId })).status).toBe(200);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/ai/catalog/models`,
      `/client/v4/accounts/${ACCOUNT_ID}/ai/catalog/models`,
      `/client/v4/accounts/${otherAccountId}/ai/catalog/models`,
    ]);
    expect(await keptFor(ACCOUNT_ID)).toBeNull();
    expect(await keptFor(otherAccountId)).toEqual({ accountId: otherAccountId, models: LISTED, readAt: Date.now() });
  });
});

describe("The models people can pick", () => {
  it("start as the one Set up Ember AI chose, by the name it was given, which the account keeps with the format it took", async () => {
    const ada = await setUp();
    cloudflare();

    const { assistant } = await turnOn(ada, { ...SETUP, model: DEEPSEEK.id, modelName: ` ${DEEPSEEK.name} ` });
    expect(assistant).toEqual(settingsWith([DEEPSEEK]));
    expect(await settingsShown(ada)).toEqual(settingsWith([DEEPSEEK]));
    expect((await storedAssistant())?.models).toEqual([kept(DEEPSEEK)]);
    // Without a name, a model is called as Ember knows it, or else by its ID.
    expect((await turnOn(ada)).assistant.models).toEqual([CLAUDE]);
    expect((await turnOn(ada, { ...SETUP, model: "openai/gpt-5.5" })).assistant.models).toEqual([
      { id: "openai/gpt-5.5", name: "openai/gpt-5.5", format: "responses", thinkingLevels: [...THINKING_LEVELS] },
    ]);
  });

  it("add a model once it answers a test question through Ember AI's account, after the others", async () => {
    const ada = await setUp();
    const requests = cloudflare({ answer: answering("Hi, I'm GPT.") });
    await turnOn(ada);
    requests.length = 0;

    const response = await addModel(ada, { model: ` ${GPT.id} `, modelName: GPT.name });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ assistant: settingsWith([CLAUDE, GPT]), greeting: "Hi, I'm GPT." } satisfies AssistantSaved);
    // Its test question, and then the same at each level of thinking.
    expect(requests.map(({ url, authorization, body }) => [url, authorization, body?.model])).toEqual(Array(5).fill([`${CLOUDFLARE_API}/ai/v1/responses`, `Bearer ${API_TOKEN}`, GPT.id]));
    const efforts = requests.map(({ body }) => (body?.reasoning as { effort: string } | undefined)?.effort);
    expect([efforts[0], efforts.slice(1).sort()]).toEqual([undefined, ["high", "low", "medium", "none"]]);
    expect((await storedAssistant())?.models).toEqual([kept(CLAUDE), kept(GPT)]);

    // Added again, it stays where it is, with the name it's given now.
    expect((await added(ada, { ...GPT, name: "GPT Sol" })).assistant.models).toEqual([CLAUDE, { ...GPT, name: "GPT Sol" }]);
  });

  it("add no model AI Gateway doesn't take, saying why on the model's field", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    vi.restoreAllMocks();
    cloudflare({ answer: refusing(400, 2001, "No such model.") });

    const response = await addModel(ada, { model: "openai/gpt-0" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining("AI Gateway didn't take that model.") as unknown, field: "model" });
    expect(await refusalOf(await addModel(ada, { model: "gpt-0" }))).toEqual([422, MODEL_REFUSED]);
    expect((await settingsShown(ada))?.models).toEqual([CLAUDE]);
  });

  it("add no model that answered through Ember AI as it was before it was set up again", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    vi.restoreAllMocks();
    cloudflare({
      // While GPT answers its test question, Ember AI is turned off and set up again with another API token.
      answer: async (sent) => {
        if (sent.body?.model === GPT.id) {
          expect((await api("/api/account/assistant", { method: "DELETE", headers: as(ada) })).status).toBe(200);
          await turnOn(ada, { ...SETUP, apiToken: `${API_TOKEN}-2`, model: DEEPSEEK.id, modelName: DEEPSEEK.name });
        }
        return answering(HELLO)(sent);
      },
    });

    expect(await refusalOf(await addModel(ada, { model: GPT.id, modelName: GPT.name }))).toEqual([409, SETUP_CHANGED]);
    expect((await settingsShown(ada))?.models).toEqual([DEEPSEEK]);
  });

  it(`hold at most ${MAX_ASSISTANT_MODELS}`, async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    for (let n = 1; n < MAX_ASSISTANT_MODELS; n++) await added(ada, { id: `openai/gpt-${n}`, name: `GPT-${n}`, format: "responses" });

    const response = await addModel(ada, { model: "openai/gpt-0" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MODELS_FULL, field: "model" });
    expect((await settingsShown(ada))?.models).toHaveLength(MAX_ASSISTANT_MODELS);
  });

  it("change which of them answers everyone, with the format it took its test question in", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);

    const response = await change(ada, { model: GPT.id, thinking: "medium" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ assistant: { ...settingsWith([CLAUDE, GPT], GPT.id), most: { thinking: "medium", length: "long" } } });
    expect(await storedAssistant()).toMatchObject({ model: GPT.id, format: "responses" });
    expect(await refusalOf(await change(ada, { model: DEEPSEEK.id }))).toEqual([422, MODEL_NOT_LISTED]);
    expect(await refusalOf(await change(ada, { model: "gpt" }))).toEqual([422, MODEL_NOT_LISTED]);
    expect((await settingsShown(ada))?.model).toBe(GPT.id);
  });

  it("lose a model to its Remove, but for the one that answers everyone", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await added(ada, DEEPSEEK);

    const response = await removeModel(ada, GPT.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ assistant: settingsWith([CLAUDE, DEEPSEEK]) });
    // Removed already, it stays removed.
    expect(await (await removeModel(ada, GPT.id)).json()).toEqual({ assistant: settingsWith([CLAUDE, DEEPSEEK]) });
    expect(await refusalOf(await removeModel(ada, CLAUDE.id))).toEqual([409, DEFAULT_MODEL_KEPT]);
    expect(await refusalOf(await removeModel(ada, "claude"))).toEqual([422, MODEL_NOT_LISTED]);
    expect((await settingsShown(ada))?.models).toEqual([CLAUDE, DEEPSEEK]);
  });

  it("have the model Set up Ember AI chooses in place of the one that answered everyone, and keep the others", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);

    expect((await turnOn(ada, { ...SETUP, model: DEEPSEEK.id, modelName: DEEPSEEK.name })).assistant).toEqual(settingsWith([DEEPSEEK, GPT]));
    // Kept with its new token, or none, it stays where it was.
    expect((await turnOn(ada, { accountId: ACCOUNT_ID, model: DEEPSEEK.id })).assistant).toEqual(settingsWith([DEEPSEEK, GPT]));
    // Chosen from among them, it's there once.
    expect((await turnOn(ada, { ...SETUP, model: GPT.id })).assistant).toEqual(settingsWith([GPT]));
  });

  it("are forgotten when Ember AI is turned off", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    expect((await api("/api/account/assistant", { method: "DELETE", headers: as(ada) })).status).toBe(200);

    expect((await turnOn(ada, { ...SETUP, model: DEEPSEEK.id, modelName: DEEPSEEK.name })).assistant).toEqual(settingsWith([DEEPSEEK]));
  });

  it("are the one it answers with, for Ember AI set up before people could pick", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await workspaceSql("UPDATE accounts SET settings = json_remove(settings, '$.assistant.models')");
    await evictDurableObject(workspaceStub());

    // Its own model, which Ember hadn't asked at each level of thinking then.
    expect(await settingsShown(ada)).toEqual(settingsWith([untested(CLAUDE)]));
    expect((await added(ada, GPT)).assistant.models).toEqual([untested(CLAUDE), GPT]);
  });

  it("are the administrators' to change, while Ember AI is on", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    const requests = cloudflare();
    for (const response of [await addModel(ada, { model: GPT.id }), await removeModel(ada, GPT.id), await change(ada, { model: GPT.id })]) {
      expect(await refusalOf(response)).toEqual([409, ASSISTANT_OFF]);
    }
    expect(requests).toEqual([]);
    await turnOn(ada);
    requests.length = 0;

    for (const response of [await addModel(null, { model: GPT.id }), await removeModel(null, CLAUDE.id), await change(null, { model: GPT.id })]) expect(response.status).toBe(401);
    for (const response of [await addModel(grace, { model: GPT.id }), await removeModel(grace, CLAUDE.id), await change(grace, { model: GPT.id })]) {
      expect(await refusalOf(response)).toEqual([403, ASSISTANT_FORBIDDEN]);
    }
    expect(requests).toEqual([]);
    expect((await settingsShown(ada))?.models).toEqual([CLAUDE]);
  });
});

describe("Your model", () => {
  it("is the one that answers everyone until you pick another of those people can pick, as your profile shows", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    expect(await yoursShown(grace)).toEqual(yoursWith([CLAUDE, GPT]));

    const response = await pick(grace, { model: GPT.id });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ assistant: yoursWith([CLAUDE, GPT], GPT.id) });
    expect(await yoursShown(grace)).toEqual(yoursWith([CLAUDE, GPT], GPT.id));
    // Each person's is their own.
    expect(await yoursShown(ada)).toEqual(yoursWith([CLAUDE, GPT]));

    expect(await refusalOf(await pick(grace, { model: DEEPSEEK.id }))).toEqual([422, MODEL_NOT_LISTED]);
    expect(await refusalOf(await pick(grace, { model: 7 }))).toEqual([422, MODEL_NOT_LISTED]);
    expect((await yoursShown(grace))?.model).toBe(GPT.id);
  });

  it("follows the one that answers everyone while you pick none, whichever administrators choose", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await added(ada, DEEPSEEK);

    await pick(grace, { model: GPT.id });
    expect(await (await pick(grace, { model: null })).json()).toEqual({ assistant: yoursWith([CLAUDE, GPT, DEEPSEEK]) });
    expect(await workspaceSql("SELECT assistant_model FROM users WHERE id = ?", grace.user.id)).toEqual([{ assistant_model: null }]);
    await change(ada, { model: DEEPSEEK.id });
    expect(await yoursShown(grace)).toEqual({ ...yoursWith([CLAUDE, GPT, DEEPSEEK]), defaultModel: DEEPSEEK.id });
  });

  it("stays yours once administrators choose it to answer everyone, and once they choose another, as does the one they chose, picked", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await added(ada, DEEPSEEK);

    await pick(grace, { model: GPT.id });
    await change(ada, { model: GPT.id });
    expect(await yoursShown(grace)).toEqual({ ...yoursWith([CLAUDE, GPT, DEEPSEEK], GPT.id), defaultModel: GPT.id });
    await change(ada, { model: DEEPSEEK.id });
    expect((await yoursShown(grace))?.model).toBe(GPT.id);

    expect(await (await pick(grace, { model: DEEPSEEK.id })).json()).toEqual({ assistant: { ...yoursWith([CLAUDE, GPT, DEEPSEEK], DEEPSEEK.id), defaultModel: DEEPSEEK.id } });
    expect(await workspaceSql("SELECT assistant_model FROM users WHERE id = ?", grace.user.id)).toEqual([{ assistant_model: DEEPSEEK.id }]);
    await change(ada, { model: CLAUDE.id });
    expect((await yoursShown(grace))?.model).toBe(DEEPSEEK.id);
  });

  it("is the one that answers everyone while yours is removed, and yours again once it's added back", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await pick(grace, { model: GPT.id });

    await removeModel(ada, GPT.id);
    expect(await yoursShown(grace)).toEqual(yoursWith([CLAUDE]));
    await added(ada, GPT);
    expect((await yoursShown(grace))?.model).toBe(GPT.id);
  });

  it("is kept only while Ember AI is on, when there are models to pick", async () => {
    const ada = await setUp();
    expect(await (await pick(ada, { model: GPT.id, thinking: "off" })).json()).toEqual({ assistant: null });
    expect(await workspaceSql("SELECT assistant_thinking, assistant_model FROM users WHERE id = ?", ada.user.id)).toEqual([{ assistant_thinking: "off", assistant_model: null }]);
    expect((await pick(null, { model: GPT.id })).status).toBe(401);
  });
});

describe("@ember's answers", () => {
  const EMBER: User = { id: ASSISTANT_ID, name: ASSISTANT_NAME };
  const mention = `<action-text-attachment sgid="${mentionSgid(ASSISTANT_ID)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

  /** The general room's ID. */
  const general = async () => ((await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }])[0].id;

  /** @ember's next message in the room `client` is in. */
  async function nextAnswer(client: Client): Promise<Message> {
    for (;;) {
      const { message } = await client.next("message.created");
      if (message.creator.id === ASSISTANT_ID) return message;
    }
  }

  /** What @ember answers `person` asking it something in general, and the model it asked. */
  async function askedAs(person: Session): Promise<[string, unknown]> {
    const client = await connect(await general(), person);
    const requests = cloudflare({ answer: answering("An answer.") });
    await post(client, `<p>${mention} what's new?</p>`);
    const answer = await nextAnswer(client);
    client.close();
    vi.restoreAllMocks();
    return [answer.plainText, requests.at(-1)?.body?.model];
  }

  it("come from the model you picked, while people can pick it, or else the one that answers everyone", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await pick(grace, { model: GPT.id });
    vi.restoreAllMocks();

    expect(await askedAs(grace)).toEqual(["An answer.", GPT.id]);
    expect(await askedAs(ada)).toEqual(["An answer.", CLAUDE.id]);

    await removeModel(ada, GPT.id);
    expect(await askedAs(grace)).toEqual(["An answer.", CLAUDE.id]);
  });

  it("come from the model you picked once administrators choose it to answer everyone, and once they choose another", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await pick(grace, { model: GPT.id });
    await change(ada, { model: GPT.id });
    vi.restoreAllMocks();
    expect(await askedAs(grace)).toEqual(["An answer.", GPT.id]);

    cloudflare();
    await change(ada, { model: CLAUDE.id });
    vi.restoreAllMocks();
    expect(await askedAs(grace)).toEqual(["An answer.", GPT.id]);
    expect(await askedAs(ada)).toEqual(["An answer.", CLAUDE.id]);
  });

  it("say you can pick another model when the one you picked can't answer", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await pick(grace, { model: GPT.id });
    vi.restoreAllMocks();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const noted = async (person: Session, status: number) => {
      const client = await connect(await general(), person);
      cloudflare({ answer: refusing(status, 2001, "Refused.") });
      await post(client, `<p>${mention} hello?</p>`);
      const answer = await nextAnswer(client);
      client.close();
      return answer.plainText;
    };
    expect(await noted(grace, 402)).toBe(PICKED_MODEL_NOTES.credits);
    expect(await noted(grace, 403)).toBe(PICKED_MODEL_NOTES.model);
    expect(await noted(grace, 429)).toBe(NOTES.busy);
    expect(await noted(ada, 403)).toBe(NOTES.model);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Ember AI's model ${GPT.id} didn't answer message`));

    // Once it answers everyone, it's still Grace's to change, as administrators choosing another wouldn't.
    cloudflare();
    await change(ada, { model: GPT.id });
    expect(await noted(grace, 403)).toBe(PICKED_MODEL_NOTES.model);
    expect(await noted(ada, 403)).toBe(NOTES.model);
  });
});

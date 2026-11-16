import { ASSISTANT_ID, type Message, type NewWorkspace, type RoomId, type WorkspaceSettings } from "@ember/protocol";
import {
  ASSISTANT_MODELS,
  MODEL_REFUSED,
  MODELS_FILE_VERSION,
  SUGGESTED_MODEL,
  WEB_SEARCHES_PER_ANSWER,
  type AssistantSaved,
  type OfferedModel,
  type OfferedModels,
  type WebSearchChanged,
} from "@ember/protocol/assistant";
import type { AgentAnswer, NewAgent } from "@ember/protocol/agents";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES, PICKED_MODEL_NOTES } from "../src/assistant/answers";
import { SEARCH_TOKEN_REFUSED } from "../src/assistant/gateway";
import {
  MODELS_FILE_RETRY_MS,
  OFFERED_FRESH_MS,
  thinkingLevelsIn,
  WORKERS_AI_TOKEN_REFUSED,
  workersAiModelOf,
} from "../src/assistant/offered";
import { API_TOKEN_NEEDED } from "../src/assistant/settings";
import { addKeptModels, agentWithKeptModel, api, apiWith, connect, cookieOf, freshDeploy, post, shown, withWorkspaceEnv, workspaceSql, workspaceStub, type Client, type Session } from "./support";

// The models Ember offers administrators, as Set up Ember AI, Add a model and the agents' pages list
// them: those the models file lists, which Ember reads from its main branch once a day, and Workers AI's
// that take tools, as Cloudflare's model search lists them for Ember AI's account, which Ember gives its
// own tool for searching the web, and runs their searches with Cloudflare's Web Search API.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const SETUP = { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "anthropic/claude-sonnet-5.5" };
/** Another Cloudflare account, and another API token. */
const [OTHER_ACCOUNT_ID, OTHER_API_TOKEN] = ["fedcba9876543210fedcba9876543210", "another-api-token-with-workers-ai-read_01"];
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const CHAT_COMPLETIONS = `${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
const WEB_SEARCH = `${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/websearch/`;
/** Where this suite's Worker reads the models file, when a test has it read one. */
const MODELS_URL = "https://models.example/models.json";
const WITH_THE_FILE = { EMBER_MODELS_URL: MODELS_URL };

/** A day a week from today, when GLM 5.2 stops running, so that it runs still while these tests do. */
const STOPS = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Workers AI's models as Cloudflare's model search lists them, in OpenRouter's format: GLM 5.2 as Cloudflare's own example has it, but for the day it stops. */
const GLM_ROW = {
  id: "@cf/zai-org/glm-5.2",
  name: "GLM 5.2",
  supported_features: ["structured_outputs", "json_mode", "tools", "reasoning"],
  reasoning: {
    supported_efforts: ["max", "high", "none"],
    default_effort: "max",
    default_enabled: true,
    mandatory: false,
    normalizes_to: { null: "max", low: "high", medium: "high", xhigh: "max", minimal: "none" },
  },
  input_modalities: ["text"],
  output_modalities: ["text"],
  context_length: 262144,
  pricing: { prompt: "0.0000014000", completion: "0.0000044000", input_cache_read: "0.0000002600" },
  deprecation_date: STOPS,
};
/** One that takes tools, and pictures, but doesn't reason. */
const GEMMA_ROW = {
  id: "@cf/google/gemma-4-26b-a4b-it",
  name: "Gemma 4 26B",
  supported_features: ["tools"],
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  pricing: { prompt: "0.0000001", completion: "0.0000003" },
};
/** One whose reasoning can't be turned off, at efforts as Ember names them. */
const QWQ_ROW = {
  id: "@cf/qwen/qwq-32b",
  name: "QwQ 32B",
  supported_features: ["tools", "reasoning"],
  reasoning: { supported_efforts: ["low", "medium", "high"], default_effort: "medium", default_enabled: true, mandatory: true },
  pricing: { prompt: "0.00000066", completion: "0.000001" },
};
/** Ones Ember doesn't offer: without tools, drawing pictures, and another company's. */
const UNOFFERED_ROWS = [
  { id: "@cf/meta/llama-3.2-1b-instruct", name: "Llama 3.2 1B", supported_features: ["json_mode"], pricing: { prompt: "0.000000027", completion: "0.0000002" } },
  { id: "@cf/black-forest-labs/flux-2", name: "FLUX.2", supported_features: ["tools"], output_modalities: ["image"] },
  { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", supported_features: ["tools", "reasoning"] },
];
const ROWS = [GLM_ROW, GEMMA_ROW, QWQ_ROW, ...UNOFFERED_ROWS];

/** The same as Ember offers them, by their names. */
const GEMMA: OfferedModel = { id: GEMMA_ROW.id, name: "Gemma 4 26B", format: "workers", price: { input: 0.1, output: 0.3 }, thinkingLevels: [] };
const GLM: OfferedModel = { id: GLM_ROW.id, name: "GLM 5.2", format: "workers", price: { input: 1.4, output: 4.4 }, thinkingLevels: ["off", "high"], until: STOPS };
const QWQ: OfferedModel = { id: QWQ_ROW.id, name: "QwQ 32B", format: "workers", price: { input: 0.66, output: 1 }, thinkingLevels: ["low", "medium", "high"] };
const WORKERS_AI = [GEMMA, GLM, QWQ];

/** A models file, as models.json on Ember's main branch is written, which lists a model the one Ember shipped with doesn't, and leaves out Grok. */
const FILE = {
  version: MODELS_FILE_VERSION,
  suggested: "anthropic/claude-haiku-5.5",
  models: [
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", price: { input: 0.1, output: 0.5 }, web: ["search", "read"] },
    { id: "openai/gpt-7", name: "GPT-7", price: { input: 3, output: 15 }, web: ["search"] },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna", price: { input: 0.1, output: 0.5 }, web: [] },
  ],
};
const FILE_MODELS: OfferedModel[] = [
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", format: "anthropic", price: { input: 0.1, output: 0.5 } },
  { id: "openai/gpt-7", name: "GPT-7", format: "openai", price: { input: 3, output: 15 } },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", format: "openai", price: { input: 0.1, output: 0.5 }, webTools: [] },
];

/** A request Cloudflare, or GitHub, was sent: where, with which API token, and what it asked. */
interface Sent {
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

/** What Cloudflare and GitHub answer, as each test has them: the models file, each page of the model search, each search of the web, and each model's answers. */
interface Internet {
  file?: () => Response | Promise<Response>;
  search?: (page: number) => Response | Promise<Response>;
  webSearch?: (sent: Sent) => Response | Promise<Response>;
  model?: (sent: Sent) => Response | Promise<Response>;
}

/** A model's answer saying `text`, in the format `sent` asked in. */
function answering(text: string): (sent: Sent) => Response {
  return ({ url }) => {
    if (url.endsWith("/messages")) return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" });
    if (url.endsWith("/responses")) return Response.json({ object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
    return Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  };
}

/** Page `page` of the model search, listing `rows` on the first. */
const searchPage = (rows: unknown[]) => (page: number) => Response.json({ data: page === 1 ? rows : [] });

/** Cloudflare's answer to a request it refuses with `status`, in its own shape. */
const refusing = (status: number, code: number, message: string) => () => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

/** The pages the Web Search API finds. */
const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs", description: "AI Gateway is Cloudflare's proxy for AI models." };
const BLOG = { url: "https://blog.cloudflare.com/ai-gateway-ga/", title: "AI Gateway is generally available", description: "It's out." };
const found = () => Response.json({ items: [DOCS, BLOG], metadata: { query: "AI Gateway", requestId: "r", latencyMs: 600 } });

/** Stands in for Cloudflare and GitHub, as `internet` says, keeping the requests each is sent, in the order they came. */
function cloudflare({ file = () => Response.json(FILE), search = searchPage(ROWS), webSearch = found, model = answering("Hello, team!") }: Internet = {}): Sent[] {
  const requests: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? null : ((await request.json()) as Record<string, unknown>);
    const sent = { url: request.url, authorization: request.headers.get("Authorization"), body };
    requests.push(sent);
    const { pathname, searchParams } = new URL(request.url);
    if (request.url === MODELS_URL) return file();
    if (pathname.endsWith("/ai/models/search")) return search(Number(searchParams.get("page")));
    if (pathname.endsWith("/ai/websearch/")) return webSearch(sent);
    return model(sent);
  });
  return requests;
}

/** Where the requests in `sent` went, without their queries. */
const placesOf = (sent: Sent[]) => sent.map(({ url }) => url.split("?")[0]);

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Sets Ember up with Ada, and Ember AI on with `setup`, as Set up Ember AI does, which has to work. */
async function setUpWithAssistant(setup: Record<string, unknown> = SETUP): Promise<Session> {
  const ada = await setUp();
  cloudflare();
  const response = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: ada.cookie }, body: JSON.stringify(setup) });
  expect(response.status, await response.clone().text()).toBe(200);
  vi.restoreAllMocks();
  return ada;
}

/** The models Ember offers `session`, as `POST /api/account/assistant/offered` answers with `keys`, from a Worker bound as this suite's is but for `changes`. */
const listed = (session: Session | null, keys: unknown = {}, changes = {}) =>
  apiWith(changes, "/api/account/assistant/offered", { method: "POST", headers: session ? { Cookie: session.cookie } : {}, body: JSON.stringify(keys) });

/** The same, which has to work. */
async function offered(session: Session, keys: unknown = {}, changes = {}): Promise<OfferedModels> {
  const response = await listed(session, keys, changes);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return (await response.json()) as OfferedModels;
}

/** The models file's models as `parseModelsFile` reads them, and the one it suggests. */
const READ = { models: FILE_MODELS, suggested: FILE.suggested };

beforeEach(freshDeploy);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("The models Ember offers", () => {
  it("are those the models file lists, then Workers AI's that take tools, as the model search lists them for Ember AI's account, by their names", async () => {
    const ada = await setUpWithAssistant();
    const requests = cloudflare();

    expect(await offered(ada)).toEqual({ models: [...ASSISTANT_MODELS, ...WORKERS_AI], suggested: SUGGESTED_MODEL, workersAi: null } satisfies OfferedModels);
    expect(requests.map(({ url, authorization }) => [url, authorization])).toEqual([
      [`${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/models/search?task=Text+Generation&format=openrouter&hide_experimental=true&per_page=100&page=1`, `Bearer ${API_TOKEN}`],
    ]);
  });

  it("read every page of the model search, the first alone and then a few at once, until one isn't full", async () => {
    const ada = await setUpWithAssistant();
    const fullPage = (page: number) => Array.from({ length: 100 }, (_, n) => ({ ...GEMMA_ROW, id: `@cf/acme/model-${page}-${n}`, name: `Model ${page}-${n}` }));
    const requests = cloudflare({ search: (page) => Response.json({ data: page <= 3 ? fullPage(page) : page === 4 ? [GLM_ROW] : [] }) });

    const { models } = await offered(ada);
    expect(models.filter(({ format }) => format === "workers")).toHaveLength(200);
    expect(models).toContainEqual(GLM);
    expect(requests.map(({ url }) => new URL(url).searchParams.get("page"))).toEqual(["1", "2", "3", "4"]);
  });

  it("read the models file at once the first time, which is kept, and answered with until it's a day old, when it's read again for the next listing", async () => {
    const ada = await setUpWithAssistant();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    let file: () => Response | Promise<Response> = () => Response.json(FILE);
    const requests = cloudflare({ file: () => file() });

    expect(await offered(ada, {}, WITH_THE_FILE)).toEqual({ ...READ, models: [...FILE_MODELS, ...WORKERS_AI], workersAi: null });
    expect(await workspaceStub().keptModelsFile()).toEqual({ url: MODELS_URL, file: READ, triedAt: Date.now(), read: true });
    expect(requests.filter(({ url }) => url === MODELS_URL).map(({ authorization }) => authorization)).toEqual([null]);

    // A later file, held back until the test lets GitHub answer.
    let answer = () => {};
    const held = new Promise<void>((resolve) => (answer = resolve));
    file = async () => (await held, Response.json({ ...FILE, models: FILE.models.slice(0, 1) }));
    vi.setSystemTime(Date.now() + OFFERED_FRESH_MS - 1);
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual([...FILE_MODELS, ...WORKERS_AI]);
    vi.setSystemTime(Date.now() + 1);
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual([...FILE_MODELS, ...WORKERS_AI]);
    await vi.waitFor(() => expect(placesOf(requests).filter((url) => url === MODELS_URL)).toHaveLength(2));
    answer();
    await vi.waitFor(async () => expect((await workspaceStub().keptModelsFile())?.file?.models).toEqual(FILE_MODELS.slice(0, 1)));
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual([FILE_MODELS[0], ...WORKERS_AI]);
  });

  it("are the shipped file's while the models file can't be read, which is tried again an hour later, and the last read's once one is", async () => {
    const ada = await setUpWithAssistant();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let file: () => Response = () => new Response("Not Found", { status: 404 });
    const requests = cloudflare({ file: () => file() });
    const fileReads = () => placesOf(requests).filter((url) => url === MODELS_URL).length;
    const shippedModels = [...ASSISTANT_MODELS, ...WORKERS_AI];

    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual(shippedModels);
    expect(errors).toHaveBeenCalledWith(`The models file wasn't read, as ${MODELS_URL} answered 404`);
    vi.setSystemTime(Date.now() + MODELS_FILE_RETRY_MS - 1);
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual(shippedModels);
    expect(fileReads()).toBe(1);

    // One for another version of Ember, then one larger than Ember reads, aren't read either.
    file = () => Response.json({ ...FILE, version: MODELS_FILE_VERSION + 1 });
    vi.setSystemTime(Date.now() + 1);
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual(shippedModels);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("The models file wasn't read, as it isn't one this Ember reads"));
    file = () => new Response(" ".repeat(64 * 1024 + 1));
    vi.setSystemTime(Date.now() + MODELS_FILE_RETRY_MS);
    await offered(ada, {}, WITH_THE_FILE);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("The models file wasn't read, as it is larger than Ember reads"));

    file = () => Response.json(FILE);
    vi.setSystemTime(Date.now() + MODELS_FILE_RETRY_MS);
    await offered(ada, {}, WITH_THE_FILE);
    await vi.waitFor(async () => expect((await workspaceStub().keptModelsFile())?.read).toBe(true));
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual([...FILE_MODELS, ...WORKERS_AI]);

    // And it's kept while a later read fails.
    file = () => new Response("Bad Gateway", { status: 502 });
    vi.setSystemTime(Date.now() + OFFERED_FRESH_MS);
    await offered(ada, {}, WITH_THE_FILE);
    await vi.waitFor(async () => expect((await workspaceStub().keptModelsFile())?.read).toBe(false));
    expect((await offered(ada, {}, WITH_THE_FILE)).models).toEqual([...FILE_MODELS, ...WORKERS_AI]);
  });

  it("keep the file another read kept when a read that started before it fails", async () => {
    const stub = workspaceStub();
    await stub.keepModelsFile({ url: MODELS_URL, file: READ, triedAt: 1, read: true });
    await stub.keepModelsFile({ url: MODELS_URL, file: null, triedAt: 2, read: false });
    expect(await stub.keptModelsFile()).toEqual({ url: MODELS_URL, file: READ, triedAt: 2, read: false });
    // But not one read at another address.
    await stub.keepModelsFile({ url: `${MODELS_URL}?branch`, file: null, triedAt: 3, read: false });
    expect(await stub.keptModelsFile()).toEqual({ url: `${MODELS_URL}?branch`, file: null, triedAt: 3, read: false });
  });

  it("are the models file's alone when Cloudflare doesn't let the API token list Workers AI's, saying why, which forgets those kept", async () => {
    const ada = await setUpWithAssistant();
    vi.spyOn(console, "error").mockImplementation(() => {});
    cloudflare();
    await offered(ada);
    expect((await workspaceStub().keptWorkersAiModels(ACCOUNT_ID))?.models).toEqual(WORKERS_AI);
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    cloudflare({ search: refusing(403, 10000, "Authentication error") });

    // Typed into Set up Ember AI, an API token lists them at once, and forgets what was kept when it's refused.
    expect(await offered(ada, { accountId: ACCOUNT_ID, apiToken: OTHER_API_TOKEN })).toEqual({ models: [...ASSISTANT_MODELS], suggested: SUGGESTED_MODEL, workersAi: WORKERS_AI_TOKEN_REFUSED });
    expect(await workspaceStub().keptWorkersAiModels(ACCOUNT_ID)).toBeNull();
    expect((await offered(ada)).workersAi).toBe(WORKERS_AI_TOKEN_REFUSED);
  });

  it("are listed for the account Set up Ember AI is given, with the API token it's given, or Ember AI's, which they're kept for", async () => {
    const ada = await setUpWithAssistant();
    const requests = cloudflare({ search: searchPage([GEMMA_ROW]) });

    expect((await offered(ada, { accountId: OTHER_ACCOUNT_ID, apiToken: OTHER_API_TOKEN })).models).toEqual([...ASSISTANT_MODELS, GEMMA]);
    expect((await offered(ada, { accountId: OTHER_ACCOUNT_ID })).models).toEqual([...ASSISTANT_MODELS, GEMMA]);
    expect(requests.map(({ url, authorization }) => [new URL(url).pathname, authorization])).toEqual([
      [`/client/v4/accounts/${OTHER_ACCOUNT_ID}/ai/models/search`, `Bearer ${OTHER_API_TOKEN}`],
    ]);
    expect((await workspaceStub().keptWorkersAiModels(OTHER_ACCOUNT_ID))?.models).toEqual([GEMMA]);
    expect(await workspaceStub().keptWorkersAiModels(ACCOUNT_ID)).toBeNull();
  });

  it("are the models file's alone, without an API token to list Workers AI's with, and only administrators'", async () => {
    const ada = await setUp();
    const requests = cloudflare();
    expect(await offered(ada)).toEqual({ models: [...ASSISTANT_MODELS], suggested: SUGGESTED_MODEL, workersAi: API_TOKEN_NEEDED });
    expect(requests).toEqual([]);

    expect((await listed(null)).status).toBe(401);
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const joined = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" }) });
    expect((await listed({ user: { id: "grace", name: "Grace" }, cookie: cookieOf(joined) })).status).toBe(403);
    const refused = await listed(ada, { accountId: "nope" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ field: "accountId" });
  });

  it("leave out a model from the day it stops running, when it can't be added, though a listing kept since the day before lists it", async () => {
    const stops = new Date(`${STOPS}T00:00:00Z`).getTime();
    vi.useFakeTimers({ toFake: ["Date"], now: stops - 12 * 60 * 60 * 1000 });
    const ada = await setUpWithAssistant();
    const requests = cloudflare();
    expect((await offered(ada)).models).toEqual([...ASSISTANT_MODELS, ...WORKERS_AI]);

    vi.setSystemTime(stops);
    expect((await offered(ada)).models).toEqual([...ASSISTANT_MODELS, GEMMA, QWQ]);
    const added = await api("/api/account/assistant/models", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ model: GLM.id }) });
    expect([added.status, await added.json()]).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
    // The listing kept since the day before is the one the model search answered then.
    expect(placesOf(requests)).toEqual([`${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/models/search`]);
  });

  it("suggest the first that runs still once the one the models file suggests stops, with an account or without one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${STOPS}T00:00:00Z`).getTime() });
    const stopping = { ...FILE, models: FILE.models.map((model) => (model.id === FILE.suggested ? { ...model, until: STOPS } : model)) };
    const running = FILE_MODELS.slice(1);

    const ada = await setUp();
    cloudflare({ file: () => Response.json(stopping) });
    expect(await offered(ada, {}, WITH_THE_FILE)).toEqual({ models: running, suggested: "openai/gpt-7", workersAi: API_TOKEN_NEEDED });
    const setup = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: ada.cookie }, body: JSON.stringify(SETUP) });
    expect(setup.status, await setup.clone().text()).toBe(200);
    expect(await offered(ada, {}, WITH_THE_FILE)).toEqual({ models: [...running, GEMMA, QWQ], suggested: "openai/gpt-7", workersAi: null });
  });
});

describe("What the model search says of a model", () => {
  it("is offered for one of Workers AI's that reads and writes text and takes tools, with what it costs and when it stops", () => {
    expect([GLM_ROW, GEMMA_ROW, QWQ_ROW].map(workersAiModelOf)).toEqual([GLM, GEMMA, QWQ]);
    for (const row of [...UNOFFERED_ROWS, null, "@cf/zai-org/glm-5.2", { ...GLM_ROW, id: "@cf/zai org/glm" }]) expect(workersAiModelOf(row)).toBeNull();
    expect(workersAiModelOf({ ...GEMMA_ROW, name: undefined, pricing: { prompt: "free" } })).toEqual({ id: GEMMA_ROW.id, name: "gemma-4-26b-a4b-it", format: "workers", thinkingLevels: [] });
    expect(workersAiModelOf({ ...GLM_ROW, deprecation_date: "soon" })).not.toHaveProperty("until");
  });

  it("gives the levels of thinking it takes, as the efforts Ember asks for are among those it supports, with nothing turned into more", () => {
    expect(thinkingLevelsIn(GLM_ROW.reasoning)).toEqual(["off", "high"]);
    expect(thinkingLevelsIn(QWQ_ROW.reasoning)).toEqual(["low", "medium", "high"]);
    expect(thinkingLevelsIn({ supported_efforts: ["none", "low", "medium", "high"] })).toEqual(["off", "low", "medium", "high"]);
    // High turned into the most counts as High, as Ember's is its most.
    expect(thinkingLevelsIn({ supported_efforts: ["none", "max"], normalizes_to: { high: "max", low: "max" } })).toEqual(["off", "high"]);
    expect(thinkingLevelsIn(null)).toEqual([]);
    for (const reasoning of [undefined, {}, { supported_efforts: [] }]) expect(thinkingLevelsIn(reasoning)).toBeUndefined();
  });
});

describe("A model Ember offers", () => {
  /** Sets Ember AI up as `session` with `setup`, as Set up Ember AI does. */
  const setUpAs = (session: Session, setup: unknown, changes = {}) =>
    apiWith(changes, "/api/account/assistant", { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify(setup) });
  /** Adds `model` as `session`, as Add a model does. */
  const addAs = (session: Session, model: string, changes = {}) =>
    apiWith(changes, "/api/account/assistant/models", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ model }) });

  it("of Workers AI's is set up in Workers AI's format, at the levels of thinking the model search lists, asked only the test question", async () => {
    const ada = await setUp();
    const requests = cloudflare();

    const response = await setUpAs(ada, { ...SETUP, model: GLM.id });
    expect(response.status, await response.clone().text()).toBe(200);
    const { assistant } = (await response.json()) as AssistantSaved;
    expect(assistant.models).toEqual([{ id: GLM.id, name: "GLM 5.2", format: "workers", thinkingLevels: ["off", "high"] }]);
    expect(assistant.webTools).toEqual([]);
    expect(placesOf(requests)).toEqual([`${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/models/search`, CHAT_COMPLETIONS]);
    expect(requests[1]!.body).toMatchObject({ model: GLM.id });
    expect(requests[1]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("is the only kind set up or added, as the model search and the models file list them, refused on the model's field before it's asked", async () => {
    const ada = await setUp();
    const requests = cloudflare({ search: searchPage([GEMMA_ROW]) });
    for (const model of [GLM.id, "@cf/meta/llama-3.2-1b-instruct", "openai/gpt-7"]) {
      const response = await setUpAs(ada, { ...SETUP, model });
      expect([response.status, await response.json()], model).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
    }
    expect(placesOf(requests)).toEqual([`${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/models/search`]);

    // Once the models file lists GPT-7, it's added, by the file's name for it.
    vi.restoreAllMocks();
    cloudflare();
    expect((await setUpAs(ada, SETUP, WITH_THE_FILE)).status).toBe(200);
    await offered(ada, {}, WITH_THE_FILE);
    const gpt = await addAs(ada, "openai/gpt-7", WITH_THE_FILE);
    expect(gpt.status, await gpt.clone().text()).toBe(200);
    expect(((await gpt.json()) as AssistantSaved).assistant.models.map(({ id, name }) => [id, name])).toEqual([
      ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"],
      ["openai/gpt-7", "GPT-7"],
    ]);
    // Which Grok, that the file leaves out, isn't.
    expect(await (await addAs(ada, "xai/grok-4.7", WITH_THE_FILE)).json()).toEqual({ error: MODEL_REFUSED, field: "model" });
  });

  it.each([
    [403, 5035, "This model requires the Workers Paid plan.", 422, "Cloudflare runs this model only for accounts on Workers Paid, or whose AI Gateway's credits pay for Workers AI. Choose another, move the account to Workers Paid, or choose Unified billing under Workers AI Billing in the default gateway's settings in AI Gateway.", "model"],
    [410, 5028, `${GLM.id} was deprecated on ${STOPS}. See the model catalog for alternatives.`, 422, "Cloudflare no longer runs this model. Choose another.", "model"],
    [
      429,
      3036,
      "You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
      429,
      "The account has used the 10,000 Neurons Workers AI runs models on free each day, which start again at midnight UTC. To go on before then, move it to Workers Paid, or choose Unified billing under Workers AI Billing in the default gateway's settings in AI Gateway, so that AI Gateway's credits pay.",
      null,
    ],
    [429, 3040, "Capacity temporarily exceeded, please try again.", 429, "Workers AI has no room to run this model just now. Try again in a moment.", null],
  ] as const)("of Workers AI's that Workers AI answers %i, %i, for is refused, saying why", async (status, code, message, answered, refusal, field) => {
    const ada = await setUp();
    cloudflare({ model: refusing(status, code, message) });
    const response = await setUpAs(ada, { ...SETUP, model: GLM.id });
    expect([response.status, await response.json()]).toEqual([answered, { error: `${refusal} Cloudflare says: ${message}`, ...(field && { field }) }]);
  });

  it("of Workers AI's makes an agent in Workers AI's format, at the levels the model search lists, and one it doesn't list doesn't", async () => {
    const ada = await setUpWithAssistant();
    const requests = cloudflare();
    const recap: NewAgent = { name: "Recap", description: "Sums up long threads", instructions: "Sum up the thread.", model: QWQ.id, thinking: "medium", length: "short", webSearch: false, rooms: null };
    const made = await apiWith({}, "/api/account/agents", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify(recap) });
    expect(made.status, await made.clone().text()).toBe(201);
    expect(((await made.json()) as AgentAnswer).agent).toMatchObject({ model: QWQ.id, modelName: "QwQ 32B", format: "workers", thinkingLevels: ["low", "medium", "high"] });
    expect(placesOf(requests)).toEqual([`${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/models/search`, CHAT_COMPLETIONS]);

    const unlisted = await apiWith({}, "/api/account/agents", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ ...recap, name: "Tiny", model: "@cf/meta/llama-3.2-1b-instruct" }) });
    expect([unlisted.status, await unlisted.json()]).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
    expect(requests).toHaveLength(2);
  });
});

describe("Workers AI's models", () => {
  const mention = `<action-text-attachment sgid="${mentionSgid(ASSISTANT_ID)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;
  const general = async () => ((await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }])[0].id;

  /** @ember's next message in the room `client` is in. */
  async function nextAnswer(client: Client): Promise<Message> {
    for (;;) {
      const { message } = await client.next("message.created");
      if (message.creator.id === ASSISTANT_ID) return message;
    }
  }

  /** A Chat Completions answer that calls Ember's tool for searching the web for each of `queries`, or says `text`. */
  const calling = (...queries: string[]) =>
    Response.json({
      choices: [
        {
          message: { role: "assistant", content: null, tool_calls: queries.map((query, n) => ({ id: `call_${n}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } })) },
          finish_reason: "tool_calls",
        },
      ],
      usage: { completion_tokens: 20 },
    });

  /** Turns Search the web on or off as `session`, as the Ember AI card's switch does. */
  const turnWebSearch = (session: Session, on: boolean) => api("/api/account/assistant/web_search", { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ on }) });

  /** A model that searches the web with Ember's tool once it's given it, for "AI Gateway", and answers with what it found. */
  const searchingModel = (sent: Sent) => {
    const messages = (sent.body?.messages ?? []) as Array<{ role: string }>;
    if (!sent.body?.tools) return answering("Hello, team!")(sent);
    return messages.at(-1)?.role === "tool" ? answering("AI Gateway is Cloudflare's proxy for AI models.")(sent) : calling("AI Gateway");
  };

  it("search the web with Ember's tool, which Ember runs with Cloudflare's Web Search API, listing the pages found under the answer", async () => {
    const ada = await setUpWithAssistant({ ...SETUP, model: GLM.id });
    let requests = cloudflare({ model: searchingModel });
    const turned = await turnWebSearch(ada, true);
    expect(turned.status, await turned.clone().text()).toBe(200);
    expect(((await turned.json()) as WebSearchChanged).found).toBe("AI Gateway is Cloudflare's proxy for AI models.");
    vi.restoreAllMocks();

    const client = await connect(await general(), ada);
    requests = cloudflare({ model: searchingModel });
    await post(client, `<p>${mention} what's AI Gateway?</p>`);
    const answer = await nextAnswer(client);
    client.close();
    expect(answer.plainText).toBe(`AI Gateway is Cloudflare's proxy for AI models.\n\nSources: ${DOCS.title}, ${BLOG.title}`);
    expect(placesOf(requests)).toEqual([CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS]);
    const [asked, searched, toldFound] = requests;
    expect(asked!.body).toMatchObject({ model: GLM.id, tools: [{ type: "function", function: { name: "web_search" } }] });
    expect([searched!.authorization, searched!.body]).toEqual([`Bearer ${API_TOKEN}`, { query: "AI Gateway", limit: 5, options: { gateway: { id: "default" } } }]);
    const messages = toldFound!.body!.messages as Array<Record<string, unknown>>;
    expect(messages.slice(-2)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_0", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "AI Gateway" }) } }] },
      { role: "tool", tool_call_id: "call_0", content: `1. ${DOCS.title}\n${DOCS.url}\n${DOCS.description}\n\n2. ${BLOG.title}\n${BLOG.url}\n${BLOG.description}` },
    ]);
  });

  it("search as a saved agent's tests found when it's tried while the model search can't list them, as it does in a room", async () => {
    const ada = await setUpWithAssistant();
    cloudflare({ model: searchingModel });
    const scout: NewAgent = { name: "Scout", description: "Finds things", instructions: "Find it.", model: GLM.id, thinking: "off", length: "short", webSearch: true, rooms: null };
    const made = await api("/api/account/agents", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify(scout) });
    expect(made.status, await made.clone().text()).toBe(201);
    const { agent } = (await made.json()) as AgentAnswer;
    expect(agent.webTools).toEqual(["search"]);
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    cloudflare({ search: refusing(403, 10000, "Authentication error") });
    expect((await offered(ada, { accountId: ACCOUNT_ID, apiToken: OTHER_API_TOKEN })).workersAi).toBe(WORKERS_AI_TOKEN_REFUSED);
    vi.restoreAllMocks();

    vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = cloudflare({ search: refusing(403, 10000, "Authentication error"), model: searchingModel });
    const trial = { name: scout.name, instructions: scout.instructions, model: scout.model, thinking: scout.thinking, length: scout.length, webSearch: true, question: "What's AI Gateway?" };
    const tried = await api(`/api/account/agents/${agent.id}/trials`, { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify(trial) });
    expect(tried.status, await tried.clone().text()).toBe(200);
    expect(placesOf(requests).filter((url) => url !== `${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}/ai/models/search`)).toEqual([CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS]);
  });

  it("search for an agent kept from before in Chat Completions at the levels the model search lists, tried or saved", async () => {
    const ada = await setUpWithAssistant();
    cloudflare({ model: searchingModel });
    const scout: NewAgent = { name: "Scout", description: "Finds things", instructions: "Find it.", model: GLM.id, thinking: "low", length: "short", webSearch: false, rooms: null };
    const made = await api("/api/account/agents", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify(scout) });
    expect(made.status, await made.clone().text()).toBe(201);
    const { agent } = (await made.json()) as AgentAnswer;
    vi.restoreAllMocks();
    await agentWithKeptModel(agent.id, { id: GLM.id, name: "GLM 5.2", format: "chat", thinkingLevels: ["off", "low", "medium", "high"] });

    let requests = cloudflare({ model: searchingModel });
    const trial = { name: scout.name, instructions: scout.instructions, model: scout.model, thinking: "low", length: scout.length, webSearch: true, question: "What's AI Gateway?" };
    const tried = await api(`/api/account/agents/${agent.id}/trials`, { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify(trial) });
    expect(tried.status, await tried.clone().text()).toBe(200);
    // Low, which GLM 5.2 turns into High, is asked as Off, the level below it that it takes.
    expect(requests.filter(({ url }) => url === CHAT_COMPLETIONS).map(({ body }) => body?.reasoning_effort)).toEqual(["none", "none"]);
    vi.restoreAllMocks();

    requests = cloudflare({ model: searchingModel });
    const changed = await api(`/api/account/agents/${agent.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ webSearch: true }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as AgentAnswer).agent).toMatchObject({ format: "workers", thinkingLevels: ["off", "high"], webTools: ["search"] });
    expect(placesOf(requests).filter((url) => url === CHAT_COMPLETIONS)).toHaveLength(2);
  });

  it("don't search the web for a model that calls Ember's tool while Search the web is off, telling it to answer without it", async () => {
    const ada = await setUpWithAssistant({ ...SETUP, model: GLM.id });
    const client = await connect(await general(), ada);
    const requests = cloudflare({
      model: (sent) => (((sent.body?.messages ?? []) as Array<{ role: string }>).at(-1)?.role === "tool" ? answering("Answered without it.")(sent) : calling("AI Gateway")),
    });
    await post(client, `<p>${mention} what's AI Gateway?</p>`);
    expect((await nextAnswer(client)).plainText).toBe("Answered without it.");
    client.close();
    expect(placesOf(requests)).toEqual([CHAT_COMPLETIONS, CHAT_COMPLETIONS]);
    expect(requests[0]!.body?.tools).toBeUndefined();
    expect((requests[1]!.body!.messages as Array<Record<string, unknown>>).at(-1)).toEqual({ role: "tool", tool_call_id: "call_0", content: "You can't search the web for this answer. Answer without it." });
  });

  it("answer what they said cut short when they take every token an answer may as they call Ember's tool, searching no more", async () => {
    const ada = await setUpWithAssistant({ ...SETUP, model: GLM.id });
    cloudflare({ model: searchingModel });
    expect((await turnWebSearch(ada, true)).status).toBe(200);
    vi.restoreAllMocks();

    const client = await connect(await general(), ada);
    const tool_calls = [{ id: "call_0", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "AI Gateway" }) } }];
    const requests = cloudflare({
      model: () => Response.json({ choices: [{ message: { role: "assistant", content: "Let me look that up.", tool_calls }, finish_reason: "tool_calls" }], usage: { completion_tokens: 1_000_000 } }),
    });
    await post(client, `<p>${mention} what's AI Gateway?</p>`);
    expect((await nextAnswer(client)).plainText).toBe("Let me look that up.\n\n…");
    client.close();
    expect(placesOf(requests)).toEqual([CHAT_COMPLETIONS]);
  });

  it(`search at most ${WEB_SEARCHES_PER_ANSWER} times an answer, then are told to answer with what they found`, async () => {
    const ada = await setUpWithAssistant({ ...SETUP, model: GLM.id });
    cloudflare({ model: searchingModel });
    expect((await turnWebSearch(ada, true)).status).toBe(200);
    vi.restoreAllMocks();

    const client = await connect(await general(), ada);
    const told: string[] = [];
    const requests = cloudflare({
      model: (sent) => {
        const last = ((sent.body?.messages ?? []) as Array<{ role: string; content: string }>).at(-1)!;
        if (last.role === "tool") told.push(last.content);
        return told.some((content) => content.startsWith("You've searched as much")) ? answering("Done.")(sent) : calling("one", "two");
      },
    });
    await post(client, `<p>${mention} search a lot</p>`);
    expect((await nextAnswer(client)).plainText).toMatch(/^Done\./);
    client.close();
    expect(placesOf(requests).filter((url) => url === WEB_SEARCH)).toHaveLength(WEB_SEARCHES_PER_ANSWER);
  });

  it("don't turn Search the web on when the Web Search API refuses Ember AI's API token, saying which permissions it needs", async () => {
    const ada = await setUpWithAssistant({ ...SETUP, model: GLM.id });
    vi.spyOn(console, "error").mockImplementation(() => {});
    cloudflare({ model: searchingModel, webSearch: refusing(403, 10000, "Authentication error") });

    const response = await turnWebSearch(ada, true);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: `${SEARCH_TOKEN_REFUSED} Cloudflare says: Authentication error` });
    const settings = ((await (await api("/api/account", { headers: { Cookie: ada.cookie } })).json()) as WorkspaceSettings).assistant;
    expect(settings?.webTools).toEqual([]);
  });

  it.each([
    [410, 5028, "retired"],
    [429, 3036, "neurons"],
  ] as const)("have @ember say why it can't answer when Workers AI answers %i, %i, as it does for the model someone picked", async (status, code, reason) => {
    const ada = await setUpWithAssistant({ ...SETUP, model: GLM.id });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(await general(), ada);
    cloudflare({ model: refusing(status, code, "Workers AI won't run it.") });
    await post(client, `<p>${mention} hello?</p>`);
    expect((await nextAnswer(client)).plainText).toBe(NOTES[reason]);
    client.close();

    // With Claude Sonnet answering everyone, the model Ada picked is GLM 5.2.
    vi.restoreAllMocks();
    cloudflare();
    expect((await api("/api/account/assistant/models", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ model: SETUP.model }) })).status).toBe(200);
    expect((await api("/api/account/assistant", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ model: SETUP.model }) })).status).toBe(200);
    expect((await api("/api/users/me/assistant", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ model: GLM.id }) })).status).toBe(200);
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const again = await connect(await general(), ada);
    cloudflare({ model: refusing(status, code, "Workers AI won't run it.") });
    await post(again, `<p>${mention} hello again?</p>`);
    expect((await nextAnswer(again)).plainText).toBe(PICKED_MODEL_NOTES[reason]);
    again.close();
  });

  it("kept from before in Chat Completions are asked in Workers AI's format, at the levels the model search lists, once it lists them", async () => {
    const ada = await setUpWithAssistant();
    await addKeptModels({ id: GLM.id, name: "GLM 5.2", format: "chat", thinkingLevels: ["off", "low", "medium", "high"] });
    await api("/api/users/me/assistant", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ model: GLM.id, thinking: "low" }) });
    cloudflare();
    await offered(ada);
    vi.restoreAllMocks();

    const client = await connect(await general(), ada);
    const requests = cloudflare();
    await post(client, `<p>${mention} hello?</p>`);
    expect((await nextAnswer(client)).plainText).toBe("Hello, team!");
    client.close();
    // Low, which GLM 5.2 turns into High, is asked as Off, the level below it that it takes.
    expect(requests.map(({ url, body }) => [url, body?.reasoning_effort])).toEqual([[CHAT_COMPLETIONS, "none"]]);
  });

  it("aren't given tools for the web the models file says a model may not use, as GPT-6 Luna isn't", async () => {
    const ada = await setUpWithAssistant({ ...SETUP, model: "openai/gpt-6-luna" });
    cloudflare({ model: (sent) => (sent.body?.tools ? Response.json({ object: "response", status: "completed", output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "Found.", annotations: [{ type: "url_citation", url: DOCS.url, title: DOCS.title }] }] }] }) : answering("Hello, team!")(sent)) });
    expect((await turnWebSearch(ada, true)).status).toBe(200);
    vi.restoreAllMocks();
    cloudflare();
    await offered(ada, {}, WITH_THE_FILE);
    vi.restoreAllMocks();

    await withWorkspaceEnv(WITH_THE_FILE, async () => {
      const client = await connect(await general(), ada);
      const requests = cloudflare();
      await post(client, `<p>${mention} hello?</p>`);
      await nextAnswer(client);
      client.close();
      // The only tool it's given is the room's search, which Ember runs.
      const given = requests.map(({ body }) => (body?.tools as Array<{ type: string; name?: string }> | undefined)?.map(({ type, name }) => [type, name]));
      expect(given).toEqual([[["function", "search_messages"]]]);
    });
  });
});

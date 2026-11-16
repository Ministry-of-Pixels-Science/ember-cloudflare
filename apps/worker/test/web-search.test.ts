import { ASSISTANT_ID, ASSISTANT_NAME, MAX_MESSAGE_HTML_LENGTH, type Message, type NewWorkspace, type RoomId, type User, type WorkspaceSettings } from "@ember/protocol";
import {
  ASSISTANT_FORBIDDEN,
  ASSISTANT_OFF,
  cannotSearchWith,
  PAGES_READ_PER_ANSWER,
  THINKING_LEVELS,
  WEB_SEARCH_CHANGED,
  WEB_SEARCH_REFUSED,
  WEB_SEARCHES_PER_ANSWER,
  type AssistantSaved,
  type AssistantSettings,
  type WebSearchChanged,
} from "@ember/protocol/assistant";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerOf, questionFor } from "../src/assistant/answers";
import { answeredUnsearched, webToolsRefused } from "../src/assistant/settings";
import { addKeptModels, answerWithKeptModel, api, connect, cookieOf, freshDeploy, post, shown, workspaceSql, type Client, type KeptModel, type Session } from "./support";

// Search the web, which lets @ember search the web and read pages through its model's own tools, as AI
// Gateway passes them on, once its model has searched for a test question, and the pages its answers
// came from, which it lists after them.

const EMBER: User = { id: ASSISTANT_ID, name: ASSISTANT_NAME };
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
/** Another Cloudflare account, and another API token. */
const [OTHER_ACCOUNT_ID, OTHER_API_TOKEN] = ["fedcba9876543210fedcba9876543210", "another-api-token-with-ai-gateway-run_01"];
/** Anthropic's model, which takes Messages, OpenAI's, which takes Responses, and DeepSeek's, which takes Chat Completions, where it has no tools for the web. */
const [MESSAGES_MODEL, RESPONSES_MODEL, CHAT_MODEL] = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "deepseek/deepseek-v4-pro"];
/** xAI's Grok, which searches the web with Ember's own tool in Chat Completions, through Cloudflare's REST API, and another of xAI's. */
const [GROK, OTHER_GROK] = ["xai/grok-4.7", "xai/grok-4.5"];
/** Another of Anthropic's. */
const HAIKU = "anthropic/claude-haiku-5.5";
/** Where the account's default gateway passes requests on to each provider's own API: Anthropic's Messages and OpenAI's Responses. */
const PROVIDER_ENDPOINTS = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/default`;
const ANTHROPIC_ENDPOINT = `${PROVIDER_ENDPOINTS}/anthropic/v1/messages`;
const OPENAI_ENDPOINT = `${PROVIDER_ENDPOINTS}/openai/responses`;
/** Where Cloudflare's REST API takes Chat Completions, through the default gateway, and Cloudflare's Web Search API, which Ember searches with for a model given its own tool. */
const CHAT_COMPLETIONS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
const WEB_SEARCH = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/websearch/`;
/** Ember's own tool for searching the web, as a model in Chat Completions is given it. */
const EMBERS_SEARCH = { type: "function", function: expect.objectContaining({ name: "web_search" }) };

/** Anthropic's tools for searching the web and reading pages, as Ember gives a model that may. */
const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCHES_PER_ANSWER };
const READ_TOOL = { type: "web_fetch_20250910", name: "web_fetch", max_uses: PAGES_READ_PER_ANSWER, max_content_tokens: 10_000 };

/** The pages the model's search finds. */
const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs" };
const BLOG = { url: "https://blog.cloudflare.com/ai-gateway-ga/", title: "AI Gateway is generally available" };
const FOUND = "AI Gateway is Cloudflare's proxy for requests to AI models, with logs and caching.";

/** A request the fake AI Gateway was sent, with the API token as Cloudflare's API takes it, or as AI Gateway's endpoints for each provider do. */
interface Asked {
  url: string;
  authorization: string | null;
  aigAuthorization: string | null;
  body: {
    model?: string;
    tools?: unknown[];
    system?: string;
    instructions?: string;
    max_tokens?: number;
    messages?: Array<{ role: string; content: unknown }>;
    reasoning?: { effort?: string };
  };
}

/**
 * Stands in for AI Gateway, answering each request with `answer`, and keeping what it's sent, but for the
 * tools Ember runs itself, which an answer in a room is given beside the web's (ember-tools.test.ts).
 */
function fakeGateway(answer: (asked: Asked) => Response | Promise<Response>): Asked[] {
  const requests: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { headers } = request;
    const { tools, ...body } = (await request.json()) as Asked["body"];
    const webTools = tools?.filter((tool) => !isEmbersTool(tool)) ?? [];
    const asked = { url: request.url, authorization: headers.get("Authorization"), aigAuthorization: headers.get("cf-aig-authorization"), body: { ...body, ...(webTools.length > 0 && { tools: webTools }) } };
    requests.push(asked);
    return answer(asked);
  });
  return requests;
}

/**
 * Whether `tool` is one Ember runs, as Messages or Responses lists one, rather than one of a provider's own
 * or Ember's own for searching the web, which Chat Completions lists as a function too.
 */
function isEmbersTool(tool: unknown): boolean {
  const { type, function: called } = tool as { type?: string; function?: { name?: string } };
  return type === undefined || (type === "function" && called?.name !== "web_search");
}

/** Whether a request to `url` goes to one of AI Gateway's endpoints for each provider, as Ember asks Claude and GPT, and not to Cloudflare's API. */
const toProvider = (url: string) => new URL(url).hostname === "gateway.ai.cloudflare.com";

/** Whether `asked` gives the model a tool of `type`'s. */
const gives = ({ body }: Asked, type: string) => (body.tools ?? []).some((tool) => (tool as { type: string }).type.startsWith(type));

/** A search result, or a citation of one, of `page`'s, as Anthropic's Messages has them. */
const searchResult = (page: typeof DOCS) => ({ type: "web_search_result", ...page, encrypted_content: "e", page_age: null });
const citing = (page: typeof DOCS) => ({ type: "web_search_result_location", ...page, encrypted_index: "e", cited_text: "…" });

/** Anthropic's model searching the web: what it says it'll look for, its search and what came of it. */
const SEARCHING = [
  { type: "text", text: "I'll look that up." },
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Cloudflare AI Gateway" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [searchResult(DOCS), searchResult(BLOG)] },
];

/** Its answer once it has searched, citing what it found. */
const CITED = [
  { type: "text", text: "AI Gateway is " },
  { type: "text", text: "Cloudflare's proxy for requests to AI models", citations: [citing(DOCS)] },
  { type: "text", text: ", with logs and caching.", citations: [citing(BLOG), citing(DOCS)] },
];

/** Anthropic's model's answer with `content`, stopped for `reason` once it had `written` as many tokens. */
const messagesAnswer = (content: unknown[], reason = "end_turn", written = 100) =>
  Response.json({ type: "message", role: "assistant", content, stop_reason: reason, usage: { input_tokens: 1_000, output_tokens: written } });

/** What a model says without searching, in the format of the API at `url`. */
function unsearched(url: string, text: string): Response {
  if (url.endsWith("/messages")) return messagesAnswer([{ type: "text", text }]);
  if (url.endsWith("/responses")) return Response.json({ object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
  return Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
}

/** OpenAI's model's answer once it has searched, linking to the docs as it cites them, and citing the blog without a link. */
const RESPONSES_SEARCHED = {
  object: "response",
  status: "completed",
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Cloudflare AI Gateway" } },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: `${FOUND} ([developers.cloudflare.com](${DOCS.url}))`,
          annotations: [
            { type: "url_citation", url: DOCS.url, title: DOCS.title, start_index: 0, end_index: 10 },
            { type: "url_citation", url: BLOG.url, title: BLOG.title, start_index: 10, end_index: 20 },
          ],
        },
      ],
    },
  ],
};

/**
 * A model in Chat Completions given Ember's own tool for searching the web, which calls it for "Cloudflare
 * AI Gateway", then says what it found, as Cloudflare's Web Search API finds the docs and the blog.
 */
function searchingInChat({ url, body }: Asked): Response {
  if (url === WEB_SEARCH) return Response.json({ success: true, result: { items: [DOCS, BLOG].map((page) => ({ ...page, description: "About AI Gateway." })) } });
  if (body.messages?.at(-1)?.role === "tool") return unsearched(url, FOUND);
  const call = { id: "call_0", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "Cloudflare AI Gateway" }) } };
  return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { completion_tokens: 20 } });
}

/** A model that searches the web whenever it's given a tool for it, in the format of the API at `url`, and else says it can't. */
function searching({ url, ...asked }: Asked): Response {
  if (url === WEB_SEARCH || (url === CHAT_COMPLETIONS && asked.body.tools)) return searchingInChat({ url, ...asked });
  if (!gives({ url, ...asked }, "web_search")) return unsearched(url, "I can't search the web.");
  return url.endsWith("/responses") ? Response.json(RESPONSES_SEARCHED) : messagesAnswer([...SEARCHING, ...CITED]);
}

/** The levels of thinking a model takes when it takes every one, and those Grok took in xAI's own Responses. */
const ALL_LEVELS = [...THINKING_LEVELS];
const XAI_LEVELS = ["low", "medium", "high"];

/** `model`, called `name`, as a copy set up before Ember asked it through its provider's endpoint keeps it, in `format`, through Cloudflare's REST API. */
const keptIn = (format: KeptModel["format"], id: string, name: string): KeptModel => ({ id, name, format, thinkingLevels: ALL_LEVELS });
const KEPT_DEEPSEEK = keptIn("chat", CHAT_MODEL, "DeepSeek V4 Pro");

/** Sets Ember up with Ada as its administrator, signed in, and Ember AI on with `model`, as `setUpAssistant` sets it up. */
async function setUp(model = MESSAGES_MODEL): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  await setUpAssistant(ada, model);
  return ada;
}

/** Stands in for AI Gateway as a model that answers without searching. */
function greetingGateway(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => unsearched(new Request(input, init).url, "Hello, team!"));
}

/**
 * Sets Ember AI up as `administrator` with `model`, through the account `accountId` with `apiToken`, as
 * Set up Ember AI does, answering Ember AI as it is then.
 */
async function setUpAssistant(
  administrator: Session,
  model: string,
  { accountId = ACCOUNT_ID, apiToken = API_TOKEN }: { accountId?: string; apiToken?: string } = {},
): Promise<AssistantSaved["assistant"]> {
  greetingGateway();
  const setup = { accountId, apiToken, model };
  const saved = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: administrator.cookie }, body: JSON.stringify(setup) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  vi.restoreAllMocks();
  return ((await saved.json()) as AssistantSaved).assistant;
}

/** Turns Search the web `on` or off as `session`, as its switch on the Ember AI card does. */
const turnWebSearch = (session: Session | null, on: unknown) =>
  api("/api/account/assistant/web_search", { method: "PUT", headers: session ? { Cookie: session.cookie } : {}, body: JSON.stringify({ on }) });

/** Turns Search the web on or off as `administrator`, which has to work, answering what came of it. */
async function turnedWebSearch(administrator: Session, on: boolean): Promise<WebSearchChanged> {
  const response = await turnWebSearch(administrator, on);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WebSearchChanged;
}

/** Changes Ember AI as `administrator`, as the Ember AI card does: its dials, or which model answers everyone. */
const changeAssistant = (administrator: Session, changes: unknown) =>
  api("/api/account/assistant", { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify(changes) });

/** Adds `model` to those people can pick as `administrator`, as Add a model does, or takes it out, as its Remove does, which has to work. */
async function changeModels(administrator: Session, method: "POST" | "DELETE", model: string): Promise<void> {
  const response = await api("/api/account/assistant/models", { method, headers: { Cookie: administrator.cookie }, body: JSON.stringify({ model }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Has @ember answer `person` with `model`, as their profile's Model menu does. */
async function pickModel(person: Session, model: string): Promise<void> {
  const response = await api("/api/users/me/assistant", { method: "PATCH", headers: { Cookie: person.cookie }, body: JSON.stringify({ model }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Ember AI as the account's settings keep it. */
const storedAssistant = async () => {
  const [{ settings }] = (await workspaceSql("SELECT settings FROM accounts")) as [{ settings: string }];
  return (JSON.parse(settings) as { assistant: { web_tools?: unknown; web_tools_asked_at?: unknown } | null }).assistant;
};

/** What Ember AI's model may do on the web, as the account's settings keep it. */
const storedWebTools = async () => (await storedAssistant())?.web_tools;

/** The format Ember AI asks the model that answers everyone in, and each model people can pick with the format and levels of thinking it's asked in, as the account's settings keep them. */
const storedModels = async () => {
  const { format, models } = (await storedAssistant()) as unknown as { format: string; models: Array<{ id: string; format: string; thinking_levels?: string[] }> };
  return [format, models.map(({ id, format, thinking_levels }) => [id, format, thinking_levels])];
};

/** Ember AI as the workspace's settings show it to `session`. */
const assistantSettings = async (session: Session) => ((await (await api("/api/account", { headers: { Cookie: session.cookie } })).json()) as WorkspaceSettings).assistant;

/** A message mentioning @ember. */
const askEmber = (question: string) => `<p><action-text-attachment sgid="${mentionSgid(ASSISTANT_ID)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment> ${question}</p>`;

/** The next message @ember posts that `client` hears of. */
async function nextAnswer(client: Client): Promise<Message> {
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.creator.id === ASSISTANT_ID) return message;
  }
}

/** The general room's id. */
const generalRoom = async () => ((await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }])[0].id;

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Search the web", () => {
  it("turns on once the model has searched the web for a test question with Anthropic's tools, saying what it found", async () => {
    const ada = await setUp();
    expect((await assistantSettings(ada))!.webTools).toEqual([]);
    const requests = fakeGateway(searching);

    const response = await turnWebSearch(ada, true);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { assistant, found } = (await response.json()) as WebSearchChanged;
    expect(assistant).toMatchObject({ model: MESSAGES_MODEL, webTools: ["search", "read"] });
    // What it said once it searched, without what it said it would look for.
    expect(found).toBe(FOUND);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(ANTHROPIC_ENDPOINT);
    expect(requests[0]!.body.tools).toEqual([SEARCH_TOOL, READ_TOOL]);
    expect(requests[0]!.body.messages).toEqual([{ role: "user", content: expect.stringContaining("Search the web") as unknown }]);

    expect(await storedWebTools()).toEqual(["search", "read"]);
    expect((await assistantSettings(ada))!.webTools).toEqual(["search", "read"]);
  });

  it("only searches when AI Gateway doesn't take the tool for reading pages", async () => {
    const ada = await setUp();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = fakeGateway((asked) =>
      gives(asked, "web_fetch") ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "tools.1: unknown tool type" } }, { status: 400 }) : searching(asked),
    );

    expect((await turnedWebSearch(ada, true)).assistant.webTools).toEqual(["search"]);
    expect(requests.map(({ body }) => body.tools)).toEqual([[SEARCH_TOOL, READ_TOOL], [SEARCH_TOOL]]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${MESSAGES_MODEL} to search again without reading pages`));
    expect(await storedWebTools()).toEqual(["search"]);
  });

  it("turns on with OpenAI's web search for a model that takes Responses", async () => {
    const ada = await setUp(RESPONSES_MODEL);
    const requests = fakeGateway(searching);

    const { assistant, found } = await turnedWebSearch(ada, true);
    expect(assistant.webTools).toEqual(["search"]);
    expect(found).toBe(`${FOUND} ([developers.cloudflare.com](${DOCS.url}))`);
    expect(requests.map(({ url, body }) => [url, body.tools])).toEqual([[OPENAI_ENDPOINT, [{ type: "web_search" }]]]);
    // What caps its calls of built-in tools caps its searches, its only one.
    expect(requests[0]!.body).toHaveProperty("max_tool_calls", WEB_SEARCHES_PER_ANSWER);
  });

  it("turns on for Grok with Ember's own tool in Chat Completions, through Cloudflare's REST API, where AI Gateway's credits pay, keeping it and the other Grok models people pick where they are", async () => {
    const ada = await setUp(GROK);
    await answerWithKeptModel(keptIn("chat", GROK, "Grok 4.7"), keptIn("chat", OTHER_GROK, "Grok 4.5"), keptIn("messages", MESSAGES_MODEL, "Claude Sonnet 5.5"));
    expect((await assistantSettings(ada))!.webTools).toEqual([]);

    const requests = fakeGateway(searching);
    const { assistant, found } = await turnedWebSearch(ada, true);
    expect(assistant.webTools).toEqual(["search"]);
    expect(found).toBe(FOUND);
    // Ember runs the search Grok asks for with Cloudflare's Web Search API, through the default gateway, and nothing goes to AI Gateway's xAI endpoint.
    expect(requests.map(({ url, authorization }) => [url, authorization])).toEqual([CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS].map((url) => [url, `Bearer ${API_TOKEN}`]));
    expect(requests[0]!.body).toMatchObject({ model: GROK, tools: [EMBERS_SEARCH] });
    expect(await storedWebTools()).toEqual(["search"]);
    expect(await storedModels()).toEqual(["chat", [[GROK, "chat", ALL_LEVELS], [OTHER_GROK, "chat", ALL_LEVELS], [MESSAGES_MODEL, "messages", ALL_LEVELS]]]);
  });

  it("moves a Grok kept in xAI's own Responses into Chat Completions once Search the web goes on, at the levels of thinking it takes there", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ada = await setUp(GROK);
    await answerWithKeptModel({ ...keptIn("xai", GROK, "Grok 4.7"), thinkingLevels: XAI_LEVELS as KeptModel["thinkingLevels"] }, keptIn("xai", OTHER_GROK, "Grok 4.5"));

    const requests = fakeGateway(searching);
    expect((await turnedWebSearch(ada, true)).assistant.webTools).toEqual(["search"]);
    expect(requests.filter(({ url }) => toProvider(url))).toEqual([]);
    expect(await storedModels()).toEqual(["chat", [[GROK, "chat", ALL_LEVELS], [OTHER_GROK, "chat", ALL_LEVELS]]]);
  });

  it("gives the Grok models people pick Ember's own tool once Search the web is on, whatever answers everyone, asking them nothing then", async () => {
    const ada = await setUp(MESSAGES_MODEL);
    await answerWithKeptModel(keptIn("messages", MESSAGES_MODEL, "Claude Sonnet 5.5"), keptIn("chat", GROK, "Grok 4.7"));
    const requests = fakeGateway(searching);
    expect((await turnedWebSearch(ada, true)).assistant.webTools).toEqual(["search", "read"]);
    expect(requests.map(({ body }) => body.model)).toEqual([MESSAGES_MODEL]);
    expect(await storedModels()).toEqual(["messages", [[MESSAGES_MODEL, "messages", ALL_LEVELS], [GROK, "chat", ALL_LEVELS]]]);
    vi.restoreAllMocks();

    const client = await connect(await generalRoom(), ada);
    await pickModel(ada, GROK);
    const asked = fakeGateway(searching);
    await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe(`${FOUND}\n\nSources: ${DOCS.title}, ${BLOG.title}`);
    client.close();
    // Claude, kept from before, moves to Anthropic's endpoint meanwhile.
    const grok = asked.filter(({ url }) => !toProvider(url));
    expect(grok.map(({ url }) => url)).toEqual([CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS]);
    // Of what @ember may do on the web, Grok only searches.
    expect(grok[0]!.body.tools).toEqual([EMBERS_SEARCH]);
  });

  it("says a model kept from before that takes Chat Completions can't search, by its name, asking it nothing", async () => {
    const ada = await setUp();
    await answerWithKeptModel(KEPT_DEEPSEEK);
    expect((await assistantSettings(ada))!.webTools).toBeNull();
    const requests = fakeGateway(searching);

    const response = await turnWebSearch(ada, true);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: cannotSearchWith("DeepSeek V4 Pro") });
    expect(requests).toEqual([]);
    expect(await storedWebTools()).toEqual([]);

    // By the name it was kept with, as Cloudflare's catalog named it then.
    await answerWithKeptModel({ ...KEPT_DEEPSEEK, name: "deepseek-v4-pro" });
    expect(await (await turnWebSearch(ada, true)).json()).toEqual({ error: cannotSearchWith("deepseek-v4-pro") });
  });

  it("stays off when AI Gateway refuses the model's tools for the web, saying so with Cloudflare's own words", async () => {
    const ada = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = fakeGateway(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "Web search is not enabled for this organization." } }, { status: 400 }));

    const response = await turnWebSearch(ada, true);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: webToolsRefused("Claude Sonnet 5.5", "Web search is not enabled for this organization.") });
    expect(requests).toHaveLength(2);
    expect(await storedWebTools()).toEqual([]);
  });

  it("stays off when the model answers without searching, or AI Gateway doesn't answer", async () => {
    const ada = await setUp();
    fakeGateway(({ url }) => unsearched(url, "AI Gateway is a gateway."));
    const response = await turnWebSearch(ada, true);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: answeredUnsearched("Claude Sonnet 5.5") });

    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeGateway(() => new Response("Bad gateway", { status: 502 }));
    expect((await turnWebSearch(ada, true)).status).toBe(502);
    expect(await storedWebTools()).toEqual([]);
  });

  it("turns off without asking the model anything", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const requests = fakeGateway(searching);

    expect(await turnedWebSearch(ada, false)).toEqual({ assistant: expect.objectContaining({ webTools: [] }) as unknown, found: null });
    expect(requests).toEqual([]);
    expect(await storedWebTools()).toEqual([]);
  });

  it("stays on through a change that keeps the model, and turns off with another model, which hasn't searched yet", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const turnedOnAt = (await storedAssistant())!.web_tools_asked_at;
    expect(turnedOnAt).toEqual(expect.any(String));

    expect((await setUpAssistant(ada, MESSAGES_MODEL)).webTools).toEqual(["search", "read"]);
    // As does when it was asked to turn on, which a change asked for before then doesn't undo.
    expect((await storedAssistant())!.web_tools_asked_at).toBe(turnedOnAt);
    expect((await setUpAssistant(ada, "anthropic/claude-opus-5.5")).webTools).toEqual([]);
    expect((await setUpAssistant(ada, MESSAGES_MODEL)).webTools).toEqual([]);
    expect(await storedWebTools()).toEqual([]);
  });

  it("stays on through another of the account's API tokens, and turns off through another account, whose AI Gateway may not take the same tools", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();

    expect((await setUpAssistant(ada, MESSAGES_MODEL, { apiToken: OTHER_API_TOKEN })).webTools).toEqual(["search", "read"]);
    expect((await setUpAssistant(ada, MESSAGES_MODEL, { accountId: OTHER_ACCOUNT_ID, apiToken: OTHER_API_TOKEN })).webTools).toEqual([]);
    expect(await storedWebTools()).toEqual([]);
  });

  it("stays on through a change to the dials or to the models people can pick, and turns off once another of them answers everyone", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    const turnedOnAt = (await storedAssistant())!.web_tools_asked_at as string;

    expect((await changeAssistant(ada, { thinking: "low" })).status).toBe(200);
    await changeModels(ada, "POST", RESPONSES_MODEL);
    await changeModels(ada, "POST", HAIKU);
    await changeModels(ada, "DELETE", HAIKU);
    // Added again, the one that answers everyone takes its test question in the format it searched in.
    await changeModels(ada, "POST", MESSAGES_MODEL);
    expect(await storedWebTools()).toEqual(["search", "read"]);
    expect((await storedAssistant())!.web_tools_asked_at).toBe(turnedOnAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const changed = await changeAssistant(ada, { model: RESPONSES_MODEL });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as { assistant: AssistantSettings }).assistant).toMatchObject({ model: RESPONSES_MODEL, webTools: [] });
    expect(await storedWebTools()).toEqual([]);
    // As of when it turned off, which nothing asked to turn on before then undoes.
    expect((await storedAssistant())!.web_tools_asked_at as string > turnedOnAt).toBe(true);
  });

  it("turns off once the model that answers everyone, kept from before, is added again, taking its test question in a format it hasn't searched in", async () => {
    const ada = await setUp();
    // Kept while Ember asked Claude through Cloudflare's REST API, where it searched in Messages.
    await answerWithKeptModel(keptIn("messages", MESSAGES_MODEL, "Claude Sonnet 5.5"));
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    expect(await storedAssistant()).toMatchObject({ format: "messages", web_tools: ["search", "read"] });

    // Through Anthropic's endpoint, as Ember asks Claude now.
    await changeModels(ada, "POST", MESSAGES_MODEL);
    expect(await storedAssistant()).toMatchObject({ format: "anthropic", web_tools: [] });
    expect((await assistantSettings(ada))!.webTools).toEqual([]);
  });

  it("turns nothing on once another of the models people can pick answers everyone, while the one asked searched", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await changeModels(ada, "POST", RESPONSES_MODEL);
    vi.restoreAllMocks();
    let asked = false;
    let answering = false;
    fakeGateway(async (request) => {
      asked = true;
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return searching(request);
    });

    const turning = turnWebSearch(ada, true);
    await vi.waitFor(() => expect(asked).toBe(true));
    expect((await changeAssistant(ada, { model: RESPONSES_MODEL })).status).toBe(200);
    answering = true;
    const refused = await turning;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: WEB_SEARCH_CHANGED });
    expect(await storedWebTools()).toEqual([]);
  });

  it("turns nothing on once Ember AI asks another model, after the one asked searched", async () => {
    const ada = await setUp();
    let asked = false;
    let answering = false;
    fakeGateway(async (request) => {
      if (!gives(request, "web_search")) return unsearched(request.url, "Hello, team!");
      asked = true;
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return searching(request);
    });

    const turning = turnWebSearch(ada, true);
    await vi.waitFor(() => expect(asked).toBe(true));
    const changed = await api("/api/account/assistant", {
      method: "PUT",
      headers: { Cookie: ada.cookie },
      body: JSON.stringify({ accountId: ACCOUNT_ID, model: "anthropic/claude-opus-5.5" }),
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    answering = true;
    const refused = await turning;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: WEB_SEARCH_CHANGED });
    expect(await storedWebTools()).toEqual([]);
  });

  it("turns nothing on once Ember AI asks through another Cloudflare account, after the one asked searched", async () => {
    const ada = await setUp();
    let asked = false;
    let answering = false;
    fakeGateway(async (request) => {
      if (!gives(request, "web_search")) return unsearched(request.url, "Hello, team!");
      asked = true;
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return searching(request);
    });

    const turning = turnWebSearch(ada, true);
    await vi.waitFor(() => expect(asked).toBe(true));
    const changed = await api("/api/account/assistant", {
      method: "PUT",
      headers: { Cookie: ada.cookie },
      body: JSON.stringify({ accountId: OTHER_ACCOUNT_ID, apiToken: OTHER_API_TOKEN, model: MESSAGES_MODEL }),
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    answering = true;
    const refused = await turning;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: WEB_SEARCH_CHANGED });
    expect(await storedWebTools()).toEqual([]);
  });

  it("turns nothing on once it's turned off, after it was asked to turn on, while the model searched", async () => {
    const ada = await setUp();
    let asked = false;
    let answering = false;
    fakeGateway(async (request) => {
      asked = true;
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return searching(request);
    });

    const turning = turnWebSearch(ada, true);
    await vi.waitFor(() => expect(asked).toBe(true));
    // Turned off a few milliseconds after it was asked to turn on, as the time it was asked goes by them.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await turnedWebSearch(ada, false)).assistant.webTools).toEqual([]);
    answering = true;
    const refused = await turning;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: WEB_SEARCH_CHANGED });
    expect(await storedWebTools()).toEqual([]);

    expect((await turnedWebSearch(ada, true)).assistant.webTools).toEqual(["search", "read"]);
  });

  it("turns nothing on once Ember AI is turned off and set up again, after it was asked to turn on, while the model searched", async () => {
    const ada = await setUp();
    let asked = false;
    let answering = false;
    fakeGateway(async (request) => {
      if (!gives(request, "web_search")) return unsearched(request.url, "Hello, team!");
      asked = true;
      while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
      return searching(request);
    });

    const turning = turnWebSearch(ada, true);
    await vi.waitFor(() => expect(asked).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    const setUpAgain = await api("/api/account/assistant", {
      method: "PUT",
      headers: { Cookie: ada.cookie },
      body: JSON.stringify({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: MESSAGES_MODEL }),
    });
    expect(setUpAgain.status, await setUpAgain.clone().text()).toBe(200);
    answering = true;
    const refused = await turning;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: WEB_SEARCH_CHANGED });
    expect(await storedWebTools()).toEqual([]);
  });

  it("is only for administrators, while Ember AI is on, before anything's asked", async () => {
    const ada = await setUp();
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const joined = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" }) });
    expect(joined.status).toBe(201);
    const grace = { user: shown(((await joined.json()) as { user: User }).user), cookie: cookieOf(joined) };
    const requests = fakeGateway(searching);

    expect((await turnWebSearch(null, true)).status).toBe(401);
    const forbidden = await turnWebSearch(grace, true);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: ASSISTANT_FORBIDDEN });
    const unsaid = await turnWebSearch(ada, "yes");
    expect(unsaid.status).toBe(422);
    expect(await unsaid.json()).toEqual({ error: WEB_SEARCH_REFUSED });

    expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    for (const on of [true, false]) {
      const off = await turnWebSearch(ada, on);
      expect(off.status).toBe(409);
      expect(await off.json()).toEqual({ error: ASSISTANT_OFF });
    }
    expect(requests).toEqual([]);
  });
});

describe("@ember on the web", () => {
  it("searches the web while Search the web is on, and lists the pages its answer cites after it", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const requests = fakeGateway(searching);
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    const answer = await nextAnswer(client);
    expect(answer.creator).toEqual(EMBER);
    expect(answer.body).toBe(
      `<p>${FOUND}</p><p>Sources: <a href="${DOCS.url}">Overview · Cloudflare AI Gateway docs</a>, <a href="${BLOG.url}">AI Gateway is generally available</a></p>`,
    );
    expect(answer.plainText).toBe(`${FOUND}\n\nSources: ${DOCS.title}, ${BLOG.title}`);
    expect(requests[0]!.body.tools).toEqual([SEARCH_TOOL, READ_TOOL]);
    expect(requests[0]!.body.system).toContain("You can search the web, and read the pages people link to or your searches find,");
    client.close();
  });

  it("carries on a turn Anthropic's model paused while it searched, sending back what it said so far", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const requests = fakeGateway(({ body }) => (body.messages!.at(-1)!.role === "assistant" ? messagesAnswer(CITED) : messagesAnswer(SEARCHING, "pause_turn", 120)));
    const client = await connect(await generalRoom(), ada);

    const question = await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe(`${FOUND}\n\nSources: ${DOCS.title}, ${BLOG.title}`);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.messages).toEqual([...requests[0]!.body.messages!, { role: "assistant", content: SEARCHING }]);
    expect(requests[1]!.body.messages!.at(-2)).toEqual({ role: "user", content: `Ada Lovelace: ${question.plainText}` });
    // Each request may search as many times as an answer may, so it's let search only what the answer has left.
    expect(requests[1]!.body.tools).toEqual([{ ...SEARCH_TOOL, max_uses: WEB_SEARCHES_PER_ANSWER - 1 }, READ_TOOL]);
    expect(requests[1]!.body).not.toHaveProperty("tool_choice");
    // And so for the tokens it may write.
    expect(requests[1]!.body.max_tokens).toBe(requests[0]!.body.max_tokens! - 120);
    client.close();
  });

  it("takes a turn Anthropic's model paused once it had written all it may as cut short, carrying nothing on", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const requests = fakeGateway(({ body }) => messagesAnswer([...SEARCHING, { type: "text", text: "AI Gateway is" }], "pause_turn", body.max_tokens));
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe("AI Gateway is\n\n…");
    expect(requests).toHaveLength(1);
    client.close();
  });

  it("takes a turn as cut short once the model paused with all it may written, the last time it's carried on too", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    // A turn is carried on twice at most, and pauses here each time, the last once it had written all it was let.
    let asked = 0;
    const requests = fakeGateway(({ body }) =>
      ++asked < 3 ? messagesAnswer(SEARCHING, "pause_turn", 120) : messagesAnswer([{ type: "text", text: "AI Gateway is" }], "pause_turn", body.max_tokens),
    );
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe("AI Gateway is\n\n…");
    expect(requests).toHaveLength(3);
    expect(requests[2]!.body.max_tokens).toBe(requests[0]!.body.max_tokens! - 240);
    client.close();
  });

  it("has a model that paused once it had searched as many times as an answer may answer with what it found", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const searches = Array.from({ length: WEB_SEARCHES_PER_ANSWER }, () => SEARCHING).flat();
    const requests = fakeGateway(({ body }) => (body.messages!.at(-1)!.role === "assistant" ? messagesAnswer(CITED) : messagesAnswer(searches, "pause_turn")));
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe(`${FOUND}\n\nSources: ${DOCS.title}, ${BLOG.title}`);
    expect(requests).toHaveLength(2);
    // The tool stays, as the turn used it, but the model may use none.
    expect(requests[1]!.body.tools).toEqual([{ ...SEARCH_TOOL, max_uses: 1 }, READ_TOOL]);
    expect(requests[1]!.body).toHaveProperty("tool_choice", { type: "none" });
    client.close();
  });

  it("lists the pages OpenAI's answer cites but doesn't link to", async () => {
    const ada = await setUp(RESPONSES_MODEL);
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const requests = fakeGateway(searching);
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    const answer = await nextAnswer(client);
    expect(requests[0]!.body).toHaveProperty("max_tool_calls", WEB_SEARCHES_PER_ANSWER);
    expect(answer.body).toContain(`<a href="${DOCS.url}">developers.cloudflare.com</a>`);
    expect(answer.body).toContain(`<p>Sources: <a href="${BLOG.url}">AI Gateway is generally available</a></p>`);
    expect(answer.plainText).toMatch(new RegExp(`\\n\\nSources: ${BLOG.title}$`));
    client.close();
  });

  it("searches with Grok with Ember's own tool through Cloudflare's REST API, listing the pages its searches found", async () => {
    const ada = await setUp(GROK);
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const requests = fakeGateway(searching);
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    const answer = await nextAnswer(client);
    client.close();
    expect(requests.map(({ url, authorization, aigAuthorization }) => [url, authorization, aigAuthorization])).toEqual(
      [CHAT_COMPLETIONS, WEB_SEARCH, CHAT_COMPLETIONS].map((url) => [url, `Bearer ${API_TOKEN}`, null]),
    );
    expect(requests[0]!.body).toMatchObject({ model: GROK, tools: [EMBERS_SEARCH] });
    expect(requests[0]!.body.messages![0]!.content).toContain("You can search the web when a question needs what's current");
    expect(answer.plainText).toBe(`${FOUND}\n\nSources: ${DOCS.title}, ${BLOG.title}`);
  });

  it("asks again without the web when AI Gateway no longer takes its tools", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = fakeGateway((asked) =>
      gives(asked, "web_search") ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "tools.0: unknown tool type" } }, { status: 400 }) : searching(asked),
    );
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe("I can't search the web.");
    // Once without thinking, which it might not have taken, then without reading pages, and then without the web.
    expect(requests.map(({ body }) => [body.tools, "thinking" in body])).toEqual([
      [[SEARCH_TOOL, READ_TOOL], true],
      [[SEARCH_TOOL, READ_TOOL], false],
      [[SEARCH_TOOL], false],
      [undefined, false],
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${MESSAGES_MODEL} again without the web`));
    // Told then that it can't search, as it was told it could.
    expect(requests[0]!.body.system).toContain("You can search the web");
    expect(requests[3]!.body.system).toContain("You can't search the web or open links this time, as AI Gateway didn't take the tools for them");
    expect(requests[3]!.body.system).not.toContain("You can search the web");
    client.close();
  });

  it("only searches when AI Gateway no longer takes the tool for reading pages, told it can't read them", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    vi.restoreAllMocks();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = fakeGateway((asked) =>
      gives(asked, "web_fetch") ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "tools.1: unknown tool type" } }, { status: 400 }) : searching(asked),
    );
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's AI Gateway?"));
    expect((await nextAnswer(client)).plainText).toBe(`${FOUND}\n\nSources: ${DOCS.title}, ${BLOG.title}`);
    expect(requests.map(({ body }) => body.tools)).toEqual([[SEARCH_TOOL, READ_TOOL], [SEARCH_TOOL, READ_TOOL], [SEARCH_TOOL]]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${MESSAGES_MODEL} to search again without reading pages`));
    expect(requests[0]!.body.system).toContain("You can search the web, and read the pages people link to or your searches find,");
    expect(requests[2]!.body.system).toContain("You can search the web when a question needs what's current");
    client.close();
  });

  it("searches with the model someone picked, with what its format has tools for, or tells them that one can't", async () => {
    const ada = await setUp();
    fakeGateway(searching);
    await turnedWebSearch(ada, true);
    await changeModels(ada, "POST", RESPONSES_MODEL);
    await addKeptModels(KEPT_DEEPSEEK);
    vi.restoreAllMocks();
    const client = await connect(await generalRoom(), ada);
    /** The requests for @ember's answer to Ada asking it `question` with `model`, and what it said. */
    const askedWith = async (model: string, question: string): Promise<[Asked[], string]> => {
      await pickModel(ada, model);
      const requests = fakeGateway(searching);
      await post(client, askEmber(question));
      const { plainText } = await nextAnswer(client);
      vi.restoreAllMocks();
      return [requests, plainText];
    };

    const [searched, found] = await askedWith(RESPONSES_MODEL, "what's AI Gateway?");
    expect(found).toMatch(new RegExp(`\\n\\nSources: ${BLOG.title}$`));
    expect(searched.map(({ url, body }) => [url, body.tools])).toEqual([[OPENAI_ENDPOINT, [{ type: "web_search" }]]]);
    expect(searched[0]!.body).toHaveProperty("max_tool_calls", WEB_SEARCHES_PER_ANSWER);
    expect(searched[0]!.body.instructions).toContain("You can search the web when a question needs what's current");

    const [unsearchable, said] = await askedWith(CHAT_MODEL, "what's the news?");
    expect(said).toBe("I can't search the web.");
    expect(unsearchable.map(({ url, body }) => [url.split("/ai/v1/")[1], body.tools])).toEqual([["chat/completions", undefined]]);
    const instructions = unsearchable[0]!.body.messages![0]!.content;
    expect(instructions).toContain("You can't search the web or open links with the model Ada Lovelace picked for your answers to them.");
    expect(instructions).toContain("they can pick one that can under Ember AI on their profile.");
    expect(instructions).not.toContain("an administrator can turn on Search the web");

    // And with the one that answers everyone again, once they pick that one.
    const [anthropic] = await askedWith(MESSAGES_MODEL, "what's AI Gateway?");
    expect(anthropic[0]!.body.tools).toEqual([SEARCH_TOOL, READ_TOOL]);
    client.close();
  });

  it("is given no tools, and told it can't search and who can let it, while Search the web is off", async () => {
    const ada = await setUp();
    const requests = fakeGateway(searching);
    const client = await connect(await generalRoom(), ada);

    await post(client, askEmber("what's the news?"));
    expect((await nextAnswer(client)).plainText).toBe("I can't search the web.");
    expect(requests[0]!.body.tools).toBeUndefined();
    expect(requests[0]!.body.system).toContain("You can't search the web or open links.");
    expect(requests[0]!.body.system).toContain("an administrator can turn on Search the web under AI assistant in community settings.");
    client.close();
  });
});

const ADA: User = { id: "ada", name: "Ada Lovelace" };
const IN_GENERAL = { community: "Fernwood", roomName: "general", inThread: false };
const QUESTION: Message = {
  id: "1",
  clientMessageId: "1",
  roomId: "room",
  creator: ADA,
  body: "<p>Hi</p>",
  plainText: "Hi",
  mentions: [],
  createdAt: "2026-11-04T12:00:00.000Z",
  updatedAt: "2026-11-04T12:00:00.000Z",
  editedAt: null,
  boosts: [],
};

describe("What @ember is told of the web", () => {
  it("says what it may do there, and that it writes its answer after it last searches, as the chat lists its sources", () => {
    const told = (webTools: Array<"search" | "read">, webSearchOn?: boolean) =>
      questionFor({ ...EMBER, instructions: "", promptTemplate: null }, [QUESTION], ADA, IN_GENERAL, { thinking: "low", length: "medium" }, new Date(), webTools, webSearchOn).instructions;
    expect(told(["search", "read"])).toContain("You can search the web, and read the pages people link to or your searches find, when a question needs what's current");
    expect(told(["search"])).toContain("You can search the web when a question needs what's current");
    expect(told(["search"])).toContain("Only what you write after you last search or read is posted");
    expect(told(["search"])).toContain("so don't list them yourself.");
    expect(told([])).toContain("You can't search the web or open links. When someone asks you to, say so, and that an administrator can turn on Search the web");
  });

  it("says, while Search the web is on, that the model the asker picked can't search, and that they can pick one that can", () => {
    const told = questionFor({ ...EMBER, instructions: "", promptTemplate: null }, [QUESTION], ADA, IN_GENERAL, { thinking: "low", length: "medium" }, new Date(), [], true).instructions;
    expect(told).toContain("You can't search the web or open links with the model Ada Lovelace picked for your answers to them.");
    expect(told).toContain("When they ask you to, say so, and that they can pick one that can under Ember AI on their profile.");
    expect(told).not.toContain("an administrator");
  });
});

describe("An answer's sources", () => {
  it("follow it as links to their pages, by title, or host without one, but for pages the answer links to itself", () => {
    const answer = answerOf("See [the docs](https://developers.cloudflare.com/ai-gateway/).", [
      DOCS,
      { url: "https://example.com/news?a=1&b=2", title: "" },
      { url: "javascript:alert(1)", title: "Not a page" },
      { url: "https://example.com/tags", title: "  <b>Bold</b>\n& more  " },
    ]);
    expect(answer.markup).toBe(
      `<p>See <a href="${DOCS.url}">the docs</a>.</p><p>Sources: <a href="https://example.com/news?a=1&amp;b=2">example.com</a>, <a href="https://example.com/tags">&lt;b&gt;Bold&lt;/b&gt; &amp; more</a></p>`,
    );
    // Its preview is of its own link, not a source's.
    expect(answer.firstLink).toBe(DOCS.url);
    expect(answerOf("No sources.", []).markup).toBe("<p>No sources.</p>");
    expect(answerOf("All linked: <https://example.com/>", [{ url: "https://example.com/", title: "Example" }]).markup).toBe(
      `<p>All linked: <a href="https://example.com/">https://example.com/</a></p>`,
    );
  });

  it("show a long title's start, and stay when the answer is cut to what a message holds", () => {
    const title = "A page whose title goes on and on ".repeat(5);
    expect(answerOf("Short.", [{ url: "https://example.com/", title }]).markup).toBe(
      `<p>Short.</p><p>Sources: <a href="https://example.com/">${title.slice(0, 79).trimEnd()}…</a></p>`,
    );
    const paragraph = `${"word ".repeat(199)}word`;
    const { markup } = answerOf(Array.from({ length: 20 }, () => paragraph).join("\n\n"), [DOCS]);
    expect(markup).toMatch(new RegExp(`<p>…</p><p>Sources: <a href="${DOCS.url}">${DOCS.title}</a></p>$`));
  });

  it("leave out a page whose address is too long to name in a message, so that the answer always fits", () => {
    const tooLong = { url: `https://example.com/${"a".repeat(MAX_MESSAGE_HTML_LENGTH / 20)}`, title: "Too long" };
    expect(answerOf("Short.", [tooLong, DOCS]).markup).toBe(`<p>Short.</p><p>Sources: <a href="${DOCS.url}">${DOCS.title}</a></p>`);
    // As many sources as an answer names, each nearly as long as one may be, still leave room for its start.
    const longest = Array.from({ length: 10 }, (_, page) => ({ url: `https://example.com/${page}/${"a".repeat(MAX_MESSAGE_HTML_LENGTH / 20 - 60)}`, title: "" }));
    const paragraph = `${"word ".repeat(199)}word`;
    const answer = answerOf(Array.from({ length: 20 }, () => paragraph).join("\n\n"), longest);
    expect(answer.markup.length).toBeLessThanOrEqual(MAX_MESSAGE_HTML_LENGTH);
    expect(answer.markup).toMatch(/^<p>word word/);
    expect(answer.markup.match(/<a href=/g)).toHaveLength(10);
  });

  it("name a page the answer links to only past where it's cut", () => {
    const paragraph = `${"word ".repeat(199)}word`;
    const text = [...Array.from({ length: 20 }, () => paragraph), `See [the docs](${DOCS.url}).`].join("\n\n");
    const { markup } = answerOf(text, [DOCS]);
    expect(markup).not.toContain("See ");
    expect(markup).toMatch(new RegExp(`<p>…</p><p>Sources: <a href="${DOCS.url}">${DOCS.title}</a></p>$`));
  });
});

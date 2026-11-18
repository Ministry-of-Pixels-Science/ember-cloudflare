import { ASSISTANT_ID, NAME_RESERVED, type Directory, type DirectoryUser, type Me, type NewWorkspace, type WorkspaceSettings } from "@ember/protocol";
import {
  ACCOUNT_ID_REFUSED,
  ASSISTANT_FORBIDDEN,
  MODEL_REFUSED,
  THINKING_LEVELS,
  TOP_LEVELS,
  type AssistantForgotten,
  type AssistantModel,
  type AssistantSaved,
  type AssistantSetup,
} from "@ember/protocol/assistant";
import { MENTION_CONTENT_TYPE, mentionPromptItem, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_UNANSWERED, NOTHING_ANSWERED } from "../src/assistant/gateway";
import { API_TOKEN_CHANGED, API_TOKEN_NEEDED } from "../src/assistant/settings";
import type { Env } from "../src/env";
import { api, apiWith, connect, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, post, shown, startDirect, WITH_THE_FLAME, workspaceSql, type Session } from "./support";

// Ember AI's setup on the AI assistant tab, the @ember account it adds, and its reserved name.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** A Cloudflare account's ID and an API token of its, as an administrator copies them from the dashboard. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
/** What Set up Ember AI sends for Claude Sonnet. */
const SETUP = { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "anthropic/claude-sonnet-5.5" } satisfies AssistantSetup;
/** Where the account's default gateway passes requests on to each provider's own API, as Ember asks Claude and GPT. */
const PROVIDER_ENDPOINTS = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/default`;
const ANTHROPIC_ENDPOINT = `${PROVIDER_ENDPOINTS}/anthropic/v1/messages`;
const OPENAI_ENDPOINT = `${PROVIDER_ENDPOINTS}/openai/responses`;
/** Where Cloudflare's REST API takes requests in Chat Completions, as Ember asks Grok. */
const CHAT_COMPLETIONS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
/** Claude Sonnet, as Ember lists it among the models people can pick, with the levels of thinking it took its test question at, every one. */
const CLAUDE: AssistantModel = { id: SETUP.model, name: "Claude Sonnet 5.5", format: "anthropic", thinkingLevels: [...THINKING_LEVELS] };
/** The same, as the account's settings keep it. */
const KEPT_CLAUDE = { id: SETUP.model, name: "Claude Sonnet 5.5", format: "anthropic", thinking_levels: [...THINKING_LEVELS] };
const HELLO = "Hello, team! Mention @ember whenever you'd like a hand.";

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

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Sets Ember AI up as `session`, as Set up Ember AI does, on a deployment whose bindings differ from this suite's by `changes`. */
const setUpAssistant = (session: Session | null, setup: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account/assistant", { method: "PUT", headers: as(session), body: JSON.stringify(setup) });

/** Sets Ember AI up as `administrator` with `setup`, which has to work. */
async function saved(administrator: Session, setup: unknown = SETUP): Promise<AssistantSaved> {
  const response = await setUpAssistant(administrator, setup);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as AssistantSaved;
}

/** Turns Ember AI off as `session`, as turning off its card's switch does. */
const turnOff = (session: Session | null) => api("/api/account/assistant", { method: "DELETE", headers: as(session) });

/** Ember AI as the workspace's settings show it to `session`. */
const assistantSettings = async (session: Session) => ((await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings).assistant;

/** The account's settings, as the database keeps them. */
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;

/** @ember as the database keeps it, if it's there. */
const storedAssistant = async () =>
  ((await workspaceSql("SELECT name, role, status, bot_token, email_address, password_digest FROM users WHERE id = ?", ASSISTANT_ID)) as Array<Record<string, unknown>>)[0];

/** The rooms @ember is in. */
const assistantRooms = async () => ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", ASSISTANT_ID)) as Array<{ room_id: string }>).map(({ room_id }) => room_id);

/** The open rooms, which everyone active is in. */
const openRooms = async () => ((await workspaceSql("SELECT id FROM rooms WHERE kind = 'open' ORDER BY id")) as Array<{ id: string }>).map(({ id }) => id);

/** Someone as the people directory lists them to `viewer`. */
async function inDirectory(viewer: Session, userId: string): Promise<DirectoryUser | undefined> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === userId);
}

/**
 * A request the fake AI Gateway was sent, with the API token as Cloudflare's API takes it, or as AI
 * Gateway's endpoints for each provider do, and the version of Anthropic's API it's written for, if it says.
 */
interface SentToGateway {
  url: string;
  authorization: string | null;
  gateway: string | null;
  aigAuthorization: string | null;
  anthropicVersion: string | null;
  body: Record<string, unknown>;
}

/** What the fake AI Gateway answers a request with. */
type GatewayAnswer = (sent: SentToGateway) => Response | Promise<Response>;

/** A model's answer saying `text`, in the format the request was sent in. */
function answering(text: string): GatewayAnswer {
  return ({ url }) => {
    if (url.endsWith("/messages")) return Response.json({ type: "message", role: "assistant", content: [{ type: "thinking", thinking: "A greeting." }, { type: "text", text }] });
    if (url.endsWith("/responses")) {
      return Response.json({ object: "response", status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
    }
    return Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  };
}

/** Cloudflare's answer to a request it refuses with `status`, in its own shape. */
const refusing = (status: number, code: number, message: string): GatewayAnswer => () => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

/** One of AI Gateway's endpoints for each provider refusing a request with `status`, in its own shape. */
const endpointRefusing = (status: number, code: number, message: string) => Response.json({ success: false, result: [], messages: [], error: [{ code, message }] }, { status });

/** The same, as it refuses an API token without AI Gateway Run. */
const refusingRun = () => endpointRefusing(401, 2009, "Unauthorized");

/** The test questions among `requests`, leaving out the same questions asked again at each level of thinking, which tell the model how much to think. */
const testQuestions = (requests: SentToGateway[]) => requests.filter(({ body }) => !("thinking" in body || "reasoning" in body || "reasoning_effort" in body));

/** Stands in for AI Gateway, answering each request with `answer`, and keeping what it's sent. */
function fakeGateway(answer: GatewayAnswer = answering(HELLO)): SentToGateway[] {
  const requests: SentToGateway[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { headers } = request;
    const sent = {
      url: request.url,
      authorization: headers.get("Authorization"),
      gateway: headers.get("cf-aig-gateway-id"),
      aigAuthorization: headers.get("cf-aig-authorization"),
      anthropicVersion: headers.get("anthropic-version"),
      body: (await request.json()) as Record<string, unknown>,
    };
    requests.push(sent);
    return answer(sent);
  });
  return requests;
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Ember AI", () => {
  describe("Set up Ember AI", () => {
    it("keeps the model once it answers a test question through the account's default gateway, its API token sealed", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const requests = fakeGateway();

      const response = await setUpAssistant(administrator, { ...SETUP, accountId: ` ${ACCOUNT_ID.toUpperCase()} `, apiToken: ` ${API_TOKEN}\n` });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ assistant: { accountId: ACCOUNT_ID, model: SETUP.model, models: [CLAUDE], most: TOP_LEVELS, webTools: [], instructions: "", promptTemplate: null, ...WITH_THE_FLAME }, greeting: HELLO } satisfies AssistantSaved);

      // Claude takes Anthropic's Messages, through the gateway's Anthropic endpoint, with the instructions as its system prompt.
      // A token in Authorization would be taken as an Anthropic key of the account's own, and passed on to Anthropic.
      const sent = { url: ANTHROPIC_ENDPOINT, authorization: null, gateway: null, aigAuthorization: `Bearer ${API_TOKEN}`, anthropicVersion: "2023-06-01" };
      expect(requests.map(({ body: _, ...rest }) => rest)).toEqual(Array(5).fill(sent));
      // As Anthropic names Claude Sonnet 5.5.
      const test = { model: "claude-sonnet-5-5", max_tokens: 2000, system: expect.stringContaining("@ember") as unknown, messages: [{ role: "user", content: "Say hello to the team in one short sentence." }] };
      expect(requests[0]!.body).toEqual(test);
      // And then again at each level of thinking, all at once, Low for Off, as Anthropic's newest models don't turn thinking off.
      const efforts = requests.slice(1).map(({ body }) => {
        expect(body).toEqual({ ...test, thinking: { type: "adaptive" }, output_config: { effort: expect.any(String) as unknown } });
        return (body.output_config as { effort: string }).effort;
      });
      expect(efforts.sort()).toEqual(["high", "low", "low", "medium"]);

      // The database holds the API token sealed, never as it was given.
      // Searching the web waits for Search the web to be turned on.
      expect((await storedSettings()).assistant).toEqual({
        account_id: ACCOUNT_ID,
        api_token: expect.stringMatching(/^v1\.[\w-]{16}\.[\w-]+$/) as unknown,
        model: SETUP.model,
        format: "anthropic",
        models: [KEPT_CLAUDE],
        web_tools: [],
        web_tools_asked_at: expect.any(String) as unknown,
        // As every model Ember AI kept was asked through its provider's endpoint first, once one answers.
        provider_endpoints_tried_at: null,
      });
      expect(JSON.stringify(await workspaceSql("SELECT * FROM accounts"))).not.toContain(API_TOKEN);
      expect(await assistantSettings(administrator)).toEqual({ accountId: ACCOUNT_ID, model: SETUP.model, models: [CLAUDE], most: TOP_LEVELS, webTools: [], instructions: "", promptTemplate: null, ...WITH_THE_FLAME });
      expect(await assistantSettings(member)).toBeNull();
    });

    it("gives administrators the Cloudflare account the deploy said Ember is in, to fill in, once it can be an account's ID", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const deployedTo = async (session: Session, given: string | undefined) =>
        ((await (await apiWith({ CLOUDFLARE_ACCOUNT_ID: given }, "/api/account", { headers: as(session) })).json()) as WorkspaceSettings).cloudflareAccountId;

      expect(await deployedTo(administrator, ` ${ACCOUNT_ID.toUpperCase()}\n`)).toBe(ACCOUNT_ID);
      expect(await deployedTo(member, ACCOUNT_ID)).toBeNull();
      expect(await deployedTo(administrator, "my-account")).toBeNull();
      expect(await deployedTo(administrator, undefined)).toBeNull();
    });

    it("adds @ember, a bot named Ember that nobody can sign in as, in every open room, and tells everyone's workspace sockets", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const team = await createRoom("Team", { as: administrator });
      const workspace = await openWorkspaceSocket(member);
      fakeGateway();

      await saved(administrator);
      expect(await storedAssistant()).toEqual({ name: "Ember", role: 2, status: 0, bot_token: null, email_address: null, password_digest: null });
      expect(await assistantRooms()).toEqual(await openRooms());
      expect(await assistantRooms()).toContain(team.id);
      const listed = await inDirectory(member, ASSISTANT_ID);
      expect(listed).toMatchObject({ id: ASSISTANT_ID, name: "Ember", role: "bot", status: "active" });
      expect(await workspace.next()).toEqual({ type: "user.updated", user: listed });

      // An open room made later takes it in, as it does anyone active.
      const later = await createRoom("Later", { as: administrator });
      expect(await assistantRooms()).toContain(later.id);
    });

    it("can be mentioned, as anyone in the room can, and answers", async () => {
      const administrator = await setUp();
      fakeGateway();
      await saved(administrator);
      const client = await connect(await openRooms().then(([room]) => room!), administrator);

      const sent = await post(client, `<p>Hi <action-text-attachment sgid="${mentionSgid(ASSISTANT_ID)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment></p>`);
      expect(sent).toMatchObject({ plainText: "Hi @Ember", mentions: [{ id: ASSISTANT_ID, name: "Ember" }] });
      // Its answer is the model's hello (answers.test.ts follows what it answers).
      expect((await client.next("message.created")).message).toMatchObject({ creator: { id: ASSISTANT_ID, name: "Ember" }, plainText: HELLO });
      client.close();
    });

    it("is offered in the mentions prompt badged as an agent, as nobody else is", async () => {
      const administrator = await setUp();
      fakeGateway();
      await saved(administrator);
      const [room] = await openRooms();
      const response = await api(`/api/autocompletable/users?room_id=${room}`, { headers: as(administrator) });
      expect(response.status, await response.clone().text()).toBe(200);
      const { users } = (await (await api("/api/users", { headers: as(administrator) })).json()) as Directory;
      const card = (userId: string) => {
        const { id, name, avatarUrl } = users.find((user) => user.id === userId)!;
        return { id, name, avatarUrl };
      };
      expect(await response.text()).toBe(mentionPromptItem(card(administrator.user.id)) + mentionPromptItem({ ...card(ASSISTANT_ID), agent: true }));
    });

    it("keeps the API token it has when a change gives none, and needs one when it has none", async () => {
      const administrator = await setUp();
      const requests = fakeGateway();
      const { apiToken: _, ...withoutToken } = SETUP;

      const refused = await setUpAssistant(administrator, { ...withoutToken, apiToken: "" });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: API_TOKEN_NEEDED, field: "apiToken" });
      expect(requests).toEqual([]);

      await saved(administrator);
      const sealed = ((await storedSettings()).assistant as { api_token: string }).api_token;
      const changed = await saved(administrator, { ...withoutToken, model: "openai/gpt-6.1-sol" });
      // In place of the model it answered everyone with.
      expect(changed.assistant).toEqual({
        accountId: ACCOUNT_ID,
        model: "openai/gpt-6.1-sol",
        models: [{ id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "openai", thinkingLevels: [...THINKING_LEVELS] }],
        most: TOP_LEVELS,
        webTools: [],
        instructions: "",
        promptTemplate: null,
        ...WITH_THE_FLAME,
      });
      expect(requests.map(({ url, aigAuthorization }) => [url, aigAuthorization])).toEqual([
        ...Array(5).fill([ANTHROPIC_ENDPOINT, `Bearer ${API_TOKEN}`]),
        ...Array(5).fill([OPENAI_ENDPOINT, `Bearer ${API_TOKEN}`]),
      ]);
      // As OpenAI names GPT-6.1 Sol, telling it to keep nothing, as it would for 30 days.
      expect(testQuestions(requests)[1]!.body).toEqual({
        model: "gpt-6.1-sol",
        max_output_tokens: 2000,
        instructions: expect.any(String) as unknown,
        input: [{ role: "user", content: expect.any(String) as unknown }],
        store: false,
      });
      // Sealed afresh, and the same @ember as before.
      expect(((await storedSettings()).assistant as { api_token: string }).api_token).not.toBe(sealed);
      expect(await workspaceSql("SELECT id FROM users WHERE role = 2")).toEqual([{ id: ASSISTANT_ID }]);
    });

    it("keeps nothing of a change that kept the API token once Ember AI was turned off while the model answered", async () => {
      const administrator = await setUp();
      fakeGateway();
      await saved(administrator);
      vi.restoreAllMocks();
      const asked = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      fakeGateway(async (sent) => {
        asked.resolve();
        await answer.promise;
        return answering(HELLO)(sent);
      });
      const { apiToken: _, ...withoutToken } = SETUP;

      const change = setUpAssistant(administrator, withoutToken);
      await asked.promise;
      expect((await turnOff(administrator)).status).toBe(200);
      answer.resolve();
      const refused = await change;
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: API_TOKEN_CHANGED, field: "apiToken" });
      expect((await storedSettings()).assistant).toBeNull();
      expect(await storedAssistant()).toMatchObject({ status: 1 });
    });

    it("keeps the levels of thinking the model took its test question at, which only asking says, none for one that refuses each", async () => {
      const administrator = await setUp();
      const logged = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const gpt = "openai/gpt-6.1-sol";
      // As OpenAI refuses a reasoning effort a model doesn't take, in its own words, which its endpoint passes on.
      const openAiRefusal = "Unsupported value: 'reasoning.effort' is not supported with this model.";
      const effortOf = (sent: SentToGateway) => (sent.body.reasoning as { effort?: string } | undefined)?.effort;
      const refusingAt =
        (efforts: string[]): GatewayAnswer =>
        (sent) =>
          efforts.includes(effortOf(sent) ?? "") ? Response.json({ error: { message: openAiRefusal, type: "invalid_request_error" } }, { status: 400 }) : answering(HELLO)(sent);

      fakeGateway(refusingAt(["none", "low", "medium", "high"]));
      const { assistant, greeting } = await saved(administrator, { ...SETUP, model: gpt });
      expect(greeting).toBe(HELLO);
      expect(assistant.models).toEqual([{ id: gpt, name: "GPT-6.1 Sol", format: "openai", thinkingLevels: [] }]);
      expect((await storedSettings()).assistant).toMatchObject({ models: [{ id: gpt, name: "GPT-6.1 Sol", format: "openai", thinking_levels: [] }] });
      expect(logged).toHaveBeenCalledWith(`${gpt} isn't told to think at off, low, medium, high, which it refused: ${openAiRefusal}`);
      vi.restoreAllMocks();
      vi.spyOn(console, "error").mockImplementation(() => {});

      // A model that can't think as little as none, nor at Medium, and one AI Gateway was too busy to ask at High, which it may take.
      fakeGateway((sent) => (effortOf(sent) === "high" ? refusing(429, 2003, "Rate limited")(sent) : refusingAt(["none", "medium"])(sent)));
      expect((await saved(administrator, { ...SETUP, model: gpt })).assistant.models).toEqual([{ id: gpt, name: "GPT-6.1 Sol", format: "openai", thinkingLevels: ["low", "high"] }]);
    });

    it("asks xAI's Grok through Cloudflare's REST API, in Chat Completions, as AI Gateway's credits don't pay for it at its xAI endpoint", async () => {
      const administrator = await setUp();
      const requests = fakeGateway();
      const grok = "xai/grok-4.7";

      const { assistant, greeting } = await saved(administrator, { ...SETUP, model: grok });
      expect(greeting).toBe(HELLO);
      expect(assistant.models).toEqual([{ id: grok, name: "Grok 4.7", format: "chat", thinkingLevels: [...THINKING_LEVELS] }]);
      expect(assistant.webTools).toEqual([]);
      expect((await storedSettings()).assistant).toMatchObject({ model: grok, format: "chat" });
      expect(requests.map(({ body: _, ...sent }) => sent)).toEqual(
        Array(5).fill({ url: CHAT_COMPLETIONS, authorization: `Bearer ${API_TOKEN}`, gateway: "default", aigAuthorization: null, anthropicVersion: null }),
      );
      expect(requests[0]!.body).toMatchObject({ model: grok });
    });

    it.each([
      ["Claude", SETUP.model, ANTHROPIC_ENDPOINT, "Ember asks Claude through AI Gateway's Anthropic endpoint, which didn't take Ember AI's API token."],
      ["GPT", "openai/gpt-6.1-sol", OPENAI_ENDPOINT, "Ember asks OpenAI's models through AI Gateway's OpenAI endpoint, which didn't take Ember AI's API token."],
    ])("refuses an API token %s's endpoint doesn't take, as one without AI Gateway Run, on its field, saying what to add, and keeps nothing", async (_, model, endpoint, lead) => {
      const administrator = await setUp();
      const requests = fakeGateway(refusingRun);
      const response = await setUpAssistant(administrator, { ...SETUP, model });
      expect(response.status).toBe(422);
      const refusal = `${lead} Add the AI Gateway Run permission to the token in the Cloudflare dashboard, then try again. Cloudflare says: Unauthorized`;
      expect(await response.json()).toEqual({ error: refusal, field: "apiToken" });
      expect(requests.map(({ url }) => url)).toEqual([endpoint]);
      expect((await storedSettings()).assistant).toBeUndefined();
      expect(await storedAssistant()).toBeUndefined();
    });

    it.each([
      ["Claude", SETUP.model, "Claude through its Anthropic endpoint. Add an Anthropic API key"],
      ["GPT", "openai/gpt-6.1-sol", "OpenAI's models through its OpenAI endpoint. Add an OpenAI API key"],
    ])("refuses %s when AI Gateway's credits can't pay for it through its provider's endpoint, saying to add the provider's key, and keeps nothing", async (_, model, what) => {
      const administrator = await setUp();
      fakeGateway(() => endpointRefusing(400, 2049, "Unified Billing is not available for this request."));
      const response = await setUpAssistant(administrator, { ...SETUP, model });
      expect(response.status).toBe(422);
      const refusal = `AI Gateway's credits can't pay for ${what} under Provider Keys in the default gateway's settings in AI Gateway, then try again. Cloudflare says: Unified Billing is not available for this request.`;
      expect(await response.json()).toEqual({ error: refusal });
      expect((await storedSettings()).assistant).toBeUndefined();
    });

    it.each([
      ["a model it doesn't have", 404, 2002, "Model not found: gpt-6.1-sol"],
      // AI Gateway's code for a request it or the provider refuses as invalid, which Cloudflare's API answers an account it can't route to with too.
      ["a question the model's provider refuses", 400, 7003, 'Model execution failed (User Input Error): {"code":"invalid-argument","error":"Model gpt-6.1-sol does not support parameter maxTokens."}'],
    ])("refuses %s on the model's field, with Cloudflare's own words, asking nothing else, and keeps nothing", async (_, status, code, message) => {
      const administrator = await setUp();
      const requests = fakeGateway(refusing(status, code, message));
      const response = await setUpAssistant(administrator, { ...SETUP, model: "openai/gpt-6.1-sol" });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: `AI Gateway didn't take that model. Cloudflare says: ${message}`, field: "model" });
      expect(requests.map(({ url }) => url)).toEqual([OPENAI_ENDPOINT]);
      expect((await storedSettings()).assistant).toBeUndefined();
      expect(await storedAssistant()).toBeUndefined();
    });

    it.each([
      [
        "an account the token can't reach",
        refusing(404, 7003, "Could not route to /client/v4/accounts/0123/ai/v1/messages, perhaps your object identifier is invalid?"),
        422,
        {
          error: "Cloudflare has no account with that ID that the token can reach. Cloudflare says: Could not route to /client/v4/accounts/0123/ai/v1/messages, perhaps your object identifier is invalid?",
          field: "accountId",
        },
      ],
      [
        "too few credits",
        () => Response.json({ error: { message: "Insufficient credits", type: "billing_error" } }, { status: 402 }),
        422,
        {
          error: "This model is paid for with AI Gateway's credits, and there aren't enough. Top them up under Credits Available in AI Gateway. Cloudflare says: Insufficient credits",
        },
      ],
      [
        "a spend limit",
        () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "Spend limit reached" } }, { status: 429 }),
        429,
        { error: "AI Gateway is turning requests away for now, or a spend limit was reached. Try again later. Cloudflare says: Spend limit reached" },
      ],
      [
        "a question the gateway's Guardrails block",
        refusing(424, 2016, "Prompt blocked due to security configurations"),
        422,
        { error: "AI Gateway's Guardrails blocked the question. Change what they block in AI Gateway. Cloudflare says: Prompt blocked due to security configurations" },
      ],
      [
        "an answer the gateway's Data Loss Prevention blocks",
        refusing(400, 2030, "Response content blocked due to DLP policy violations"),
        422,
        {
          error:
            "AI Gateway's Data Loss Prevention blocked the model's answer. Change its policies in AI Gateway. Cloudflare says: Response content blocked due to DLP policy violations",
        },
      ],
      ["a gateway that fails", () => new Response("Bad gateway", { status: 502 }), 502, { error: GATEWAY_UNANSWERED }],
      [
        "a gateway that can't be reached",
        () => {
          throw new TypeError("Network connection lost.");
        },
        502,
        { error: GATEWAY_UNANSWERED },
      ],
      ["a model that answers with nothing", answering("  "), 502, { error: NOTHING_ANSWERED, field: "model" }],
    ] satisfies Array<[string, GatewayAnswer, number, Record<string, string>]>)("refuses %s, saying what to do, and keeps nothing", async (_, answer, status, body) => {
      const administrator = await setUp();
      const requests = fakeGateway(answer);
      const response = await setUpAssistant(administrator, SETUP);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(requests.map(({ url }) => url)).toEqual([ANTHROPIC_ENDPOINT]);
      expect((await storedSettings()).assistant).toBeUndefined();
      expect(await storedAssistant()).toBeUndefined();
    });

    it("refuses fields that can't be what they're for before asking AI Gateway anything", async () => {
      const administrator = await setUp();
      const requests = fakeGateway();
      for (const [setup, refusal] of [
        [{ ...SETUP, accountId: "not-an-account" }, { error: ACCOUNT_ID_REFUSED, field: "accountId" }],
        [{ ...SETUP, model: "claude" }, { error: MODEL_REFUSED, field: "model" }],
        [{ ...SETUP, model: "openai/gpt-5.5" }, { error: MODEL_REFUSED, field: "model" }],
      ] as const) {
        const response = await setUpAssistant(administrator, setup);
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual(refusal);
      }
      expect(requests).toEqual([]);
    });

    it("lets only administrators set it up or turn it off, before asking AI Gateway anything", async () => {
      await setUp();
      const member = await joinAsGrace();
      const requests = fakeGateway();
      expect((await setUpAssistant(null, SETUP)).status).toBe(401);
      const forbidden = await setUpAssistant(member, SETUP);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({ error: ASSISTANT_FORBIDDEN });
      expect((await turnOff(null)).status).toBe(401);
      expect((await turnOff(member)).status).toBe(403);
      expect(requests).toEqual([]);
      expect(await storedAssistant()).toBeUndefined();
    });

    it("asks a stand-in for AI Gateway only at a loopback address", async () => {
      const administrator = await setUp();
      const requests = fakeGateway();
      await saved(administrator);
      expect(
        (await setUpAssistant(administrator, SETUP, { AI_GATEWAY_URL: "http://127.0.0.1:8793" })).status,
      ).toBe(200);
      expect((await setUpAssistant(administrator, SETUP, { AI_GATEWAY_URL: "https://gateway.example.com" })).status).toBe(200);
      expect(requests.map(({ url }) => url)).toEqual([
        ...Array(5).fill(ANTHROPIC_ENDPOINT),
        ...Array(5).fill(`http://127.0.0.1:8793/v1/${ACCOUNT_ID}/default/anthropic/v1/messages`),
        ...Array(5).fill(ANTHROPIC_ENDPOINT),
      ]);
    });
  });

  describe("Turn Ember AI off", () => {
    it("forgets the API token and deactivates @ember, which keeps its DMs, and tells everyone's workspace sockets", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      fakeGateway();
      await saved(administrator);
      const dm = await startDirect(member, [ASSISTANT_ID]);
      expect(dm.status, await dm.clone().text()).toBe(201);
      const { room } = (await dm.json()) as { room: { id: string } };
      const workspace = await openWorkspaceSocket(member);

      const response = await turnOff(administrator);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ assistant: null } satisfies AssistantForgotten);
      expect((await storedSettings()).assistant).toBeNull();
      expect(await assistantSettings(administrator)).toBeNull();
      expect(await storedAssistant()).toMatchObject({ name: "Ember", status: 1 });
      expect(await assistantRooms()).toEqual([room.id]);
      expect(await workspace.next()).toEqual({ type: "user.updated", user: await inDirectory(member, ASSISTANT_ID) });
      expect(await inDirectory(member, ASSISTANT_ID)).toMatchObject({ status: "deactivated" });

      // Off already, it stays off, which lifting a ban, as People can someone's, doesn't change.
      expect(await (await turnOff(administrator)).json()).toEqual({ assistant: null });
      expect((await api(`/api/users/${ASSISTANT_ID}/ban`, { method: "DELETE", headers: as(administrator) })).status).toBe(404);
      expect(await storedAssistant()).toMatchObject({ status: 1 });
    });

    it("brings the same @ember back when it's set up again, in every open room", async () => {
      const administrator = await setUp();
      fakeGateway();
      await saved(administrator);
      await turnOff(administrator);
      const team = await createRoom("Team", { as: administrator });

      await saved(administrator);
      expect(await storedAssistant()).toMatchObject({ name: "Ember", status: 0 });
      expect(await workspaceSql("SELECT count(*) AS n FROM users WHERE role = 2")).toEqual([{ n: 1 }]);
      expect(await assistantRooms()).toEqual(await openRooms());
      expect(await assistantRooms()).toContain(team.id);
    });
  });

  describe("@ember", () => {
    it("isn't one of Chat bots, which can't change or delete it, nor can People remove, ban or unban it", async () => {
      const administrator = await setUp();
      fakeGateway();
      await saved(administrator);
      expect(await (await api("/api/account/bots", { headers: as(administrator) })).json()).toEqual({ bots: [] });
      expect((await api(`/api/account/bots/${ASSISTANT_ID}`, { headers: as(administrator) })).status).toBe(404);
      expect((await api(`/api/account/bots/${ASSISTANT_ID}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ name: "Sparky" }) })).status).toBe(404);
      expect((await api(`/api/account/bots/${ASSISTANT_ID}`, { method: "DELETE", headers: as(administrator) })).status).toBe(404);
      expect((await api(`/api/account/users/${ASSISTANT_ID}`, { method: "DELETE", headers: as(administrator) })).status).toBe(404);
      expect((await api(`/api/users/${ASSISTANT_ID}/ban`, { method: "POST", headers: as(administrator) })).status).toBe(404);
      expect((await api(`/api/users/${ASSISTANT_ID}/ban`, { method: "DELETE", headers: as(administrator) })).status).toBe(404);
      expect(await storedAssistant()).toMatchObject({ name: "Ember", status: 0 });
    });

    it("has Ember's flame on the sunset as its picture", async () => {
      const administrator = await setUp();
      fakeGateway();
      await saved(administrator);
      vi.restoreAllMocks();
      const flame = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#FF5F0F"/></svg>';
      const builtFiles = {
        fetch: async (input: Request | string | URL) =>
          new URL(input instanceof Request ? input.url : input).pathname === "/assistant-avatar.svg" ? new Response(flame) : new Response("Not found", { status: 404 }),
      } as unknown as Fetcher;
      const { avatarUrl } = (await inDirectory(administrator, ASSISTANT_ID))!;
      const response = await apiWith({ ASSETS: builtFiles }, avatarUrl, { headers: as(administrator) });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(await response.text()).toBe(flame);
    });
  });
});

describe("The name Ember is reserved", () => {
  it("can't be taken setting Ember up, joining or signing in as a guest, in any capitals", async () => {
    const firstRun = await api("/api/first_run", { method: "POST", body: JSON.stringify({ ...ada, name: "Ember" }) });
    expect(firstRun.status).toBe(422);
    expect(await firstRun.json()).toEqual({ error: NAME_RESERVED, field: "name" });

    await setUp();
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const joined = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ ...grace, name: " EMBER " }) });
    expect(joined.status).toBe(422);
    expect(await joined.json()).toEqual({ error: NAME_RESERVED, field: "name" });

    const guest = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "@ember" }) });
    expect(guest.status).toBe(422);
    expect(await guest.json()).toEqual({ error: NAME_RESERVED });
    expect(await workspaceSql("SELECT name FROM users")).toEqual([{ name: ada.name }]);
  });

  it("can't be taken editing a profile, unless it was the name already", async () => {
    await setUp();
    const member = await joinAsGrace();
    const rename = (name: string) => api("/api/users/me/profile", { method: "PATCH", headers: as(member), body: JSON.stringify({ name }) });

    const refused = await rename("ember");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: NAME_RESERVED });

    // Someone called Ember before it was reserved keeps their name, in whatever capitals they like.
    await workspaceSql("UPDATE users SET name = 'Ember' WHERE id = ?", member.user.id);
    expect((await rename("EMBER")).status).toBe(200);
    expect((await rename("Grace")).status).toBe(200);
    expect((await rename("Ember")).status).toBe(422);
  });

  it("can't be given to a bot, unless it was its name already", async () => {
    const administrator = await setUp();
    const add = await api("/api/account/bots", { method: "POST", headers: as(administrator), body: JSON.stringify({ name: "Ember" }) });
    expect(add.status).toBe(422);
    expect(await add.json()).toEqual({ error: NAME_RESERVED });

    const added = await api("/api/account/bots", { method: "POST", headers: as(administrator), body: JSON.stringify({ name: "Build Bot" }) });
    const { bot } = (await added.json()) as { bot: { id: string } };
    const rename = (name: string) => api(`/api/account/bots/${bot.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ name }) });
    const refused = await rename("ember");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: NAME_RESERVED });

    await workspaceSql("UPDATE users SET name = 'Ember' WHERE id = ?", bot.id);
    expect((await rename("EMBER")).status).toBe(200);
  });
});

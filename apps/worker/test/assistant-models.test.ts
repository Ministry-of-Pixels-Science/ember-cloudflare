import { ASSISTANT_ID, ASSISTANT_NAME, type Me, type Message, type NewWorkspace, type ProfileAnswer, type RoomId, type User, type WorkspaceSettings } from "@ember/protocol";
import {
  ASSISTANT_FORBIDDEN,
  ASSISTANT_OFF,
  DEFAULT_LEVELS,
  DEFAULT_MODEL_KEPT,
  MAX_ASSISTANT_MODELS,
  MODEL_NOT_LISTED,
  MODEL_REFUSED,
  MODELS_FULL,
  THINKING_LEVELS,
  TOP_LEVELS,
  type AssistantModel,
  type AssistantSaved,
  type AssistantSettings,
  type YourAssistant,
} from "@ember/protocol/assistant";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES, PICKED_MODEL_NOTES } from "../src/assistant/answers";
import { SETUP_CHANGED } from "../src/assistant/settings";
import { addKeptModels, api, connect, cookieOf, freshDeploy, post, shown, WITH_THE_FLAME, workspaceSql, workspaceStub, type Client, type KeptModel, type Session } from "./support";

// The models @ember can answer with: those Ember offers, which Set up Ember AI and Add a model list, the
// ones administrators let people pick on the Ember AI card, which can be ones kept before Ember stopped
// offering them, the one among them that answers everyone, and the one each person picks on their
// profile, which @ember answers them with.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const SETUP = { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "anthropic/claude-sonnet-5.5" };
/** Where Cloudflare's REST API takes requests in Chat Completions, as Ember asks a model kept before Ember stopped offering it. */
const CHAT_COMPLETIONS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
/** Where the account's default gateway passes requests on to OpenAI's own Responses, as Ember asks GPT. */
const OPENAI_ENDPOINT = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/default/openai/responses`;
const HELLO = "Hello, team!";

/**
 * The models people can pick, as Ember AI lists them once they've answered their test questions, which
 * they did at every level of thinking, through their providers' endpoints.
 */
const CLAUDE: AssistantModel = { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "anthropic", thinkingLevels: [...THINKING_LEVELS] };
const HAIKU: AssistantModel = { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", format: "anthropic", thinkingLevels: [...THINKING_LEVELS] };
const GPT: AssistantModel = { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "openai", thinkingLevels: [...THINKING_LEVELS] };
/** A model Ember no longer offers, kept from before, which Cloudflare's REST API took in Chat Completions. */
const DEEPSEEK: AssistantModel & KeptModel = { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", format: "chat", thinkingLevels: [...THINKING_LEVELS] };

/** `model` as Ember listed one it hadn't asked at each level of thinking, saying nothing of the levels it takes. */
const untested = ({ thinkingLevels: _, ...model }: AssistantModel): AssistantModel => model;

/** `model` as the account's settings keep it. */
const kept = ({ thinkingLevels, ...model }: AssistantModel) => ({ ...model, thinking_levels: thinkingLevels });

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

/** A request AI Gateway was sent: how, where, with which API token, and what it asked a model. */
interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

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
 * Stands in for AI Gateway, whose models answer as `answer` says, saying hello unless it says otherwise.
 * Keeps the requests it's sent, in the order they came.
 */
function cloudflare({ answer = answering(HELLO) }: { answer?: (sent: Sent) => Response | Promise<Response> } = {}): Sent[] {
  const requests: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? null : ((await request.json()) as Record<string, unknown>);
    const sent = { method: request.method, url: request.url, authorization: request.headers.get("Authorization"), body };
    requests.push(sent);
    return answer(sent);
  });
  return requests;
}

/** Sets Ember AI up as `administrator` with `setup`, as Set up Ember AI does, which has to work. */
async function turnOn(administrator: Session, setup: unknown = SETUP): Promise<AssistantSaved> {
  const response = await setUpAs(administrator, setup);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as AssistantSaved;
}

/** Sets Ember AI up as `session` with `setup`, as Set up Ember AI does. */
const setUpAs = (session: Session | null, setup: unknown) => api("/api/account/assistant", { method: "PUT", headers: as(session), body: JSON.stringify(setup) });

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
  const response = await addModel(administrator, { model: model.id });
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

describe("The models people can pick", () => {
  it("start as the one Set up Ember AI chose, by the name Ember calls it, which the account keeps with the format it took", async () => {
    const ada = await setUp();
    cloudflare();

    const { assistant } = await turnOn(ada, { ...SETUP, model: HAIKU.id, modelName: "Haiku" });
    expect(assistant).toEqual(settingsWith([HAIKU]));
    expect(await settingsShown(ada)).toEqual(settingsWith([HAIKU]));
    expect((await storedAssistant())?.models).toEqual([kept(HAIKU)]);
  });

  it("start as none Ember doesn't offer, which is refused on the model's field before AI Gateway is asked anything", async () => {
    const ada = await setUp();
    const requests = cloudflare();

    for (const model of ["openai/gpt-5.5", DEEPSEEK.id, "gpt", 7]) {
      const response = await setUpAs(ada, { ...SETUP, model });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: MODEL_REFUSED, field: "model" });
    }
    expect(requests).toEqual([]);
    expect(await settingsShown(ada)).toBeNull();
  });

  it("add a model once it answers a test question through Ember AI's account, after the others", async () => {
    const ada = await setUp();
    const requests = cloudflare({ answer: answering("Hi, I'm GPT.") });
    await turnOn(ada);
    requests.length = 0;

    const response = await addModel(ada, { model: ` ${GPT.id} `, modelName: "GPT" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ assistant: settingsWith([CLAUDE, GPT]), greeting: "Hi, I'm GPT." } satisfies AssistantSaved);
    // Its test question, and then the same at each level of thinking, through the gateway's OpenAI endpoint, as OpenAI names it.
    expect(requests.map(({ url, authorization, body }) => [url, authorization, body?.model])).toEqual(Array(5).fill([OPENAI_ENDPOINT, null, "gpt-6.1-sol"]));
    const efforts = requests.map(({ body }) => (body?.reasoning as { effort: string } | undefined)?.effort);
    expect([efforts[0], efforts.slice(1).sort()]).toEqual([undefined, ["high", "low", "medium", "none"]]);
    expect((await storedAssistant())?.models).toEqual([kept(CLAUDE), kept(GPT)]);

    // Added again, it stays where it is, with the levels of thinking it takes now.
    vi.restoreAllMocks();
    cloudflare({ answer: (sent) => ((sent.body?.reasoning as { effort?: string } | undefined)?.effort === "none" ? refusing(400, 2001, "Unsupported effort.")() : answering(HELLO)(sent)) });
    expect((await added(ada, GPT)).assistant.models).toEqual([CLAUDE, { ...GPT, thinkingLevels: ["low", "medium", "high"] }]);
  });

  it("add no model Ember doesn't offer, before AI Gateway is asked anything, nor one AI Gateway doesn't take, saying why on the model's field", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    vi.restoreAllMocks();
    const requests = cloudflare({ answer: refusing(400, 2001, "No such model.") });

    for (const model of ["openai/gpt-0", DEEPSEEK.id, "gpt-0", 7]) {
      const response = await addModel(ada, { model });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: MODEL_REFUSED, field: "model" });
    }
    expect(requests).toEqual([]);
    const response = await addModel(ada, { model: GPT.id });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining("AI Gateway didn't take that model.") as unknown, field: "model" });
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
        if (sent.url === OPENAI_ENDPOINT) {
          expect((await api("/api/account/assistant", { method: "DELETE", headers: as(ada) })).status).toBe(200);
          await turnOn(ada, { ...SETUP, apiToken: `${API_TOKEN}-2`, model: HAIKU.id });
        }
        return answering(HELLO)(sent);
      },
    });

    expect(await refusalOf(await addModel(ada, { model: GPT.id }))).toEqual([409, SETUP_CHANGED]);
    expect((await settingsShown(ada))?.models).toEqual([HAIKU]);
  });

  it(`hold at most ${MAX_ASSISTANT_MODELS}, counting those kept before Ember stopped offering them`, async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await addKeptModels(...Array.from({ length: MAX_ASSISTANT_MODELS - 1 }, (_, n): KeptModel => ({ id: `openai/gpt-${n + 1}`, name: `GPT-${n + 1}`, format: "responses", thinkingLevels: [] })));

    const response = await addModel(ada, { model: GPT.id });
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
    expect(await storedAssistant()).toMatchObject({ model: GPT.id, format: "openai" });
    expect(await refusalOf(await change(ada, { model: HAIKU.id }))).toEqual([422, MODEL_NOT_LISTED]);
    expect(await refusalOf(await change(ada, { model: "gpt" }))).toEqual([422, MODEL_NOT_LISTED]);
    expect((await settingsShown(ada))?.model).toBe(GPT.id);
  });

  it("lose a model to its Remove, but for the one that answers everyone", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await added(ada, HAIKU);

    const response = await removeModel(ada, GPT.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ assistant: settingsWith([CLAUDE, HAIKU]) });
    // Removed already, it stays removed.
    expect(await (await removeModel(ada, GPT.id)).json()).toEqual({ assistant: settingsWith([CLAUDE, HAIKU]) });
    expect(await refusalOf(await removeModel(ada, CLAUDE.id))).toEqual([409, DEFAULT_MODEL_KEPT]);
    expect(await refusalOf(await removeModel(ada, "claude"))).toEqual([422, MODEL_NOT_LISTED]);
    expect((await settingsShown(ada))?.models).toEqual([CLAUDE, HAIKU]);
  });

  it("have the model Set up Ember AI chooses in place of the one that answered everyone, and keep the others", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);

    expect((await turnOn(ada, { ...SETUP, model: HAIKU.id })).assistant).toEqual(settingsWith([HAIKU, GPT]));
    // Kept with its new token, or none, it stays where it was.
    expect((await turnOn(ada, { accountId: ACCOUNT_ID, model: HAIKU.id })).assistant).toEqual(settingsWith([HAIKU, GPT]));
    // Chosen from among them, it's there once.
    expect((await turnOn(ada, { ...SETUP, model: GPT.id })).assistant).toEqual(settingsWith([GPT]));
  });

  it("are forgotten when Ember AI is turned off", async () => {
    const ada = await setUp();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    expect((await api("/api/account/assistant", { method: "DELETE", headers: as(ada) })).status).toBe(200);

    expect((await turnOn(ada, { ...SETUP, model: HAIKU.id })).assistant).toEqual(settingsWith([HAIKU]));
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

  it("keep those kept before Ember stopped offering them, which can answer everyone, until they're removed, when they can't be added again", async () => {
    const ada = await setUp();
    const requests = cloudflare();
    await turnOn(ada);
    await addKeptModels(DEEPSEEK);
    expect(await settingsShown(ada)).toEqual(settingsWith([CLAUDE, DEEPSEEK]));
    requests.length = 0;

    expect(await (await change(ada, { model: DEEPSEEK.id })).json()).toEqual({ assistant: settingsWith([CLAUDE, DEEPSEEK], DEEPSEEK.id) });
    expect(await storedAssistant()).toMatchObject({ model: DEEPSEEK.id, format: "chat" });
    // Set up again, Ember AI answers everyone with one Ember offers.
    expect(await refusalOf(await setUpAs(ada, { accountId: ACCOUNT_ID, model: DEEPSEEK.id }))).toEqual([422, MODEL_REFUSED]);
    await change(ada, { model: CLAUDE.id });
    expect(await (await removeModel(ada, DEEPSEEK.id)).json()).toEqual({ assistant: settingsWith([CLAUDE]) });
    expect(await refusalOf(await addModel(ada, { model: DEEPSEEK.id }))).toEqual([422, MODEL_REFUSED]);
    expect(requests).toEqual([]);
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

    expect(await refusalOf(await pick(grace, { model: HAIKU.id }))).toEqual([422, MODEL_NOT_LISTED]);
    expect(await refusalOf(await pick(grace, { model: 7 }))).toEqual([422, MODEL_NOT_LISTED]);
    expect((await yoursShown(grace))?.model).toBe(GPT.id);
  });

  it("follows the one that answers everyone while you pick none, whichever administrators choose", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await added(ada, HAIKU);

    await pick(grace, { model: GPT.id });
    expect(await (await pick(grace, { model: null })).json()).toEqual({ assistant: yoursWith([CLAUDE, GPT, HAIKU]) });
    expect(await workspaceSql("SELECT assistant_model FROM users WHERE id = ?", grace.user.id)).toEqual([{ assistant_model: null }]);
    await change(ada, { model: HAIKU.id });
    expect(await yoursShown(grace)).toEqual({ ...yoursWith([CLAUDE, GPT, HAIKU]), defaultModel: HAIKU.id });
  });

  it("stays yours once administrators choose it to answer everyone, and once they choose another, as does the one they chose, picked", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await added(ada, GPT);
    await added(ada, HAIKU);

    await pick(grace, { model: GPT.id });
    await change(ada, { model: GPT.id });
    expect(await yoursShown(grace)).toEqual({ ...yoursWith([CLAUDE, GPT, HAIKU], GPT.id), defaultModel: GPT.id });
    await change(ada, { model: HAIKU.id });
    expect((await yoursShown(grace))?.model).toBe(GPT.id);

    expect(await (await pick(grace, { model: HAIKU.id })).json()).toEqual({ assistant: { ...yoursWith([CLAUDE, GPT, HAIKU], HAIKU.id), defaultModel: HAIKU.id } });
    expect(await workspaceSql("SELECT assistant_model FROM users WHERE id = ?", grace.user.id)).toEqual([{ assistant_model: HAIKU.id }]);
    await change(ada, { model: CLAUDE.id });
    expect((await yoursShown(grace))?.model).toBe(HAIKU.id);
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

  /** What @ember answers `person` asking it something in general, and the model it asked, as the model's provider names it. */
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

    expect(await askedAs(grace)).toEqual(["An answer.", "gpt-6.1-sol"]);
    expect(await askedAs(ada)).toEqual(["An answer.", "claude-sonnet-5-5"]);

    await removeModel(ada, GPT.id);
    expect(await askedAs(grace)).toEqual(["An answer.", "claude-sonnet-5-5"]);
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
    expect(await askedAs(grace)).toEqual(["An answer.", "gpt-6.1-sol"]);

    cloudflare();
    await change(ada, { model: CLAUDE.id });
    vi.restoreAllMocks();
    expect(await askedAs(grace)).toEqual(["An answer.", "gpt-6.1-sol"]);
    expect(await askedAs(ada)).toEqual(["An answer.", "claude-sonnet-5-5"]);
  });

  it("come from a model kept before Ember stopped offering it as it was kept, through Cloudflare's REST API", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    cloudflare();
    await turnOn(ada);
    await addKeptModels(DEEPSEEK);
    await pick(grace, { model: DEEPSEEK.id });
    vi.restoreAllMocks();

    const client = await connect(await general(), grace);
    const requests = cloudflare({ answer: answering("An answer.") });
    await post(client, `<p>${mention} what's new?</p>`);
    expect((await nextAnswer(client)).plainText).toBe("An answer.");
    client.close();
    expect(requests.map(({ url, authorization, body }) => [url, authorization, body?.model])).toEqual([[CHAT_COMPLETIONS, `Bearer ${API_TOKEN}`, DEEPSEEK.id]]);
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

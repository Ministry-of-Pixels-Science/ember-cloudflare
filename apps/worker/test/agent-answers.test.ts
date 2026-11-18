import { ASSISTANT_ID, ASSISTANT_NAME, type BotAnswer, type BotSettings, type Card, type DirectRoom, type Me, type Message, type NewWorkspace, type RoomId, type Sidebar, type User, type UserId } from "@ember/protocol";
import { agentCannotSearchWith, AGENTS_FORBIDDEN, NAME_REFUSED, QUESTION_NEEDED, type AgentAnswer, type AgentSettings, type AgentTrialAnswer, type NewAgent } from "@ember/protocol/agents";
import { ASSISTANT_OFF, maxTokensAt, MODEL_REFUSED, THINKING_LEVELS, WEB_SEARCHES_PER_ANSWER } from "@ember/protocol/assistant";
import { unknownPlaceholder } from "@ember/protocol/prompts";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_NOTES, NOTES } from "../src/assistant/answers";
import { agentWithKeptModel, answerWithKeptModel, api, connect, cookieOf, createRoom, freshDeploy, post, roomSql, settle, shown, startDirect, workspaceSql, type Client, type KeptModel, type Session } from "./support";

// What AI agents answer when someone mentions them in a room they're in, or writes to them directly: as
// their instructions say, with their own model and levels, through Ember AI's account, never to a bot,
// and what Try it answers an administrator setting one up. And @ember, which now answers with the
// instructions administrators add to its own.

const EMBER: User = { id: ASSISTANT_ID, name: ASSISTANT_NAME };
const SETUP = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "an-api-token-with-ai-gateway-run_0123456" };
const CLOUDFLARE_API = `https://api.cloudflare.com/client/v4/accounts/${SETUP.accountId}/ai/v1`;
/** Where the account's default gateway passes requests on to Anthropic's own Messages. */
const ANTHROPIC_ENDPOINT = `https://gateway.ai.cloudflare.com/v1/${SETUP.accountId}/default/anthropic/v1/messages`;
/** Cloudflare's Web Search API, which Ember searches with for a model given its own tool. */
const WEB_SEARCH = `https://api.cloudflare.com/client/v4/accounts/${SETUP.accountId}/ai/websearch/`;
/** Workers AI's models, which take Chat Completions, whose turns AI Gateway is sent as they are, and Anthropic's, which take Messages and can search the web. */
const [GLM, GEMMA, GPT_OSS, HAIKU, SONNET] = ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it", "@cf/openai/gpt-oss-120b", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"];
/** xAI's model that takes Chat Completions but no thinking level. */
const GROK = "xai/grok-4.20-0309-reasoning";
/** DeepSeek's, which takes Chat Completions and has no tools for the web there, nor Ember's, as Workers AI's do. */
const DEEPSEEK = "deepseek/deepseek-v4-pro";

/**
 * The models Ember no longer offers that @ember and the agents answer with here, as a copy set up before
 * Ember stopped offering them keeps them, asked through Cloudflare's REST API in Chat Completions.
 */
const KEPT: Record<string, KeptModel> = {
  [GLM]: { id: GLM, name: "GLM-4.7 Flash", format: "chat", thinkingLevels: [...THINKING_LEVELS] },
  [GEMMA]: { id: GEMMA, name: "Gemma 4 26B", format: "chat", thinkingLevels: [...THINKING_LEVELS] },
  [GPT_OSS]: { id: GPT_OSS, name: "gpt-oss-120b", format: "chat", thinkingLevels: [...THINKING_LEVELS] },
  [GROK]: { id: GROK, name: "Grok 4.20 Reasoning", format: "chat", thinkingLevels: [...THINKING_LEVELS] },
  [DEEPSEEK]: { id: DEEPSEEK, name: "DeepSeek V4 Pro", format: "chat", thinkingLevels: [...THINKING_LEVELS] },
};

/** An agent: Scout, on Gemma, made before Ember stopped offering it (`makeAgent`), in every open room, thinking not at all and answering briefly. */
const SCOUT: NewAgent = {
  name: "Scout",
  description: "Finds what's current",
  instructions: "Say what you know of the weather, and nothing else.",
  model: GEMMA,
  thinking: "off",
  length: "short",
  webSearch: false,
  rooms: null,
};

/** Another, Recap, on gpt-oss, at the levels @ember's start at. */
const RECAP: NewAgent = { ...SCOUT, name: "Recap", description: "Sums up long threads", instructions: "Sum up the thread.", model: GPT_OSS, thinking: "low", length: "medium" };

/** Scout as Try it sends it, with a question. */
const TRIAL = { name: SCOUT.name, instructions: SCOUT.instructions, model: SCOUT.model, thinking: SCOUT.thinking, length: SCOUT.length, webSearch: false, question: "Is it sunny?" };
/** The same for an agent that isn't saved yet, which has a model Ember offers. */
const NEW_TRIAL = { ...TRIAL, model: HAIKU };

/** A forecast's Slack payload, which an agent writes in a ```slack block for a card under its answer, and the card it posts. */
const FORECAST = {
  blocks: [
    { type: "header", text: { type: "plain_text", text: "Today" } },
    { type: "section", fields: [{ type: "mrkdwn", text: "*High*\n21°" }, { type: "mrkdwn", text: "*Rain*\n10%" }] },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Hourly" }, url: "https://weather.example/hourly" }] },
  ],
};
const FORECAST_CARD: Card = {
  source: "blocks",
  parts: [
    { kind: "header", text: "Today" },
    { kind: "section", fields: [{ html: "<p><strong>High</strong><br>21°</p>", short: true }, { html: "<p><strong>Rain</strong><br>10%</p>", short: true }] },
    { kind: "buttons", buttons: [{ text: "Hourly", href: "https://weather.example/hourly" }] },
  ],
};
/** An answer with the forecast's card under its words. */
const FORECASTED = `Mostly sunny.\n\n\`\`\`slack\n${JSON.stringify(FORECAST, null, 2)}\n\`\`\``;

/** A question AI Gateway was sent, as Chat Completions or Messages takes it. */
interface Asked {
  url: string;
  metadata: string | null;
  body: {
    model: string;
    max_completion_tokens?: number;
    reasoning_effort?: string;
    max_tokens?: number;
    system?: string;
    messages: Array<{ role: string; content: string }>;
    tools?: Array<{ type?: string; name?: string }>;
  };
}

/** A page Anthropic's model finds on the web, and its answer citing it, as Messages gives them. */
const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs" };
const SEARCHED = [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Cloudflare AI Gateway" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", ...DOCS, encrypted_content: "e", page_age: null }] },
  { type: "text", text: "AI Gateway is Cloudflare's proxy for AI models.", citations: [{ type: "web_search_result_location", ...DOCS, encrypted_index: "e", cited_text: "…" }] },
];

/** A model's answer saying `text`, as Chat Completions answers, stopped where it did for `reason`. */
const chatAnswer = (text: string, reason: "stop" | "length" = "stop") =>
  Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: reason }] });

/** A model's answer saying `text`, in the format of the API at `url`, searching the web first when it's given a tool for it, as `asked` is. */
function answerTo({ url, body }: Pick<Asked, "url" | "body">, text: string): Response {
  if (!url.endsWith("/messages")) return chatAnswer(text);
  const searches = (body.tools ?? []).some(({ type }) => type?.startsWith("web_search"));
  return Response.json({ type: "message", role: "assistant", content: searches ? SEARCHED : [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
}

/** Cloudflare's answer to a request it refuses with `status`, in its own shape. */
const refusal = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

/**
 * A Grok model's answer saying `text`, as AI Gateway answers once xAI has refused a thinking level, with
 * its code for a request the provider refuses, which Cloudflare's API answers an account it can't route to with too.
 */
const unthinkingGrok = (text: string) => ({ body }: Asked) =>
  body.reasoning_effort === undefined
    ? chatAnswer(text)
    : refusal(400, 7003, `Model execution failed (User Input Error): {"code":"invalid-argument","error":"Model grok-4.20-0309-reasoning does not support parameter reasoningEffort."}`);

/**
 * Stands in for AI Gateway, whose model answers each question with what `answer` makes of it, keeping the
 * questions in the order they came: through Cloudflare's REST API, and through the gateway's endpoints for
 * each provider too, where Ember asks Grok, only `throughProviders`.
 */
function internet(answer: (asked: Asked) => Response | Promise<Response>, throughProviders = false): Asked[] {
  const questions: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname !== "api.cloudflare.com" && !(throughProviders && hostname === "gateway.ai.cloudflare.com")) return new Response("not found", { status: 404 });
    const asked = { url: request.url, metadata: request.headers.get("cf-aig-metadata"), body: (await request.json()) as Asked["body"] };
    questions.push(asked);
    return answer(asked);
  });
  return questions;
}

/**
 * Sets Ember up with Ada as its administrator, signed in, and Ember AI on with GLM, which it kept from
 * before Ember stopped offering it, answering her session and the general room.
 */
async function setUp(): Promise<{ ada: Session; general: RoomId }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  internet((asked) => answerTo(asked, "Hello, team!"), true);
  const saved = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: ada.cookie }, body: JSON.stringify({ ...SETUP, model: SONNET }) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  vi.restoreAllMocks();
  await answerWithKeptModel(KEPT[GLM]!);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada, general };
}

/** A model answering as `answerTo` does with `text`, but refused the tool for reading pages, as AI Gateway may refuse it for a model. */
const refusedReading = (text: string) => (asked: Asked) =>
  (asked.body.tools ?? []).some(({ name }) => name === "web_fetch")
    ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "tools.1: unknown tool type" } }, { status: 400 })
    : answerTo(asked, text);

/**
 * Makes `agent` as `administrator`, its model answering its test question, and searching the web when
 * it's given a tool for it, but refused the tool for reading pages (`refusedReading`), or as `answer` has
 * it, answering it as its page shows it. One with a model Ember no longer offers is made as an agent made
 * before Ember stopped offering it keeps it (`KEPT`), at the levels of thinking `kept` says it took.
 */
async function makeAgent(administrator: Session, agent: NewAgent, answer = refusedReading("Hello, team!"), kept = KEPT[agent.model]): Promise<AgentSettings> {
  internet(kept ? (asked) => answerTo(asked, "Hello, team!") : answer, true);
  const response = await api("/api/account/agents", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify(kept ? { ...agent, model: HAIKU } : agent) });
  expect(response.status, await response.clone().text()).toBe(201);
  vi.restoreAllMocks();
  const made = ((await response.json()) as AgentAnswer).agent;
  if (!kept) return made;
  await agentWithKeptModel(made.id, kept);
  const shown = await api(`/api/account/agents/${made.id}`, { headers: { Cookie: administrator.cookie } });
  return ((await shown.json()) as AgentAnswer).agent;
}

/** Deletes `agent` as `administrator`, as its page's Delete agent does. */
async function deleteAgent(administrator: Session, agent: Pick<User, "id">): Promise<void> {
  expect((await api(`/api/account/agents/${agent.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
}

/** Turns Ember AI off as `administrator`, as turning off its card's switch does. */
async function turnOff(administrator: Session): Promise<void> {
  expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(200);
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

/** The next message each of `bots` posts that `client` hears of, by the bot's id. */
async function nextFromEach(client: Client, bots: Array<Pick<User, "id">>): Promise<Map<UserId, Message>> {
  const answers = new Map<UserId, Message>();
  while (answers.size < bots.length) {
    const { message } = await client.next("message.created");
    if (bots.some(({ id }) => id === message.creator.id)) answers.set(message.creator.id, message);
  }
  return answers;
}

/** Replies in `parent`'s thread as `client`, and waits for the room to confirm it. */
async function reply(client: Client, parent: Pick<Message, "id">, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** Adds a bot as `administrator`, which joins the rooms open to everyone, answering it as its edit page shows it. */
async function addBot(administrator: Session, name: string): Promise<BotSettings> {
  const response = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** Starts the DM of `person` and `others`, answering its room. */
async function directWith(person: Session, others: Array<Pick<User, "id">>): Promise<DirectRoom> {
  const started = await startDirect(person, others.map(({ id }) => id));
  expect(started.status, await started.clone().text()).toBe(201);
  return ((await started.json()) as { room: DirectRoom }).room;
}

/** Waits until `room` has sent the Workspace every event it logged, whose answer says whom each message goes to. */
const allApplied = (room: RoomId) => vi.waitFor(async () => expect(await roomSql(room, "SELECT count(*) AS n FROM room_events")).toEqual([{ n: 0 }]));

/**
 * A model that answers `text` only once `answer` is called, waiting in the room's own I/O context, where
 * a promise of the test's can't be awaited, and `asked` waits until it has been asked.
 */
function waitingModel(text: string) {
  let [asked, answering] = [false, false];
  internet(async () => {
    asked = true;
    while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
    return chatAnswer(text);
  });
  return { asked: () => vi.waitFor(() => expect(asked).toBe(true)), answer: () => (answering = true) };
}

/** Asks Try it as `session`, of agent `agentId` as it's saved, or of one not saved yet, for null, as `trial` sets it up. */
const tryIt = (session: Session | null, agentId: UserId | null, trial: unknown) =>
  api(agentId === null ? "/api/account/agents/trials" : `/api/account/agents/${agentId}/trials`, { method: "POST", headers: session ? { Cookie: session.cookie } : {}, body: JSON.stringify(trial) });

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("An AI agent", () => {
  it("answers a mention in a room it's in, there, as its instructions say, with its own model and levels, through Ember AI's account", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    const questions = internet(() => chatAnswer("Sunny, then **rain** by six."));
    const client = await connect(general, ada);

    await post(client, "<p>Are we still on for the picnic?</p>");
    const question = await post(client, `<p>${mention(scout)} what's the forecast?</p>`);
    const answer = await nextFrom(client, scout);
    const asScout = { id: scout.id, name: "Scout" };
    expect(answer).toMatchObject({ creator: asScout, body: "<p>Sunny, then <strong>rain</strong> by six.</p>", plainText: "Sunny, then rain by six." });
    expect(answer.parentId).toBeUndefined();
    expect(await client.next("typing")).toEqual({ type: "typing", user: asScout, typing: true });
    expect(await client.next("typing")).toEqual({ type: "typing", user: asScout, typing: false });

    expect(questions).toHaveLength(1);
    const [{ url, metadata, body }] = questions as [Asked];
    expect(url).toBe(`${CLOUDFLARE_API}/chat/completions`);
    // AI Gateway's logs and spend limits know each request by who asked, and which agent answers.
    expect(JSON.parse(metadata!)).toEqual({ user_id: ada.user.id, agent_id: scout.id });
    expect(body).toMatchObject({ model: GEMMA, max_completion_tokens: maxTokensAt({ thinking: "off", length: "short" }), reasoning_effort: "none" });
    const [instructions, ...turns] = body.messages;
    expect(instructions!.content).toMatch(/^You are Scout, an AI agent in the team chat ".*". People ask you things by mentioning @Scout in a room or a thread, or by writing to you directly\.\n\n/);
    expect(instructions!.content).toContain(`${SCOUT.instructions}\n\nWrite in Markdown.`);
    expect(instructions!.content).toMatch(/\n\nYou're asked in the room "general"\. .* Answer the last one, which "Ada Lovelace" wrote, in at most about 150 words\. [^\n]+$/);
    expect(instructions!.content).not.toContain("You are Ember");
    expect(turns).toEqual([
      { role: "user", content: "Ada Lovelace: Are we still on for the picnic?" },
      { role: "user", content: `Ada Lovelace: ${question.plainText}` },
    ]);
    client.close();
  });

  it("is told what an administrator changed what Ember adds around its instructions to, each placeholder filled in", async () => {
    const { ada, general } = await setUp();
    const template = "You are {{name}} of {{community}}, asked in {{where}} by {{asker}}.\n\n{{instructions}}\n\nWrite at most {{words}} words. {{web}} Today is {{today}}.";
    const scout = await makeAgent(ada, { ...SCOUT, promptTemplate: template });
    expect(scout.promptTemplate).toBe(template);
    const questions = internet(() => chatAnswer("Sunny."));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(scout)} what's the forecast?</p>`);
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: "Sunny." });
    const told = questions[0]!.body.messages[0]!.content;
    expect(told).toMatch(new RegExp(`^You are Scout of .+, asked in the room "general" by "Ada Lovelace"\\.\n\n${SCOUT.instructions.replace(/[.,]/g, "\\$&")}\n\nWrite at most 150 words\\. You can't search the web or open links\\.`));
    expect(told).toMatch(/ Today is \w+, \w+ \d+, \d{4} at \d{2}:\d{2}\.$/);
    expect(told).not.toContain("{{");
    client.close();
  });

  it("shows the cards of the Slack payloads it writes under its answer, as a bot's webhook posts them", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    internet(() => chatAnswer(FORECASTED));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(scout)} what's the weather?</p>`);
    const answer = await nextFrom(client, scout);
    expect(answer).toMatchObject({ body: "<p>Mostly sunny.</p>", plainText: "Mostly sunny.\nToday\nHigh\n21°\nRain\n10%\nHourly" });
    expect(answer.cards).toEqual([FORECAST_CARD]);
    client.close();
  });

  it("answers a reply in a thread in the thread, only there, reading its own answers there as its own", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    const answers = ["Friday.", "At noon."];
    const questions = internet(() => chatAnswer(answers.shift()!));
    const client = await connect(general, ada);

    const parent = await post(client, "<p>When's the picnic?</p>");
    await reply(client, parent, `<p>${mention(scout)} which day?</p>`);
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: "Friday.", parentId: parent.id, alsoSent: false });
    const asked = await reply(client, parent, `<p>${mention(scout)} what time?</p>`);
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: "At noon.", parentId: parent.id });

    const [instructions, ...turns] = questions[1]!.body.messages;
    expect(instructions!.content).toContain(`You're asked in a thread in the room "general".`);
    expect(turns).toEqual([
      { role: "user", content: "Ada Lovelace: When's the picnic?" },
      { role: "user", content: "Ada Lovelace: @Scout which day?" },
      { role: "assistant", content: "Friday." },
      { role: "user", content: `Ada Lovelace: ${asked.plainText}` },
    ]);
    client.close();
  });

  it("answers every message in a DM with it, and with two agents each answers the person, neither the other", async () => {
    const { ada } = await setUp();
    const [scout, recap] = [await makeAgent(ada, SCOUT), await makeAgent(ada, RECAP)];
    const questions = internet(({ body }) => chatAnswer(`You said: ${body.messages.at(-1)!.content}`));

    const dm = await connect((await directWith(ada, [scout])).id, ada);
    await post(dm, "<p>Hi there</p>");
    expect(await nextFrom(dm, scout)).toMatchObject({ creator: { id: scout.id, name: "Scout" }, plainText: "You said: Ada Lovelace: Hi there" });
    expect(questions[0]!.body.messages[0]!.content).toContain("You're asked in a direct message.");
    expect(JSON.parse(questions[0]!.metadata!)).toEqual({ user_id: ada.user.id, agent_id: scout.id });
    dm.close();

    const room = await directWith(ada, [scout, recap]);
    const group = await connect(room.id, ada);
    await post(group, "<p>Morning, both</p>");
    const answers = await nextFromEach(group, [scout, recap]);
    expect([answers.get(scout.id)!.plainText, answers.get(recap.id)!.plainText]).toEqual(["You said: Ada Lovelace: Morning, both", "You said: Ada Lovelace: Morning, both"]);
    await allApplied(room.id);
    await settle(group);
    expect(questions).toHaveLength(3);
    group.close();
  });

  it("answers with @ember and another agent when one message mentions them all, each once, each with its own model", async () => {
    const { ada, general } = await setUp();
    const [scout, recap] = [await makeAgent(ada, SCOUT), await makeAgent(ada, RECAP)];
    const questions = internet(({ body }) => chatAnswer(`${body.model} answers.`));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(scout)} ${mention(recap)} ${mention(EMBER)} and ${mention(scout)} again, what do you all think?</p>`);
    const answers = await nextFromEach(client, [scout, recap, EMBER]);
    expect([answers.get(scout.id)!.plainText, answers.get(recap.id)!.plainText, answers.get(ASSISTANT_ID)!.plainText]).toEqual([
      `${GEMMA} answers.`,
      `${GPT_OSS} answers.`,
      `${GLM} answers.`,
    ]);
    await allApplied(general);
    await settle(client);
    expect(questions.map(({ metadata }) => (JSON.parse(metadata!) as { agent_id: string }).agent_id).sort()).toEqual([ASSISTANT_ID, recap.id, scout.id].sort());
    // @ember answers as it does, and each agent as it's set up.
    const told = (model: string) => questions.find(({ body }) => body.model === model)!.body.messages[0]!.content;
    expect(told(GLM)).toContain("You are Ember, the AI assistant");
    expect(told(GPT_OSS)).toContain(`You are Recap, an AI agent`);
    expect(told(GPT_OSS)).toContain(RECAP.instructions);
    client.close();
  });

  it("answers a mention in a room with no DM, which the asker's sidebar doesn't list, nor one with @ember", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    internet(() => chatAnswer("Sunny."));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(scout)} ${mention(EMBER)} what's the forecast?</p>`);
    await nextFromEach(client, [scout, EMBER]);
    await allApplied(general);
    const sidebar = (await (await api("/api/sidebar", { headers: { Cookie: ada.cookie } })).json()) as Sidebar;
    expect(sidebar.rooms.filter(({ kind }) => kind === "direct")).toEqual([]);
    client.close();
  });

  it("doesn't answer a bot's message mentioning it, though it reads it", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    const bot = await addBot(ada, "Build Bot");
    const questions = internet(() => chatAnswer("It did."));
    const client = await connect(general, ada);

    const fromBot = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: `<p>${mention(scout)} build 42 passed</p>`, headers: { "Content-Type": "text/html" } });
    expect(fromBot.status).toBe(201);
    const asked = await post(client, `<p>${mention(scout)} did the build pass?</p>`);
    await nextFrom(client, scout);
    await allApplied(general);
    await settle(client);
    expect(questions.map(({ body }) => body.messages.at(-1)!.content)).toEqual([`Ada Lovelace: ${asked.plainText}`]);
    expect(questions[0]!.body.messages.map(({ content }) => content)).toContain("Build Bot: @Scout build 42 passed");
    client.close();
  });

  it("answers only in the rooms it's in, and nothing once it's deleted, or Ember AI is off", async () => {
    const { ada, general } = await setUp();
    const launch = await createRoom("launch", { as: ada });
    const scout = await makeAgent(ada, { ...SCOUT, rooms: [launch.id] });
    const recap = await makeAgent(ada, RECAP);
    const questions = internet(({ body }) => chatAnswer(`${body.model} is here.`));
    const client = await connect(general, ada);
    const inLaunch = await connect(launch.id, ada);

    // Each time, a question for someone who answers follows, so the one before it would have been asked by then.
    await post(client, `<p>${mention(scout)} are you here?</p>`);
    await post(client, `<p>${mention(recap)} and you?</p>`);
    await nextFrom(client, recap);
    await post(inLaunch, `<p>${mention(scout)} and here?</p>`);
    expect(await nextFrom(inLaunch, scout)).toMatchObject({ plainText: `${GEMMA} is here.` });

    await deleteAgent(ada, scout);
    await post(inLaunch, `<p>${mention(scout)} still here?</p>`);
    await post(inLaunch, `<p>${mention(recap)} and you?</p>`);
    await nextFrom(inLaunch, recap);
    await allApplied(launch.id);
    expect(questions.map(({ body }) => body.model)).toEqual([GPT_OSS, GEMMA, GPT_OSS]);

    await turnOff(ada);
    await post(inLaunch, `<p>${mention(recap)} still here?</p>`);
    await allApplied(launch.id);
    await settle(inLaunch);
    expect(questions).toHaveLength(3);
    client.close();
    inLaunch.close();
  });

  it("posts nothing once it's deleted while its model answers, and stops typing", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = waitingModel("Too late.");
    const client = await connect(general, ada);

    const question = await post(client, `<p>${mention(scout)} are you there?</p>`);
    await model.asked();
    await deleteAgent(ada, scout);
    model.answer();
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        `Agent ${scout.id}'s answer to message ${question.id} failed:`,
        "it wasn't posted: Ember AI has been turned off, or the agent has been deleted or is no longer in the room",
      ),
    );
    await settle(client);
    expect(client.log.filter((frame) => frame.type === "message.created" && frame.message.creator.id === scout.id)).toEqual([]);
    expect(client.log.filter((frame) => frame.type === "typing").at(-1)).toEqual({ type: "typing", user: { id: scout.id, name: "Scout" }, typing: false });
    client.close();
  });

  it("says why it can't answer, naming administrators for how much it thinks, and logs which agent it is", async () => {
    const { ada, general } = await setUp();
    const scout = await makeAgent(ada, { ...SCOUT, thinking: "high" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Each made as it's asked for, as a body made in the test can't be read in the room.
    const answers = [() => chatAnswer("", "length"), () => refusal(402, 2009, "Insufficient credits")];
    internet(() => answers.shift()!());
    const client = await connect(general, ada);

    await post(client, `<p>${mention(scout)} think hard?</p>`);
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: AGENT_NOTES["out of room"] });
    expect(AGENT_NOTES["out of room"]).toContain("an administrator can choose less Thinking for me");
    const question = await post(client, `<p>${mention(scout)} and now?</p>`);
    expect(await nextFrom(client, scout)).toMatchObject({ plainText: NOTES.credits });
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Agent ${scout.id}'s model ${GEMMA.replaceAll(".", "\\.")} didn't answer message ${question.id}: .*Insufficient credits`)));
    client.close();
  });

  it("asks its model at no thinking level, once, when the model refused each as the agent was made, as xAI refused each for Grok 4.20 Reasoning", async () => {
    const { ada, general } = await setUp();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const grok = await makeAgent(ada, { ...SCOUT, name: "Grok", model: GROK, thinking: "low" }, undefined, { ...KEPT[GROK]!, thinkingLevels: [] });
    expect(grok.thinkingLevels).toEqual([]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(unthinkingGrok("The Packers won."));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(grok)} who won the latest Packers game?</p>`);
    expect(await nextFrom(client, grok)).toMatchObject({ plainText: "The Packers won." });
    expect(questions.map(({ url, body }) => [url, body.reasoning_effort])).toEqual([[`${CLOUDFLARE_API}/chat/completions`, undefined]]);
    expect(errors).not.toHaveBeenCalled();
    client.close();
  });

  it("asks its model again without a thinking level when the model's provider refuses one it took when the agent was made, rather than saying Ember AI's account is gone", async () => {
    const { ada, general } = await setUp();
    const grok = await makeAgent(ada, { ...SCOUT, name: "Grok", model: GROK, thinking: "low" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(unthinkingGrok("The Packers won."));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(grok)} who won the latest Packers game?</p>`);
    expect(await nextFrom(client, grok)).toMatchObject({ plainText: "The Packers won." });
    expect(questions.map(({ url, body }) => [url, body.reasoning_effort])).toEqual([
      [`${CLOUDFLARE_API}/chat/completions`, "low"],
      [`${CLOUDFLARE_API}/chat/completions`, undefined],
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${GROK} again without a thinking level`));
    client.close();
  });
});

describe("@ember", () => {
  it("answers with the instructions administrators added after who it is, labeled as its answer", async () => {
    const { ada, general } = await setUp();
    const changed = await api("/api/account/assistant", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ instructions: "Answer in British English." }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const questions = internet(() => chatAnswer("Brilliant."));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} how's the launch?</p>`);
    expect(await nextFrom(client, EMBER)).toMatchObject({ plainText: "Brilliant." });
    const [{ metadata, body }] = questions as [Asked];
    expect(body.messages[0]!.content).toContain(`or by writing to you directly.\n\nAnswer in British English.\n\nWrite in Markdown.`);
    expect(body.messages[0]!.content).toContain(`\n\nYou're asked in the room "general".`);
    expect(body.messages[0]!.content).toContain("as a helpful teammate would: plainly, and in at most about 400 words.");
    expect(JSON.parse(metadata!)).toEqual({ user_id: ada.user.id, agent_id: ASSISTANT_ID });
    client.close();
  });

  it("answers within what administrators changed what Ember adds around its instructions to", async () => {
    const { ada, general } = await setUp();
    const promptTemplate = "{{instructions}}\n\nYou are {{name}}. Answer {{asker}}, in {{where}}.";
    const changed = await api("/api/account/assistant", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ instructions: "Be brief.", promptTemplate }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const questions = internet(() => chatAnswer("Fine."));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} how's the launch?</p>`);
    expect(await nextFrom(client, EMBER)).toMatchObject({ plainText: "Fine." });
    expect(questions[0]!.body.messages[0]!.content).toBe(`Be brief.\n\nYou are Ember. Answer "Ada Lovelace", in the room "general".`);
    client.close();
  });
});

describe("Try it", () => {
  it("asks an agent that isn't saved yet the administrator's question as a direct message, answering what it said as a message of its shows it", async () => {
    const { ada } = await setUp();
    const questions = internet((asked) => answerTo(asked, "**Yes**, see ![the sky](https://example.com/sky.png)"), true);

    const response = await tryIt(ada, null, { ...NEW_TRIAL, description: "", rooms: "any", question: "  Is it sunny? https://example.com/sky.png  " });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      body: `<p><strong>Yes</strong>, see <a href="https://example.com/sky.png">the sky</a></p>`,
      cards: [{ source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/sky.png", alt: "the sky" } }] }],
      ms: expect.any(Number),
    } satisfies AgentTrialAnswer);

    const [{ url, metadata, body }] = questions as [Asked];
    expect(url).toBe(ANTHROPIC_ENDPOINT);
    // An agent that isn't saved has no id to label it with.
    expect(JSON.parse(metadata!)).toEqual({ user_id: ada.user.id });
    expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: maxTokensAt({ thinking: "off", length: "short" }) });
    expect(body.system).toMatch(/^You are Scout, an AI agent in the team chat/);
    expect(body.system).toContain(`${SCOUT.instructions}\n\nWrite in Markdown.`);
    expect(body.system).toContain(`\n\nYou're asked in a direct message.`);
    expect(body.messages).toEqual([{ role: "user", content: "Ada Lovelace: Is it sunny? https://example.com/sky.png" }]);
    // Nothing's saved, and nobody else hears of it.
    expect(await workspaceSql("SELECT count(*) AS n FROM agents")).toEqual([{ n: 0 }]);
  });

  it("answers the cards of the Slack payloads its answer writes, as a message of its shows them", async () => {
    const { ada } = await setUp();
    internet((asked) => answerTo(asked, FORECASTED), true);

    const response = await tryIt(ada, null, NEW_TRIAL);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ body: "<p>Mostly sunny.</p>", cards: [FORECAST_CARD], ms: expect.any(Number) } satisfies AgentTrialAnswer);
  });

  it("asks the agent with what Ember adds around its instructions as the page has it, saved or not", async () => {
    const { ada } = await setUp();
    const scout = await makeAgent(ada, { ...SCOUT, promptTemplate: "Saved. {{instructions}}" });
    const questions = internet(() => chatAnswer("Sunny."));

    expect((await tryIt(ada, scout.id, { ...TRIAL, promptTemplate: "You are {{name}}, in {{where}}. {{instructions}}" })).status).toBe(200);
    expect(questions[0]!.body.messages[0]!.content).toBe(`You are Scout, in a direct message. ${SCOUT.instructions}`);
    // Ember's own, for none.
    expect((await tryIt(ada, scout.id, TRIAL)).status).toBe(200);
    expect(questions[1]!.body.messages[0]!.content).toMatch(/^You are Scout, an AI agent in the team chat/);
    const refused = await tryIt(ada, scout.id, { ...TRIAL, promptTemplate: "{{instructions}} in {{room}}" });
    expect([refused.status, await refused.json()]).toEqual([422, { error: unknownPlaceholder("room"), field: "promptTemplate" }]);
    expect(questions).toHaveLength(2);
  });

  it("asks a saved agent in the format, and with the web tools, its tests found, while its model is the same, labeled as its", async () => {
    const { ada } = await setUp();
    const scout = await makeAgent(ada, { ...SCOUT, model: HAIKU, webSearch: true });
    expect(scout.webTools).toEqual(["search"]);
    const questions = internet((asked) => answerTo(asked, "Nothing found."), true);

    const response = await tryIt(ada, scout.id, { ...TRIAL, model: HAIKU, webSearch: true, question: "What's AI Gateway?" });
    expect(response.status, await response.clone().text()).toBe(200);
    const { body } = (await response.json()) as AgentTrialAnswer;
    expect(body).toBe(`<p>AI Gateway is Cloudflare's proxy for AI models.</p><p>Sources: <a href="${DOCS.url}">${DOCS.title}</a></p>`);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.url).toBe(ANTHROPIC_ENDPOINT);
    expect(questions[0]!.body.tools!.map(({ name }) => name)).toEqual(["web_search"]);
    expect(JSON.parse(questions[0]!.metadata!)).toEqual({ user_id: ada.user.id, agent_id: scout.id });

    // Another model is asked in the format Ember asks it in, with every tool that format has.
    const another = await tryIt(ada, scout.id, { ...TRIAL, model: SONNET, webSearch: true, question: "What's AI Gateway?" });
    expect(another.status, await another.clone().text()).toBe(200);
    expect(questions[1]!.body.tools!.map(({ name }) => name)).toEqual(["web_search", "web_fetch"]);
    // Without Search the web, it's asked with no tools, told it can't search.
    const unsearched = await tryIt(ada, scout.id, { ...TRIAL, model: HAIKU, question: "What's AI Gateway?" });
    expect(((await unsearched.json()) as AgentTrialAnswer).body).toBe("<p>Nothing found.</p>");
    expect(questions[2]!.body.tools).toBeUndefined();
    expect(questions[2]!.body.system).toContain("You can't search the web or open links.");
  });

  it("only searches when AI Gateway doesn't take the tool for reading pages, as the agent would once it's saved", async () => {
    const { ada } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(refusedReading("Nothing found."), true);

    const response = await tryIt(ada, null, { ...TRIAL, model: SONNET, webSearch: true, question: "What's AI Gateway?" });
    expect(response.status, await response.clone().text()).toBe(200);
    const { body } = (await response.json()) as AgentTrialAnswer;
    expect(body).toBe(`<p>AI Gateway is Cloudflare's proxy for AI models.</p><p>Sources: <a href="${DOCS.url}">${DOCS.title}</a></p>`);
    // Once without thinking, which it might not have taken, and then only searching, told so.
    expect(questions.map(({ body }) => body.tools!.map(({ name }) => name))).toEqual([["web_search", "web_fetch"], ["web_search", "web_fetch"], ["web_search"]]);
    expect(questions[2]!.body.system).toContain("You can search the web when a question needs what's current");
  });

  it("tries no model Ember doesn't offer, refusing it on its field before AI Gateway is asked anything, but for the one a saved agent kept", async () => {
    const { ada } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    const questions = internet(() => chatAnswer("Sunny."));

    for (const [agentId, model] of [[null, GEMMA], [scout.id, GPT_OSS], [scout.id, "openai/gpt-5.5"]] as const) {
      const refused = await tryIt(ada, agentId, { ...TRIAL, model });
      expect([refused.status, await refused.json()]).toEqual([422, { error: MODEL_REFUSED, field: "model" }]);
    }
    expect(questions).toEqual([]);
    expect((await tryIt(ada, scout.id, TRIAL)).status).toBe(200);
    expect(questions.map(({ url, body }) => [url, body.model])).toEqual([[`${CLOUDFLARE_API}/chat/completions`, GEMMA]]);
  });

  it("asks a saved agent's model again without a thinking level when the model's provider refuses one, as it would in a room", async () => {
    const { ada } = await setUp();
    const grok = await makeAgent(ada, { ...SCOUT, name: "Grok", model: GROK, thinking: "low" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(unthinkingGrok("The Packers won."));

    const response = await tryIt(ada, grok.id, { ...TRIAL, name: "Grok", model: GROK, thinking: "low", question: "who won the latest packers game" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as AgentTrialAnswer).body).toBe("<p>The Packers won.</p>");
    expect(questions.map(({ body }) => body.reasoning_effort)).toEqual(["low", undefined]);
  });

  it("tries Grok searching the web with Ember's own tool in Chat Completions, which Ember runs with Cloudflare's Web Search API", async () => {
    const { ada } = await setUp();
    const trial = { ...TRIAL, name: "Grok", model: "xai/grok-4.7", thinking: "low", webSearch: true, question: "who won the latest Packers game?" };
    const questions = internet((asked) => {
      if (asked.url === WEB_SEARCH) return Response.json({ success: true, result: { items: [{ ...DOCS, description: "The Packers won." }] } });
      if (asked.body.messages.at(-1)?.role === "tool") return chatAnswer("The Packers won [1].");
      const call = { id: "call_0", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "Packers" }) } };
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { completion_tokens: 20 } });
    });
    const tried = await tryIt(ada, null, trial);
    expect(tried.status, await tried.clone().text()).toBe(200);
    expect(((await tried.json()) as AgentTrialAnswer).body).toBe(`<p>The Packers won.</p><p>Sources: <a href="${DOCS.url}">${DOCS.title}</a></p>`);
    expect(questions.map(({ url }) => url)).toEqual([`${CLOUDFLARE_API}/chat/completions`, WEB_SEARCH, `${CLOUDFLARE_API}/chat/completions`]);
    expect(questions[0]!.body).toMatchObject({ model: "xai/grok-4.7", reasoning_effort: "low", tools: [{ type: "function", function: expect.objectContaining({ name: "web_search" }) }] });
  });

  it("refuses Search the web for a model kept from before that can't search, as saving would, and says on the model's field why it didn't answer", async () => {
    const { ada } = await setUp();
    const scout = await makeAgent(ada, { ...SCOUT, model: DEEPSEEK });
    const answers = [() => chatAnswer("Sunny."), () => refusal(403, 5018, "This model isn't available to your account")];
    internet(() => answers.shift()!());

    const searching = await tryIt(ada, scout.id, { ...TRIAL, model: DEEPSEEK, webSearch: true });
    expect(searching.status).toBe(422);
    expect(await searching.json()).toEqual({ error: agentCannotSearchWith("DeepSeek V4 Pro"), field: "webSearch" });
    const refused = await tryIt(ada, scout.id, { ...TRIAL, model: DEEPSEEK });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Cloudflare won't run that model for this account."), field: "model" });
  });

  it("is for administrators only, while Ember AI is on, for agents there are, and refuses a field that can't be what it's for, asking nothing", async () => {
    const { ada } = await setUp();
    const scout = await makeAgent(ada, SCOUT);
    const questions = internet(() => chatAnswer("Sunny."));
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const joined = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" }) });
    expect(joined.status, await joined.clone().text()).toBe(201);
    const grace = { user: shown(((await joined.json()) as { user: Me }).user), cookie: cookieOf(joined) };

    expect((await tryIt(null, null, TRIAL)).status).toBe(401);
    const forbidden = await tryIt(grace, scout.id, TRIAL);
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: AGENTS_FORBIDDEN }]);
    const missing = await tryIt(ada, "no-such-agent", TRIAL);
    expect(missing.status).toBe(404);
    const unasked = await tryIt(ada, null, { ...TRIAL, question: " \n " });
    expect([unasked.status, await unasked.json()]).toEqual([422, { error: QUESTION_NEEDED, field: "question" }]);
    const unnamed = await tryIt(ada, scout.id, { ...TRIAL, name: undefined });
    expect([unnamed.status, await unnamed.json()]).toEqual([422, { error: NAME_REFUSED, field: "name" }]);
    await turnOff(ada);
    const off = await tryIt(ada, null, TRIAL);
    expect([off.status, await off.json()]).toEqual([409, { error: ASSISTANT_OFF }]);
    expect(questions).toEqual([]);
  });
});

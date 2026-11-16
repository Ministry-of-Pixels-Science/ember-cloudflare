import { ASSISTANT_ID, ASSISTANT_NAME, MAX_MESSAGE_LENGTH, type BotAnswer, type BotSettings, type DirectRoom, type Message, type NewWorkspace, type RoomId, type User } from "@ember/protocol";
import { DEFAULT_LEVELS, MAX_CONVERSATION_LENGTH, maxTokensAt, THINKING_LEVELS, TOP_LEVELS, UNTHINKING_TOKENS, type AnswerLevelChanges } from "@ember/protocol/assistant";
import { CARDS_PROMPT } from "@ember/protocol/prompts";
import { MENTION_CONTENT_TYPE, mentionSgid, OPENGRAPH_EMBED_CONTENT_TYPE, prepareBody } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerOf,
  NOTES,
  previewAttachment,
  questionFor,
  ROOM_MESSAGES_READ,
  THREAD_REPLIES_READ,
  waitFor,
  writtenBy,
  type Answerer,
} from "../src/assistant/answers";
import { markdownHtml } from "../src/bots/markdown";
import { keptCards } from "../src/cards";
import { answerWithKeptModel, api, apiWith, connect, cookieOf, freshDeploy, post, roomSql, settle, shown, startDirect, workspaceSql, type Client, type KeptModel, type Session } from "./support";

// What @ember answers when someone asks it something: in the room or thread they asked in, having read
// the conversation there, as rich text, with the pictures it shows in a card and a preview of its first
// link, at addresses people wrote there, or a note saying why it can't, and only while Ember AI is on.

const EMBER: User = { id: ASSISTANT_ID, name: ASSISTANT_NAME };
/**
 * One of Workers AI's models, which a copy set up before Ember stopped offering them may answer with,
 * which takes Chat Completions, through Cloudflare's REST API, whose turns AI Gateway is sent as they are.
 */
const MODEL = "@cf/zai-org/glm-4.7-flash";
const GLM: KeptModel = { id: MODEL, name: "GLM-4.7 Flash", format: "chat", thinkingLevels: [...THINKING_LEVELS] };
/** Anthropic's model, which takes Messages, and OpenAI's, which takes Responses, through their providers' endpoints. */
const [MESSAGES_MODEL, RESPONSES_MODEL] = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol"];
const SETUP = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "an-api-token-with-ai-gateway-run_0123456" };

/**
 * Sets Ember up with Ada as its administrator, signed in, and Ember AI on with `model`, answering her
 * session and the general room: GLM, kept from before Ember stopped offering it, unless it's one Ember offers.
 */
async function setUp(model = MODEL): Promise<{ ada: Session; general: RoomId }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => answerAt(new Request(input, init).url, "Hello, team!"));
  await setUpAgain(ada, model === MODEL ? MESSAGES_MODEL : model);
  vi.restoreAllMocks();
  if (model === MODEL) await answerWithKeptModel(GLM);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada, general };
}

/** Sets Ember AI up as `administrator` with `model`, one Ember offers, which asks the model its test question at each level of thinking. */
async function setUpAgain(administrator: Session, model: string): Promise<void> {
  const saved = await api("/api/account/assistant", { method: "PUT", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ ...SETUP, model }) });
  expect(saved.status, await saved.clone().text()).toBe(200);
}

/** Turns Ember AI off as `administrator`, as turning off its card's switch does. */
async function turnOff(administrator: Session): Promise<void> {
  expect((await api("/api/account/assistant", { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(200);
}

/** How a message mentioning `person` is written. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** A model's answer saying `text`, as Chat Completions answers, stopped where it did for `reason`. */
const chatAnswer = (text: string, reason: "stop" | "length" = "stop") =>
  Response.json({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: reason }] });

/**
 * A model's answer saying `text` after its thinking, or only thinking when `text` is blank, in the format
 * of the API at `url`, stopped at its token limit if `cut`.
 */
function answerAt(url: string, text: string, cut = false): Response {
  if (url.endsWith("/messages")) {
    const content = [{ type: "thinking", thinking: "Let me see." }, ...(text ? [{ type: "text", text }] : [])];
    return Response.json({ type: "message", role: "assistant", content, stop_reason: cut ? "max_tokens" : "end_turn" });
  }
  if (url.endsWith("/responses")) {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
    const output = [{ type: "reasoning", summary: [] }, ...(text ? [message] : [])];
    return Response.json({ object: "response", output, ...(cut ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } : { status: "completed" }) });
  }
  return chatAnswer(text, cut ? "length" : "stop");
}

/** Changes how much @ember thinks and how long it answers `person`, as their profile's dials do. */
async function pickLevels(person: Session, changes: AnswerLevelChanges): Promise<void> {
  const response = await api("/api/users/me/assistant", { method: "PATCH", headers: { Cookie: person.cookie }, body: JSON.stringify(changes) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Changes the most @ember thinks and writes for anyone as `administrator`, as the Ember AI card's dials do. */
async function limitLevels(administrator: Session, changes: AnswerLevelChanges): Promise<void> {
  const response = await api("/api/account/assistant", { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify(changes) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Cloudflare's answer to a request it refuses with `status`, in its own shape. */
const refusal = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

/**
 * A question AI Gateway was sent, as Chat Completions takes it, or with the fields that Anthropic's
 * Messages and OpenAI's Responses say how much to think and write with.
 */
interface Asked {
  url: string;
  metadata: string | null;
  body: {
    model: string;
    max_completion_tokens: number;
    reasoning_effort?: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    thinking?: { type: string };
    output_config?: { effort: string };
    max_output_tokens?: number;
    reasoning?: { effort: string };
  };
}

/** A page with a preview, at http://www.example.com/, and the image it shows. */
const PAGE =
  '<meta property="og:url" content="https://example.com/"><meta property="og:title" content="Example"><meta property="og:description" content="An example page."><meta property="og:image" content="https://example.com/card.png">';

/**
 * Stands in for AI Gateway, through Cloudflare's REST API or its endpoints for each provider, whose model
 * answers each question with what `answer` makes of it, and for the Internet, where every name is at one
 * public address and http://www.example.com/ has a preview. Keeps the questions, in the order they came.
 */
function internet(answer: (asked: Asked) => Response | Promise<Response>): Asked[] {
  const questions: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.cloudflare.com" || url.hostname === "gateway.ai.cloudflare.com") {
      const asked = { url: request.url, metadata: request.headers.get("cf-aig-metadata"), body: (await request.json()) as Asked["body"] };
      questions.push(asked);
      return answer(asked);
    }
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
    if (request.url === "http://www.example.com/") return new Response(PAGE, { headers: { "Content-Type": "text/html" } });
    if (request.url === "https://example.com/card.png") return new Response(null, { headers: { "Content-Type": "image/png" } });
    return new Response("not found", { status: 404 });
  });
  return questions;
}

/** The hosts of what was fetched since `internet` stood in for the Internet, but AI Gateway, in order. */
const fetchedHosts = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).hostname)
    .filter((host) => host !== "api.cloudflare.com");

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

/** The next message @ember posts that `client` hears of. */
async function nextAnswer(client: Client): Promise<Message> {
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.creator.id === ASSISTANT_ID) return message;
  }
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

/** 350 steps of a numbered list, each numbered 1 in its Markdown, which shows them counting up, longer than a message. */
const STEPS = Array.from({ length: 350 }, (_, index) => `1. step-${String(index).padStart(18, "0")}`).join("\n");

/** Waits until `room` has sent the Workspace every event it logged, whose answer says whom each message goes to. */
const allApplied = (room: RoomId) => vi.waitFor(async () => expect(await roomSql(room, "SELECT count(*) AS n FROM room_events")).toEqual([{ n: 0 }]));

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("@ember", () => {
  it("answers a mention in the room, there, having read the room's latest messages, each after its writer's name", async () => {
    const { ada, general } = await setUp();
    const questions = internet(() => chatAnswer("It's on **Friday**, after the review."));
    const client = await connect(general, ada);

    await post(client, "<p>The launch moved to Friday.</p>");
    const question = await post(client, `<p>${mention(EMBER)} when's the launch?</p>`);
    const answer = await nextAnswer(client);
    expect(answer).toMatchObject({ creator: EMBER, body: "<p>It's on <strong>Friday</strong>, after the review.</p>", plainText: "It's on Friday, after the review." });
    expect(answer.parentId).toBeUndefined();
    // It types while the model answers, until the answer's there.
    expect(await client.next("typing")).toEqual({ type: "typing", user: EMBER, typing: true });
    expect(await client.next("typing")).toEqual({ type: "typing", user: EMBER, typing: false });

    expect(questions).toHaveLength(1);
    const [{ url, metadata, body }] = questions as [Asked];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${SETUP.accountId}/ai/v1/chat/completions`);
    // AI Gateway's logs and spend limits know each request by who asked, and who answers.
    expect(JSON.parse(metadata!)).toEqual({ user_id: ada.user.id, agent_id: ASSISTANT_ID });
    // At the levels everyone starts with: a little thinking, and a Medium answer.
    expect(body).toMatchObject({ model: MODEL, max_completion_tokens: maxTokensAt(DEFAULT_LEVELS), reasoning_effort: "low" });
    const [instructions, ...turns] = body.messages;
    expect(instructions!.role).toBe("system");
    expect(instructions!.content).toContain("in at most about 400 words.");
    expect(instructions!.content).toContain(`You're asked in the room "general".`);
    expect(instructions!.content).toContain("Answer the last one, which Ada Lovelace wrote");
    expect(turns).toEqual([
      { role: "user", content: "Ada Lovelace: The launch moved to Friday." },
      { role: "user", content: `Ada Lovelace: ${question.plainText}` },
    ]);
    client.close();
  });

  it("answers a reply in a thread in the thread, only there, having read its first message and replies, and types there", async () => {
    const { ada, general } = await setUp();
    const questions = internet(() => chatAnswer("The flame."));
    const client = await connect(general, ada);

    const parent = await post(client, "<p>Which logo should we use?</p>");
    await reply(client, parent, "<p>The flame, or the spark?</p>");
    await reply(client, parent, `<p>${mention(EMBER)} which one?</p>`);
    const answer = await nextAnswer(client);
    expect(answer).toMatchObject({ creator: EMBER, plainText: "The flame.", parentId: parent.id, alsoSent: false });
    expect(await client.next("typing")).toEqual({ type: "typing", user: EMBER, typing: true, threadId: parent.id });
    expect(await client.next("typing")).toEqual({ type: "typing", user: EMBER, typing: false, threadId: parent.id });

    const [instructions, ...turns] = questions[0]!.body.messages;
    expect(instructions!.content).toContain(`You're asked in a thread in the room "general".`);
    expect(turns.map(({ content }) => content)).toEqual(["Ada Lovelace: Which logo should we use?", "Ada Lovelace: The flame, or the spark?", "Ada Lovelace: @Ember which one?"]);
    client.close();
  });

  it("reads the room's latest messages, and a thread's first message and latest replies", async () => {
    const { ada, general } = await setUp();
    const questions = internet(() => chatAnswer("Sure."));
    const client = await connect(general, ada);

    for (let n = 1; n <= ROOM_MESSAGES_READ; n++) await post(client, `<p>Message ${n}</p>`);
    await post(client, `<p>${mention(EMBER)} what's the latest?</p>`);
    await nextAnswer(client);
    const room = questions[0]!.body.messages.slice(1).map(({ content }) => content);
    expect(room).toHaveLength(ROOM_MESSAGES_READ);
    expect(room[0]).toBe("Ada Lovelace: Message 2");

    const parent = await post(client, "<p>A long thread</p>");
    for (let n = 1; n <= THREAD_REPLIES_READ; n++) await reply(client, parent, `<p>Reply ${n}</p>`);
    await reply(client, parent, `<p>${mention(EMBER)} sum it up?</p>`);
    await nextAnswer(client);
    const thread = questions[1]!.body.messages.slice(1).map(({ content }) => content);
    expect(thread).toHaveLength(THREAD_REPLIES_READ + 1);
    expect(thread.slice(0, 2)).toEqual(["Ada Lovelace: A long thread", "Ada Lovelace: Reply 2"]);
    client.close();
  });

  it("answers every message in a DM with it, and in a room only those that mention it, never a bot's", async () => {
    const { ada, general } = await setUp();
    const questions = internet(({ body }) => chatAnswer(`You said: ${body.messages.at(-1)!.content}`));
    const bot = await addBot(ada, "Build Bot");
    const client = await connect(general, ada);

    await post(client, "<p>Nobody asked @ember this</p>");
    const fromBot = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: `<p>${mention(EMBER)} build 42 passed</p>`, headers: { "Content-Type": "text/html" } });
    expect(fromBot.status).toBe(201);
    const asked = await post(client, `<p>${mention(EMBER)} did the build pass?</p>`);
    await nextAnswer(client);
    await allApplied(general);
    await settle(client);
    expect(questions.map(({ body }) => body.messages.at(-1)!.content)).toEqual([`Ada Lovelace: ${asked.plainText}`]);
    // The bot's message is read, though it isn't answered.
    expect(questions[0]!.body.messages.map(({ content }) => content)).toContain("Build Bot: @Ember build 42 passed");
    client.close();

    const started = await startDirect(ada, [ASSISTANT_ID]);
    expect(started.status, await started.clone().text()).toBe(201);
    const { room: dm } = (await started.json()) as { room: DirectRoom };
    const direct = await connect(dm.id, ada);
    await post(direct, "<p>Hi there</p>");
    expect(await nextAnswer(direct)).toMatchObject({ creator: EMBER, plainText: "You said: Ada Lovelace: Hi there" });
    expect(questions.at(-1)!.body.messages[0]!.content).toContain("You're asked in a direct message.");
    direct.close();
  });

  it("shows the pictures its answer shows in a card under it, and a preview of its first web link below it, at addresses people wrote there", async () => {
    const { ada, general } = await setUp();
    internet(() => chatAnswer("Here's our logo:\n\n![The flame](https://images.example.com/flame.png)\n\nWrite to [us](mailto:team@example.com), or see [the guide](http://www.example.com/)."));
    const client = await connect(general, ada);

    await post(client, "<p>The logo is at https://images.example.com/flame.png, and the guide at http://www.example.com/</p>");
    await post(client, `<p>${mention(EMBER)} show me the logo</p>`);
    const answer = await nextAnswer(client);
    expect(answer.cards).toEqual([{ source: "blocks", parts: [{ kind: "image", image: { url: "https://images.example.com/flame.png", alt: "The flame" } }] }]);
    expect(answer.body).toContain(`<a href="http://www.example.com/">the guide</a>`);
    expect(answer.body).toContain(`<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}"`);
    expect(answer.body).toContain("An example page.");
    expect(answer.plainText).toBe("Here's our logo:\n\nThe flame\n\nWrite to us, or see the guide.");
    client.close();
  });

  it("shows the cards of the Slack payloads its answer writes under it, as a bot's webhook posts them, their pictures only at addresses people wrote, fetching none", async () => {
    const { ada, general } = await setUp();
    const alert = { attachments: [{ color: "danger", title: "Error rate", title_link: "https://made-up.example/alerts?d=bGF1bmNo", thumb_url: "https://made-up.example/t.png?d=bGF1bmNo", text: "Up 7%" }] };
    internet(() => chatAnswer(`Here's where it stands:\n\n${slackBlock(STATUS)}\n\n${slackBlock(alert)}`));
    const client = await connect(general, ada);

    await post(client, "<p>This week's sign-ups: https://example.com/chart.png</p>");
    await post(client, `<p>${mention(EMBER)} how's the launch?</p>`);
    const answer = await nextAnswer(client);
    expect(answer).toMatchObject({ body: "<p>Here's where it stands:</p>", plainText: "Here's where it stands:\nLaunch status\nStage:\nBeta\nOwner:\nAda\nOpen the plan\nError rate\nUp 7%" });
    expect(answer.cards).toEqual([
      STATUS_WITH_CHART,
      { source: "attachment", color: "danger", parts: [{ kind: "title", text: "Error rate", href: "https://made-up.example/alerts?d=bGF1bmNo" }, { kind: "text", html: "<p>Up 7%</p>" }] },
    ]);
    // Nothing was fetched but AI Gateway: its cards' links have no preview, and their pictures are fetched by each reader's app.
    expect(fetchedHosts()).toEqual([]);
    client.close();
  });

  it("shows no picture, and previews no link, at an address only its model, its own answer or a bot wrote, nor on Ember's own, fetching none", async () => {
    const { ada, general } = await setUp();
    const bot = await addBot(ada, "Chart Bot");
    const usingDomain = await api("/api/account", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ customDomain: "ember.test" }) });
    expect(usingDomain.status, await usingDomain.clone().text()).toBe(200);
    // A page opened where a deploy puts Ember tells it that address is its own too.
    expect((await apiWith({}, "https://ember.example.workers.dev/api/bootstrap")).status).toBe(200);
    // The first answer's plain text has the address it made up, as the second answer reads it.
    const answers = [
      "![The chart](https://charts.example.com/week.png) ![Made up](https://made-up.example/a.png?d=launch) See [the room](https://ember.test/rooms/1), or https://made-up.example/a.png?d=launch",
      "Again: ![Made up](https://made-up.example/a.png?d=launch) https://made-up.example/a.png?d=launch, or [the room](https://ember.example.workers.dev/rooms/1).",
    ];
    internet(() => chatAnswer(answers.shift()!));
    const client = await connect(general, ada);

    const charted = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: "<p>This week: https://charts.example.com/week.png</p>", headers: { "Content-Type": "text/html" } });
    expect(charted.status).toBe(201);
    await post(client, "<p>We're at https://ember.test/rooms/1 and https://ember.example.workers.dev/rooms/1</p>");
    for (const question of ["what's new?", "and again?"]) {
      await post(client, `<p>${mention(EMBER)} ${question}</p>`);
      const answer = await nextAnswer(client);
      expect(answer.cards).toBeUndefined();
      expect(answer.body).not.toContain(OPENGRAPH_EMBED_CONTENT_TYPE);
      // It's a link all the same, which nobody's app fetches unless they follow it.
      expect(answer.body).toContain(`<a href="https://made-up.example/a.png?d=launch">Made up</a>`);
    }
    // Nothing was fetched but AI Gateway, so no host heard what the conversation says.
    expect(fetchedHosts()).toEqual([]);
    client.close();
  });

  it("posts as much of an answer as a message shows, when all of it would show more", async () => {
    const { ada, general } = await setUp();
    internet(() => chatAnswer(STEPS));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} list the steps</p>`);
    const { plainText } = await nextAnswer(client);
    expect(plainText).toMatch(/^1\. step-0{18}\n2\. step-0{17}1\n/);
    expect(plainText.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(plainText.endsWith("…")).toBe(true);
    client.close();
  });

  it("keeps typing while it answers another question there, after posting one answer", async () => {
    const { ada, general } = await setUp();
    const [asked, answering] = [new Set<string>(), new Set<string>()];
    internet(async ({ body }) => {
      const question = body.messages.at(-1)!.content.endsWith("first?") ? "first" : "second";
      asked.add(question);
      while (!answering.has(question)) await new Promise((resolve) => setTimeout(resolve, 10));
      return chatAnswer(`The ${question} answer.`);
    });
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} first?</p>`);
    await post(client, `<p>${mention(EMBER)} second?</p>`);
    await vi.waitFor(() => expect(asked.size).toBe(2));
    answering.add("first");
    expect(await nextAnswer(client)).toMatchObject({ plainText: "The first answer." });
    answering.add("second");
    expect(await nextAnswer(client)).toMatchObject({ plainText: "The second answer." });
    await settle(client);
    // An answer ends its writer's typing in apps, so after the first one the room says again that @ember is typing.
    const heard = client.log.flatMap((frame): Array<boolean | string> =>
      frame.type === "typing" ? [frame.typing] : frame.type === "message.created" && frame.message.creator.id === ASSISTANT_ID ? [frame.message.plainText] : [],
    );
    expect(heard.filter((said, index) => said !== heard[index - 1])).toEqual([true, "The first answer.", true, "The second answer.", false]);
    client.close();
  });

  it("thinks and writes as much as the asker picked, up to the most an administrator allows", async () => {
    const { ada, general } = await setUp();
    const questions = internet(() => chatAnswer("Here's the plan."));
    const client = await connect(general, ada);

    await pickLevels(ada, { thinking: "high", length: "long" });
    await post(client, `<p>${mention(EMBER)} plan the launch?</p>`);
    await nextAnswer(client);
    await limitLevels(ada, { thinking: "medium", length: "short" });
    await post(client, `<p>${mention(EMBER)} and the party?</p>`);
    await nextAnswer(client);
    await pickLevels(ada, { thinking: "off" });
    await post(client, `<p>${mention(EMBER)} quickly?</p>`);
    await nextAnswer(client);

    expect(questions.map(({ body }) => [body.reasoning_effort, body.max_completion_tokens])).toEqual([
      ["high", 32_000 + 6_000],
      ["medium", 16_000 + 1_000],
      // Room for a model that thinks a little all the same, as thinking counts toward the most.
      ["none", UNTHINKING_TOKENS + 1_000],
    ]);
    expect(questions.map(({ body }) => body.messages[0]!.content.match(/in at most about ([\d,]+) words/)![1])).toEqual(["1,500", "150", "150"]);
    client.close();
  });

  it("asks a model that doesn't take a thinking level again without one", async () => {
    const { ada, general } = await setUp();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(({ body }) =>
      body.reasoning_effort === undefined ? chatAnswer("Without thinking.") : Response.json({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }, { status: 400 }),
    );
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} hello?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ plainText: "Without thinking." });
    expect(questions.map(({ body }) => body.reasoning_effort)).toEqual(["low", undefined]);
    expect(questions[1]!.body.max_completion_tokens).toBe(questions[0]!.body.max_completion_tokens);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${MODEL} again without a thinking level`));
    client.close();
  });

  it("asks a model at the level of thinking it took its test question at nearest the asker's, below it first, and one that took none at no level, in the room the asker's level gives", async () => {
    const { ada, general } = await setUp(RESPONSES_MODEL);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let refused = ["none", "medium"];
    const questions = internet(({ url, body }) =>
      body.reasoning !== undefined && refused.includes(body.reasoning.effort)
        ? Response.json({ error: { message: `Unsupported value: 'reasoning.effort' does not support '${body.reasoning.effort}' with this model.` } }, { status: 400 })
        : answerAt(url, "Here's the plan."),
    );
    await setUpAgain(ada, RESPONSES_MODEL);
    const client = await connect(general, ada);

    for (const thinking of ["off", "medium", "high"] as const) {
      await pickLevels(ada, { thinking });
      await post(client, `<p>${mention(EMBER)} plan the launch?</p>`);
      await nextAnswer(client);
    }
    // As a model can refuse each.
    refused = ["none", "low", "medium", "high"];
    await setUpAgain(ada, RESPONSES_MODEL);
    await post(client, `<p>${mention(EMBER)} and the party?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ plainText: "Here's the plan." });

    // Past the test question and its levels each time Ember AI was set up.
    const answers = [...questions.slice(5, 8), ...questions.slice(13)];
    expect(answers.map(({ body }) => [body.reasoning?.effort, body.max_output_tokens])).toEqual([
      ["low", UNTHINKING_TOKENS + 2_000],
      ["low", 16_000 + 2_000],
      ["high", 32_000 + 2_000],
      [undefined, 32_000 + 2_000],
    ]);
    expect(errors).not.toHaveBeenCalled();
    client.close();
  });

  it("asks a model that takes Anthropic's Messages to think adaptively at the asker's effort, Low at Off, and again without thinking when it won't", async () => {
    const { ada, general } = await setUp(MESSAGES_MODEL);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(({ url, body }) =>
      body.output_config?.effort === "high"
        ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "output_config.effort: high isn't available for this model" } }, { status: 400 })
        : answerAt(url, "Here's the plan."),
    );
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} plan the launch?</p>`);
    await nextAnswer(client);
    await pickLevels(ada, { thinking: "off", length: "short" });
    await post(client, `<p>${mention(EMBER)} quickly?</p>`);
    await nextAnswer(client);
    await pickLevels(ada, { thinking: "high" });
    await post(client, `<p>${mention(EMBER)} and the party?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ plainText: "Here's the plan." });

    expect(questions.map(({ body }) => [body.thinking, body.output_config, body.max_tokens])).toEqual([
      [{ type: "adaptive" }, { effort: "low" }, 4_000 + 2_000],
      // Anthropic's newest models don't turn thinking off, so Off asks them to think as little as they do.
      [{ type: "adaptive" }, { effort: "low" }, UNTHINKING_TOKENS + 1_000],
      [{ type: "adaptive" }, { effort: "high" }, 32_000 + 1_000],
      [undefined, undefined, 32_000 + 1_000],
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${MESSAGES_MODEL} again without a thinking level`));
    client.close();
  });

  it("asks a model that takes OpenAI's Responses to reason at the asker's effort, none at Off, and again without reasoning when it won't", async () => {
    const { ada, general } = await setUp(RESPONSES_MODEL);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(({ url, body }) =>
      body.reasoning?.effort === "none"
        ? Response.json({ error: { message: "Unsupported value: 'reasoning.effort' does not support 'none' with this model.", type: "invalid_request_error" } }, { status: 400 })
        : answerAt(url, "Here's the plan."),
    );
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} plan the launch?</p>`);
    await nextAnswer(client);
    await pickLevels(ada, { thinking: "off", length: "short" });
    await post(client, `<p>${mention(EMBER)} quickly?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ plainText: "Here's the plan." });
    await pickLevels(ada, { thinking: "high" });
    await post(client, `<p>${mention(EMBER)} and the party?</p>`);
    await nextAnswer(client);

    expect(questions.map(({ body }) => [body.reasoning, body.max_output_tokens])).toEqual([
      [{ effort: "low" }, 4_000 + 2_000],
      [{ effort: "none" }, UNTHINKING_TOKENS + 1_000],
      [undefined, UNTHINKING_TOKENS + 1_000],
      [{ effort: "high" }, 32_000 + 1_000],
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Asking ${RESPONSES_MODEL} again without a thinking level`));
    client.close();
  });

  it.each([
    ["Chat Completions", MODEL],
    ["Anthropic's Messages", MESSAGES_MODEL],
    ["OpenAI's Responses", RESPONSES_MODEL],
  ])("ends an answer cut short in %s with an ellipsis, and says so when it was cut short before it wrote anything", async (_, model) => {
    const { ada, general } = await setUp(model);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answers = ["The first three steps are", ""];
    internet(({ url }) => answerAt(url, answers.shift()!, true));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} all the steps?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ plainText: "The first three steps are\n\n…" });
    await post(client, `<p>${mention(EMBER)} and now?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ plainText: NOTES["out of room"] });
    client.close();
  });

  it("says why it can't answer when AI Gateway refuses, in a note, and logs Cloudflare's words", async () => {
    const { ada, general } = await setUp();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    internet(() => refusal(402, 2009, "Insufficient credits"));
    const client = await connect(general, ada);

    const question = await post(client, `<p>${mention(EMBER)} hello?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ creator: EMBER, plainText: NOTES.credits });
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Ember AI's model ${MODEL.replaceAll(".", "\\.")} didn't answer message ${question.id}: .*Insufficient credits`)));
    client.close();
  });

  it.each([
    [2016, "Prompt blocked due to security configurations", "guardrails"],
    [2017, "Response blocked due to security configurations", "guardrails answer"],
    [2029, "Request content blocked due to DLP policy violations", "dlp"],
    [2030, "Response content blocked due to DLP policy violations", "dlp answer"],
  ] as const)("says the gateway's Guardrails or Data Loss Prevention blocked it when AI Gateway answers %i, asking nothing again", async (code, said, reason) => {
    const { ada, general } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const questions = internet(() => refusal(424, code, said));
    const client = await connect(general, ada);

    await post(client, `<p>${mention(EMBER)} hello?</p>`);
    expect(await nextAnswer(client)).toMatchObject({ creator: EMBER, plainText: NOTES[reason] });
    expect(questions).toHaveLength(1);
    client.close();
  });

  it("posts nothing once Ember AI is turned off while the model answers, and stops typing", async () => {
    const { ada, general } = await setUp();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = waitingModel("Too late.");
    const client = await connect(general, ada);

    const question = await post(client, `<p>${mention(EMBER)} are you there?</p>`);
    await model.asked();
    await turnOff(ada);
    model.answer();
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(`Ember AI's answer to message ${question.id} failed:`, "it wasn't posted: Ember AI has been turned off, or @ember is no longer in the room"),
    );
    await settle(client);
    expect(client.log.filter((frame) => frame.type === "message.created" && frame.message.creator.id === ASSISTANT_ID)).toEqual([]);
    expect(client.log.filter((frame) => frame.type === "typing").at(-1)).toEqual({ type: "typing", user: EMBER, typing: false });
    client.close();
  });

  it("posts nothing once the question is deleted while the model answers", async () => {
    const { ada, general } = await setUp();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = waitingModel("Too late.");
    const client = await connect(general, ada);

    const question = await post(client, `<p>${mention(EMBER)} never mind</p>`);
    await model.asked();
    client.send({ type: "message.delete", messageId: question.id });
    await client.next("message.deleted");
    model.answer();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(`Ember AI's answer to message ${question.id} failed:`, "it wasn't posted: the message is gone"));
    await settle(client);
    expect(client.log.filter((frame) => frame.type === "message.created" && frame.message.creator.id === ASSISTANT_ID)).toEqual([]);
    client.close();
  });
});

/** A message as the room has it, from Ada unless `changes` say otherwise. */
function message(id: string, plainText: string, changes: Partial<Message> = {}): Message {
  const at = "2026-10-31T12:00:00.000Z";
  return { id, clientMessageId: id, roomId: "room", creator: { id: "ada", name: "Ada Lovelace" }, body: `<p>${plainText}</p>`, plainText, mentions: [], createdAt: at, updatedAt: at, editedAt: null, boosts: [], ...changes };
}

const ADA: User = { id: "ada", name: "Ada Lovelace" };
const IN_GENERAL = { community: "Fernwood", roomName: "general", inThread: false };
const NOW = new Date("2026-10-31T12:00:00Z");
/** @ember as it answers, without instructions administrators added. */
const ASSISTANT: Answerer = { ...EMBER, instructions: "", promptTemplate: null };
/** An agent as it answers. */
const SCOUT: Answerer = { id: "scout", name: "Scout", instructions: "Find what's current on the web, and say where it's from.", promptTemplate: null };

describe("What people wrote in what @ember read", () => {
  it("is the plain text of each message it read that one of them wrote, not its own answers, bots', or what's deleted", () => {
    const long = "x".repeat(MAX_CONVERSATION_LENGTH - 100);
    const conversation = [
      message("1", long),
      message("2", "https://example.com/build.png", { creator: { id: "bot", name: "Build Bot" } }),
      message("3", "https://example.com/made-up.png", { creator: EMBER }),
      message("4", "https://example.com/gone.png", { deleted: true }),
      message("5", "https://example.com/chart.png", { creator: { id: "grace", name: "Grace Hopper" } }),
      message("6", "@Ember show me"),
    ];
    const people = new Set(["ada", "grace"]);
    // In the room, the first is too long to read with the rest; in a thread, where it's the first message, the oldest replies are.
    expect(writtenBy(people, conversation, false)).toEqual(["https://example.com/chart.png", "@Ember show me"]);
    expect(writtenBy(people, conversation, true)).toEqual([long, "https://example.com/chart.png", "@Ember show me"]);
  });
});

describe("What @ember asks its model", () => {
  it("says who it is, where it's asked, by whom, and today's date, and labels the question with who asked", () => {
    const { instructions, maxTokens, thinking, askerId } = questionFor(ASSISTANT, [message("1", "Hi")], ADA, IN_GENERAL, DEFAULT_LEVELS, NOW);
    expect(instructions).toContain(`You are Ember, the AI assistant in the team chat "Fernwood".`);
    expect(instructions).toContain(`You're asked in the room "general".`);
    expect(instructions).toContain("Answer the last one, which Ada Lovelace wrote");
    expect(instructions).toContain("Today is Saturday, October 31, 2026, in UTC.");
    expect(instructions).toContain("in at most about 400 words.");
    expect([thinking, maxTokens]).toEqual(["low", 4_000 + 2_000]);
    expect(askerId).toBe("ada");
    expect(questionFor(ASSISTANT, [message("1", "Hi")], ADA, { ...IN_GENERAL, roomName: null }, DEFAULT_LEVELS, NOW).instructions).toContain("You're asked in a direct message.");
  });

  it("waits two minutes for an answer, or longer the more it may think and write, never as long as a pending request keeps a room in memory", () => {
    const waiting = (levels: typeof DEFAULT_LEVELS) => waitFor(questionFor(ASSISTANT, [message("1", "Hi")], ADA, IN_GENERAL, levels, NOW));
    expect(waiting(DEFAULT_LEVELS)).toBe(120_000);
    expect(waiting({ thinking: "off", length: "short" })).toBe(120_000);
    expect(waiting({ thinking: "medium", length: "medium" })).toBe(18_000 * 20);
    expect(waiting(TOP_LEVELS)).toBe(38_000 * 20);
    expect(waiting(TOP_LEVELS)).toBeLessThan(15 * 60_000);
  });

  it("reads each message after its writer's name, its own answers as its own, files by their names, and leaves out what's deleted or blank", () => {
    const conversation = [
      message("1", "Who's in?"),
      message("2", "Me", { creator: { id: "grace", name: "Grace Hopper" } }),
      message("3", "Ada and Grace are.", { creator: EMBER }),
      message("4", "plan.pdf", { body: "", attachment: { name: "plan.pdf" } as Message["attachment"] }),
      message("5", "", { deleted: true }),
      message("6", "  "),
      message("7", "@Ember thanks!"),
    ];
    expect(questionFor(ASSISTANT, conversation, ADA, IN_GENERAL, DEFAULT_LEVELS, NOW).turns).toEqual([
      { role: "user", text: "Ada Lovelace: Who's in?" },
      { role: "user", text: "Grace Hopper: Me" },
      { role: "assistant", text: "Ada and Grace are." },
      { role: "user", text: "Ada Lovelace: (shares a file, plan.pdf)" },
      { role: "user", text: "Ada Lovelace: @Ember thanks!" },
    ]);
  });

  it("follows who it is with the instructions administrators added, and labels the question with who answers", () => {
    const told = questionFor({ ...ASSISTANT, instructions: "Answer in British English." }, [message("1", "Hi")], ADA, IN_GENERAL, DEFAULT_LEVELS, NOW);
    expect(told.instructions).toContain(`You are Ember, the AI assistant in the team chat "Fernwood". People ask you things by mentioning @ember in a room or a thread, or by writing to you directly.\n\nAnswer in British English.\n\nWrite in Markdown.`);
    expect(told.instructions).toMatch(/\n\nYou're asked in the room "general"\. .* as a helpful teammate would: plainly, and in at most about 400 words\.$/);
    expect(told.agentId).toBe(ASSISTANT_ID);
    expect(questionFor(ASSISTANT, [message("1", "Hi")], ADA, IN_GENERAL, DEFAULT_LEVELS, NOW).instructions).toContain("directly.\n\nWrite in Markdown.");
  });

  it("reads the newest messages that fit, the question always, and a thread's first message first", () => {
    const long = "x".repeat(MAX_CONVERSATION_LENGTH / 4);
    const conversation = ["1", "2", "3", "4", "5"].map((id) => message(id, `${id}${long}`)).concat(message("6", "@Ember what now?"));
    const texts = (inThread: boolean) => questionFor(ASSISTANT, conversation, ADA, { ...IN_GENERAL, inThread }, DEFAULT_LEVELS, NOW).turns.map(({ text }) => text.slice(14, 15));
    expect(texts(false)).toEqual(["3", "4", "5", "@"]);
    expect(texts(true)).toEqual(["1", "4", "5", "@"]);
  });
});

describe("What an agent asks its model", () => {
  it("says it's the agent, then its instructions, and answers as they say, labeled with who asked and which agent answers", () => {
    const { instructions, askerId, agentId } = questionFor(SCOUT, [message("1", "Hi")], ADA, { ...IN_GENERAL, inThread: true }, { thinking: "off", length: "short" }, NOW);
    expect(instructions).toBe(
      [
        `You are Scout, an AI agent in the team chat "Fernwood". People ask you things by mentioning @Scout in a room or a thread, or by writing to you directly.`,
        SCOUT.instructions,
        "Write in Markdown. Links, bold, italics, lists, quotes, code blocks and tables show as they do in the chat, and a picture you show with ![what it shows](its address) appears under your answer when a person in the conversation wrote its address. Don't begin with your name.",
        CARDS_PROMPT,
        "You can't search the web or open links. When someone asks you to, say so, and that an administrator can turn on Search the web under AI assistant in community settings.",
        "Today is Saturday, October 31, 2026, in UTC.",
        `You're asked in a thread in the room "general". Its messages follow, oldest first, each after its writer's name. Answer the last one, which Ada Lovelace wrote, in at most about 150 words.`,
      ].join("\n\n"),
    );
    expect([askerId, agentId]).toEqual(["ada", "scout"]);
  });

  it("reads its own answers as its own, and @ember's and other agents' as anyone's", () => {
    const conversation = [
      message("1", "@Scout who won?"),
      message("2", "The Hawks did.", { creator: { id: "scout", name: "Scout" } }),
      message("3", "By two goals.", { creator: EMBER }),
      message("4", "In overtime.", { creator: { id: "recap", name: "Recap" } }),
      message("5", "@Scout when?"),
    ];
    expect(questionFor(SCOUT, conversation, ADA, IN_GENERAL, DEFAULT_LEVELS, NOW).turns).toEqual([
      { role: "user", text: "Ada Lovelace: @Scout who won?" },
      { role: "assistant", text: "The Hawks did." },
      { role: "user", text: "Ember: By two goals." },
      { role: "user", text: "Recap: In overtime." },
      { role: "user", text: "Ada Lovelace: @Scout when?" },
    ]);
  });

  it("isn't labeled with an agent that isn't saved yet, as one an administrator tries", () => {
    const told = questionFor({ ...SCOUT, id: null }, [message("1", "Hi")], ADA, { ...IN_GENERAL, roomName: null }, DEFAULT_LEVELS, NOW);
    expect(told.askerId).toBe("ada");
    expect(told).not.toHaveProperty("agentId");
    expect(told.instructions).toContain("You're asked in a direct message.");
  });
});

/** A Slack payload as an answer writes one for its cards, in a ```slack block, or a block of `info`'s. */
const slackBlock = (payload: unknown, info = "slack") => `\`\`\`${info}\n${JSON.stringify(payload, null, 2)}\n\`\`\``;

/** A status card's payload: a header, two fields, a chart and a button to a plan, with text for notifications. */
const STATUS = {
  text: "The launch is in beta",
  blocks: [
    { type: "header", text: { type: "plain_text", text: "Launch status" } },
    { type: "section", fields: [{ type: "mrkdwn", text: "*Stage:*\nBeta" }, { type: "mrkdwn", text: "*Owner:*\nAda" }] },
    { type: "image", image_url: "https://example.com/chart.png", alt_text: "Sign-ups" },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open the plan" }, url: "https://plans.example/launch", style: "primary" }] },
  ],
};

/** The card `STATUS` posts, with its chart only when someone wrote the chart's address. */
const statusCard = (chart: boolean) => ({
  source: "blocks",
  parts: [
    { kind: "header", text: "Launch status" },
    { kind: "section", fields: [{ html: "<p><strong>Stage:</strong><br>Beta</p>", short: true }, { html: "<p><strong>Owner:</strong><br>Ada</p>", short: true }] },
    ...(chart ? [{ kind: "image", image: { url: "https://example.com/chart.png", alt: "Sign-ups" } }] : []),
    { kind: "buttons", buttons: [{ text: "Open the plan", href: "https://plans.example/launch", style: "primary" }] },
  ],
});
const [STATUS_CARD, STATUS_WITH_CHART] = [statusCard(false), statusCard(true)];

describe("@ember's answer", () => {
  it("is the model's Markdown as rich text, without its name in front", () => {
    expect(answerOf("Ember: **Yes**, and _soon_.").markup).toBe("<p><strong>Yes</strong>, and <em>soon</em>.</p>");
    expect(answerOf("**Ember:** Done.").markup).toBe("<p>Done.</p>");
    expect(answerOf("Embers glow.").markup).toBe("<p>Embers glow.</p>");
    expect(answerOf("**Scout:** Found it.", [], [], [], "Scout").markup).toBe("<p>Found it.</p>");
    expect(answerOf("Ember: Not mine.", [], [], [], "Scout").markup).toBe("<p>Ember: Not mine.</p>");
    // A name is matched as it's written, whatever characters it has.
    expect(answerOf("c++ (beta): Done.", [], [], [], "C++ (Beta)").markup).toBe("<p>Done.</p>");
    expect(answerOf("C (Beta): Done.", [], [], [], "C++ (Beta)").markup).toBe("<p>C (Beta): Done.</p>");
  });

  it("shows the web pictures it shows in a card, and has its first web link for a preview, at addresses people wrote", () => {
    const written = ["The logo: https://example.com/a.png", "See https://example.com/x?a=1&b=2 or https://example.com/y"];
    const answer = answerOf("![A](https://example.com/a.png) ![B](data:image/png;base64,AAAA) [mail](mailto:a@example.com) <https://example.com/x?a=1&b=2> [y](https://example.com/y)", [], written);
    expect(answer.cards).toEqual([{ source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/a.png", alt: "A" } }] }]);
    expect(answer.firstLink).toBe("https://example.com/x?a=1&b=2");
    expect(answerOf("No links.")).toEqual({ markup: "<p>No links.</p>", cards: [], firstLink: null });
  });

  it("shows no picture, and has no link for a preview, at an address nobody wrote, nor a page it came from, which it links to all the same", () => {
    const text = "![Made up](https://evil.example/t.gif?d=bGF1bmNo) [made up](https://evil.example/r?d=bGF1bmNo) [the page](https://example.com/page) ![Found](https://example.com/found.png)";
    const answer = answerOf(text, [{ url: "https://example.com/found.png", title: "Found" }], ["Have a look at https://example.com/page"]);
    expect(answer.cards).toEqual([{ source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/found.png", alt: "Found" } }] }]);
    // Its first link nobody wrote, so its preview is of the next.
    expect(answer.firstLink).toBe("https://example.com/page");
    expect(answer.markup).toContain(`<a href="https://evil.example/t.gif?d=bGF1bmNo">Made up</a> <a href="https://evil.example/r?d=bGF1bmNo">made up</a>`);
    expect(answerOf(text)).toMatchObject({ cards: [], firstLink: null });
  });

  it("shows the cards of the Slack payloads it writes in ```slack blocks after the card of its pictures, leaving the blocks and the payloads' text out of its own", () => {
    const checks = { attachments: [{ color: "good", title: "Checks", text: "All *green*", mrkdwn_in: ["text"] }] };
    const text = `Here's where it stands:\n${slackBlock(STATUS)}\n![Logo](https://example.com/logo.png)\n\n${slackBlock(checks, "Slack json")}\nAsk me again tomorrow.`;
    const answer = answerOf(text, [], ["The logo is at https://example.com/logo.png, and the chart at https://example.com/chart.png"]);
    // A blank line where each block was keeps the text around it apart, as the line after the first would join its paragraph.
    expect(answer.markup).toBe(markdownHtml("Here's where it stands:\n\n![Logo](https://example.com/logo.png)\n\nAsk me again tomorrow."));
    expect(answer.cards).toEqual([
      { source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/logo.png", alt: "Logo" } }] },
      STATUS_WITH_CHART,
      { source: "attachment", color: "good", parts: [{ kind: "title", text: "Checks" }, { kind: "text", html: "<p>All <strong>green</strong></p>" }] },
    ]);
    expect(answerOf(slackBlock(STATUS))).toEqual({ markup: "", cards: [STATUS_CARD], firstLink: null });
  });

  it("shows the guide's example as the card the guide says it is, under its words, wherever they're written", () => {
    const [, example = ""] = /\n```slack\n([\s\S]*?)\n```$/.exec(CARDS_PROMPT) ?? [];
    const answer = answerOf(`The launch slipped.\n\n\`\`\`slack\n${example}\n\`\`\`\n\nAsk me again tomorrow.`);
    expect(answer.markup).toBe(markdownHtml("The launch slipped.\n\nAsk me again tomorrow."));
    const field = (title: string, value: string) => ({ html: `<p><strong>${title}</strong><br>${value}</p>`, short: true });
    expect(answer.cards).toEqual([
      {
        source: "attachment",
        color: "warning",
        parts: [
          { kind: "header", text: "Spring launch: at risk" },
          { kind: "section", html: "<p>Three of five tasks are done. The <strong>pricing page</strong> waits on legal review.</p>" },
          { kind: "section", fields: [field("Owner", "Web team"), field("Launch", "March 14"), field("Done", "3 of 5"), field("Waiting on", "Legal review")] },
          { kind: "context", items: [{ html: "<p>From the launch tracker, updated this morning</p>" }] },
        ],
      },
    ]);
  });

  it("shows each kind of block the guide teaches, as the guide writes them, and its markup as it says", () => {
    const plain = (text: string) => ({ type: "plain_text", text });
    const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
    const cell = (text: string) => ({ type: "raw_text", text });
    const button = (text: string, url: string, style?: string) => ({ type: "button", text: plain(text), url, ...(style && { style }) });
    const offsite = {
      blocks: [
        { type: "header", text: plain("Team offsite") },
        { type: "section", text: mrkdwn("*Two* fit _all_ of us, ~three~ `28`, on <https://maps.example/offsite|the map> :white_check_mark:\n• Lake\n• Trails"), accessory: button("Map", "https://maps.example/offsite") },
        { type: "section", fields: [mrkdwn("*Owner*\nDana"), mrkdwn("*Pick by*\nFriday")], accessory: { type: "image", image_url: "https://example.com/lodge.png", alt_text: "The lodge" } },
        { type: "context", elements: [mrkdwn("From <@U123|Priya>'s list, for <@U456>")] },
        { type: "divider" },
        { type: "image", image_url: "https://example.com/lake.png", alt_text: "The lake" },
        { type: "table", rows: [[cell("Venue"), cell("Per day")], [cell("Juniper Lodge, by the lake"), cell("$3,200")]], column_settings: [{ align: "left", is_wrapped: true }, { align: "right" }] },
        { type: "carousel", elements: [{ type: "card", title: plain("Juniper Lodge"), subtitle: plain("Up to 40"), body: mrkdwn("A lake and *trails*"), actions: [button("Visit", "https://juniperlodge.example")] }] },
        { type: "actions", elements: [button("Book it", "https://juniperlodge.example/book", "primary"), button("Call it off", "https://juniperlodge.example/cancel", "danger"), button("Ask", "https://juniperlodge.example/ask")] },
        { type: "markdown", text: "- Lake\n- **Trails**" },
      ],
    };
    const answer = answerOf(slackBlock(offsite), [], ["The lodge https://example.com/lodge.png and the lake https://example.com/lake.png"]);
    const html = (text: string) => `<p>${text}</p>`;
    expect(answer.cards).toEqual([
      {
        source: "blocks",
        parts: [
          { kind: "header", text: "Team offsite" },
          {
            kind: "section",
            html: html(`<strong>Two</strong> fit <em>all</em> of us, <s>three</s> <code>28</code>, on <a href="https://maps.example/offsite">the map</a> ✅<br>• Lake<br>• Trails`),
            button: { text: "Map", href: "https://maps.example/offsite" },
          },
          {
            kind: "section",
            fields: [{ html: html("<strong>Owner</strong><br>Dana"), short: true }, { html: html("<strong>Pick by</strong><br>Friday"), short: true }],
            thumb: { url: "https://example.com/lodge.png", alt: "The lodge" },
          },
          // A Slack mention shows as its text, which notifies nobody.
          { kind: "context", items: [{ html: html("From @Priya's list, for @U456") }] },
          { kind: "divider" },
          { kind: "image", image: { url: "https://example.com/lake.png", alt: "The lake" } },
          {
            kind: "table",
            rows: [
              [html("Venue"), html("Per day")],
              [html("Juniper Lodge, by the lake"), html("$3,200")],
            ],
            columns: [
              { align: "left", wrap: true },
              { align: "right", wrap: false },
            ],
          },
          {
            kind: "tiles",
            tiles: [{ title: "Juniper Lodge", subtitle: "Up to 40", body: html("A lake and <strong>trails</strong>"), buttons: [{ text: "Visit", href: "https://juniperlodge.example" }] }],
          },
          {
            kind: "buttons",
            buttons: [
              { text: "Book it", href: "https://juniperlodge.example/book", style: "primary" },
              { text: "Call it off", href: "https://juniperlodge.example/cancel", style: "danger" },
              { text: "Ask", href: "https://juniperlodge.example/ask" },
            ],
          },
          { kind: "text", html: "<ul><li>Lake</li><li><strong>Trails</strong></li></ul>" },
        ],
      },
    ]);
  });

  it("keeps the links and pictures its text names by reference when it takes a block out, wherever their definitions are", () => {
    const text = [
      "See [the guide][guide] and ![our logo][logo].",
      "[guide]: https://example.com/guide",
      slackBlock(STATUS),
      "[logo]: https://example.com/logo.png",
      // A label defined again keeps its first address, as it does without the block.
      "[guide]: https://elsewhere.example/guide",
    ].join("\n\n");
    const answer = answerOf(text, [], ["The guide is https://example.com/guide and the logo https://example.com/logo.png"]);
    expect(answer.markup).toBe(markdownHtml(text.replace(`${slackBlock(STATUS)}\n\n`, "")));
    expect(answer.markup).toContain(`<a href="https://example.com/guide">the guide</a>`);
    expect(answer.cards).toEqual([{ source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/logo.png", alt: "our logo" } }] }, STATUS_CARD]);
    expect(answer.firstLink).toBe("https://example.com/guide");
  });

  it("leaves a block as the code it's written as when its payload doesn't parse or posts no card the room keeps, or it's another language's, or in a list or a quote", () => {
    const blocks = [
      '```slack\n{ "blocks": [ }\n```',
      slackBlock(["not", "a", "payload"]),
      slackBlock({ text: "Only text, which goes where a card would show" }),
      slackBlock({ blocks: [{ type: "divider" }, { type: "actions", elements: [{ type: "static_select", action_id: "stage" }] }] }),
      slackBlock({ blocks: [{ type: "image", image_url: "https://made-up.example/t.gif?d=bGF1bmNo", alt_text: "" }] }),
      slackBlock(STATUS, "json"),
      slackBlock(STATUS, "slackware"),
      `- In a list:\n\n  ${slackBlock(STATUS).replace(/\n/g, "\n  ")}`,
      `> ${slackBlock(STATUS).replace(/\n/g, "\n> ")}`,
    ];
    for (const block of blocks) {
      const text = `Here:\n\n${block}`;
      expect([block, answerOf(text)]).toEqual([block, { markup: markdownHtml(text), cards: [], firstLink: null }]);
    }
  });

  it("shows a card's pictures only at addresses people wrote or of the pages it came from, but has its links go anywhere, as its Markdown's do", () => {
    expect(answerOf(slackBlock(STATUS)).cards).toEqual([STATUS_CARD]);
    expect(answerOf(slackBlock(STATUS), [{ url: "https://example.com/chart.png", title: "Sign-ups" }]).cards).toEqual([STATUS_WITH_CHART]);
    // An address people wrote, however the payload writes it.
    const chart = { blocks: [{ type: "image", image_url: "https://EXAMPLE.com/chart.png", alt_text: "Sign-ups" }] };
    expect(answerOf(slackBlock(chart), [], ["See https://example.com/chart.png"]).cards).toEqual([
      { source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/chart.png", alt: "Sign-ups" } }] },
    ]);
    const alert = { attachments: [{ title: "Error rate", title_link: "https://made-up.example/alerts?d=bGF1bmNo", thumb_url: "https://made-up.example/t.png?d=bGF1bmNo", text: "Up 7%" }] };
    expect(answerOf(slackBlock(alert)).cards).toEqual([
      { source: "attachment", parts: [{ kind: "title", text: "Error rate", href: "https://made-up.example/alerts?d=bGF1bmNo" }, { kind: "text", html: "<p>Up 7%</p>" }] },
    ]);
  });

  it("keeps as many of its cards as fit, each whole, beside as much of its text as fits, counting the cards' text as the room does", () => {
    const paragraph = `${"word ".repeat(199)}word`;
    const prose = Array.from({ length: 20 }, () => paragraph).join("\n\n");
    const notes = { blocks: [{ type: "section", text: { type: "mrkdwn", text: `Notes: ${"n".repeat(1_500)}` } }] };
    const cut = answerOf(`${prose}\n\n${slackBlock(notes)}`);
    expect(cut.cards).toEqual([{ source: "blocks", parts: [{ kind: "section", html: `<p>Notes: ${"n".repeat(1_500)}</p>` }] }]);
    const { plainText } = prepareBody(cut.markup, () => undefined)!;
    expect(plainText.endsWith(`${paragraph}\n\n…`)).toBe(true);
    expect(`${plainText}\n${keptCards(cut.cards).plainText}`.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    // Without the card, more of the text fits.
    expect(prepareBody(answerOf(prose).markup, () => undefined)!.plainText.length).toBeGreaterThan(plainText.length + 900);

    // When not all of them fit beside an ellipsis, the first that do, and the text whole if it fits beside them.
    const note = (n: number) => ({ blocks: [{ type: "section", text: { type: "mrkdwn", text: `Note ${n}: ${"x".repeat(4_000)}` } }] });
    const three = answerOf(["Three notes:", ...[1, 2, 3].map((n) => slackBlock(note(n))), "That's all."].join("\n\n"));
    expect(three.cards.map(({ parts }) => parts[0])).toEqual([1, 2].map((n) => ({ kind: "section", html: `<p>Note ${n}: ${"x".repeat(4_000)}</p>` })));
    expect(prepareBody(three.markup, () => undefined)!.plainText).toBe("Three notes:\n\nThat's all.");
  });

  /** Where the pictures in the card of the answer `text` makes go, and its link for a preview, when people wrote `written`. */
  const fetchedFor = (text: string, written: readonly string[], ownHosts: readonly string[] = []) => {
    const { cards, firstLink } = answerOf(text, [], written, ownHosts);
    return [...cards.flatMap(({ parts }) => parts.map((part) => (part.kind === "image" ? part.image.url : ""))), firstLink];
  };

  it("takes an address people wrote as their message links to it, however the answer writes it, but nothing added to it", () => {
    const written = ["Our site is https://example.com/, the forum www.example.com/forum, the logo https://example.com/logo.png and the shop https://shop.example/a&b"];
    const shown = (text: string) => fetchedFor(text, written);
    expect(shown("[It](https://example.com)")).toEqual(["https://example.com/"]);
    expect(shown("See www.example.com/forum")).toEqual(["http://www.example.com/forum"]);
    expect(shown("[The shop](https://shop.example/a&amp;b)")).toEqual(["https://shop.example/a&b"]);
    expect(shown("![Logo](https://example.com/logo.png) [It](https://example.com/logo.png?d=bGF1bmNo)")).toEqual(["https://example.com/logo.png", null]);
    expect(shown("![Logo](https://example.com/logo.png?d=bGF1bmNo) [It](https://other.example/logo.png)")).toEqual([null]);
  });

  it("takes only whole addresses, as the start of one people wrote can be another site's", () => {
    const written = ["Our logo is at https://example.com.au/logo.png, and the guide at https://docs.example.com/guide?page=2."];
    expect(fetchedFor("![Logo](https://example.com) [The guide](https://docs.example.com/guide)", written)).toEqual([null]);
    expect(fetchedFor("![Logo](https://example.com.au/logo) [The docs](https://docs.example.co)", written)).toEqual([null]);
    expect(fetchedFor("![Logo](https://example.com.au/logo.png) [The guide](https://docs.example.com/guide?page=2).", written)).toEqual([
      "https://example.com.au/logo.png",
      "https://docs.example.com/guide?page=2",
    ]);
  });

  it("has the first link people wrote that isn't to Ember's own pages for a preview", () => {
    const written = ["We're at https://ember.test/rooms/1 and http://localhost:8787/rooms/1, and the guide is at https://example.com/guide"];
    const text = "See [the room](https://ember.test/rooms/1), [here](http://localhost:8787/rooms/1) or [the guide](https://example.com/guide).";
    expect(fetchedFor(text, written, ["ember.test", "localhost:8787"])).toEqual(["https://example.com/guide"]);
    expect(fetchedFor(text, written)).toEqual(["https://ember.test/rooms/1"]);
  });

  it("is cut, a line at a time, to what a message holds", () => {
    const paragraph = `${"word ".repeat(199)}word`;
    const { markup } = answerOf(Array.from({ length: 20 }, () => paragraph).join("\n\n"));
    const body = prepareBody(markup, () => undefined)!;
    expect(body.plainText.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(body.plainText.endsWith(`${paragraph}\n\n…`)).toBe(true);
  });

  it("is measured as it shows, as a numbered list counts up, or a picture's address shows for each reference to it", () => {
    const pictures = `${Array(6).fill("![][flame]").join(" ")}\n\n[flame]: https://images.example.com/${"f".repeat(1_988)}.png`;
    for (const text of [STEPS, pictures]) {
      expect(text.length).toBeLessThan(MAX_MESSAGE_LENGTH);
      expect(prepareBody(markdownHtml(text), () => undefined)!.plainText.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
      const { plainText } = prepareBody(answerOf(text).markup, () => undefined)!;
      expect(plainText.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(plainText.endsWith("…")).toBe(true);
    }
  });

  it("is cut within its first line when even that is longer than a message", () => {
    const { markup } = answerOf(`${"word ".repeat(2_400)}word`);
    const { plainText } = prepareBody(markup, () => undefined)!;
    expect(plainText.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(plainText.length).toBeGreaterThan(MAX_MESSAGE_LENGTH - 10);
    expect(plainText).toMatch(/^word word .*\n\n…$/s);
  });

  it("has a preview below it as the composer writes one", () => {
    const attachment = previewAttachment({ url: "https://example.com/", title: `"Quotes" & <tags>`, description: "A page.", image: null });
    const body = prepareBody(`<p>See <a href="https://example.com/">it</a></p>${attachment}`, () => undefined)!;
    expect(body.html).toContain(`content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}"`);
    expect(body.html).toContain("Quotes");
    expect(body.html).toContain("A page.");
    // All of it is in the attachment, which has no plain text, the quotes in its title included.
    expect(body.plainText).toBe("See it");
  });
});

import { DEFAULT_LEVELS, TOP_LEVELS } from "@ember/protocol/assistant";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { administratorSession, cookieHeader, drawnPicture, editorField, expect, SAME_ORIGIN, shownPicture, signInAsAdministrator, test, useOwnAddress } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT } from "../../projects/workspace-settings";
import { ANTHROPIC_PATH, FOUND, GEMMA, HELLO, NEWER, RECALL_QUESTION, RECALLED, SOURCE, startFakeGateway, type FakeGateway } from "./fake-gateway";

// The AI assistant tab's Ember AI card and Set up Ember AI, @ember's page, with Add a model, and @ember
// answering, on the second test server, which asks models through the AI Gateway this spec fakes. Each test leaves the workspace as a new one is: Ember AI off, its dials
// where they start, with no model picked, nothing added to @ember's instructions, Ember's own around
// them, and @ember's avatar Ember's flame.

let gateway: FakeGateway;
test.beforeAll(async () => void (gateway = await startFakeGateway()));
test.afterAll(() => gateway.close());
test.afterEach(async ({ request }) => {
  const headers = await asAdministrator(request);
  // Ember keeps the dials, @ember's instructions, what Ember adds around them and the model someone picked
  // while Ember AI is off, so they go back first, the most and the instructions only while it's on.
  const unlimited = await request.patch("/api/account/assistant", { data: { ...TOP_LEVELS, instructions: "", promptTemplate: null }, headers });
  expect([200, 409], await unlimited.text()).toContain(unlimited.status());
  const unpicked = await request.patch("/api/users/me/assistant", { data: { ...DEFAULT_LEVELS, model: null }, headers });
  expect(unpicked.status(), await unpicked.text()).toBe(200);
  // @ember's avatar stays while Ember AI is off, and can be taken away only while it's on.
  const flame = await request.delete("/api/account/assistant/avatar", { headers });
  expect([200, 409], await flame.text()).toContain(flame.status());
  const forgotten = await request.delete("/api/account/assistant", { headers });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** Opens the AI assistant tab as the administrator, answering its Ember AI card. */
async function openAssistant(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#assistant-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Ember AI", exact: true });
}

/** Opens @ember's page as the administrator, answering its settings. */
async function openEmber(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/agents/ember/edit");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "@ember", exact: true });
}

/** @ember's row in the AI assistant tab's Agents card. */
const emberRow = (page: Page) => page.getByRole("region", { name: "Agents", exact: true }).getByRole("listitem").filter({ hasText: "Built in" });

/** How many of a room's latest messages @ember reads with a question asked there, the question among them (apps/worker/src/assistant/answers.ts). */
const ROOM_MESSAGES_READ = 20;

/** The model Ember suggests, which the tests set Ember AI up with, and what Anthropic's endpoint calls it. */
const HAIKU = { id: "anthropic/claude-haiku-5.5", there: "claude-haiku-5-5" };

/** The models the models file lists, by their makers, as the menu shows them, with what each costs: those Ember shipped with, and `NEWER`, which the file adds. */
const FILE_MODELS = [
  "Claude Fable 5.2 · $8 / $40",
  "Claude Opus 5.5 · $4 / $20",
  "Claude Sonnet 5.5 · $2 / $10",
  "Claude Haiku 5.5 · $0.10 / $0.50",
  "GPT-6 Astra · $10 / $50",
  "GPT-6.1 Sol · $2 / $10",
  "GPT-6.1 Terra · $1 / $5",
  "GPT-6 Luna · $0.10 / $0.50",
  `${NEWER.name} · $5 / $25`,
  "Grok 4.7 · $2 / $6",
];

/** The one of Workers AI's models the fake model search lists that takes tools, as the menu shows it. */
const GEMMA_OPTION = `${GEMMA.name} · $0.10 / $0.30`;

/** Where Cloudflare's REST API takes Chat Completions, as Ember asks Workers AI's models, for the account the fake AI Gateway knows. */
const CHAT_PATH = `/accounts/${AI_GATEWAY_ACCOUNT.accountId}/ai/v1/chat/completions`;

/** Sets Ember AI up with `model`, as Set up Ember AI does, through the account the fake AI Gateway knows. */
async function setUpAssistant(request: APIRequestContext, model = HAIKU.id) {
  const saved = await request.put("/api/account/assistant", { data: { ...AI_GATEWAY_ACCOUNT, model }, headers: await asAdministrator(request) });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Mentions @ember in general, as the administrator, and waits for its answer, which `gateway` then holds what it asked for. */
async function askEmber(page: Page, question: string) {
  await page.goto("/");
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "general" }).click();
  const composer = editorField(page, "Write a message");
  await composer.pressSequentially("@Embe");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Ember Agent"]);
  await composer.press("Tab");
  await composer.pressSequentially(`${question} ${crypto.randomUUID().slice(0, 8)}`);
  const answering = gateway.hold();
  await composer.press("Enter");
  await expect(page.locator(".spinner")).toHaveText("Ember");
  answering();
  await expect(page.locator(".spinner")).toHaveText("");
}

/** Chooses `level` on `dial`, a group of radio buttons, by its name, as someone clicks it. */
async function choose(dial: Locator, level: string) {
  await dial.getByText(level, { exact: true }).click();
  await expect(dial.getByRole("radio", { name: level })).toBeChecked();
}

test.describe("Ember AI", () => {
  test("the administrator gives Ember an account and API token, and a model that says hello through AI Gateway", async ({ page }) => {
    const card = await openAssistant(page);
    await expect(card).toContainText("Ember AI adds AI agents people can mention in the chat: @ember, and any you make for a task");
    await expect(page.getByRole("region", { name: "Agents", exact: true })).toBeHidden();
    await card.getByRole("switch", { name: "Ember AI" }).click();

    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up Ember AI");
    // It fills in the account the server was deployed to, as the deploy said, opening its pages in the dashboard.
    const accountId = setup.getByRole("textbox", { name: "Account ID" });
    await expect(accountId).toHaveValue(AI_GATEWAY_ACCOUNT.accountId);
    await expect(accountId).toHaveAccessibleDescription("Ember is deployed to this account. To ask through another, paste that account's ID.");
    await expect(setup.getByRole("link", { name: "Open Account API tokens in the Cloudflare dashboard" })).toHaveAttribute(
      "href",
      `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/api-tokens`,
    );
    await setup.getByRole("textbox", { name: "API token" }).fill("e2e-only-not-the-accounts-token");
    await setup.getByRole("button", { name: "Continue" }).click();
    await expect(setup).toHaveAccessibleName("Choose a model");
    // The models Ember offers, by their makers, with what each costs, starting at the one it suggests: those
    // the models file lists, one of them added after Ember shipped, but none of Workers AI's, as Cloudflare
    // didn't let the token list them.
    const menu = setup.getByRole("combobox", { name: "Model" });
    await expect(menu.getByRole("option")).toHaveText(FILE_MODELS);
    await expect(setup).toContainText(
      "Workers AI's models aren't listed, as Cloudflare didn't let the API token list them. Add the Workers AI Read permission to it in the Cloudflare dashboard.",
    );
    await expect(menu).toHaveValue(HAIKU.id);
    await setup.getByRole("button", { name: "Save" }).click();

    // AI Gateway's Anthropic endpoint refuses a token without AI Gateway Run, which comes back to its field.
    await expect(setup).toHaveAccessibleName("Set up Ember AI");
    await expect(setup.getByRole("alert")).toContainText("Add the AI Gateway Run permission to the token in the Cloudflare dashboard, then try again.");
    await setup.getByRole("textbox", { name: "API token" }).fill(AI_GATEWAY_ACCOUNT.apiToken);
    await setup.getByRole("button", { name: "Continue" }).click();
    // With the account's own token, Workers AI's models that take tools follow, which Cloudflare runs.
    await expect(menu.getByRole("option")).toHaveText([...FILE_MODELS, GEMMA_OPTION]);
    await expect(menu.locator("optgroup").last()).toHaveAttribute("label", "Workers AI");
    await expect(setup).not.toContainText("Workers AI's models aren't listed");
    await setup.getByRole("button", { name: "Save" }).click();
    await expect(setup).toHaveAccessibleName("Ember AI is set up");
    await expect(setup).toContainText(HELLO);
    // Through AI Gateway's Anthropic endpoint, which takes the API token in AI Gateway's own header.
    expect(gateway.asked.at(-1)).toMatchObject({
      path: ANTHROPIC_PATH,
      authorization: undefined,
      aigAuthorization: `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}`,
      body: { model: HAIKU.there, max_tokens: expect.any(Number) as unknown },
    });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(card).toContainText("Ember's agents answer through Cloudflare AI Gateway, each on the model you choose for it.");
    await expect(card.getByRole("switch", { name: "Ember AI" })).toBeChecked();
    // The Agents card lists @ember, on the model chosen, with a link to its page.
    await expect(emberRow(page)).toContainText("EmberBuilt inAnswers anything people ask.Claude Haiku 5.5 · Every room");
    await expect(emberRow(page).getByRole("link", { name: "Edit Ember" })).toHaveAttribute("href", "/account/agents/ember/edit");

    // Ember keeps it.
    await page.reload();
    await expect(emberRow(page)).toContainText("Claude Haiku 5.5 · Every room");
  });

  test("the administrator changes the model, keeping the API token, which Ember asks through its provider's endpoint", async ({ page, request }) => {
    await setUpAssistant(request, "openai/gpt-6.1-sol");
    const card = await openAssistant(page);
    await expect(emberRow(page)).toContainText("GPT-6.1 Sol · Every room");
    await card.getByRole("button", { name: "Change" }).click();

    const setup = page.getByRole("dialog");
    await expect(setup.getByRole("textbox", { name: "Account ID" })).toHaveValue(AI_GATEWAY_ACCOUNT.accountId);
    await expect(setup.getByRole("textbox", { name: "API token" })).toHaveValue("");
    await setup.getByRole("button", { name: "Continue" }).click();
    await setup.getByRole("combobox", { name: "Model" }).selectOption("anthropic/claude-sonnet-5.5");
    await setup.getByRole("button", { name: "Save" }).click();
    await expect(setup).toHaveAccessibleName("Ember AI is set up");
    // Through AI Gateway's Anthropic endpoint, which takes the API token in AI Gateway's own header.
    expect(gateway.asked.at(-1)).toMatchObject({
      path: ANTHROPIC_PATH,
      authorization: undefined,
      aigAuthorization: `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}`,
      body: { model: "claude-sonnet-5-5", max_tokens: expect.any(Number) as unknown },
    });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(emberRow(page)).toContainText("Claude Sonnet 5.5 · Every room");
  });

  test("the administrator chooses one of Workers AI's models, which Cloudflare runs, and Ember asks it through Cloudflare's REST API", async ({ page, request }) => {
    await setUpAssistant(request);
    const card = await openAssistant(page);
    await card.getByRole("button", { name: "Change" }).click();

    const setup = page.getByRole("dialog");
    await setup.getByRole("button", { name: "Continue" }).click();
    const menu = setup.getByRole("combobox", { name: "Model" });
    await menu.selectOption(GEMMA.id);
    await expect(menu).toHaveAccessibleDescription(
      "Cloudflare runs this model on Workers AI, free for the account's first 10,000 Neurons each day, and beyond that on Workers Paid, at $0.10 for each million tokens it reads, and $0.30 for each million it writes. AI Gateway's credits pay for its searches of the web, and for the model too once the default gateway's Workers AI Billing is Unified billing. Open Workers AI in the Cloudflare dashboard",
    );
    await expect(setup.getByRole("link", { name: "Open Workers AI in the Cloudflare dashboard" })).toHaveAttribute(
      "href",
      `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/ai/workers-ai`,
    );
    await setup.getByRole("button", { name: "Save" }).click();
    await expect(setup).toHaveAccessibleName("Ember AI is set up");
    await expect(setup).toContainText(HELLO);
    // Through Cloudflare's REST API, which takes the API token as Cloudflare's API does, and the default gateway.
    expect(gateway.asked.at(-1)).toMatchObject({
      path: CHAT_PATH,
      authorization: `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}`,
      gateway: "default",
      body: { model: GEMMA.id },
    });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(emberRow(page)).toContainText(`${GEMMA.name} · Every room`);
  });

  test("the administrator lets @ember search the web on one of Workers AI's models, with Ember's own tool on Cloudflare's Web Search API", async ({ page, request }) => {
    await setUpAssistant(request, GEMMA.id);
    const card = await openEmber(page);
    const webSearch = card.getByRole("switch", { name: "Search the web" });
    await webSearch.click();
    await expect(card.getByRole("status")).toHaveText(`It searched the web and said: ${FOUND}`);
    await expect(webSearch).toBeChecked();
    // The model called Ember's tool, which searched through the default gateway, and was told what it found.
    const searched = gateway.asked.findLast(({ path }) => path === `/accounts/${AI_GATEWAY_ACCOUNT.accountId}/ai/websearch/`);
    expect(searched).toMatchObject({
      authorization: `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}`,
      body: { query: "Cloudflare AI Gateway", limit: 5, options: { gateway: { id: "default" } } },
    });
    const told = gateway.asked.findLast(({ path, body }) => path === CHAT_PATH && Array.isArray(body.tools))!;
    expect(told).toMatchObject({ body: { model: GEMMA.id, tools: [{ type: "function", function: { name: "web_search" } }] } });
    expect((told.body.messages as Array<{ role: string; content: string }>).at(-1)).toEqual(
      expect.objectContaining({ role: "tool", content: expect.stringContaining(SOURCE.url) as unknown }),
    );

    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(emberRow(page)).toContainText(`${GEMMA.name} · Searches the web · Every room`);
  });

  test("the administrator lets @ember search the web once its model has searched for a test question", async ({ page, request }) => {
    await setUpAssistant(request, "anthropic/claude-sonnet-5.5");
    const card = await openEmber(page);
    const webSearch = card.getByRole("switch", { name: "Search the web" });
    await expect(webSearch).not.toBeChecked();
    await expect(webSearch).toHaveAccessibleDescription(/^@ember answers from what its model learned in training\./);

    const searching = gateway.hold();
    await webSearch.click();
    await expect(card.getByRole("status")).toHaveText("Asking Claude Sonnet 5.5 something it has to search the web for…");
    await expect(webSearch).toBeDisabled();
    searching();
    await expect(card.getByRole("status")).toHaveText(`It searched the web and said: ${FOUND}`);
    await expect(webSearch).toBeChecked();
    await expect(webSearch).toHaveAccessibleDescription(/^@ember searches the web when a question needs it, at most 5 times an answer, and reads the pages/);
    expect(gateway.asked.at(-1)).toMatchObject({
      path: ANTHROPIC_PATH,
      body: { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 }] },
    });

    // Ember keeps it, which the Agents card says.
    await page.reload();
    await expect(page.getByRole("region", { name: "@ember", exact: true }).getByRole("switch", { name: "Search the web" })).toBeChecked();
    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(emberRow(page)).toContainText("Claude Sonnet 5.5 · Searches the web · Every room");
  });

  test("the administrator lets people pick another model, which someone picks on their profile, and @ember answers them with it", async ({ page, request }) => {
    await setUpAssistant(request);
    const card = await openEmber(page);
    const models = card.getByRole("group", { name: "Models" });
    await expect(models.getByRole("radio")).toHaveCount(1);
    await card.getByRole("button", { name: "Add a model" }).click();

    // It offers the models Ember offers that people can't pick yet, asking the one chosen a test question.
    const adding = page.getByRole("dialog");
    await expect(adding).toHaveAccessibleName("Add a model");
    const menu = adding.getByRole("combobox", { name: "Model" });
    await expect(menu.getByRole("option")).toHaveText([...FILE_MODELS.filter((model) => !model.startsWith("Claude Haiku 5.5")), GEMMA_OPTION]);
    await menu.selectOption("anthropic/claude-sonnet-5.5");
    await adding.getByRole("button", { name: "Add" }).click();
    await expect(adding).toHaveAccessibleName("Model added");
    await expect(adding).toContainText(HELLO);
    expect(gateway.asked.at(-1)).toMatchObject({ path: ANTHROPIC_PATH, body: { model: "claude-sonnet-5-5" } });
    await adding.getByRole("button", { name: "Done" }).click();
    await expect(adding).toBeHidden();
    await expect(models.getByRole("radio", { name: "Claude Haiku 5.5" })).toBeChecked();
    await expect(models.getByRole("radio", { name: "Claude Sonnet 5.5" })).not.toBeChecked();
    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(emberRow(page)).toContainText("Claude Haiku 5.5, or the model each person picks · Every room");

    // On their profile, they pick it, which Ember keeps.
    await page.goto("/users/me/profile");
    const yours = page.getByRole("region", { name: "Ember AI", exact: true }).getByRole("combobox", { name: "Model" });
    await expect(yours.getByRole("option")).toHaveText(["Default (Claude Haiku 5.5)", "Claude Haiku 5.5", "Claude Sonnet 5.5"]);
    await expect(yours).toHaveValue("");
    await yours.selectOption("anthropic/claude-sonnet-5.5");
    await expect(yours).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "Ember AI", exact: true }).getByRole("combobox", { name: "Model" })).toHaveValue("anthropic/claude-sonnet-5.5");

    await askEmber(page, "Which model are you?");
    expect(gateway.asked.at(-1)).toMatchObject({ path: ANTHROPIC_PATH, body: { model: "claude-sonnet-5-5" } });
  });

  test("the administrator uploads a picture as @ember's avatar, which an open room shows at once, and brings back Ember's flame", async ({ page, request }) => {
    await setUpAssistant(request);
    const card = await openEmber(page);
    const avatar = card.getByRole("img", { name: "@ember's avatar" });
    const useTheFlame = card.getByRole("button", { name: "Use Ember's flame" });
    await expect(card).toContainText("Choose a picture of your own in place of Ember's flame.");
    await expect(useTheFlame).toHaveCount(0);
    expect(await shownPicture(avatar)).toMatchObject({ type: expect.stringMatching(/^image\/svg\+xml/) });
    const flame = (await avatar.getAttribute("src"))!;
    // @ember's answer in general, open in another tab.
    const room = await page.context().newPage();
    await askEmber(room, "Who's this?");
    const answersAvatar = room.getByRole("article").last().locator('img[src^="/users/ember."]');
    await expect(answersAvatar).toHaveAttribute("src", flame);

    await card.getByLabel("Upload @ember's avatar").setInputFiles(await drawnPicture(page, "robot.png", 640, 640));
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(useTheFlame).toBeVisible();
    await expect(avatar).not.toHaveAttribute("src", flame);
    const uploaded = (await avatar.getAttribute("src"))!;
    // The variant the administrator's browser made of it, 512×512.
    expect(await shownPicture(avatar)).toEqual({ type: "image/webp", width: 512, height: 512 });
    // The room shows it without loading again.
    await expect(answersAvatar).toHaveAttribute("src", uploaded);
    expect(await shownPicture(answersAvatar)).toEqual({ type: "image/webp", width: 512, height: 512 });

    // Straight away, which can be the same second, and the address is new all the same.
    await useTheFlame.click();
    await expect(useTheFlame).toHaveCount(0);
    await expect(avatar).not.toHaveAttribute("src", uploaded);
    expect(await shownPicture(avatar)).toMatchObject({ type: expect.stringMatching(/^image\/svg\+xml/) });
    await expect(answersAvatar).toHaveAttribute("src", (await avatar.getAttribute("src"))!);
    expect(await shownPicture(answersAvatar)).toMatchObject({ type: expect.stringMatching(/^image\/svg\+xml/) });
    await room.close();
  });

  test("the administrator adds to @ember's instructions on its page, seeing what Ember adds around them, and @ember follows them", async ({ page, request }) => {
    await setUpAssistant(request);
    const card = await openEmber(page);
    await expect(page).toHaveTitle("Edit agent");
    const instructions = card.getByRole("textbox", { name: "Instructions" });
    const save = card.getByRole("button", { name: "Save instructions" });
    await expect(instructions).toHaveValue("");
    await expect(save).toBeDisabled();
    await card.getByText("What Ember adds around them").click();
    await expect(card.locator("details")).toContainText('You are Ember, the AI assistant in the team chat');
    await expect(card.locator("details")).toContainText("Answer the last one, which Ada Lovelace wrote, as a helpful teammate would");

    await instructions.fill("Answer in British English.");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(save).toBeDisabled();
    // Ember keeps them.
    await page.reload();
    await expect(page.getByRole("region", { name: "@ember", exact: true }).getByRole("textbox", { name: "Instructions" })).toHaveValue("Answer in British English.");

    // Between who @ember is and how the chat shows its answer.
    await askEmber(page, "Colour or color?");
    expect(gateway.asked.at(-1)!.body.system).toMatch(/^You are Ember, [^\n]+\n\nAnswer in British English\.\n\nWrite in Markdown\.[\s\S]+\n\nYou're asked in the room "general"\./);
  });

  test("the administrator modifies what Ember adds around @ember's instructions, with caution, which @ember follows once it's saved", async ({ page, request }) => {
    await setUpAssistant(request);
    const card = await openEmber(page);
    await card.getByText("What Ember adds around them").click();
    const caution = card.getByRole("region", { name: "Modify with caution" });
    await expect(caution).toContainText("Every answer @ember gives starts from these words.");
    await caution.getByRole("button", { name: "Modify" }).click();
    const template = card.getByRole("textbox", { name: "What Ember adds around them" });
    await expect(template).toBeFocused();
    const scribe = "You are {{name}}, the scribe of {{community}}.\n\n{{instructions}}\n\nYou're asked in {{where}}. Answer {{asker}} in at most {{words}} words.";
    await template.fill(scribe);
    await expect(card.locator("details")).toContainText("You are Ember, the scribe of");
    await caution.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(caution.getByRole("button", { name: "Save" })).toBeDisabled();
    // Ember keeps it.
    await page.reload();
    const kept = page.getByRole("region", { name: "@ember", exact: true });
    await expect(kept.getByText("Modified", { exact: true })).toBeVisible();
    await kept.getByText("What Ember adds around them").click();
    await expect(kept.getByRole("textbox", { name: "What Ember adds around them" })).toHaveValue(scribe);

    // Without instructions added, nor the space they'd take.
    await askEmber(page, "Colour or color?");
    expect(gateway.asked.at(-1)!.body.system).toMatch(/^You are Ember, the scribe of [^\n]+\.\n\nYou're asked in the room "general"\. Answer Ada Lovelace in at most [\d,]+ words\.$/);
  });

  test("the administrator turns Ember AI off, once they're sure", async ({ page, request }) => {
    await setUpAssistant(request);
    const card = await openAssistant(page);
    const assistantSwitch = card.getByRole("switch", { name: "Ember AI" });
    await expect(assistantSwitch).toBeChecked();
    page.once("dialog", (dialog) => void dialog.accept());
    await assistantSwitch.click();
    await expect(assistantSwitch).not.toBeChecked();
    await expect(card).toContainText("Ember AI adds AI agents");
    await expect(page.getByRole("region", { name: "Agents", exact: true })).toBeHidden();

    // Turned off, Ember forgot the API token, so setting it up again needs one.
    await assistantSwitch.click();
    const setup = page.getByRole("dialog");
    await expect(setup.getByRole("textbox", { name: "Account ID" })).toHaveValue(AI_GATEWAY_ACCOUNT.accountId);
    await expect(setup.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

test.describe("@ember", () => {
  test("someone mentions @ember in a room, sees it typing, and reads its answer there", async ({ page, request }) => {
    await setUpAssistant(request);
    await useOwnAddress(page);
    await page.goto("/");
    await signInAsAdministrator(page);
    await page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "general" }).click();

    const question = `What's our logo? ${crypto.randomUUID().slice(0, 8)}`;
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially("@Embe");
    // The prompt badges it as an agent, as its messages do.
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Ember Agent"]);
    await composer.press("Tab");
    await expect(page.getByRole("listbox")).toBeHidden();
    await composer.pressSequentially(question);
    const answering = gateway.hold();
    await composer.press("Enter");
    // A mention shows as its avatar, then its name.
    await expect(page.getByRole("article").filter({ hasText: question })).toContainText(`Ember ${question}`);

    // It's typing while its model answers, and its answer is a message of its own.
    await expect(page.locator(".spinner")).toHaveText("Ember");
    answering();
    // The room's last message, as an earlier test's answer in general says the same.
    const answer = page.getByRole("article").last();
    await expect(answer).toContainText(HELLO);
    await expect(answer.getByRole("heading", { level: 3 })).toHaveText(/^Ember Agent/);
    await expect(page.locator(".spinner")).toHaveText("");
    const { system, messages } = gateway.asked.at(-1)!.body as { system: string; messages: Array<{ role: string; content: string }> };
    expect(system).toContain(`You're asked in the room "general".`);
    expect(messages.at(-1)).toEqual({ role: "user", content: `Ada Lovelace: @Ember ${question}` });
  });

  test("someone asks @ember something it searches the web for, and reads the pages its answer came from under it", async ({ page, request }) => {
    await setUpAssistant(request, "anthropic/claude-sonnet-5.5");
    const searching = await request.put("/api/account/assistant/web_search", { data: { on: true }, headers: await asAdministrator(request) });
    expect(searching.status(), await searching.text()).toBe(200);
    await useOwnAddress(page);
    await page.goto("/");
    await signInAsAdministrator(page);
    await page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "general" }).click();

    const composer = editorField(page, "Write a message");
    await composer.pressSequentially("@Embe");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Ember Agent"]);
    await composer.press("Tab");
    await composer.pressSequentially(`What's AI Gateway? ${crypto.randomUUID().slice(0, 8)}`);
    await composer.press("Enter");

    // Its answer is what it said once it had searched, then the page it cites, linked.
    const answer = page.getByRole("article").filter({ hasText: FOUND });
    await expect(answer).toContainText(`${FOUND}Sources: ${SOURCE.title}`);
    await expect(answer).not.toContainText("I'll look that up.");
    await expect(answer.getByRole("link", { name: SOURCE.title })).toHaveAttribute("href", SOURCE.url);
    expect(gateway.asked.at(-1)!.body.system).toEqual(expect.stringContaining("You can search the web"));
  });

  test("someone asks @ember about something written in the room before, which it searches the room for, and answers with what it found", async ({ page, request }) => {
    await setUpAssistant(request);
    // In a room of the test's own, which everyone is in: the messages it writes would move general's first ones off its page.
    const headers = await asAdministrator(request);
    const created = await request.post("/api/rooms", { data: { kind: "open", name: `Offsite ${crypto.randomUUID().slice(0, 8)}` }, headers });
    expect(created.status(), await created.text()).toBe(201);
    const { room } = (await created.json()) as { room: { id: string; name: string } };
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);

    const word = `lisbon${crypto.randomUUID().slice(0, 8)}`;
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially(`The offsite is in ${word}`);
    await composer.press("Enter");
    await expect(page.getByRole("article").filter({ hasText: word })).toBeVisible();
    // The search index takes a message a moment after its room does.
    await expect.poll(async () => ((await (await request.get(`/api/searches?q=${word}`, { headers })).json()) as { matches: unknown[] }).matches.length).toBe(1);
    // The room moves on until that's no longer among the messages @ember reads with a question, which its search leaves out.
    for (let n = 1; n < ROOM_MESSAGES_READ; n++) {
      await composer.pressSequentially(`Onwards ${n}`);
      await composer.press("Enter");
    }
    await expect(page.getByRole("article").filter({ hasText: `Onwards ${ROOM_MESSAGES_READ - 1}` })).toBeVisible();

    await composer.pressSequentially("@Embe");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Ember Agent"]);
    await composer.press("Tab");
    await composer.pressSequentially(`${RECALL_QUESTION} ${word}`);
    await composer.press("Enter");

    // Its answer is what its model said once Ember had run the search it called for.
    const answer = page.getByRole("article").filter({ hasText: RECALLED });
    await expect(answer).toContainText(`Ada Lovelace: The offsite is in ${word}`);
    await expect(answer).not.toContainText("I'll look.");
    await expect(answer.getByRole("heading", { level: 3 })).toHaveText(/^Ember Agent/);
    // Its model was asked twice: with the tool, and again with its call and what the search found.
    const [called, answered] = gateway.asked.slice(-2).map(({ body }) => body as { tools: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> });
    expect(called!.tools.map(({ name }) => name)).toEqual(["search_messages"]);
    expect(answered!.messages.slice(called!.messages.length)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "I'll look." }, { type: "tool_use", id: "toolu_e2e", name: "search_messages", input: { words: word } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e", content: expect.stringContaining(`Ada Lovelace: The offsite is in ${word}`) }] },
    ]);
  });

  test("someone picks how much @ember thinks and writes for them on their profile, up to the most the administrator allows, and it asks its model so", async ({
    page,
    request,
  }) => {
    await setUpAssistant(request);

    // The administrator lets @ember think no more than Medium for anyone, which Ember keeps.
    const card = await openEmber(page);
    const mostThinking = card.getByRole("group", { name: "Thinking" });
    await expect(mostThinking.getByRole("radio", { name: "High" })).toBeChecked();
    await choose(mostThinking, "Medium");
    await expect(mostThinking.getByRole("radio", { name: "Medium" })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "@ember", exact: true }).getByRole("group", { name: "Thinking" }).getByRole("radio", { name: "Medium" })).toBeChecked();

    // On their profile, their own levels start at Low and a Medium answer, and go no higher than that.
    await page.goto("/users/me/profile");
    const levels = page.getByRole("region", { name: "Ember AI", exact: true });
    const thinking = levels.getByRole("group", { name: "Thinking" });
    const length = levels.getByRole("group", { name: "Answer length" });
    await expect(thinking.getByRole("radio", { name: "Low" })).toBeChecked();
    await expect(length.getByRole("radio", { name: "Medium" })).toBeChecked();
    await expect(thinking.getByRole("radio", { name: "High" })).toBeDisabled();
    await choose(thinking, "Medium");
    await choose(length, "Short");
    await expect(length).toHaveAccessibleDescription("About 150 words.");
    await expect(length.getByRole("radio", { name: "Short" })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "Ember AI", exact: true }).getByRole("group", { name: "Thinking" }).getByRole("radio", { name: "Medium" })).toBeChecked();

    await askEmber(page, "How long is a fortnight?");
    const { body } = gateway.asked.at(-1)!;
    expect(body).toMatchObject({ model: HAIKU.there, thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    expect(body.system).toEqual(expect.stringContaining("in at most about 150 words."));
  });
});

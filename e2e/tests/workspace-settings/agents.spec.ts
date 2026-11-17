import type { Directory, WorkspaceSettings } from "@ember/protocol";
import type { AgentAnswer, Agents, NewAgent } from "@ember/protocol/agents";
import { CARDS_PROMPT } from "@ember/protocol/prompts";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { administratorSession, cookieHeader, editorField, expect, newAddress, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT } from "../../projects/workspace-settings";
import { ANTHROPIC_PATH, CARD_HEADER, CARD_LINK, CARD_QUESTION, CARDED, CHAT_COMPLETIONS_PATH, HELLO, startFakeGateway, type FakeGateway } from "./fake-gateway";

// The AI assistant tab's Agents card, New agent and an agent's page, with Try it, an agent answering a
// mention, its badge and profile, the agents kept for administrators, and the sidebar's Available
// Agents, on the second test server, through the AI Gateway this spec fakes.
// Each test starts with Ember AI on Claude Sonnet 5.5, and leaves the workspace as a new one is: no
// agents, and Ember AI off.

const SONNET = "anthropic/claude-sonnet-5.5";
/** xAI's Grok, which Ember asks through Cloudflare's REST API, and through AI Gateway's xAI endpoint to search the web. */
const GROK = "xai/grok-4.7";

let gateway: FakeGateway;
test.beforeAll(async () => void (gateway = await startFakeGateway()));
test.afterAll(() => gateway.close());
test.beforeEach(async ({ request }) => {
  const saved = await request.put("/api/account/assistant", { data: { ...AI_GATEWAY_ACCOUNT, model: SONNET }, headers: await asAdministrator(request) });
  expect(saved.status(), await saved.text()).toBe(200);
});
test.afterEach(async ({ request }) => {
  const headers = await asAdministrator(request);
  // Agents are deleted while Ember AI is on, which keeps them while it's off.
  const listed = await request.get("/api/account/agents", { headers });
  expect(listed.status(), await listed.text()).toBe(200);
  for (const { id } of ((await listed.json()) as Agents).agents) {
    const deleted = await request.delete(`/api/account/agents/${id}`, { headers });
    expect(deleted.status(), await deleted.text()).toBe(204);
  }
  const forgotten = await request.delete("/api/account/assistant", { headers });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** Makes the agent called `name` through the API, as New agent would, on Claude Sonnet 5.5, or `model`, off the web, in every open room. */
async function makeAgent(request: APIRequestContext, name: string, model = SONNET) {
  const agent: NewAgent = {
    name,
    description: "Sums up threads into decisions and to-dos.",
    instructions: "Sum up the conversation so far as decisions and to-dos.",
    model,
    thinking: "low",
    length: "medium",
    webSearch: false,
    rooms: null,
  };
  const made = await request.post("/api/account/agents", { data: agent, headers: await asAdministrator(request) });
  expect(made.status(), await made.text()).toBe(201);
  return ((await made.json()) as AgentAnswer).agent;
}

/** Opens the AI assistant tab as the administrator, answering its Agents card. */
async function openAgents(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#assistant-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Agents", exact: true });
}

/** The names `card` lists, @ember first. */
const namesIn = (card: Locator) => card.getByRole("listitem").locator("strong");

/** The row of the agent called `name` in `card`. */
const rowOf = (card: Locator, name: string) => card.getByRole("listitem").filter({ has: card.page().locator("strong").getByText(name, { exact: true }) });

/** The sidebar's Available Agents row on `page`, and the list it opens. */
const availableAgents = (page: Page) => ({
  row: page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: /^Available Agents/ }),
  list: page.getByRole("dialog", { name: "Available Agents" }),
});

test.describe("Agents", () => {
  test("the administrator makes an agent on New agent, trying it first, and it answers a mention in a room", async ({ page }) => {
    const card = await openAgents(page);
    await expect(namesIn(card)).toHaveText(["Ember"]);
    await card.getByRole("link", { name: "New agent" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New agent" })).toBeVisible();
    await expect(page).toHaveTitle("New agent");
    await page.getByRole("textbox", { name: "Name" }).fill("Recap");
    await page.getByRole("textbox", { name: "What it does" }).fill("Sums up threads into decisions and to-dos.");
    await page.getByRole("textbox", { name: "Instructions" }).fill("Sum up the conversation so far as decisions and to-dos.");
    // It starts on @ember's model.
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue(SONNET);

    // Try it asks the agent as the page sets it up, before it's saved.
    const tryIt = page.getByRole("region", { name: "Try it" });
    await tryIt.getByRole("textbox", { name: "Question" }).fill("What did we decide?");
    const trying = gateway.hold();
    await tryIt.getByRole("button", { name: "Ask" }).click();
    await expect(tryIt.getByRole("status")).toHaveText("Asking Claude Sonnet 5.5 your question…");
    trying();
    await expect(tryIt).toContainText(HELLO);
    await expect(tryIt).toContainText(/Answered in [\d.]+ seconds\./);
    const tried = gateway.asked.at(-1)!;
    expect(tried).toMatchObject({ path: ANTHROPIC_PATH, body: { model: "claude-sonnet-5-5" } });
    expect(tried.body.system).toMatch(/^You are Recap, an AI agent in the team chat "[^"]+"\. [^\n]+\n\nSum up the conversation so far as decisions and to-dos\.\n\nWrite in Markdown\.[\s\S]+\n\nYou're asked in a direct message\./);

    // Making it asks its model a test question, then goes back to the tab, which lists it.
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(namesIn(card)).toHaveText(["Ember", "Recap"]);
    await expect(rowOf(card, "Recap")).toContainText("Sums up threads into decisions and to-dos.Claude Sonnet 5.5 · Every room");

    // It's in every open room, where someone mentions it.
    await page.goto("/");
    await page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "general" }).click();
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially("@Reca");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([/^Recap/]);
    await composer.press("Tab");
    const question = `What did we decide? ${crypto.randomUUID().slice(0, 8)}`;
    await composer.pressSequentially(question);
    const answering = gateway.hold();
    await composer.press("Enter");
    await expect(page.locator(".spinner")).toHaveText("Recap");
    answering();
    const answer = page.getByRole("article").last();
    await expect(answer).toContainText(HELLO);
    await expect(answer.getByRole("heading", { level: 3 })).toHaveText(/^Recap/);
    const asked = gateway.asked.at(-1)!;
    expect(asked.body.system).toMatch(/^You are Recap, [\s\S]+You're asked in the room "general"\./);
    expect((asked.body.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: "user", content: `Ada Lovelace: @Recap ${question}` });
  });

  test("the administrator changes an agent on its page, which Ember keeps, then deletes it, once they're sure", async ({ page, request }) => {
    const scout = await makeAgent(request, "Scout");
    const card = await openAgents(page);
    await card.getByRole("link", { name: "Edit Scout" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Edit Scout" })).toBeVisible();
    await expect(page).toHaveTitle("Edit agent");
    const description = page.getByRole("textbox", { name: "What it does" });
    await expect(description).toHaveValue(scout.description);
    await expect(page.getByText(/^Ada Lovelace last changed Scout on /)).toBeVisible();

    await description.fill("Looks up what's new on the web.");
    const webSearch = page.getByRole("switch", { name: "Search the web" });
    await webSearch.click();
    await expect(webSearch).toHaveAccessibleDescription(/^Scout searches the web when a question needs it, at most 5 times an answer/);
    await page.getByRole("radio", { name: "Only the rooms I choose" }).click();
    await page.getByRole("checkbox", { name: "general" }).check();
    // Saving asks its model something it has to search the web for.
    const searching = gateway.hold();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Asking Claude Sonnet 5.5 something it has to search the web for…")).toBeVisible();
    searching();
    await expect(rowOf(card, "Scout")).toContainText("Looks up what's new on the web.Claude Sonnet 5.5 · Searches the web · general");
    expect(gateway.asked.at(-1)).toMatchObject({
      path: ANTHROPIC_PATH,
      body: { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 }] },
    });

    // Ember keeps it.
    await card.getByRole("link", { name: "Edit Scout" }).click();
    await expect(page).toHaveURL(new RegExp(`/account/agents/${scout.id}/edit$`));
    await page.reload();
    await expect(page.getByRole("textbox", { name: "What it does" })).toHaveValue("Looks up what's new on the web.");
    await expect(page.getByRole("switch", { name: "Search the web" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "general" })).toBeChecked();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete Scout" }).click();
    await expect(namesIn(card)).toHaveText(["Ember"]);
    // Its page is gone.
    const gone = await page.goto(`/account/agents/${scout.id}/edit`);
    expect(gone!.status()).toBe(404);
  });

  test("an agent on Grok searches the web with Ember's own tool, once the administrator turns Search the web on", async ({ page, request }) => {
    await makeAgent(request, "Scout", GROK);
    // Its test question went to Cloudflare's REST API, in Chat Completions, as AI Gateway's credits pay for Grok there.
    const throughRest = { path: CHAT_COMPLETIONS_PATH, authorization: `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}` };
    expect(gateway.asked.at(-1)).toMatchObject({ ...throughRest, body: { model: GROK } });
    const card = await openAgents(page);
    await card.getByRole("link", { name: "Edit Scout" }).click();

    const webSearch = page.getByRole("switch", { name: "Search the web" });
    await webSearch.click();
    // Ember's own tool only searches, so it doesn't read pages of its own.
    await expect(webSearch).toHaveAccessibleDescription(
      "Scout searches the web when a question needs it, at most 5 times an answer, and lists the pages it used under its answer. AI Gateway's credits pay for each search.",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(rowOf(card, "Scout")).toContainText("Grok 4.7 · Searches the web");
    // It's still asked there, given Ember's tool, which Ember runs with Cloudflare's Web Search API through the same gateway.
    const searched = gateway.asked.filter(({ body }) => "tools" in body).at(-1);
    expect(searched).toMatchObject({ ...throughRest, body: { model: GROK, tools: [{ type: "function", function: { name: "web_search" } }] } });
    expect(gateway.asked.findLast(({ path }) => path === `/accounts/${AI_GATEWAY_ACCOUNT.accountId}/ai/websearch/`)).toMatchObject({
      ...throughRest,
      path: `/accounts/${AI_GATEWAY_ACCOUNT.accountId}/ai/websearch/`,
      body: { options: { gateway: { id: "default" } } },
    });
    expect(gateway.asked.some(({ path }) => path.includes("/grok/"))).toBe(false);
  });

  test("the administrator modifies what Ember adds around an agent's instructions, with caution, which Ember keeps until Use Ember's own puts its own back", async ({ page, request }) => {
    const scout = await makeAgent(request, "Scout");
    const card = await openAgents(page);
    await card.getByRole("link", { name: "Edit Scout" }).click();
    await page.getByText("What Ember adds around them").click();
    const caution = page.getByRole("region", { name: "Modify with caution" });
    await expect(caution).toContainText("Every answer Scout gives starts from these words.");
    await caution.getByRole("button", { name: "Modify" }).click();
    const template = page.getByRole("textbox", { name: "What Ember adds around them" });
    await expect(template).toBeFocused();
    await expect(template).toHaveValue(/^You are \{\{name\}\}, an AI agent in the team chat "\{\{community\}\}"\./);
    await template.fill("You are {{name}}, the scout of {{community}}.\n\n{{instructions}}\n\nAnswer {{asker}} in {{where}}.");
    await expect(page.locator("details")).toContainText("You are Scout, the scout of");

    // Try it asks with it before it's saved.
    const tryIt = page.getByRole("region", { name: "Try it" });
    await tryIt.getByRole("textbox", { name: "Question" }).fill("What did we decide?");
    await tryIt.getByRole("button", { name: "Ask" }).click();
    await expect(tryIt).toContainText(HELLO);
    expect(gateway.asked.at(-1)!.body.system).toMatch(/^You are Scout, the scout of [^\n]+\.\n\nSum up the conversation so far as decisions and to-dos\.\n\nAnswer "Ada Lovelace" in a direct message\.$/);

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(rowOf(card, "Scout")).toBeVisible();
    // Ember keeps it.
    await page.goto(`/account/agents/${scout.id}/edit`);
    await expect(page.getByText("Modified", { exact: true })).toBeVisible();
    await page.getByText("What Ember adds around them").click();
    await expect(template).toHaveValue("You are {{name}}, the scout of {{community}}.\n\n{{instructions}}\n\nAnswer {{asker}} in {{where}}.");

    await page.getByRole("button", { name: "Use Ember's own" }).click();
    await expect(page.getByText("Modified", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(rowOf(card, "Scout")).toBeVisible();
    await page.goto(`/account/agents/${scout.id}/edit`);
    await page.getByText("What Ember adds around them").click();
    await expect(page.getByRole("region", { name: "Modify with caution" }).getByRole("button", { name: "Modify" })).toBeVisible();
    await expect(page.getByText("Modified", { exact: true })).toBeHidden();
  });

  test("an agent shows a card under its answer, from the Slack payload it writes, in Try it and in a DM with it", async ({ page, request }) => {
    const recap = await makeAgent(request, "Recap");
    const card = await openAgents(page);
    await card.getByRole("link", { name: "Edit Recap" }).click();
    const tryIt = page.getByRole("region", { name: "Try it" });
    await tryIt.getByRole("textbox", { name: "Question" }).fill(CARD_QUESTION);
    await tryIt.getByRole("button", { name: "Ask" }).click();
    await expect(tryIt).toContainText(CARDED);
    await expect(tryIt.getByRole("article", { name: CARD_HEADER }).getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", CARD_LINK);
    // Its model is told how to write one.
    expect(gateway.asked.at(-1)!.body.system).toContain(CARDS_PROMPT);

    await page.goto(`/users/${recap.id}`);
    await page.getByRole("button", { name: "Ping Recap" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Direct message with Recap");
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially(CARD_QUESTION);
    await composer.press("Enter");
    const status = page.getByRole("article", { name: CARD_HEADER });
    const answer = page.getByRole("article").filter({ has: status });
    await expect(answer).toContainText(CARDED);
    await expect(answer.getByRole("heading", { level: 3 })).toHaveText(/^Recap Agent/);
    await expect(status).toContainText("Stage:Beta");
    await expect(status.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", CARD_LINK);
    // Its payload shows as the card, not as code.
    await expect(answer.locator("pre")).toHaveCount(0);
  });

  test("an agent's name has the Agent badge in the mention prompt and on its answers, and its profile says what it does and runs on", async ({ page, request }) => {
    const recap = await makeAgent(request, "Recap");
    await useOwnAddress(page);
    await page.goto("/");
    await signInAsAdministrator(page);
    await page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "general" }).click();
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially("@Reca");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([/^Recap\s*Agent$/]);
    await composer.press("Tab");
    await composer.pressSequentially(`What did we decide? ${crypto.randomUUID().slice(0, 8)}`);
    const answering = gateway.hold();
    await composer.press("Enter");
    await expect(page.locator(".spinner")).toHaveText("Recap");
    answering();
    const answer = page.getByRole("article").last();
    await expect(answer).toContainText(HELLO);
    await expect(answer.getByRole("heading", { level: 3 })).toHaveText(/^Recap Agent/);

    await page.goto(`/users/${recap.id}`);
    const profile = page.getByRole("main");
    await expect(profile.getByRole("heading", { level: 1 })).toHaveText("Recap");
    await expect(profile.getByText("Agent", { exact: true })).toBeVisible();
    await expect(profile.getByText(recap.description)).toBeVisible();
    await expect(profile.getByText(/^An AI agent running on /)).toHaveText(
      "An AI agent running on Claude Sonnet 5.5 through Cloudflare AI Gateway, which sends the conversation you ask it in to Anthropic. You set it up.",
    );
    await expect(profile.getByRole("button", { name: "Ping Recap" })).toBeVisible();
    // Its instructions are for administrators, on its settings page.
    await expect(profile).not.toContainText("Sum up the conversation so far");
  });

  test("the administrator keeps an agent for administrators, then to their own DMs, and Available Agents lists each person the agents they can ask", async ({ page, request, browser, baseURL }) => {
    await makeAgent(request, "Recap");
    const herald = await makeAgent(request, "Herald");
    const card = await openAgents(page);

    // Admins only, on its page, leaves it in its rooms.
    await card.getByRole("link", { name: "Edit Herald" }).click();
    const adminsOnly = page.getByRole("switch", { name: "Admins only" });
    await adminsOnly.click();
    await expect(adminsOnly).toHaveAccessibleDescription("Only administrators can ask Herald. Everyone else sees its answers in its rooms, but it doesn't answer them.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(rowOf(card, "Herald")).toContainText("Claude Sonnet 5.5 · Admins only · Every room");

    // Grace, who joins Ember with the join link, is listed the agents anyone can ask.
    const headers = await asAdministrator(request);
    const { joinCode } = (await (await request.get("/api/account", { headers })).json()) as WorkspaceSettings;
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    try {
      const asGrace = { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN };
      const joined = await context.request.post(`/api/join/${joinCode}`, {
        data: { name: `Grace ${crypto.randomUUID().slice(0, 8)}`, emailAddress: `${crypto.randomUUID()}@example.com`, password: "compiler error" },
        headers: asGrace,
      });
      expect(joined.status(), await joined.text()).toBe(201);
      const grace = await context.newPage();
      await useOwnAddress(grace);
      await grace.goto("/");
      const hers = availableAgents(grace);
      await expect(hers.row).toHaveAccessibleName("Available Agents, 2 to ask");
      await hers.row.click();
      await expect(hers.list.getByRole("tab")).toHaveText(["Ember", "Recap"]);
      await hers.list.getByRole("tab", { name: "Recap" }).click();
      await expect(hers.list.getByRole("tabpanel")).toContainText("Sums up threads into decisions and to-dos.");
      await expect(hers.list.getByRole("tabpanel")).toContainText("Type @Recap in a room it's in, or message it directly.");
      await expect(hers.list.getByRole("region", { name: "Available in" })).toHaveText(/Every room$/);
      await grace.keyboard.press("Escape");
      await expect(hers.row).toBeFocused();
      // Herald's page says who can ask it, in place of the button that starts a DM with it.
      await grace.goto(`/users/${herald.id}`);
      await expect(grace.getByRole("main")).toContainText("Only administrators can ask Herald.");
      await expect(grace.getByRole("button", { name: "Ping Herald" })).toHaveCount(0);

      // The administrator is listed it too, marked, with a link to its page.
      await page.goto("/");
      const theirs = availableAgents(page);
      await expect(theirs.row).toHaveAccessibleName("Available Agents, 3 to ask");
      await theirs.row.click();
      await expect(theirs.list.getByRole("tab")).toHaveText(["Ember", "Herald", "Recap"]);
      await theirs.list.getByRole("tab", { name: "Herald" }).click();
      await expect(theirs.list.getByRole("tabpanel").getByRole("heading", { level: 3 })).toHaveText("Herald");
      await expect(theirs.list.getByRole("tabpanel")).toContainText("Admins only");
      await theirs.list.getByRole("link", { name: "Edit" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Edit Herald" })).toBeVisible();
      await expect(theirs.list).toBeHidden();

      // Only available in admin DMs takes it out of every room, and holds Admins only on.
      await page.getByRole("switch", { name: "Only available in admin DMs" }).click();
      await expect(page.getByRole("switch", { name: "Admins only" })).toBeDisabled();
      await expect(page.getByRole("switch", { name: "Admins only" })).toBeChecked();
      for (const rooms of ["Every room", "Only the rooms I choose"]) {
        await expect(page.getByRole("radio", { name: rooms })).toBeDisabled();
        await expect(page.getByRole("radio", { name: rooms })).not.toBeChecked();
      }
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(rowOf(card, "Herald")).toContainText("Claude Sonnet 5.5 · Admin DMs only");

      // Nobody else can see it: Grace's people directory no longer lists it, and its page is gone for her.
      const directory = (await (await context.request.get("/api/users", { headers: asGrace })).json()) as Directory;
      expect(directory.users.map(({ name }) => name)).not.toContain("Herald");
      expect((await context.request.get(`/api/users/${herald.id}`, { headers: asGrace })).status()).toBe(404);
      await grace.goto("/");
      await expect(hers.row).toHaveAccessibleName("Available Agents, 2 to ask");

      // The administrator messages it from the list, and it answers there.
      await page.goto("/");
      await theirs.row.click();
      await theirs.list.getByRole("tab", { name: "Herald" }).click();
      await expect(theirs.list.getByRole("tabpanel")).toContainText("Admin DMs only");
      await expect(theirs.list.getByRole("tabpanel")).toContainText("Message it directly. It isn't in any room, and only administrators can see it.");
      await expect(theirs.list.getByRole("region", { name: "Available in" })).toHaveText(/Direct messages only$/);
      await theirs.list.getByRole("button", { name: "Message Herald" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Direct message with Herald");
      await expect(theirs.list).toBeHidden();
      const composer = editorField(page, "Write a message");
      await expect(composer).toBeFocused();
      await composer.pressSequentially(`What's new? ${crypto.randomUUID().slice(0, 8)}`);
      await composer.press("Enter");
      const answer = page.getByRole("article").last();
      await expect(answer).toContainText(HELLO);
      await expect(answer.getByRole("heading", { level: 3 })).toHaveText(/^Herald Agent/);
    } finally {
      await context.close();
    }
  });
});

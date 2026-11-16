import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { ASSISTANT_ID, PROFILE_PATH, type WorkspaceSettings } from "@ember/protocol";
import { TOOL_GONE, type AgentTools, type AppAnswer, type Apps } from "@ember/protocol/apps";
import { administratorSession, cookieHeader, editorField, expect, newAddress, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT } from "../../projects/workspace-settings";
import { FILE_QUESTION, FILED, startFakeGateway, type FakeGateway } from "./fake-gateway";
import { ALLOW_HEADING, asksFor, calledWith, MCP_TOKEN, SERVER_NAME, startFakeMcp, TOOLS, type FakeMcp } from "./fake-mcp";

// The Apps card on the AI assistant tab, Connect an app, a connected app's page, the Tools card on
// @ember's page, and @ember calling a picked tool once it's allowed, or at once where an administrator
// always allows it, the card a tool answers with, whose buttons call its tools, and the Apps section of
// someone's profile, where they sign in to an app themselves, on the second test
// server, with an MCP server this spec fakes on this machine. Each test leaves the workspace as a new one is: no apps,
// and Ember AI off.

const SONNET = "anthropic/claude-sonnet-5.5";

let gateway: FakeGateway;
let mcp: FakeMcp;
test.beforeAll(async () => void ([gateway, mcp] = await Promise.all([startFakeGateway(), startFakeMcp()])));
test.afterAll(() => Promise.all([gateway.close(), mcp.close()]));
test.beforeEach(async ({ request }) => {
  const saved = await request.put("/api/account/assistant", { data: { ...AI_GATEWAY_ACCOUNT, model: SONNET }, headers: await asAdministrator(request) });
  expect(saved.status(), await saved.text()).toBe(200);
});
test.afterEach(async ({ request }) => {
  const headers = await asAdministrator(request);
  // Apps are removed while Ember AI is on, which keeps them while it's off.
  const listed = await request.get("/api/account/apps", { headers });
  expect(listed.status(), await listed.text()).toBe(200);
  for (const { id } of ((await listed.json()) as Apps).apps) {
    const removed = await request.delete(`/api/account/apps/${id}`, { headers });
    // An app Ember was signed in to answers whether its service took the sign-in back.
    expect([200, 204], await removed.text()).toContain(removed.status());
  }
  const forgotten = await request.delete("/api/account/assistant", { headers });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** Opens the AI assistant tab as the administrator, answering its Apps card. */
async function openApps(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#assistant-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Apps", exact: true });
}

/** Fills in Connect an app, which the Apps card `card` links to, for an app at `url`, and sends it. */
async function connectAt(page: Page, card: Locator, url: string): Promise<void> {
  await card.getByRole("link", { name: "Connect an app" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Tracker");
  await page.getByRole("textbox", { name: "Server address" }).fill(url);
  await page.getByRole("button", { name: "Connect" }).click();
}

/** Asks @ember `question` in the room the page shows. */
async function askEmber(page: Page, question: string): Promise<void> {
  const composer = editorField(page, "Write a message");
  await composer.pressSequentially("@Embe");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Ember Agent"]);
  await composer.press("Tab");
  await composer.pressSequentially(question);
  await composer.press("Enter");
}

test.describe("Apps", () => {
  test("the administrator connects an app by its MCP server's address and token, reads its tools again, and removes it", async ({ page }) => {
    const card = await openApps(page);
    await expect(card).toContainText("No apps are connected yet.");
    await card.getByRole("link", { name: "Connect an app" }).click();
    await expect(page).toHaveURL(/\/account\/apps\/new$/);
    await expect(page).toHaveTitle("Connect an app");

    // Without its token, the server asks for a sign-in, which the token's field says.
    const host = new URL(mcp.url).host;
    await page.getByRole("textbox", { name: "Name" }).fill("Tracker");
    await page.getByRole("textbox", { name: "Server address" }).fill(mcp.url);
    await page.getByRole("button", { name: "Connect" }).click();
    const token = page.getByLabel("Token", { exact: true });
    await expect(token).toHaveAccessibleDescription(`${host} asks for a sign-in. Sign in to it, or give a token for it, if it has one.`);
    await expect(page).toHaveURL(/\/account\/apps\/new$/);
    // This server describes no sign-in, which the offer to sign in finds.
    await page.getByRole("button", { name: `Sign in to ${host}` }).click();
    await expect(token).toHaveAccessibleDescription(`${host} doesn't say how to sign in to it. Give a token for it, if it has one.`);
    await expect(page.getByRole("button", { name: /^Sign in/ })).toHaveCount(0);

    // With it, Ember reads the server's tools and goes to the app's page, which lists them.
    await token.fill(MCP_TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page).toHaveURL(/\/account\/apps\/[^/]+\/edit$/);
    await expect(page.getByRole("alert")).toHaveText("Tracker is connected. Ember read 2 tools from it.");
    await expect(page).toHaveTitle("Edit app");
    const tools = page.getByRole("region", { name: /^Tools/ });
    await expect(tools.getByRole("heading", { name: "Tools (2)" })).toBeVisible();
    await expect(tools).toContainText(`Its server calls itself ${SERVER_NAME}`);
    await expect(tools).toContainText("Connected by Ada Lovelace");
    await expect(tools.getByRole("listitem")).toHaveText([/^search_issuesSearch issuesFinds issues by their words\.$/, /^create_issueOpens an issue in a project\.$/]);
    // The page never shows the token again.
    await expect(token).toHaveValue("");
    await expect(token).toHaveAccessibleDescription("It has a token. Leave this blank to keep it, or type another.");
    expect(mcp.asked.filter((method) => method === "tools/list")).toHaveLength(1);

    // The server gains a tool, which Read its tools again finds.
    mcp.tools.push({ name: "close_issue", description: "Closes an issue.", inputSchema: { type: "object" } });
    await tools.getByRole("button", { name: "Read its tools again" }).click();
    await expect(tools.getByRole("heading", { name: "Tools (3)" })).toBeVisible();
    await expect(tools.getByRole("listitem").last()).toHaveText("close_issueCloses an issue.");

    // A reload shows the app's page, and the tab lists it.
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Tracker");
    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(card.getByRole("listitem")).toHaveText([`Tracker${host}/mcp · 3 toolsEdit Tracker`]);

    // Removing it asks first, then takes it off the tab.
    await card.getByRole("link", { name: "Edit Tracker" }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Remove Tracker" }).click();
    await expect(card).toContainText("No apps are connected yet.");
    await expect(card.getByRole("listitem")).toHaveCount(0);
  });

  test("the administrator connects an app whose server signs people in by signing in there, and signs in again once that has ended", async ({ page }) => {
    const signsIn = await startFakeMcp({ signsIn: true });
    try {
      const signIn = signsIn.signIn!;
      const host = new URL(signsIn.url).host;
      const card = await openApps(page);

      // The server asks for a sign-in, which Ember finds and sends the browser to. Denying it there changes nothing.
      await connectAt(page, card, signsIn.url);
      await page.getByRole("button", { name: `Sign in to ${host}` }).click();
      await expect(page.getByRole("heading", { name: ALLOW_HEADING })).toBeVisible();
      await page.getByRole("link", { name: "Deny" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "The app isn't signed in to" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText("The sign-in was turned down there, so nothing has changed.");
      await expect(page).toHaveURL(/\/account\/apps\/signed-in$/);
      await page.getByRole("link", { name: "Back to the apps" }).click();
      await expect(card).toContainText("No apps are connected yet.");

      // Allowing it comes back to Ember, which finishes the sign-in, reads the server's tools and connects the app.
      await connectAt(page, card, signsIn.url);
      await page.getByRole("button", { name: `Sign in to ${host}` }).click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page).toHaveURL(/\/account\/apps\/[^/]+\/edit$/);
      await expect(page.getByRole("alert")).toHaveText("Tracker is connected. Ember read 2 tools from it.");
      expect(signIn.exchanged).toBe(1);
      const kept = page.getByRole("group", { name: "Sign-in" });
      await expect(kept).toContainText("Signed in by Ada Lovelace");
      await expect(kept).not.toContainText("has ended");
      await expect(page.getByLabel("Token", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Server address" })).toHaveAttribute("readonly");
      const tools = page.getByRole("region", { name: /^Tools/ });
      await expect(tools.getByRole("heading", { name: "Tools (2)" })).toBeVisible();

      // Its access tokens are short-lived, so Ember gets itself another to read the tools again.
      signsIn.tools.push({ name: "close_issue", description: "Closes an issue.", inputSchema: { type: "object" } });
      await tools.getByRole("button", { name: "Read its tools again" }).click();
      await expect(tools.getByRole("heading", { name: "Tools (3)" })).toBeVisible();
      expect(signIn.refreshed).toBe(1);

      // Once the sign-in is ended at the service, Ember finds so, and says so on the app's page and its row.
      signIn.end();
      await tools.getByRole("button", { name: "Read its tools again" }).click();
      await expect(tools.getByRole("status")).toHaveText("Ember's sign-in to Tracker has ended. An administrator has to sign in to it again, on its page.");
      await page.reload();
      await expect(kept.getByRole("alert")).toContainText("Its sign-in has ended");
      await page.getByRole("link", { name: "Go Back" }).click();
      await expect(card.getByRole("listitem")).toContainText("Its sign-in has ended");

      // Signing in again keeps the app, which its server answers again.
      await card.getByRole("link", { name: "Edit Tracker" }).click();
      await kept.getByRole("button", { name: "Sign in again" }).click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page).toHaveURL(/\/account\/apps\/[^/]+\/edit$/);
      await expect(page.getByRole("alert")).toHaveText("Ember is signed in to Tracker again.");
      await expect(kept).not.toContainText("has ended");
      await expect(tools.getByRole("heading", { name: "Tools (3)" })).toBeVisible();
      await page.getByRole("link", { name: "Go Back" }).click();
      await expect(card.getByRole("listitem")).toHaveText([`Tracker${host}/mcp · 3 toolsEdit Tracker`]);
    } finally {
      await signsIn.close();
    }
  });

  test("the administrator connects an app whose service wants Ember registered there, by giving the client ID and secret it got, which signing in again keeps", async ({ page, baseURL }) => {
    const client = { id: "ember-at-tracker", secret: "e2e-client-secret" };
    const signsIn = await startFakeMcp({ signsIn: true, client });
    try {
      const signIn = signsIn.signIn!;
      const host = new URL(signsIn.url).host;
      const card = await openApps(page);
      const signInButton = page.getByRole("button", { name: `Sign in to ${host}` });
      const clientId = page.getByRole("textbox", { name: "Client ID" });
      const clientSecret = page.getByLabel("Client secret", { exact: true });

      // Its sign-in doesn't let Ember register itself, so the form asks who Ember is there, with the address to register it with.
      await connectAt(page, card, signsIn.url);
      await signInButton.click();
      await expect(page.getByLabel("Token", { exact: true })).toHaveAccessibleDescription(
        `${host} has a sign-in, but doesn't let Ember register itself for it. Register Ember there yourself and give its client ID, or give a token, if it has one.`,
      );
      await expect(page.getByRole("textbox", { name: "Redirect address" })).toHaveValue(`${baseURL}/account/apps/signed-in`);

      // A secret the service doesn't know is refused once the browser is back, which the page says.
      await clientId.fill(client.id);
      await clientSecret.fill("not-its-secret");
      await signInButton.click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page.getByRole("alert")).toHaveText(`${host} didn't take the client ID or secret Ember signed in with. Check both, and start the sign-in again.`);
      await page.getByRole("link", { name: "Back to the apps" }).click();
      await expect(card).toContainText("No apps are connected yet.");

      // With the client ID and secret it got, Ember signs in as that client and connects the app, whose page shows the ID alone.
      await connectAt(page, card, signsIn.url);
      await signInButton.click();
      await clientId.fill(client.id);
      await clientSecret.fill(client.secret);
      await signInButton.click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page.getByRole("alert")).toHaveText("Tracker is connected. Ember read 2 tools from it.");
      expect(signIn.exchanged).toBe(1);
      const kept = page.getByRole("group", { name: "Sign-in" });
      await expect(kept.getByRole("textbox", { name: "Client ID" })).toHaveValue(client.id);
      await expect(kept.getByLabel("Client secret", { exact: true })).toHaveValue("");
      await expect(kept.getByLabel("Client secret", { exact: true })).toHaveAttribute("placeholder", "Unchanged");

      // It gets itself another token as that client, and signing in again, once the sign-in has ended, asks for neither again.
      const tools = page.getByRole("region", { name: /^Tools/ });
      await tools.getByRole("button", { name: "Read its tools again" }).click();
      await expect.poll(() => signIn.refreshed).toBe(1);
      signIn.end();
      await tools.getByRole("button", { name: "Read its tools again" }).click();
      await expect(tools.getByRole("status")).toHaveText("Ember's sign-in to Tracker has ended. An administrator has to sign in to it again, on its page.");
      await kept.getByRole("button", { name: "Sign in again" }).click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page.getByRole("alert")).toHaveText("Ember is signed in to Tracker again.");
      expect(signIn.exchanged).toBe(2);
      await expect(kept.getByRole("textbox", { name: "Client ID" })).toHaveValue(client.id);
    } finally {
      await signsIn.close();
    }
  });

  test("a call an app's server refuses as more than Ember's sign-in allows has the administrator sign in again for it, and removing the app takes the sign-in back there", async ({ page, request }) => {
    const signsIn = await startFakeMcp({ signsIn: true });
    try {
      const signIn = signsIn.signIn!;
      const host = new URL(signsIn.url).host;
      const card = await openApps(page);
      await connectAt(page, card, signsIn.url);
      await page.getByRole("button", { name: `Sign in to ${host}` }).click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page.getByRole("alert")).toHaveText("Tracker is connected. Ember read 2 tools from it.");
      const headers = await asAdministrator(request);
      const offered = (await (await request.get("/api/account/agents/ember/tools", { headers })).json()) as AgentTools;
      const tools = offered.apps.flatMap(({ id, tools }) => tools.filter(({ name }) => name === "create_issue").map(({ name, fingerprint }) => ({ appId: id, name, fingerprint })));
      const picked = await request.put("/api/account/agents/ember/tools", { data: { tools }, headers });
      expect(picked.status(), await picked.text()).toBe(200);
      const created = await request.post("/api/rooms", { data: { kind: "open", name: `Scopes ${crypto.randomUUID().slice(0, 8)}` }, headers });
      expect(created.status(), await created.text()).toBe(201);
      const { room } = (await created.json()) as { room: { id: string; name: string } };

      // The server takes Ember's sign-in, but not for this: the call isn't run, and the model is told who can allow it.
      signIn.needs = "issues:write";
      await page.goto(`/rooms/${room.id}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);
      const title = `Login fails ${crypto.randomUUID().slice(0, 8)}`;
      await askEmber(page, `${FILE_QUESTION} ${title}`);
      await page.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: title }).getByRole("button", { name: "Allow once" }).click();
      const told = "Not run: Tracker says this takes more access than Ember's sign-in to it has. An administrator has to sign in to it again, on its page, to allow it.";
      await expect(page.getByRole("article").filter({ hasText: `${FILED} ${told}` })).toBeVisible();
      expect(signsIn.calls).toEqual([]);

      // Its row and its page say so, and signing in again asks the service for it.
      await page.goto("/account/edit#assistant-settings");
      await expect(card.getByRole("listitem")).toContainText("Its server asks for more than its sign-in allows");
      await card.getByRole("link", { name: "Edit Tracker" }).click();
      const kept = page.getByRole("group", { name: "Sign-in" });
      await expect(kept.getByRole("alert")).toHaveText("Its server has asked for more than this sign-in allows (issues:write). Sign in again to allow it.");
      await kept.getByRole("button", { name: "Sign in again" }).click();
      await expect(page.getByText(asksFor("issues:write"))).toBeVisible();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page.getByRole("alert")).toHaveText("Ember is signed in to Tracker again.");
      await expect(kept.getByRole("alert")).toHaveCount(0);
      expect(signIn.allows).toEqual(["issues:write"]);

      // The same call then runs.
      await page.goto(`/rooms/${room.id}`);
      const other = `Logout fails ${crypto.randomUUID().slice(0, 8)}`;
      await askEmber(page, `${FILE_QUESTION} ${other}`);
      await page.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: other }).getByRole("button", { name: "Allow once" }).click();
      await expect(page.getByRole("article").filter({ hasText: `${FILED} ${calledWith("create_issue", { title: other })}` })).toBeVisible();

      // Removing the app takes back what the sign-in gave, at the service, which the tab says.
      await page.goto("/account/edit#assistant-settings");
      await card.getByRole("link", { name: "Edit Tracker" }).click();
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "Remove Tracker" }).click();
      await expect(page.getByRole("alert")).toHaveText(`Tracker is removed, and ${host} took back Ember's sign-in.`);
      await expect(card).toContainText("No apps are connected yet.");
      expect(signIn.revoked).toHaveLength(2);
      expect([signIn.access, signIn.refresh]).toEqual([null, null]);
    } finally {
      await signsIn.close();
    }
  });

  test("the administrator renames an app, which reads nothing from its server, and an address with no MCP server is refused", async ({ page, request }) => {
    const connected = await request.post("/api/account/apps", { data: { name: "Tracker", url: mcp.url, token: MCP_TOKEN }, headers: await asAdministrator(request) });
    expect(connected.status(), await connected.text()).toBe(201);
    const card = await openApps(page);
    await card.getByRole("link", { name: "Edit Tracker" }).click();

    const asked = mcp.asked.length;
    const name = page.getByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue("Tracker");
    await name.fill("Issue tracker");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(mcp.asked).toHaveLength(asked);

    // Another address is asked before it's saved, and one without a server there is refused, on its field.
    const address = page.getByRole("textbox", { name: "Server address" });
    await address.fill(mcp.url.replace(/\/mcp$/, "/nowhere"));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(address).toHaveAccessibleDescription(`${new URL(mcp.url).host} has no MCP server at that address. Check the address, which often ends in /mcp.`);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Issue tracker");
    await expect(page.getByRole("textbox", { name: "Server address" })).toHaveValue(mcp.url);
  });

  test("the administrator picks a connected app's tools for @ember, which a reload keeps, and picks again one its server describes another way since", async ({ page, request }) => {
    mcp.tools.splice(0, mcp.tools.length, ...TOOLS.map((tool) => ({ ...tool })));
    const headers = await asAdministrator(request);
    const connected = await request.post("/api/account/apps", { data: { name: "Tracker", url: mcp.url, token: MCP_TOKEN }, headers });
    expect(connected.status(), await connected.text()).toBe(201);
    const { app } = (await connected.json()) as AppAnswer;

    await useOwnAddress(page);
    await page.goto("/account/agents/ember/edit");
    await signInAsAdministrator(page);
    const tools = page.getByRole("region", { name: "Tools", exact: true });
    await expect(tools.getByRole("group", { name: "Tracker" }).getByRole("checkbox")).toHaveCount(2);
    const search = tools.getByRole("checkbox", { name: "search_issues, Search issues" });
    const create = tools.getByRole("checkbox", { name: "create_issue", exact: true });
    await expect(search).toHaveAccessibleDescription("Finds issues by their words.");

    // A pick is saved as it's made.
    await search.check();
    await expect(tools).toContainText("1 of 20 picked");
    await create.check();
    await expect(tools).toContainText("2 of 20 picked");
    await page.reload();
    await expect(search).toBeChecked();
    await expect(create).toBeChecked();
    // Picking a tool doesn't call it.
    expect(mcp.asked).not.toContain("tools/call");

    // The server says something else of a tool, which Ember finds when it reads its tools again.
    mcp.tools[1]!.description = "Opens an issue, and emails everyone.";
    const read = await request.post(`/api/account/apps/${app.id}/tools`, { headers });
    expect(read.status(), await read.text()).toBe(200);
    // The page loaded before that, so a pick from it would be of a tool nobody has read: it's refused,
    // and the card shows the tools as they are now.
    await search.uncheck();
    await expect(tools.getByRole("alert")).toHaveText(TOOL_GONE);
    await expect(search).toBeChecked();
    await expect(create).not.toBeChecked();
    await expect(create).toHaveAccessibleDescription(/^Opens an issue, and emails everyone\..*Pick it again to keep it\.$/);
    await expect(tools).toContainText("1 of 20 picked");
    await create.check();
    await expect(tools).toContainText("2 of 20 picked");
    await expect(create).toHaveAccessibleDescription("Opens an issue, and emails everyone.");

    // Removing the app leaves @ember nothing to pick.
    const removed = await request.delete(`/api/account/apps/${app.id}`, { headers });
    expect(removed.status(), await removed.text()).toBe(204);
    await page.reload();
    await expect(tools).toContainText("No apps are connected yet.");
    await expect(tools.getByRole("checkbox")).toHaveCount(0);
  });

  test("someone asks @ember for what a picked tool does, and it runs once they allow the call on its card, and not when they deny it", async ({ page, request }) => {
    mcp.tools.splice(0, mcp.tools.length, ...TOOLS.map((tool) => ({ ...tool })));
    mcp.calls.length = 0;
    const headers = await asAdministrator(request);
    const connected = await request.post("/api/account/apps", { data: { name: "Tracker", url: mcp.url, token: MCP_TOKEN }, headers });
    expect(connected.status(), await connected.text()).toBe(201);
    const offered = (await (await request.get("/api/account/agents/ember/tools", { headers })).json()) as AgentTools;
    const tools = offered.apps.flatMap(({ id, tools }) => tools.filter(({ name }) => name === "create_issue").map(({ name, fingerprint }) => ({ appId: id, name, fingerprint })));
    const picked = await request.put("/api/account/agents/ember/tools", { data: { tools }, headers });
    expect(picked.status(), await picked.text()).toBe(200);
    // In a room of the test's own, which everyone is in, @ember too.
    const created = await request.post("/api/rooms", { data: { kind: "open", name: `Issues ${crypto.randomUUID().slice(0, 8)}` }, headers });
    expect(created.status(), await created.text()).toBe(201);
    const { room } = (await created.json()) as { room: { id: string; name: string } };
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);

    // Its model calls the tool, which waits on a card that says what it would be called with.
    const title = `Login fails ${crypto.randomUUID().slice(0, 8)}`;
    await askEmber(page, `${FILE_QUESTION} ${title}`);
    const card = page.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: title });
    await expect(card).toContainText("create_issue, with:");
    await expect(card).toContainText(`"title": "${title}"`);
    await expect(card).toContainText("Ada Lovelace or an administrator can allow this call.");
    expect(mcp.calls).toEqual([]);

    // Allowed, it runs, with what the card showed, and the answer goes on with what the app answered.
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(card).toContainText("Allowed by Ada Lovelace.");
    await expect(card.getByRole("button", { name: "Allow once" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Deny" })).toHaveCount(0);
    await expect(page.getByRole("article").filter({ hasText: FILED })).toContainText(`${FILED} ${calledWith("create_issue", { title })}`);
    expect(mcp.calls).toEqual([{ name: "create_issue", arguments: { title } }]);
    // The model was given the tool under its app's name, and never the app's address or token.
    const said = JSON.stringify(gateway.asked.map(({ body }) => body));
    expect(said).toContain("Tracker__create_issue");
    expect(said).not.toContain(MCP_TOKEN);
    expect(said).not.toContain(new URL(mcp.url).host);

    // Denied, it isn't run, which the model is told.
    const other = `Logout fails ${crypto.randomUUID().slice(0, 8)}`;
    await askEmber(page, `${FILE_QUESTION} ${other}`);
    const denied = page.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: other });
    await denied.getByRole("button", { name: "Deny" }).click();
    await expect(denied).toContainText("Not allowed by Ada Lovelace.");
    await expect(page.getByRole("article").filter({ hasText: `${FILED} Not run: the person you're answering was asked to allow this call, and didn't.` })).toBeVisible();
    expect(mcp.calls).toHaveLength(1);
  });
  test("the administrator always allows @ember a tool, whose calls are then made at once and shown on a card, until its app changes it, which the app's row and page say", async ({ page, request }) => {
    mcp.tools.splice(0, mcp.tools.length, ...TOOLS.map((tool) => ({ ...tool })));
    mcp.calls.length = 0;
    const headers = await asAdministrator(request);
    const connected = await request.post("/api/account/apps", { data: { name: "Tracker", url: mcp.url, token: MCP_TOKEN }, headers });
    expect(connected.status(), await connected.text()).toBe(201);
    const created = await request.post("/api/rooms", { data: { kind: "open", name: `Triage ${crypto.randomUUID().slice(0, 8)}` }, headers });
    expect(created.status(), await created.text()).toBe(201);
    const { room } = (await created.json()) as { room: { id: string; name: string } };

    // Picked, a tool has a box under it that always allows it, saved as it's checked.
    await useOwnAddress(page);
    await page.goto("/account/agents/ember/edit");
    await signInAsAdministrator(page);
    const tools = page.getByRole("region", { name: "Tools", exact: true });
    const create = tools.getByRole("checkbox", { name: "create_issue", exact: true });
    const always = tools.getByRole("checkbox", { name: "Always allow create_issue" });
    await expect(always).toHaveCount(0);
    await create.check();
    await always.check();
    await expect(tools).toHaveAttribute("aria-busy", "false");
    await page.reload();
    await expect(always).toBeChecked();

    // Its call is made at once, with nobody asked, and the room is shown what it was called with.
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);
    const title = `Login fails ${crypto.randomUUID().slice(0, 8)}`;
    await askEmber(page, `${FILE_QUESTION} ${title}`);
    const used = page.getByRole("article", { name: "Ember used Tracker" }).filter({ hasText: title });
    await expect(used).toContainText("create_issue, with:");
    await expect(used).toContainText("An administrator always allows Ember this tool, so nobody was asked first.");
    await expect(used.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("article").filter({ hasText: FILED })).toContainText(`${FILED} ${calledWith("create_issue", { title })}`);
    expect(mcp.calls).toEqual([{ name: "create_issue", arguments: { title } }]);

    // Its app describes the tool another way, which Ember finds as it goes to call it: the call isn't made.
    mcp.tools[1]!.description = "Opens an issue, and emails everyone.";
    const other = `Logout fails ${crypto.randomUUID().slice(0, 8)}`;
    await askEmber(page, `${FILE_QUESTION} ${other}`);
    await expect(page.getByRole("article").filter({ hasText: `${FILED} Not run: create_issue has changed since an administrator looked at it.` })).toBeVisible();
    expect(mcp.calls).toHaveLength(1);

    // The app's row says a picked tool is set aside, and its page which, and for whom, with a link to the agent's page.
    await page.goto("/account/edit#assistant-settings");
    const apps = page.getByRole("region", { name: "Apps", exact: true });
    await expect(apps.getByRole("listitem")).toContainText("1 picked tool is set aside");
    await apps.getByRole("link", { name: "Edit Tracker" }).click();
    const setAside = page.getByRole("region", { name: /^Tools/ }).getByRole("group");
    await expect(setAside).toContainText("create_issue");
    await setAside.getByRole("link", { name: "Ember" }).click();

    // Picked again there, as it's described now, it asks first: Always allow was of the tool as it was.
    await expect(create).toHaveAccessibleDescription(/^Opens an issue, and emails everyone\..*Pick it again to keep it\.$/);
    await expect(create).not.toBeChecked();
    await create.check();
    await expect(always).not.toBeChecked();
    await expect(tools).toHaveAttribute("aria-busy", "false");
    await page.goto(`/rooms/${room.id}`);
    const third = `Signup fails ${crypto.randomUUID().slice(0, 8)}`;
    await askEmber(page, `${FILE_QUESTION} ${third}`);
    const asks = page.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: third });
    await expect(asks.getByRole("button", { name: "Allow once" })).toBeVisible();
    expect(mcp.calls).toHaveLength(1);
  });

  test("a tool that answers with a card of its own has it shown in the room, where its button calls the tool it names, whose card takes its place", async ({ page, request }) => {
    const CLOSE = { name: "close_issue", description: "Closes an issue.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } };
    mcp.tools.splice(0, mcp.tools.length, ...TOOLS.map((tool) => ({ ...tool })), CLOSE);
    mcp.calls.length = 0;
    // The server answers a call with Block Kit, as one built for Slack's client does: an issue, open with a button that closes it, or closed.
    mcp.blocks = (name, given) => {
      const { title } = given as { title: string };
      const state = (text: string) => [{ type: "header", text: { type: "plain_text", text: title } }, { type: "section", text: { type: "mrkdwn", text } }];
      if (name === "close_issue") return state("*Closed*");
      const close = { type: "button", text: { type: "plain_text", text: "Close" }, style: "danger", action_id: "tool:close_issue", value: JSON.stringify({ title }) };
      return [...state("*Open*"), { type: "actions", elements: [close] }];
    };
    try {
      const headers = await asAdministrator(request);
      const connected = await request.post("/api/account/apps", { data: { name: "Tracker", url: mcp.url, token: MCP_TOKEN }, headers });
      expect(connected.status(), await connected.text()).toBe(201);
      const offered = (await (await request.get("/api/account/agents/ember/tools", { headers })).json()) as AgentTools;
      const tools = offered.apps.flatMap(({ id, tools }) => tools.filter(({ name }) => name !== "search_issues").map(({ name, fingerprint }) => ({ appId: id, name, fingerprint })));
      const picked = await request.put("/api/account/agents/ember/tools", { data: { tools }, headers });
      expect(picked.status(), await picked.text()).toBe(200);
      const created = await request.post("/api/rooms", { data: { kind: "open", name: `Cards ${crypto.randomUUID().slice(0, 8)}` }, headers });
      expect(created.status(), await created.text()).toBe(201);
      const { room } = (await created.json()) as { room: { id: string; name: string } };
      await useOwnAddress(page);
      await page.goto(`/rooms/${room.id}`);
      await signInAsAdministrator(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);

      // Once the call is allowed, the tool's card is in the room, saying whose it is, before the answer.
      const title = `Login fails ${crypto.randomUUID().slice(0, 8)}`;
      await askEmber(page, `${FILE_QUESTION} ${title}`);
      await page.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: title }).getByRole("button", { name: "Allow once" }).click();
      const card = page.getByRole("article", { name: title });
      await expect(card).toContainText("Open");
      await expect(card).toContainText("From Tracker, answering create_issue.");
      await expect(page.getByRole("article").filter({ hasText: FILED })).toContainText(`${FILED} ${calledWith("create_issue", { title })}`);

      // Its button calls the tool it names, with what the server put in it, and nobody is asked first: the card that answers takes its place.
      await card.getByRole("button", { name: "Close" }).click();
      await expect(card).toContainText("Closed");
      await expect(card).toContainText("From Tracker, answering close_issue, after Ada Lovelace clicked Close.");
      await expect(card.getByRole("button", { name: "Close" })).toHaveCount(0);
      expect(mcp.calls).toEqual([
        { name: "create_issue", arguments: { title } },
        { name: "close_issue", arguments: { title } },
      ]);
      await expect(page.getByRole("article", { name: "Ember wants to use Tracker" })).toHaveCount(1);
    } finally {
      mcp.blocks = null;
    }
  });

  test("someone signs in to an app themselves on their profile, and what @ember does with it in their direct conversation goes as them, once they allow it, until they sign out", async ({ page, request, browser, baseURL }) => {
    const signsIn = await startFakeMcp({ signsIn: true });
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    try {
      const signIn = signsIn.signIn!;
      const host = new URL(signsIn.url).host;
      // The administrator connects the app by signing in to it, and picks one of its tools for @ember.
      const card = await openApps(page);
      await connectAt(page, card, signsIn.url);
      await page.getByRole("button", { name: `Sign in to ${host}` }).click();
      await page.getByRole("link", { name: "Allow" }).click();
      await expect(page.getByRole("alert")).toHaveText("Tracker is connected. Ember read 2 tools from it.");
      const headers = await asAdministrator(request);
      const offered = (await (await request.get("/api/account/agents/ember/tools", { headers })).json()) as AgentTools;
      const tools = offered.apps.flatMap(({ id, tools }) => tools.filter(({ name }) => name === "create_issue").map(({ name, fingerprint }) => ({ appId: id, name, fingerprint })));
      const picked = await request.put("/api/account/agents/ember/tools", { data: { tools }, headers });
      expect(picked.status(), await picked.text()).toBe(200);

      // Grace, who joins Ember with the join link, finds the app on her profile, not signed in to.
      const { joinCode } = (await (await request.get("/api/account", { headers })).json()) as WorkspaceSettings;
      const name = `Grace ${crypto.randomUUID().slice(0, 8)}`;
      const asGrace = { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN };
      const joined = await context.request.post(`/api/join/${joinCode}`, { data: { name, emailAddress: `${crypto.randomUUID()}@example.com`, password: "compiler error" }, headers: asGrace });
      expect(joined.status(), await joined.text()).toBe(201);
      const grace = await context.newPage();
      await useOwnAddress(grace);
      await grace.goto(PROFILE_PATH);
      const apps = grace.getByRole("region", { name: "Apps", exact: true });
      await expect(apps.getByRole("listitem")).toContainText(["TrackerYou haven't signed in. Agents use the sign-in an administrator made."]);

      // Signing in sends her to the app's service, and allowing it there comes back to her profile, signed in.
      await apps.getByRole("button", { name: "Sign in to Tracker" }).click();
      await expect(grace.getByRole("heading", { name: ALLOW_HEADING })).toBeVisible();
      await grace.getByRole("link", { name: "Allow" }).click();
      await expect(grace.getByRole("alert")).toHaveText("You're signed in to Tracker. What an agent does with it in your direct conversation with that agent, it now does as you.");
      await expect(grace).toHaveURL(new RegExp(`${PROFILE_PATH}$`));
      await expect(apps.getByRole("listitem")).toContainText("You signed in");
      await expect(apps.getByRole("button", { name: "Sign in to Tracker" })).toHaveCount(0);
      expect(signIn.exchanged).toBe(2);

      // In her direct conversation with @ember, a call of the tool waits on a card that says it goes as her.
      const direct = await context.request.post("/api/directs", { data: { userIds: [ASSISTANT_ID] }, headers: asGrace });
      expect(direct.status(), await direct.text()).toBe(201);
      const { room } = (await direct.json()) as { room: { id: string } };
      await grace.goto(`/rooms/${room.id}`);
      const title = `Login fails ${crypto.randomUUID().slice(0, 8)}`;
      const composer = editorField(grace, "Write a message");
      await composer.pressSequentially(`${FILE_QUESTION} ${title}`);
      await composer.press("Enter");
      const call = grace.getByRole("article", { name: "Ember wants to use Tracker" }).filter({ hasText: title });
      await expect(call).toContainText(`${name} can allow this call. It goes to Tracker as ${name}, with the sign-in they made to it themselves.`);
      expect(signsIn.calls).toEqual([]);

      // The service keeps one sign-in good at a time, and hers is the later, so the call it runs is the one made as her.
      await call.getByRole("button", { name: "Allow once" }).click();
      await expect(call).toContainText(`Allowed by ${name}.`);
      await expect(grace.getByRole("article").filter({ hasText: FILED })).toContainText(`${FILED} ${calledWith("create_issue", { title })}`);
      expect(signsIn.calls).toEqual([{ name: "create_issue", arguments: { title } }]);

      // Signing out takes her sign-in back at the service, and leaves the app as it was for her.
      await grace.goto(PROFILE_PATH);
      await apps.getByRole("button", { name: "Sign out of Tracker" }).click();
      await expect(grace.getByRole("alert")).toHaveText("You're signed out of Tracker, which took your sign-in back.");
      await expect(apps.getByRole("listitem")).toContainText(["TrackerYou haven't signed in. Agents use the sign-in an administrator made."]);
      expect(signIn.revoked).toHaveLength(2);
      expect([signIn.access, signIn.refresh]).toEqual([null, null]);
    } finally {
      await context.close();
      await signsIn.close();
    }
  });
});

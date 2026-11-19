import type { Locator, Page } from "@playwright/test";
import type { BotAnswer, Bots, BotSettings, WorkspaceSettings } from "@ember/protocol";
import type { AgentAnswer, Agents, AgentSettings, AgentTrialAnswer } from "@ember/protocol/agents";
import type { AgentTools } from "@ember/protocol/apps";
import { THINKING_LEVELS, TOP_LEVELS, type AssistantSettings } from "@ember/protocol/assistant";
import { AGENT_TEMPLATE } from "@ember/protocol/prompts";
import { answerChanged, changeTheWorkspace, fakeTurnstile, isolateRoom, listing, openRoom, signInAs, signInAsAdministrator, TURNSTILE_WIDGET, useOwnAddress, type Passes } from "../../fixtures";
import { auditScreen, settle } from "./audits";
import { expect, hasDrawerLayout, SWITCHES, test } from "./fixtures";

/** A name as long as the server takes, with a run that only breaks anywhere. */
const LONG_NAME = "The-Analytical-Engine-Appreciation-Society-of-Greater-Marylebone-and-the-Surrounding-Districts";
/** A tagline as long as the server takes, in everyday words. */
const LONGEST_TAGLINE = "Engines and tea for every soul";

const nameTheWorkspaceLong = (page: Page) => changeTheWorkspace(page, (account) => ({ ...account, name: LONG_NAME }));
const showTranslationButtons = (page: Page, passes?: Passes) => changeTheWorkspace(page, (account) => ({ ...account, hideTranslationButtons: false }), passes);

test("an administrator's workspace settings, with a long name, fit the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await nameTheWorkspaceLong(page);
  await page.goto("/account/edit");
  await signInAsAdministrator(page);
  await expect(page.getByRole("textbox", { name: "Community name" })).toHaveValue(LONG_NAME);
  await screenIsFine({ denseTargets: [SWITCHES] });

  // Back in a room, the conversations under it, where the name wraps.
  await page.getByRole("link", { name: "Go Back" }).tap();
  if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open conversations" }).tap();
  await expect(page.getByRole("heading", { level: 2, name: LONG_NAME })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's people list, with Delete by everyone else, fits the phone", async ({ page, session, screenIsFine }) => {
  await useOwnAddress(page);
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
  const remove = page.getByRole("region", { name: "Membership" }).getByRole("button", { name: `Delete ${session.user.name}` }).first();
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeInViewport();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's ways to join, with Open's sign-up link, fit the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await changeTheWorkspace(page, (account) => ({ ...account, openSignUp: true }));
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
  const open = page.getByRole("region", { name: "Open", exact: true });
  await open.scrollIntoViewIfNeeded();
  await expect(open.getByRole("textbox", { name: "Share so anyone can sign up" })).toBeInViewport();
  await screenIsFine({ denseTargets: [SWITCHES] });

  await open.getByRole("button", { name: "Set up Turnstile" }).scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's Set up Turnstile, with the widget's check, fits the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await fakeTurnstile(page);
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
  const card = page.getByRole("region", { name: "Turnstile", exact: true });
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("switch", { name: "Turnstile" }).tap();
  const setup = page.getByRole("dialog", { name: "Set up Turnstile" });
  await expect(setup.getByRole("list", { name: "Steps to make a Turnstile widget" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });

  await setup.getByRole("textbox", { name: "Site key" }).fill(TURNSTILE_WIDGET.siteKey);
  await setup.getByRole("textbox", { name: "Secret key" }).fill(TURNSTILE_WIDGET.secretKey);
  await setup.getByRole("button", { name: "Continue" }).tap();
  const check = page.getByRole("dialog", { name: "Pass the widget's check" });
  await expect(check.frameLocator("iframe[title=\"Turnstile's check\"]").getByRole("button", { name: "Verify you are human" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's Huddles tab and Set up huddles, with a key refused, fit the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await page.goto("/account/edit#huddles-settings");
  await signInAsAdministrator(page);
  const card = page.getByRole("region", { name: "Audio and video chat", exact: true });
  await expect(card.getByRole("switch", { name: "Audio and video chat" })).toBeInViewport();
  await screenIsFine({ denseTargets: [SWITCHES] });

  await card.getByRole("switch", { name: "Audio and video chat" }).tap();
  const setup = page.getByRole("dialog", { name: "Set up huddles" });
  await expect(setup.getByRole("list", { name: "Steps to set up huddles" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });

  // Keys that can't be an app's are refused on their field, before Cloudflare is asked anything.
  await setup.getByRole("textbox", { name: "App ID" }).fill("my huddles app");
  await setup.getByRole("textbox", { name: "App Secret" }).fill("f".repeat(64));
  await setup.getByRole("button", { name: "Save" }).tap();
  await expect(setup.getByRole("alert")).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's Huddles tab, naming the app huddles run through, its card of Cameras and Screen sharing under that, and the relay's, with Set up the relay and a key refused, fit the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  // The settings as they are once an app's keys are given, and a TURN key's, without giving the test server any, which every other test shows.
  const relayKeyId = "7e1a".repeat(8);
  await page.route("**/api/account", (route) => answerChanged<WorkspaceSettings>(route, (settings) => ({ ...settings, huddles: { appId: "ca11".repeat(8), relayKeyId } })));
  await page.goto("/account/edit#huddles-settings");
  await signInAsAdministrator(page);
  const card = page.getByRole("region", { name: "Audio and video chat", exact: true });
  await card.getByRole("button", { name: "Change keys" }).scrollIntoViewIfNeeded();
  await expect(card.getByRole("switch", { name: "Audio and video chat" })).toBeChecked();
  await screenIsFine({ denseTargets: [SWITCHES] });

  // What people may do in a huddle comes with huddles: turn their camera on and share their screen, which are both on.
  const cameras = page.getByRole("region", { name: "Cameras", exact: true });
  const screens = page.getByRole("region", { name: "Screen sharing", exact: true });
  await screens.getByRole("switch", { name: "Screen sharing" }).scrollIntoViewIfNeeded();
  await expect(cameras.getByRole("switch", { name: "Cameras" })).toBeChecked();
  await expect(cameras).toContainText("People can turn their camera on in a huddle.");
  await expect(screens.getByRole("switch", { name: "Screen sharing" })).toBeChecked();
  await expect(screens).toContainText("People can share their screen in a huddle, from a computer.");
  await screenIsFine({ denseTargets: [SWITCHES] });

  // Under them, the relay's card names the TURN key it goes by.
  const relay = page.getByRole("region", { name: "Relay for strict networks", exact: true });
  await relay.getByRole("button", { name: "Change key" }).scrollIntoViewIfNeeded();
  await expect(relay.getByRole("switch", { name: "Relay for strict networks" })).toBeChecked();
  await expect(relay).toContainText(`by the TURN key ${relayKeyId} in your Cloudflare account.`);
  await screenIsFine({ denseTargets: [SWITCHES] });

  // Change key opens Set up the relay, which refuses what can't be a TURN key's on its field, before Cloudflare is asked anything.
  await relay.getByRole("button", { name: "Change key" }).tap();
  const setup = page.getByRole("dialog", { name: "Set up the relay" });
  await expect(setup.getByRole("list", { name: "Steps to set up the relay" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
  await setup.getByRole("textbox", { name: "TURN Token ID" }).fill("my TURN key");
  await setup.getByRole("textbox", { name: "API Token" }).fill("f".repeat(64));
  await setup.getByRole("button", { name: "Save" }).tap();
  await expect(setup.getByRole("alert")).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's custom domain steps, for a domain at another provider, fit the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  // As Cloudflare's resolver finds a domain whose DNS is at GoDaddy, whose steps to keep it there are the
  // most, and which doesn't reach Ember yet.
  await page.route("**/api/account/custom_domain_lookups", (route) => route.fulfill({ json: { zone: "example.com", provider: "godaddy" } }));
  await page.route("**/api/account/custom_domain_checks", (route) => route.fulfill({ json: { reaches: "nothing" } }));
  await page.goto("/account/edit#domain-settings");
  await signInAsAdministrator(page);
  const section = page.getByRole("region", { name: "Custom domain" });
  await section.getByRole("textbox", { name: "Domain" }).fill("chat.example.com");
  await section.getByRole("button", { name: "Set up" }).tap();
  await section.getByRole("textbox", { name: "Domain on Cloudflare" }).fill("example.net");
  const steps = section.getByRole("list", { name: "Steps to make chat.example.com Ember's address" });
  await expect(steps.getByRole("listitem")).toHaveCount(5);
  const provider = section.getByRole("combobox", { name: "DNS provider" });
  await provider.scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });

  // The longest record, to add at GoDaddy.
  await steps.getByRole("button", { name: "Copy ember-saas.example.net" }).scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
  await steps.getByRole("button", { name: "Use chat.example.com" }).scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });

  // Or moving its DNS to Cloudflare.
  await provider.selectOption("cloudflare");
  await expect(steps.getByRole("listitem")).toHaveCount(4);
  await provider.scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an administrator's Save, for a domain that already reaches Ember, fits the phone, under Domain settings in view", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  // As Set up's check finds Ember at a domain added to the Worker before.
  await page.route("**/api/account/custom_domain_checks", (route) => route.fulfill({ json: { reaches: "ember" } }));
  await page.goto("/account/edit#domain-settings");
  await signInAsAdministrator(page);
  await expect(page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Domain settings" })).toBeInViewport();
  const section = page.getByRole("region", { name: "Custom domain" });
  await section.getByRole("textbox", { name: "Domain" }).fill("community-chat.analytical-engines.example.com");
  await section.getByRole("button", { name: "Set up" }).tap();
  await expect(section).toContainText("community-chat.analytical-engines.example.com already reaches Ember.");
  await section.getByRole("button", { name: "Save" }).scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("a member's workspace settings, with a long name, fit the phone", async ({ page, session, screenIsFine }) => {
  await nameTheWorkspaceLong(page);
  await signInAs(page, session);
  await page.goto("/account/edit");
  await expect(page.getByRole("main").getByRole("heading", { level: 2, name: LONG_NAME })).toBeVisible();
  await screenIsFine();
});

/** How many lines `text` takes up. */
const linesOf = (text: Locator) =>
  text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size;
  });

test("the longest tagline fits the phone under a long name, in a member's settings and the conversations, clear of the drawer's close button", async ({
  page,
  room,
  session,
  screenIsFine,
}) => {
  await changeTheWorkspace(page, (account) => ({ ...account, name: LONG_NAME, tagline: LONGEST_TAGLINE }));
  await signInAs(page, session);
  await page.goto("/account/edit");
  const settingsName = page.getByRole("main").getByRole("heading", { level: 2, name: LONG_NAME });
  await expect(settingsName.locator("xpath=following-sibling::p")).toHaveText(LONGEST_TAGLINE);
  await screenIsFine();

  // Community settings' links take the conversations' place, so they're a room's.
  await openRoom(page, room);
  if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open conversations" }).tap();
  const conversations = page.getByRole("complementary", { name: "Conversations" });
  const tagline = conversations.locator("hgroup > h2 + p");
  await expect(tagline).toHaveText(LONGEST_TAGLINE);
  await screenIsFine();
  if (hasDrawerLayout(page)) {
    const [line, close] = [(await tagline.boundingBox())!, (await page.getByRole("dialog").getByRole("button", { name: "Close conversations" }).boundingBox())!];
    expect(line.x + line.width <= close.x || line.y >= close.y + close.height, "the tagline is clear of the close button").toBe(true);
  }
  // A drawer with room for the sidebar's full 280px, from 376px wide, takes it on one line, as the desktop does.
  if ((await conversations.evaluate((sidebar) => sidebar.getBoundingClientRect().width)) >= 280) expect(await linesOf(tagline)).toBe(1);
});

test("the Custom styles page fits the phone, its navigation icons first, then a CSS field too big for iOS to zoom in on", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await page.goto("/account/custom_styles/edit");
  await signInAsAdministrator(page);
  const css = page.getByRole("textbox", { name: "Custom CSS" });
  await expect(css).toBeEnabled();
  await expect(page.getByRole("region", { name: "Navigation icons" }).getByRole("button", { name: "Choose Home icon" })).toBeInViewport();
  await screenIsFine();

  await css.scrollIntoViewIfNeeded();
  await expect(css).toBeInViewport();
  await screenIsFine();
});

/** A bot named as long as names go, in a room named so, as the bots page lists it. */
const BOT: BotSettings = {
  id: "0mgk3x2a9b4c5e",
  name: LONG_NAME,
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/users/0mgk3x2a9b4c5e/avatar?v=1",
  key: "0mgk3x2a9b4c5e-Ab3dEf5hiJ7k",
  rooms: [{ id: "0mgk3x2a9b4c5a", name: LONG_NAME }],
  webhookUrl: "https://ci.example.com/hook",
  pickedRooms: null,
};

/** Shows `page` `BOT` as the only bot, without adding one to the test server, where it would join every other test's rooms. */
async function showTheBot(page: Page): Promise<void> {
  await page.route("**/api/account/bots", (route) => route.fulfill({ json: { bots: [BOT] } satisfies Bots }));
  await page.route(`**/api/account/bots/${BOT.id}`, (route) => route.fulfill({ json: { bot: BOT } satisfies BotAnswer }));
}

test("the Chat bots page, with a bot's commands, fits the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await showTheBot(page);
  await page.goto("/account/bots");
  await signInAsAdministrator(page);
  // The bot's row, folded away, then open, with its only room open too.
  const bot = page.getByRole("button", { name: BOT.name, exact: true });
  await expect(bot).toBeVisible();
  await screenIsFine();
  await bot.click();
  await expect(page.getByRole("textbox", { name: "curl command for posting messages" })).toHaveValue(/^curl -d 'Hello!' /);
  await screenIsFine();
});

test("a bot's settings fit the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await showTheBot(page);
  await page.goto("/account/bots");
  await signInAsAdministrator(page);
  // From the bots page, as the Worker answers its 404 page for a bot it doesn't have.
  await page.getByRole("link", { name: `Edit ${BOT.name}` }).click();
  await expect(page.getByRole("textbox", { name: "Bot name" })).toHaveValue(BOT.name);
  await expect(page.getByRole("button", { name: "Generate a new key" })).toBeVisible();
  await screenIsFine();
  // Rooms, then Incoming, whose menu names a room as long as names go, then Outgoing, each scrolled to.
  for (const name of ["Rooms", "Incoming", "Outgoing"]) {
    await page.getByRole("region", { name }).scrollIntoViewIfNeeded();
    await screenIsFine();
  }
});

/** Ember AI on Claude Sonnet 5.5, with Ember's flame as @ember's avatar. */
const ASSISTANT: AssistantSettings = {
  accountId: "0123456789abcdef0123456789abcdef",
  model: "anthropic/claude-sonnet-5.5",
  models: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "anthropic" }],
  most: TOP_LEVELS,
  webTools: [],
  instructions: "",
  promptTemplate: null,
  avatarUrl: "/assistant-avatar.svg",
  avatar: false,
};

/**
 * An agent named as long as names go, saying as much as it can of what it does, kept to rooms named as
 * long, with what Ember adds around its instructions modified, and last changed by someone named so, as
 * the AI assistant tab lists it and its page shows it.
 */
const AGENT: AgentSettings = {
  id: "0mgk3x2a9b4c60",
  name: LONG_NAME,
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/assistant-avatar.svg",
  description: "Sums up every thread into the decisions made, the questions still open and the to-dos people took on",
  model: "anthropic/claude-sonnet-5.5",
  modelName: "Claude Sonnet 5.5",
  webTools: ["search", "read"],
  access: "everyone",
  rooms: [1, 2, 3, 4].map((n) => ({ id: `0mgk3x2a9b4c5${n}`, name: `${LONG_NAME}-${n}` })),
  instructions: "You sum up conversations for the team.\n\nList the decisions made, then the questions still open, then the to-dos, each with who took it on.",
  promptTemplate: `${AGENT_TEMPLATE}\n\nSign off as ${LONG_NAME}.`,
  format: "anthropic",
  levels: { thinking: "medium", length: "long" },
  thinkingLevels: [...THINKING_LEVELS],
  avatar: true,
  changedBy: { id: "0mgk3x2a9b4c5d", name: LONG_NAME },
  changedAt: "2026-11-09T12:00:00.000Z",
};

/** What Try it's model says. */
const TRIED: AgentTrialAnswer = { body: `<p>Two decisions so far, and one to-do for ${LONG_NAME}.</p>`, cards: [], ms: 2345 };

/** The tools an agent's page offers: an app named as long as names go, with a tool named as long as the protocol takes, one picked, which can be always allowed, one set aside, and one its app says nothing of. */
const TOOLS: AgentTools = {
  apps: [
    {
      id: "0mgk3x2a9b4c70",
      name: LONG_NAME,
      tools: [
        { name: "search_issues", title: "Search issues", description: "Finds issues by their words, in every project the token can read.", fingerprint: "f-search", picked: true, changed: false, alwaysAllowed: false },
        { name: `create_${"issue_".repeat(20)}now`, title: null, description: "Opens an issue.", fingerprint: "f-create", picked: false, changed: true, alwaysAllowed: false },
        { name: "close_issue", title: null, description: "", fingerprint: "f-close", picked: false, changed: false, alwaysAllowed: false },
      ],
    },
  ],
};

/** Shows `page` Ember AI on, with `AGENT` its only agent, without turning on the test server's, which would put @ember in every other test's rooms. */
async function showTheAgents(page: Page): Promise<void> {
  await page.route("**/api/account", (route) => answerChanged<WorkspaceSettings>(route, (settings) => ({ ...settings, assistant: ASSISTANT })));
  await page.route("**/api/account/agents", (route) => route.fulfill({ json: { agents: [AGENT] } satisfies Agents }));
  await page.route(`**/api/account/agents/${AGENT.id}`, (route) => route.fulfill({ json: { agent: AGENT } satisfies AgentAnswer }));
  await page.route("**/api/account/agents/trials", (route) => route.fulfill({ json: TRIED }));
  await page.route("**/api/account/agents/*/tools", (route) => route.fulfill({ json: TOOLS }));
}

/** Scrolls to each of the agent's page's cards in turn, which fit the phone. */
/**
 * Opens What Ember adds around the instructions and presses Modify, unless what's there is `modified`
 * already, checking the screen at the box that asks for care, at the template and at what's under it.
 */
async function modifyingFits(scope: Page | Locator, screenIsFine: (options?: { denseTargets?: string[] }) => Promise<void>, modified = false) {
  await scope.getByText("What Ember adds around them").tap();
  const caution = scope.getByRole("region", { name: "Modify with caution" });
  await caution.scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
  if (!modified) await caution.getByRole("button", { name: "Modify" }).tap();
  for (const part of [caution.getByRole("textbox", { name: "What Ember adds around them" }), caution.getByRole("button", { name: "Use Ember's own" })]) {
    await part.scrollIntoViewIfNeeded();
    await screenIsFine({ denseTargets: [SWITCHES] });
  }
}

async function eachCardFits(page: Page, screenIsFine: (options?: { denseTargets?: string[] }) => Promise<void>, saved = false) {
  for (const name of ["Instructions", "How it answers", "Search the web", "Rooms", "Try it", ...(saved ? ["Tools"] : [])]) {
    await page.getByRole("region", { name, exact: true }).scrollIntoViewIfNeeded();
    await screenIsFine({ denseTargets: [SWITCHES] });
  }
}

test("an administrator's AI assistant tab, listing an agent named as long as names go, fits the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await showTheAgents(page);
  await page.goto("/account/edit#assistant-settings");
  await signInAsAdministrator(page);
  const edit = page.getByRole("region", { name: "Agents", exact: true }).getByRole("link", { name: `Edit ${LONG_NAME}` });
  await expect(edit).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
  await edit.scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("New agent fits the phone, card by card, with what Ember adds around the instructions, modified, and Try it's answer", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await showTheAgents(page);
  await page.goto("/account/agents/new");
  await signInAsAdministrator(page);
  await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
  await modifyingFits(page, screenIsFine);
  await page.getByRole("radio", { name: "Only the rooms I choose" }).tap();
  const tryIt = page.getByRole("region", { name: "Try it", exact: true });
  await tryIt.getByRole("textbox", { name: "Question" }).fill("What did we decide?");
  await tryIt.getByRole("button", { name: "Ask" }).tap();
  await expect(tryIt).toContainText("Answered in 2.3 seconds.");
  await eachCardFits(page, screenIsFine);
  await page.getByRole("button", { name: "Create agent" }).scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("an agent's settings fit the phone, with what Ember adds around its instructions modified, who last changed it and Delete agent", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await showTheAgents(page);
  await page.goto("/account/edit#assistant-settings");
  await signInAsAdministrator(page);
  // From the tab, as the Worker answers its 404 page for an agent it doesn't have.
  await page.getByRole("link", { name: `Edit ${LONG_NAME}` }).click();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(LONG_NAME);
  await expect(page.getByRole("button", { name: "Remove avatar" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
  await modifyingFits(page, screenIsFine, true);
  await eachCardFits(page, screenIsFine, true);
  await page.getByRole("button", { name: `Delete ${LONG_NAME}` }).scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("@ember's page fits the phone", async ({ page, screenIsFine }) => {
  await useOwnAddress(page);
  await showTheAgents(page);
  await page.goto("/account/agents/ember/edit");
  await signInAsAdministrator(page);
  const ember = page.getByRole("region", { name: "@ember", exact: true });
  await expect(ember.getByRole("textbox", { name: "Instructions" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
  await modifyingFits(ember, screenIsFine);
  for (const heading of ["Instructions", "Models", "Search the web", "Limits"]) {
    await ember.getByRole("heading", { name: heading, exact: true }).scrollIntoViewIfNeeded();
    await screenIsFine({ denseTargets: [SWITCHES] });
  }
  const tools = page.getByRole("region", { name: "Tools", exact: true });
  await expect(tools.getByRole("checkbox")).toHaveCount(4);
  await expect(tools.getByRole("checkbox", { name: "Always allow search_issues" })).toBeVisible();
  await tools.scrollIntoViewIfNeeded();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("your profile, opened from the rail, fits the phone with Log out in the top bar and a translation button by each field", async ({ page, room, session, screenIsFine }) => {
  await showTranslationButtons(page);
  await signInAs(page, session);
  await openRoom(page, room);
  if (hasDrawerLayout(page)) {
    await page.getByRole("button", { name: "Open conversations" }).tap();
    await settle(page);
  }
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).tap();
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await expect(page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("main").locator("summary", { hasText: "Translate" })).toHaveCount(4);
  await screenIsFine();
});

test("your sign-in link, at the foot of your profile, fits the phone", async ({ page, room: _, session, screenIsFine }) => {
  await signInAs(page, session);
  await page.goto("/users/me/profile");
  const link = page.getByRole("textbox", { name: "Use this link to login automatically on another device" });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();
  await screenIsFine();
});

test("translation buttons, and the list each opens, fit the phone", async ({ page, safeArea, screenIsFine }) => {
  await showTranslationButtons(page);
  await page.goto("/session/new");
  const globe = page.locator("summary", { hasText: "Translate" }).first();
  await expect(globe).toBeVisible();
  await screenIsFine();

  await globe.tap();
  await expect(page.locator("details[open] dl")).toBeVisible();
  // What the list covers takes no tap until it closes, as under any menu, so only how it fits counts.
  const results = await auditScreen(page, safeArea);
  expect.soft(results.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
  expect.soft(results.safeArea, "Nothing sits under the notch, rounded corners or home indicator").toEqual([]);
});

test("the welcome card's translation list, by the screen's edge, opens where it fits the phone", async ({ page, room, session, safeArea }) => {
  await isolateRoom(page, room, { joinCode: "aB3d-Ef5h-iJ7k" });
  await showTranslationButtons(page, listing([room.id]));
  await signInAs(page, session);
  await openRoom(page, room);
  await page.getByRole("main").locator("summary", { hasText: "Translate" }).tap();
  await expect(page.locator("details[open] dl")).toBeVisible();
  const results = await auditScreen(page, safeArea);
  expect.soft(results.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
  expect.soft(results.safeArea, "Nothing sits under the notch, rounded corners or home indicator").toEqual([]);
});

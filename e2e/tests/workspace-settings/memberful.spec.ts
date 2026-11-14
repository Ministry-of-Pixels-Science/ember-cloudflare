import { MEMBERFUL_CALLBACK_PATH, MEMBERFUL_SIGN_IN_PROBLEMS, MEMBERFUL_WEBHOOK_PATH, type Account, type WorkspaceSettings } from "@ember/protocol";
import { MEMBERFUL_API_KEY_UNKNOWN, MEMBERFUL_CLIENT_UNKNOWN } from "@ember/protocol/memberful";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { administratorSession, cookieHeader, logOut, SAME_ORIGIN, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { MEMBERFUL_KEYS, MEMBERFUL_SITE } from "../../projects/workspace-settings";
import { sendWebhook, startFakeMemberful, type FakeMember, type FakeMemberful } from "./fake-memberful";

// Signing in with Memberful, at a Memberful site of the specs' own (fake-memberful.ts), whose address and
// keys the first spec gives Ember in Set up Memberful, and the others as it saves them. Each spec turns
// Memberful on, members only unless it says, and off again after, since Members only turns the join link
// off for the specs that follow.

let site: FakeMemberful;

test.beforeAll(async ({ baseURL }) => {
  site = await startFakeMemberful(baseURL!);
});

test.afterAll(() => site.close());

test.afterEach(({ request }) => turnMemberful(request, false));

/** Memberful as the administrator's settings show it. */
async function memberfulOf(request: APIRequestContext): Promise<WorkspaceSettings> {
  const administrator = await administratorSession(request);
  const response = await request.get("/api/account", { headers: { Cookie: cookieHeader(administrator) } });
  return (await response.json()) as WorkspaceSettings;
}

/** Gives Ember the site's address and keys, as Set up Memberful saves them, as the administrator. Giving them again changes nothing. */
async function giveKeys(request: APIRequestContext): Promise<void> {
  const administrator = await administratorSession(request);
  const keys = { site: MEMBERFUL_SITE, ...MEMBERFUL_KEYS };
  const response = await request.put("/api/account/memberful_keys", { data: keys, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
}

/** Turns Memberful on, members only unless `membersOnly` is false, with the site's keys, or off, which turns Members only off too, as the administrator. */
async function turnMemberful(request: APIRequestContext, on: boolean, { membersOnly = true } = {}): Promise<void> {
  if (on) await giveKeys(request);
  const administrator = await administratorSession(request);
  const settings = on ? { memberfulJoin: true, memberfulSignIn: membersOnly } : { memberfulJoin: false };
  const response = await request.patch("/api/account", { data: { settings }, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
  const { account } = (await response.json()) as { account: Account };
  expect([account.memberfulJoin, account.memberfulSignIn]).toEqual([on, on && membersOnly]);
}

/** The join link's address, which only works while Memberful isn't members only. */
async function joinPath(request: APIRequestContext): Promise<string> {
  return `/join/${(await memberfulOf(request)).joinCode}`;
}

/** Someone who joins with a password, as everyone did before Memberful was members only. */
interface Joiner {
  name: string;
  emailAddress: string;
  password: string;
}

/** Has someone new join through the join link in `page`, with a password, which signs them in there. */
async function joinWithPassword(page: Page, request: APIRequestContext, name: string): Promise<Joiner> {
  const joiner = { name, emailAddress: `${crypto.randomUUID()}@example.com`, password: "compiler error" };
  await page.goto(await joinPath(request));
  await page.getByLabel("Name", { exact: true }).fill(joiner.name);
  await page.getByLabel("Email address").fill(joiner.emailAddress);
  await page.getByLabel("Password").fill(joiner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(composer(page)).toBeVisible();
  return joiner;
}

/** Signs in at the Memberful site as `member`, from the page it shows its members on. */
const signInThereAs = (page: Page, member: FakeMember) => page.getByRole("link", { name: `Sign in as ${member.fullName}` }).click();

/** Signs in with Memberful from the sign-in page `page` shows, as `member`. */
async function signInWithMemberful(page: Page, member: FakeMember): Promise<void> {
  await page.getByRole("link", { name: "Sign in with Memberful" }).click();
  await signInThereAs(page, member);
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Write a message" });
const memberfulSection = (page: Page) => page.getByRole("region", { name: "Memberful" });
/** A name no earlier run of a server kept between runs has used. */
const nameFor = (name: string) => `${name} ${crypto.randomUUID().slice(0, 8)}`;

test.describe("Set up Memberful", () => {
  test("the administrator turns Memberful on, which sets it up first with the site's address and its custom app's and webhook's keys, once Memberful takes them", async ({
    page,
    request,
    baseURL,
  }) => {
    test.skip((await memberfulOf(request)).memberfulKeys !== null, "An earlier run of this server gave Ember the site's keys, so the switch turns Memberful on at once");
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const memberful = page.getByRole("switch", { name: "Memberful", exact: true });
    await memberful.click();
    const setup = page.getByRole("dialog", { name: "Set up Memberful" });
    // Ember's addresses, to give Memberful's custom app and webhook.
    await expect(setup.getByRole("listitem").nth(1)).toContainText(`${baseURL}${MEMBERFUL_CALLBACK_PATH}`);
    await expect(setup.getByRole("listitem").nth(2)).toContainText(`${baseURL}${MEMBERFUL_WEBHOOK_PATH}`);
    await setup.getByLabel("Address", { exact: true }).fill(MEMBERFUL_SITE);
    await setup.getByLabel("OAuth identifier", { exact: true }).fill(MEMBERFUL_KEYS.clientId);
    await setup.getByLabel("OAuth secret", { exact: true }).fill("not-the-apps-secret");
    await setup.getByLabel("API key", { exact: true }).fill("not-the-apps-api-key");
    await setup.getByLabel("Secret key", { exact: true }).fill(MEMBERFUL_KEYS.webhookSecret);
    const save = setup.getByRole("button", { name: "Save" });
    await save.click();
    // Memberful's admin API doesn't take the API key, and then its token endpoint doesn't know the app with that secret.
    await expect(setup.getByRole("alert")).toHaveText(MEMBERFUL_API_KEY_UNKNOWN);
    await setup.getByLabel("API key", { exact: true }).fill(MEMBERFUL_KEYS.apiKey);
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(MEMBERFUL_CLIENT_UNKNOWN);
    await setup.getByLabel("OAuth secret", { exact: true }).fill(MEMBERFUL_KEYS.clientSecret);
    await save.click();

    const done = page.getByRole("dialog", { name: "Memberful is set up" });
    await expect(done).toContainText(`members of ${MEMBERFUL_SITE} join and sign in with their Memberful account`);
    await done.getByRole("button", { name: "Done" }).click();
    await expect(memberful).toBeChecked();
    await expect(memberfulSection(page)).toContainText(`Members of ${MEMBERFUL_SITE} join and sign in with their Memberful account.`);
    await expect(memberfulSection(page).getByRole("button", { name: "Change keys" })).toBeVisible();
    // Ember keeps the secrets to itself.
    const settings = await memberfulOf(request);
    expect(settings).toMatchObject({ memberfulSite: MEMBERFUL_SITE, memberfulWebhooks: true, memberfulKeys: "saved" });
    for (const secret of [MEMBERFUL_KEYS.clientSecret, MEMBERFUL_KEYS.apiKey, MEMBERFUL_KEYS.webhookSecret]) expect(JSON.stringify(settings)).not.toContain(secret);
  });
});

test.describe("Sign in with Memberful", () => {
  test("a member of the Memberful site signs in as someone new, and as themselves from then on", async ({ page, request }) => {
    const member = site.add(nameFor("Grace"));
    await turnMemberful(request, true);
    await useOwnAddress(page);
    await page.goto("/users/me/profile");
    await signInWithMemberful(page, member);
    // Back on the page they were sent to sign in from.
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(member.fullName);
    await expect(page.getByLabel("Email address")).toHaveValue(member.email);
    // Their profile names the account, which is how they sign in, so it offers them no password, and nothing to disconnect.
    await expect(memberfulSection(page)).toContainText(`Connected to Memberful as ${member.fullName} (${member.email}), so you sign in with it.`);
    await expect(page.getByLabel("New password")).toHaveCount(0);
    await expect(memberfulSection(page).getByRole("button", { name: "Disconnect Memberful" })).toHaveCount(0);

    await logOut(page);
    await signInWithMemberful(page, member);
    await expect(composer(page)).toBeVisible();
    await page.goto("/users/me/profile");
    await expect(page.getByLabel("Email address")).toHaveValue(member.email);
  });

  test("beside the join link, a member of the Memberful site joins with it from under the password form, and keeps signing in with it once it's off, when nobody new can", async ({
    page,
    request,
  }) => {
    await useOwnAddress(page);
    const joiner = await joinWithPassword(page, request, nameFor("Annie"));
    const member = site.add(nameFor("Grace"));
    await turnMemberful(request, true, { membersOnly: false });
    await logOut(page);
    await expect(page.getByLabel("Email address")).toBeVisible();
    await signInWithMemberful(page, member);
    await expect(composer(page)).toBeVisible();

    await turnMemberful(request, false);
    await logOut(page);
    await signInWithMemberful(page, member);
    await expect(composer(page)).toBeVisible();
    await logOut(page);
    await signInWithMemberful(page, site.add(nameFor("Dorothy")));
    await expect(page.getByRole("alert")).toHaveText(MEMBERFUL_SIGN_IN_PROBLEMS.off);

    // Whoever joined with a password signs in with it as they always did.
    await page.getByLabel("Email address").fill(joiner.emailAddress);
    await page.getByLabel("Password").fill(joiner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(composer(page)).toBeVisible();
  });
});

test.describe("Ways to join", () => {
  test("the administrator turns Memberful on beside the join link, then makes it members only once they confirm, which turns the join link off", async ({ page, request }) => {
    await giveKeys(request);
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const memberful = page.getByRole("switch", { name: "Memberful", exact: true });
    await memberful.click();
    await expect(memberful).toBeChecked();
    const link = page.getByRole("switch", { name: "Join link" });
    await expect(link).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Share to invite more people" })).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    const membersOnly = page.getByRole("switch", { name: "Members only", exact: true });
    await membersOnly.click();
    await expect(membersOnly).toBeChecked();
    await expect(link).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Share to invite more people" })).toHaveCount(0);

    // Turning Memberful off takes Members only with it.
    await memberful.click();
    await expect(membersOnly).toHaveCount(0);
    await expect(link).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Share to invite more people" })).toBeVisible();
  });
});

test.describe("Memberful memberships", () => {
  test("a member whose membership lapses is signed out, and signs in again once it's renewed", async ({ page, request }) => {
    const member = site.add(nameFor("Katherine"));
    await turnMemberful(request, true);
    await useOwnAddress(page);
    await page.goto("/");
    await signInWithMemberful(page, member);
    await expect(composer(page)).toBeVisible();

    // Memberful's webhook says it changed, and the Workspace asks Memberful's admin API, which says it lapsed.
    member.active = false;
    await sendWebhook(request, member);
    await expect(page.getByRole("link", { name: "Sign in with Memberful" })).toBeVisible();
    await signInWithMemberful(page, member);
    await expect(page.getByRole("alert")).toHaveText(MEMBERFUL_SIGN_IN_PROBLEMS.membership);

    member.active = true;
    await signInWithMemberful(page, member);
    await expect(composer(page)).toBeVisible();
  });
});

test.describe("Connect Memberful", () => {
  test("someone with an account from before connects their Memberful account from their profile, and signs in with it from then on", async ({ page, request }) => {
    await useOwnAddress(page);
    const joiner = await joinWithPassword(page, request, nameFor("Dorothy"));
    const member = site.add(joiner.name);
    await turnMemberful(request, true);

    await page.goto("/users/me/profile");
    const section = memberfulSection(page);
    await expect(section).toContainText("Members sign in with Memberful. Connect your Memberful account to keep signing in as yourself.");
    await section.getByLabel("Password").fill(joiner.password);
    await section.getByRole("button", { name: "Connect Memberful" }).click();
    await signInThereAs(page, member);
    await expect(page.getByRole("alert")).toHaveText("Your Memberful account is connected.");
    await expect(section).toContainText(`Connected to Memberful as ${member.fullName} (${member.email}), so you sign in with it.`);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/users/me/profile");

    // Signing in with Memberful is signing in as themselves, with the account they had.
    await logOut(page);
    await signInWithMemberful(page, member);
    await expect(composer(page)).toBeVisible();
    await page.goto("/users/me/profile");
    await expect(page.getByLabel("Email address")).toHaveValue(joiner.emailAddress);

    // Disconnecting it, with their password, leaves them signed in here and offers to connect one again.
    await section.getByLabel("Password").fill(joiner.password);
    await section.getByRole("button", { name: "Disconnect Memberful" }).click();
    await expect(page.getByRole("alert")).toHaveText("Your Memberful account is disconnected.");
    await expect(section).toContainText("Members sign in with Memberful. Connect your Memberful account to keep signing in as yourself.");
    await expect(page.getByLabel("Email address")).toHaveValue(joiner.emailAddress);
  });

  test("a member with an account from before connects Memberful as they sign in with their password", async ({ page, browser, baseURL, request }) => {
    const joining = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const joinPage = await joining.newPage();
    await useOwnAddress(joinPage);
    const joiner = await joinWithPassword(joinPage, request, nameFor("Mary"));
    await joining.close();
    // Memberful has their email address too, which never matches them to an account here.
    const member = site.add(joiner.name, joiner.emailAddress);
    await turnMemberful(request, true);

    await useOwnAddress(page);
    await page.goto("/users/me/profile");
    await signInWithMemberful(page, member);
    await expect(page.getByRole("alert")).toHaveText(MEMBERFUL_SIGN_IN_PROBLEMS.taken);
    await page.getByLabel("Email address").fill(joiner.emailAddress);
    await page.getByLabel("Password").fill(joiner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Members sign in with Memberful now. Connect your Memberful account to keep signing in as yourself.")).toBeVisible();
    await page.getByRole("link", { name: "Connect Memberful" }).click();
    await signInThereAs(page, member);

    // Signed in as themselves, on the page they were sent to sign in from.
    await expect(page.getByLabel("Email address")).toHaveValue(joiner.emailAddress);
    await expect(memberfulSection(page)).toContainText(`Connected to Memberful as ${member.fullName} (${joiner.emailAddress}), so you sign in with it.`);
  });
});

import { INVITATION_GONE, type WorkspaceSettings } from "@ember/protocol";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { ADMINISTRATOR, administratorSession, allowClipboard, cookieHeader, SAME_ORIGIN, sentFrom, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { forgetResendKey, giveResendKey, startFakeResend, type FakeResend, type SentEmail } from "./fake-resend";

// Membership's Invite by email card, and the page an invitation's link opens, on the second test server,
// which sends email with the Resend API the email specs fake, whose key each test gives Ember first. Each
// leaves the workspace as a new one is: no Resend API key, no From address, and no invitations waiting.

const FROM = "chat@acme.example";

let resend: FakeResend;
test.beforeAll(async () => void (resend = await startFakeResend()));
test.afterAll(() => resend.close());
test.beforeEach(({ request }) => giveResendKey(request));
test.afterEach(async ({ request }) => {
  await forgetResendKey(request);
  await giveFrom(request, null);
  await revokeInvitations(request);
});

/** The administrator's session's headers, for the API. */
async function asAdministrator(request: APIRequestContext) {
  return { Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN };
}

/** Gives the workspace the From address `emailFrom`, as the administrator. */
async function giveFrom(request: APIRequestContext, emailFrom: string | null): Promise<void> {
  const response = await request.patch("/api/account", { data: { emailFrom }, headers: await asAdministrator(request) });
  expect(response.status(), await response.text()).toBe(200);
}

/** Revokes every invitation no one has accepted, as the administrator. */
async function revokeInvitations(request: APIRequestContext): Promise<void> {
  const headers = await asAdministrator(request);
  const { invitations } = (await (await request.get("/api/account", { headers })).json()) as WorkspaceSettings;
  for (const { id } of invitations) expect((await request.delete(`/api/invitations/${id}`, { headers })).status()).toBe(204);
}

/** Invites `emailAddress`, as the administrator, from the API. */
async function invite(request: APIRequestContext, emailAddress: string): Promise<void> {
  const response = await request.post("/api/invitations", { data: { emailAddresses: [emailAddress] }, headers: await asAdministrator(request) });
  expect(response.status(), await response.text()).toBe(200);
}

/** A new address no one has, to invite. */
const newAddress = (name: string) => `${name}-${crypto.randomUUID()}@example.com`;

/** The link in an invitation email. */
const linkIn = (email: SentEmail) => /Join here: (\S+)/.exec(email.text)![1]!;

/** Whether `link` still opens the join form, as its page asks the server. */
async function works(request: APIRequestContext, link: string): Promise<boolean> {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  const response = await request.post("/api/email_links/lookup", { data: { token }, headers: SAME_ORIGIN });
  expect([200, 404], await response.text()).toContain(response.status());
  return response.ok();
}

/** Opens Membership as the administrator, answering its Invite by email card. */
async function openInvitations(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Invite by email" });
}

/** A page signed out, in a browser of its own, from an IP address of its own. */
async function signedOut(browser: Browser, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await useOwnAddress(page);
  return page;
}

/** Joins with the invitation `link` to `emailAddress` in a browser of its own, landing in the workspace. */
async function joinWith(browser: Browser, baseURL: string, link: string, emailAddress: string): Promise<void> {
  const newcomer = await signedOut(browser, baseURL);
  await newcomer.goto(link);
  await expect(newcomer.getByRole("heading", { level: 1 })).toHaveText(/^Join /);
  // The secret has left the address bar.
  await expect(newcomer).toHaveURL(`${baseURL}/join/invitation`);
  const address = newcomer.getByRole("textbox", { name: "Email address" });
  await expect(address).toHaveValue(emailAddress);
  await expect(address).not.toBeEditable();
  await newcomer.getByLabel("Name").fill("Hal");
  await newcomer.getByLabel("Password").fill("heuristically");
  await newcomer.getByRole("button", { name: "Create account" }).click();
  await expect(newcomer.getByRole("textbox", { name: "Write a message" })).toBeVisible();
  await newcomer.context().close();
}

test.describe("Invite people by email", () => {
  test("the administrator invites people, whom Ember emails a link each, then sends one again and revokes another", async ({ page, request, baseURL }) => {
    await giveFrom(request, FROM);
    const card = await openInvitations(page);
    await expect(card).toContainText("Ember emails each person a link to join with their address, whichever ways to join are on.");

    const hal = newAddress("hal");
    const ida = newAddress("ida");
    const sent = resend.sent.length;
    const addresses = card.getByRole("textbox", { name: "Email addresses" });
    await addresses.fill(`${hal}, "Ida" <${ida}>\n${ADMINISTRATOR.emailAddress}`);
    await card.getByRole("button", { name: "Send invitations" }).click();
    await expect(card.getByRole("status")).toHaveText(`Sent 2 invitations. ${ADMINISTRATOR.emailAddress} has an account already.`);
    await expect(addresses).toHaveValue("");
    const invitedYou = expect.stringMatching(new RegExp(`^${ADMINISTRATOR.name} invited you to `)) as unknown;
    const from = await sentFrom(request, FROM);
    expect(resend.sent.slice(sent)).toEqual([
      expect.objectContaining({ from, to: [hal], subject: invitedYou }),
      expect.objectContaining({ from, to: [ida], subject: invitedYou }),
    ]);
    const [halsLink, idasLink] = resend.sent.slice(sent).map(linkIn);
    expect(halsLink).toMatch(new RegExp(`^${baseURL}/join/invitation#token=[\\w-]{43}$`));

    const pending = card.getByRole("region", { name: "Pending invitations" }).getByRole("listitem");
    await expect(pending).toHaveText([new RegExp(`^${ida}Emailed · Invited by ${ADMINISTRATOR.name} · Expires `), new RegExp(`^${hal}Emailed · `)]);

    // Sending again emails a new link, and the old one stops working.
    await card.getByRole("button", { name: `Send again for ${hal}` }).click();
    await expect.poll(() => resend.sent.length).toBe(sent + 3);
    expect(resend.sent.at(-1)).toEqual(expect.objectContaining({ to: [hal], subject: invitedYou }));
    expect(linkIn(resend.sent.at(-1)!)).not.toBe(halsLink);
    expect(await works(request, halsLink!)).toBe(false);
    expect(await works(request, linkIn(resend.sent.at(-1)!))).toBe(true);
    await expect(pending.first()).toHaveText(new RegExp(`^${hal}Emailed · `));

    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: `Revoke the invitation for ${ida}` }).click();
    await expect(pending).toHaveText([new RegExp(`^${hal}`)]);
    expect(await works(request, idasLink!)).toBe(false);
  });

  test("without a From address, the administrator copies each new link to send themselves, and it joins", async ({ page, browser, request, baseURL }) => {
    const card = await openInvitations(page);
    await expect(card).toContainText("Ember can't send email yet, so you'll get each person's link to send them yourself.");
    const hal = newAddress("hal");
    const sent = resend.sent.length;
    await card.getByRole("textbox", { name: "Email addresses" }).fill(hal);
    await card.getByRole("button", { name: "Create invite links" }).click();
    await expect(card.getByRole("status")).toHaveText("Made 1 invite link. Copy each below and send it yourself.");
    expect(resend.sent).toHaveLength(sent);
    const row = card.getByRole("region", { name: "Pending invitations" }).getByRole("listitem").filter({ hasText: hal });
    await expect(row).toContainText(`Not emailed · Invited by ${ADMINISTRATOR.name} · Expires `);

    await allowClipboard(page.context());
    await row.getByRole("button", { name: `Copy the invite link for ${hal}` }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(new RegExp(`^${baseURL}/join/invitation#token=[\\w-]{43}$`));
    await joinWith(browser, baseURL!, link, hal);

    // Joining takes the invitation out of the list.
    const { invitations } = (await (await request.get("/api/account", { headers: await asAdministrator(request) })).json()) as WorkspaceSettings;
    expect(invitations.map(({ emailAddress }) => emailAddress)).not.toContain(hal);
  });
});

test.describe("Join with an invitation", () => {
  test("someone invited opens the link in their email, joins with the address it's for, and lands signed in, once", async ({ request, browser, baseURL }) => {
    await giveFrom(request, FROM);
    const hal = newAddress("hal");
    const sent = resend.sent.length;
    await invite(request, hal);
    expect(resend.sent.slice(sent)).toEqual([expect.objectContaining({ to: [hal] })]);
    const link = linkIn(resend.sent.at(-1)!);
    await joinWith(browser, baseURL!, link, hal);

    const latecomer = await signedOut(browser, baseURL!);
    await latecomer.goto(link);
    await expect(latecomer.getByText(INVITATION_GONE)).toBeVisible();
    await expect(latecomer.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new");
    await expect(latecomer).toHaveURL(`${baseURL}/join/invitation`);
    await latecomer.context().close();
  });
});

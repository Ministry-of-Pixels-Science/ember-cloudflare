import { SIGN_IN_LIMITED, type Directory } from "@ember/protocol";
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { ADMINISTRATOR, editorField, newAddress, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { join } from "./fixtures";

/** The sign-in page's heading, which names the workspace, which another test here may have renamed. */
const signInHeading = (tab: Page) => tab.getByRole("heading", { level: 1, name: /^Sign in to / });

test.describe("Make or revoke administrators", () => {
  test("the administrator makes someone an administrator, and a member again, and that person's pages follow at once", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const people = page.getByRole("region", { name: "Membership" });
    // Their own crown can't be pressed, so there's always an administrator.
    await expect(people.getByRole("listitem").filter({ hasText: "Ada Lovelace" }).getByRole("checkbox", { name: "Role: Administrator" })).toBeDisabled();

    // A server kept from an earlier run has had people join already.
    const name = `Grace ${crypto.randomUUID().slice(0, 8)}`;
    const grace = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), name);
    const rail = grace.getByRole("navigation", { name: "Workspace" });
    await rail.getByRole("link", { name: "Workspace" }).click();
    await grace.getByRole("link", { name: "Membership" }).click();
    const gracesPeople = grace.getByRole("region", { name: "Membership" });
    await expect(gracesPeople.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: name })).toBeVisible();
    await expect(grace.getByRole("checkbox")).toHaveCount(0);

    // The administrator's page lists them once it loads again.
    await page.reload();
    const row = people.getByRole("listitem").filter({ hasText: name });
    await expect(row.getByRole("checkbox", { name: "Role: Member" })).not.toBeChecked();
    await row.locator("label").click();
    await expect(row.getByRole("checkbox", { name: "Role: Administrator" })).toBeChecked();
    // Under Admins, its crown keeping the focus.
    await expect(people.getByRole("list", { name: "Admins" }).getByRole("listitem").filter({ hasText: name })).toBeVisible();
    await expect(row.getByRole("checkbox")).toBeFocused();

    // Their page follows without being loaded again: the rail's Admin, the administrators' pages, and crowns.
    await expect(rail.getByRole("link", { name: "Admin" })).toBeVisible();
    await expect(grace.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Chat bots" })).toBeVisible();
    await expect(grace.getByRole("button", { name: "Regenerate join link" })).toBeVisible();
    await expect(gracesPeople.getByRole("list", { name: "Admins" }).getByRole("listitem").filter({ hasText: name }).getByRole("checkbox")).toBeDisabled();

    await page.reload();
    await expect(row.getByRole("checkbox", { name: "Role: Administrator" })).toBeChecked();
    await row.locator("label").click();
    await expect(row.getByRole("checkbox", { name: "Role: Member" })).not.toBeChecked();
    await expect(rail.getByRole("link", { name: "Workspace" })).toBeVisible();
    await expect(grace.getByRole("link", { name: "Chat bots" })).toHaveCount(0);
    await expect(grace.getByRole("checkbox")).toHaveCount(0);
    await grace.context().close();
  });
});

test.describe("Welcome someone who joins", () => {
  test("starts a DM with each person here as someone joins, which opens with their having joined, and which they see once someone writes in it", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const joinUrl = await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue();
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(editorField(page, "Write a message")).toBeVisible();

    const name = `Grace ${crypto.randomUUID().slice(0, 8)}`;
    const grace = await join(browser, baseURL!, joinUrl, name);
    // The administrator's sidebar lists it as it starts, with her active, as her tab is in use.
    const withGrace = page.getByRole("region", { name: "DMs" }).getByRole("link", { name: `Direct message with ${name}`, exact: true });
    await expect(withGrace).toHaveAccessibleDescription("Active");
    await expect(withGrace.locator("[data-presence]")).toHaveAttribute("data-presence", "active");
    await withGrace.click();
    const joined = page.getByRole("log").getByRole("article").first();
    await expect(joined.getByRole("heading", { level: 3 })).toContainText(name);
    await expect(joined).toContainText(/joined /);

    // Hers waits for a message, then counts it.
    const withAda = grace.getByRole("region", { name: "DMs" }).getByRole("link", { name: `Direct message with ${ADMINISTRATOR.name}`, exact: true });
    await expect(withAda).toHaveCount(0);
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially("Welcome aboard!");
    await composer.press("Enter");
    await expect(withAda).toHaveAccessibleDescription("Active 1 unread message");
    await expect(withAda.getByText("1", { exact: true })).toBeVisible();
    await withAda.click();
    await expect(grace.getByRole("log").getByRole("article").first()).toContainText(/joined /);
    await expect(grace.getByRole("log")).toContainText("Welcome aboard!");
    await expect(withAda).toHaveAccessibleDescription("Active");
    await grace.context().close();
  });
});

test.describe("Remove someone from the workspace", () => {
  test("the administrator removes someone after asking, and that person's pages go to sign in at once", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const people = page.getByRole("region", { name: "Membership" });
    await expect(people.getByRole("listitem").filter({ hasText: "Ada Lovelace" })).toBeVisible();
    await expect(people.getByRole("listitem").filter({ hasText: "Ada Lovelace" }).getByRole("button", { name: /^Delete/ })).toHaveCount(0);

    const name = `Grace ${crypto.randomUUID().slice(0, 8)}`;
    const grace = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), name);
    // A tab showing a page that isn't a room, which only the workspace socket tells.
    const graceSettings = await grace.context().newPage();
    await graceSettings.goto("/account/edit#membership-settings");
    await expect(graceSettings.getByRole("region", { name: "Membership" }).getByRole("listitem").filter({ hasText: name })).toBeVisible();

    await page.reload();
    const row = people.getByRole("listitem").filter({ hasText: name });
    page.once("dialog", (dialog) => void dialog.dismiss());
    await row.getByRole("button", { name: `Delete ${name}` }).click();
    await expect(row.getByRole("button", { name: `Delete ${name}` })).toBeEnabled();

    const asked = new Promise<string>((resolve) =>
      page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await row.getByRole("button", { name: `Delete ${name}` }).click();
    expect(await asked).toBe("Are you sure you want to permanently remove this person from the account? This can’t be undone.");
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    for (const tab of [grace, graceSettings]) {
      await expect(signInHeading(tab)).toBeVisible();
      await expect(tab).toHaveURL(/\/session\/new$/);
    }
    await graceSettings.goto("/account/edit");
    await expect(signInHeading(graceSettings)).toBeVisible();
    await page.reload();
    await expect(people.getByRole("listitem").filter({ hasText: "Ada Lovelace" })).toBeVisible();
    await expect(row).toHaveCount(0);
    await grace.context().close();
  });
});

test.describe("Ban and unban people", () => {
  test("the administrator bans someone from their page after asking, signing them out and deleting their messages, and lifts the ban", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const name = `Grace ${crypto.randomUUID().slice(0, 8)}`;
    // From an address of her own, a public one, which a ban can block.
    const grace = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), name);
    const text = `Cheap watches ${crypto.randomUUID().slice(0, 8)}`;
    const composer = editorField(grace, "Write a message");
    await composer.fill(text);
    await composer.press("Enter");
    const message = (tab: Page) => tab.getByRole("article").filter({ hasText: text });
    await expect(message(grace)).toBeVisible();
    // The administrator has the room open in another tab.
    const room = await page.context().newPage();
    await room.goto(new URL(grace.url()).pathname);
    await expect(message(room)).toBeVisible();

    const { users } = (await (await page.request.get("/api/users")).json()) as Directory;
    await page.goto(`/users/${users.find((user) => user.name === name)!.id}`);
    const ban = page.getByRole("button", { name: `Ban ${name}` });
    page.once("dialog", (dialog) => void dialog.dismiss());
    await ban.click();
    await expect(ban).toBeEnabled();

    const asked = new Promise<string>((resolve) =>
      page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await ban.click();
    expect(await asked).toBe("Are you sure you want to ban this user? This will log them out, delete their messages, and block their IP addresses.");
    const unban = page.getByRole("button", { name: "Remove ban" });
    await expect(unban).toBeVisible();
    await expect(page.getByRole("img", { name: "Profile avatar" })).toHaveClass(/opacity-50/);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Her tab goes to sign in at once, and her message leaves the room where it's open, and for good.
    await expect(signInHeading(grace)).toBeVisible();
    await expect(message(room)).toHaveCount(0);
    await room.reload();
    await expect(room.getByRole("log")).not.toHaveAttribute("aria-busy");
    await expect(message(room)).toHaveCount(0);

    const unasked = new Promise<string>((resolve) =>
      page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await unban.click();
    expect(await unasked).toBe("Are you sure you want to remove the ban on this user?");
    await expect(ban).toBeVisible();
    await expect(page.getByRole("img", { name: "Profile avatar" })).not.toHaveClass(/opacity-50/);
    await page.reload();
    await expect(ban).toBeVisible();
    await grace.context().close();
  });
});

/** The status of the request to change something at an address ending in `path` that `act` has `tab` send. */
async function statusOfChange(tab: Page, path: string, act: () => Promise<unknown>): Promise<number> {
  const response = tab.waitForResponse((response) => response.request().method() !== "GET" && new URL(response.url()).pathname.endsWith(path));
  await act();
  return (await response).status();
}

test.describe("What a ban blocks", () => {
  // Browsers don't send a test's address when they open a WebSocket (see `useOwnAddress`), so the
  // Worker's tests cover what a banned address's room sockets can do.
  test("nobody at a banned address can sign in or change anything, though they can still read, until the ban is lifted", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const joinUrl = await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue();
    const tag = crypto.randomUUID().slice(0, 8);
    // Hal joins from Grace's address, as someone on her network would, and someone else there is about to sign in.
    const shared = newAddress();
    const graceName = `Grace ${tag}`;
    const grace = await join(browser, baseURL!, joinUrl, graceName, shared);
    const hal = await join(browser, baseURL!, joinUrl, `Hal ${tag}`, shared);
    const visitor = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
    await useOwnAddress(visitor, shared);
    await visitor.goto("/session/new");
    const star = hal.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Favorite room" });

    const { users } = (await (await page.request.get("/api/users")).json()) as Directory;
    await page.goto(`/users/${users.find((user) => user.name === graceName)!.id}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: `Ban ${graceName}` }).click();
    await expect(page.getByRole("button", { name: "Remove ban" })).toBeVisible();
    await expect(signInHeading(grace)).toBeVisible();

    // Hal's room still loads, but starring it is refused, and so is signing in there.
    await hal.reload();
    await expect(hal.getByRole("log")).not.toHaveAttribute("aria-busy");
    expect(await statusOfChange(hal, "/favorite", () => star.click())).toBe(429);
    await expect(hal.getByRole("status").filter({ hasText: "Couldn’t save your favorite. Please try again." })).toBeVisible();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    expect(await statusOfChange(visitor, "/api/session", () => signInAsAdministrator(visitor))).toBe(429);
    // As if they'd tried too often.
    await expect(visitor.getByRole("alert")).toHaveText(SIGN_IN_LIMITED);

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Remove ban" }).click();
    await expect(page.getByRole("button", { name: `Ban ${graceName}` })).toBeVisible();
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await signInAsAdministrator(visitor);
    await expect(visitor.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", ADMINISTRATOR.name);
    for (const tab of [grace, hal, visitor]) await tab.context().close();
  });
});

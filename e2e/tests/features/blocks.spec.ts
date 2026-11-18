import { notTakingDirects } from "@ember/protocol";
import type { Locator, Page } from "@playwright/test";
import { expect, startDirect, test, unique, type Member } from "./fixtures";

/** What a message from someone you've blocked collapses to, a button that shows it. */
const COLLAPSED = "Message from someone you blocked";

/** The collapsed messages on `member`'s page. */
const collapsed = (member: Member) => member.page.getByRole("button", { name: COLLAPSED });

/** Hovers the message that says `text`, then clicks Message options, the bar's last button, and returns More actions. */
async function openMoreActions(member: Member, text: string): Promise<Locator> {
  await member.actions(text);
  await member.message(text).getByRole("button", { name: "Message options" }).click();
  return member.message(text).getByRole("group", { name: "More actions" });
}

/** Opens `other`'s page on `member`'s and waits for it to show them. */
async function openPage(member: Member, other: Member): Promise<void> {
  await member.page.goto(`/users/${other.session.user.id}`);
  await expect(member.page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(other.name);
}

/** Opens your profile from the rail and waits for it to load. */
async function openYourProfile(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).click();
  await expect(page).toHaveURL(/\/users\/me\/profile$/);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
}

/** `member`'s sidebar row for their DM with `other`. */
const directRow = (member: Member, other: Member) =>
  member.page.getByRole("region", { name: "DMs" }).getByRole("link", { name: `Direct message with ${other.name}`, exact: true });

test.describe("Block someone", () => {
  test("collapses their messages from More actions, which a tap shows, and Unblock on your profile shows them again", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"));
    await grace.send("Hello from Grace");
    await expect(ada.message("Hello from Grace")).toContainText(grace.name);

    const actions = await openMoreActions(ada, "Hello from Grace");
    await actions.getByRole("button", { name: `Block ${grace.name}` }).click();
    await expect(collapsed(ada)).toHaveCount(1);
    await expect(ada.message("Hello from Grace")).toHaveCount(0);
    // As the message collapses, the composer takes focus.
    await expect(ada.composer()).toBeFocused();

    // What Grace writes next collapses as it comes, and nothing tells her.
    await grace.send("Are you there?");
    await expect(collapsed(ada)).toHaveCount(2);
    await expect(grace.message("Hello from Grace")).toBeVisible();
    await expect(collapsed(grace)).toHaveCount(0);

    // A tap shows one, saying whose it is.
    await collapsed(ada).first().click();
    await expect(ada.message("Hello from Grace")).toContainText(grace.name);
    await expect(collapsed(ada)).toHaveCount(1);

    await openYourProfile(ada.page);
    const blocked = ada.page.getByRole("region", { name: "Blocked people" });
    await expect(blocked.getByRole("link", { name: grace.name })).toHaveAttribute("href", `/users/${grace.session.user.id}`);
    await blocked.getByRole("button", { name: `Unblock ${grace.name}` }).click();
    await expect(blocked).toHaveCount(0);
    await ada.page.getByRole("link", { name: "Go Back" }).click();
    // Grouped again, as two messages in a row from one person are.
    await expect(ada.message("Hello from Grace")).toContainText(grace.name);
    await expect(ada.message("Are you there?")).toBeVisible();
    await expect(collapsed(ada)).toHaveCount(0);
  });

  test("blocks someone from their page, taking your DM with them from your sidebar until you unblock them", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"));
    await startDirect(request, grace, [ada]);
    await expect(directRow(ada, grace)).toBeVisible();

    await openPage(ada, grace);
    const main = ada.page.getByRole("main");
    await main.getByRole("button", { name: `Block ${grace.name}` }).click();
    await expect(main.getByRole("button", { name: `Unblock ${grace.name}` })).toBeVisible();
    await expect(main.getByRole("button", { name: `Ping ${grace.name}` })).toHaveCount(0);
    await expect(directRow(ada, grace)).toHaveCount(0);
    // Grace keeps hers.
    await expect(directRow(grace, ada)).toBeVisible();

    await main.getByRole("button", { name: `Unblock ${grace.name}` }).click();
    await expect(main.getByRole("button", { name: `Ping ${grace.name}` })).toBeVisible();
    await expect(directRow(ada, grace)).toBeVisible();
  });

  test("refuses a new DM from someone you've blocked, as if you weren't taking DMs", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const linus = await members.signIn(unique("Linus"));
    await openPage(ada, linus);
    await ada.page.getByRole("main").getByRole("button", { name: `Block ${linus.name}` }).click();
    await expect(ada.page.getByRole("main").getByRole("button", { name: `Unblock ${linus.name}` })).toBeVisible();

    await openPage(linus, ada);
    await linus.page.getByRole("button", { name: `Ping ${ada.name}` }).click();
    await expect(linus.page.getByRole("alert")).toHaveText(notTakingDirects(ada.name));
    await expect(linus.page).toHaveURL(new RegExp(`/users/${ada.session.user.id}$`));
    await expect(directRow(ada, linus)).toHaveCount(0);
  });
});

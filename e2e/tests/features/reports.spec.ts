import type { Locator, Page } from "@playwright/test";
import { expect, test, unique, type Member } from "./fixtures";

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

/** Opens Membership from the rail's Admin link, as an administrator does, and returns its Reports list once it loads. */
async function openReports(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Admin" }).click();
  await page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Membership" }).click();
  const reports = page.getByRole("region", { name: /^Reports/ });
  await expect(reports).toBeVisible();
  await expect(reports).not.toHaveAttribute("aria-busy");
  return reports;
}

/** Sends the report Report asks for, why as `reason` says, with `note`. */
async function report(dialog: Locator, reason: string, note = ""): Promise<void> {
  await dialog.getByRole("radio", { name: reason }).check();
  if (note) await dialog.getByRole("textbox", { name: "Details (optional)" }).fill(note);
  await dialog.getByRole("button", { name: "Report", exact: true }).click();
}

/** The report handled last that `reports` lists as handled and has `text`, with its list opened. */
async function handled(reports: Locator, text: string): Promise<Locator> {
  const summary = reports.getByText(/^Handled \(\d+\)$/);
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click();
  return reports.getByRole("list", { name: "Handled reports" }).getByRole("listitem").filter({ hasText: text });
}

test.describe("Report a message or someone", () => {
  test("reports someone's message from More actions, which an administrator's Membership lists as it comes and who deletes it", async ({ members, rooms }) => {
    const ada = await members.signIn(unique("Ada"), { administrator: true });
    const grace = await members.signIn(unique("Grace"));
    const linus = await members.signIn(unique("Linus"));
    const text = unique("Buy my course");
    await grace.send(text);
    await expect(linus.message(text)).toContainText(grace.name);
    const reports = await openReports(ada.page);

    const actions = await openMoreActions(linus, text);
    await actions.getByRole("button", { name: "Report message" }).click();
    const dialog = linus.page.getByRole("dialog", { name: "Report message" });
    await expect(dialog).toHaveAccessibleDescription(`The administrators will see ${grace.name}’s message as it is now. Nobody is told who reported it.`);
    await expect(dialog.getByRole("radio", { name: "Spam" })).toBeFocused();
    await report(dialog, "Spam", "In every room");
    const reported = linus.page.getByRole("dialog", { name: "Reported" });
    await expect(reported).toHaveAccessibleDescription("The administrators will take a look.");
    await expect(reported).toContainText(ada.name);
    await expect(reported.getByRole("button", { name: `Block ${grace.name}` })).toBeVisible();
    await reported.getByRole("button", { name: "Done" }).click();
    await expect(reported).toHaveCount(0);
    await expect(linus.composer()).toBeFocused();

    // Ada's list loads it as the count of open reports changes, and the rail and Membership count them.
    const graces = reports.getByRole("listitem", { name: `Report of ${grace.name}` }).filter({ hasText: text });
    await expect(graces).toContainText(`SpamReported by ${linus.name}`);
    await expect(graces).toContainText("“In every room”");
    await expect(graces).toContainText(`${grace.name} in ${rooms.general.name}`);
    await expect(ada.page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Membership" })).toHaveAccessibleDescription(/^\d+ open reports?$/);
    await expect(ada.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Admin" })).toHaveAccessibleDescription(/\d+ open reports?$/);

    ada.page.once("dialog", (dialog) => void dialog.accept());
    await graces.getByRole("button", { name: "Delete message" }).click();
    await expect(graces).toHaveCount(0);
    await expect(grace.message(text)).toHaveCount(0);
    await expect(linus.message(text)).toHaveCount(0);
    await expect(await handled(reports, text)).toContainText("Message deleted by you");
  });

  test("reports someone from their page, blocking them too, and an administrator dismisses it", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"), { administrator: true });
    const grace = await members.signIn(unique("Grace"));
    const linus = await members.signIn(unique("Linus"));

    await openPage(linus, grace);
    const main = linus.page.getByRole("main");
    await main.getByRole("button", { name: `Report ${grace.name}` }).click();
    const dialog = linus.page.getByRole("dialog", { name: `Report ${grace.name}` });
    await expect(dialog).toHaveAccessibleDescription("For their name, picture or bio. Nobody is told who reported them.");
    await report(dialog, "Harassment");
    const reported = linus.page.getByRole("dialog", { name: "Reported" });
    await reported.getByRole("button", { name: `Block ${grace.name}` }).click();
    await expect(reported).toHaveCount(0);
    await expect(main.getByRole("button", { name: `Unblock ${grace.name}` })).toBeVisible();
    await expect(main.getByRole("button", { name: `Report ${grace.name}` })).toBeFocused();

    const reports = await openReports(ada.page);
    const graces = reports.getByRole("listitem", { name: `Report of ${grace.name}` }).filter({ hasText: `Reported by ${linus.name}` });
    await expect(graces).toContainText("Harassment");
    await expect(graces).toContainText("No bio");
    await expect(graces.getByRole("link", { name: grace.name })).toHaveAttribute("href", `/users/${grace.session.user.id}`);
    await graces.getByRole("button", { name: "Dismiss" }).click();
    await expect(graces).toHaveCount(0);
    await expect(await handled(reports, `Reported by ${linus.name}`)).toContainText("Dismissed by you");
  });
});

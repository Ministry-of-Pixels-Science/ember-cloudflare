import { CURRENT_PASSWORD_WRONG, DELETION_NAME_NEEDED, SIGN_IN_REJECTED } from "@ember/protocol";
import type { Page } from "@playwright/test";
import { ADMINISTRATOR, drawnPicture, nextSecond, shownPicture, useOwnAddress, variantType } from "../../fixtures";
import { expect, test } from "./fixtures";

const unique = (name: string) => `${name} ${crypto.randomUUID().slice(0, 8)}`;

/** Opens your profile from the rail and waits for it to load. */
async function openYourProfile(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).click();
  await expect(page).toHaveURL(/\/users\/me\/profile$/);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
}

test.describe("Edit your profile", () => {
  test("saves your name, email address, password and bio, and everyone's open pages show the new name at once", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"));
    await ada.send("Hello from Ada");
    await expect(grace.message("Hello from Ada")).toContainText(ada.name);

    const { page } = ada;
    await openYourProfile(page);
    await expect(page).toHaveTitle(ada.name);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(ada.name);
    // Someone who joined with just a name has no email address or bio yet.
    await expect(page.getByLabel("Email address")).toHaveValue("");
    await expect(page.getByLabel("Bio")).toHaveValue("");

    const newName = unique("Ada King");
    const emailAddress = `ada-${crypto.randomUUID()}@example.com`;
    await page.getByLabel("Name", { exact: true }).fill(newName);
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("New password").fill("difference engine");
    await page.getByLabel("Bio").fill("Wrote the first program");
    await page.getByRole("button", { name: "Save changes" }).click();
    // The flash's check, read as "Changes saved".
    await expect(page.getByRole("alert")).toHaveText("Changes saved");
    await expect(page.getByLabel("New password")).toHaveValue("");
    await expect(page).toHaveTitle(newName);
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", newName);
    await expect(grace.message("Hello from Ada")).toContainText(newName);

    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(newName);
    await expect(page.getByLabel("Email address")).toHaveValue(emailAddress);
    await expect(page.getByLabel("Bio")).toHaveValue("Wrote the first program");

    // The email address and password sign them in once they log out.
    await useOwnAddress(page);
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/session\/new$/);
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("Password").fill("difference engine");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", newName);
  });

  test("asks for your current password to change your email address or password once you have one", async ({ members }) => {
    const { page } = await members.signIn(unique("Ada"));
    // Checking a password counts against sign-in's limit for the address it comes from.
    await useOwnAddress(page);
    await openYourProfile(page);
    const current = page.getByLabel("Current password");
    const save = page.getByRole("button", { name: "Save changes" });
    // Someone who joined with just a name has none to ask for, until they save one.
    await expect(current).toHaveCount(0);
    await page.getByLabel("New password").fill("difference engine");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved");
    await expect(current).toBeVisible();

    await page.getByLabel("Email address").fill(`ada-${crypto.randomUUID()}@example.com`);
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Enter your current password to change your email address or password.");
    await current.fill("analytical engine");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("That isn't your current password.");
    await current.fill("difference engine");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved");
    await expect(current).toHaveValue("");
  });

  test("says when someone else has the email address, saving nothing", async ({ members }) => {
    const { page } = await members.signIn("Grace");
    await openYourProfile(page);
    await page.getByLabel("Email address").fill(ADMINISTRATOR.emailAddress);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText("That email address has an account already");
    await expect(page.getByLabel("Email address")).toHaveValue(ADMINISTRATOR.emailAddress);

    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Email address")).toHaveValue("");
  });

  test("goes back to the room it was opened from, or home when opened by its address", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    await openYourProfile(ada.page);
    await ada.page.getByRole("link", { name: "Go Back" }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await ada.connected();

    await ada.page.goto("/users/me/profile");
    await expect(ada.page.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/");
  });
});

test.describe("Upload an avatar", () => {
  test("changes your avatar from your profile, everywhere it shows at once, and removes it", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"));
    await ada.send("Portrait check");
    // Ada's avatar on her message, as Grace sees it.
    const gracesView = grace.message("Portrait check").locator("img[aria-hidden=true]").first();

    const { page } = ada;
    await openYourProfile(page);
    const avatar = page.getByRole("img", { name: "Your avatar" });
    const remove = page.getByRole("button", { name: "Remove avatar" });
    const initials = await avatar.getAttribute("src");
    await expect(page.getByText("Choose a profile photo")).toBeVisible();
    await expect(remove).toHaveCount(0);

    await nextSecond();
    await page.getByLabel("Upload avatar").setInputFiles(await drawnPicture(page, "portrait.png", 1200, 800));
    await expect(page.getByRole("alert")).toHaveText("It may take up to 30 minutes to change everywhere.");
    await expect(avatar).toHaveAttribute("src", /^\/users\/[^/]+\/avatar\?v=\d{14}$/);
    await expect(avatar).not.toHaveAttribute("src", initials!);
    // The variant Ada's browser made of it, within 512×512.
    const variant = { type: await variantType(page), width: 512, height: 341 };
    expect(await shownPicture(avatar)).toEqual(variant);
    const uploaded = (await avatar.getAttribute("src"))!;
    await expect(gracesView).toHaveAttribute("src", uploaded);
    expect(await shownPicture(gracesView)).toEqual(variant);

    await nextSecond();
    await remove.click();
    await expect(remove).toHaveCount(0);
    await expect(avatar).not.toHaveAttribute("src", uploaded);
    expect(await shownPicture(avatar)).toMatchObject({ type: expect.stringMatching(/^image\/svg\+xml/) });
    await expect(gracesView).toHaveAttribute("src", (await avatar.getAttribute("src"))!);

    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
    await expect(remove).toHaveCount(0);
    expect(await shownPicture(avatar)).toMatchObject({ type: expect.stringMatching(/^image\/svg\+xml/) });
  });

  test("crops a photo taller than it's wide to the avatar's square", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"), { context: { viewport: { width: 1280, height: 800 } } });
    await ada.send("Tall portrait check");
    const gracesView = grace.message("Tall portrait check").locator("img[aria-hidden=true]").first();

    await openYourProfile(ada.page);
    await nextSecond();
    await ada.page.getByLabel("Upload avatar").setInputFiles(await drawnPicture(ada.page, "tall.png", 800, 1200));
    await expect(ada.page.getByRole("alert")).toHaveText("It may take up to 30 minutes to change everywhere.");
    await expect(gracesView).toHaveAttribute("src", (await ada.page.getByRole("img", { name: "Your avatar" }).getAttribute("src"))!);
    expect(await shownPicture(gracesView)).toEqual({ type: await variantType(ada.page), width: 341, height: 512 });

    // The picture fills its link, a message's 36px square, rather than running below it.
    const shown = await gracesView.boundingBox();
    expect(shown).toMatchObject({ width: 36, height: 36 });
    expect(await gracesView.locator("..").boundingBox()).toEqual(shown);
    await expect(gracesView).toHaveCSS("object-fit", "cover");
  });
});

test.describe("Delete my account", () => {
  /** What the sign-in page says once your account is deleted. */
  const deleted = "Your account is deleted. It can take a few minutes for your messages to leave every room.";

  test("deletes your account once you type your name, taking your messages from everyone's open pages, and signs you out", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"));
    await ada.send("Goodbye from Ada");
    await expect(grace.message("Goodbye from Ada")).toContainText(ada.name);

    const { page } = ada;
    await openYourProfile(page);
    const section = page.getByRole("region", { name: "Delete my account" });
    await expect(section).toContainText("It can't be undone");
    const deleteButton = section.getByRole("button", { name: "Delete my account" });
    await deleteButton.click();
    // Someone who joined with just a name has no password to give, so they type their name.
    const name = section.getByLabel(`Type your name, ${ada.name}, to delete your account`);
    await expect(name).toBeFocused();
    await name.fill(unique("Ada"));
    await deleteButton.click();
    await expect(page.getByRole("alert")).toHaveText(DELETION_NAME_NEEDED);
    await expect(name).toHaveValue("");

    await name.fill(ada.name);
    await deleteButton.click();
    await expect(page).toHaveURL(/\/session\/new$/);
    await expect(page.getByRole("alert")).toHaveText(deleted);
    // As the Workspace gets to each room Ada was in, which every test's open rooms make many.
    await expect(grace.message("Goodbye from Ada")).toHaveCount(0, { timeout: 30_000 });

    // Ada's sessions went with the account.
    await page.goto("/");
    await expect(page).toHaveURL(/\/session\/new$/);
  });

  test("asks for your password once you have one, which then signs nobody in", async ({ members }) => {
    const { page } = await members.signIn(unique("Ada"));
    // Checking a password counts against sign-in's limit for the address it comes from.
    await useOwnAddress(page);
    await openYourProfile(page);
    const emailAddress = `ada-${crypto.randomUUID()}@example.com`;
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("New password").fill("difference engine");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved");

    const section = page.getByRole("region", { name: "Delete my account" });
    await section.getByRole("button", { name: "Delete my account" }).click();
    const password = section.getByLabel("Your password");
    await expect(password).toBeFocused();
    await password.fill("analytical engine");
    await password.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(CURRENT_PASSWORD_WRONG);
    await expect(password).toHaveValue("");
    await password.fill("difference engine");
    await password.press("Enter");
    await expect(page).toHaveURL(/\/session\/new$/);
    await expect(page.getByRole("alert")).toHaveText(deleted);

    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("Password").fill("difference engine");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(SIGN_IN_REJECTED);
  });
});

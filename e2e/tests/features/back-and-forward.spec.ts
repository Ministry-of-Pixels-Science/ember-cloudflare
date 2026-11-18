import type { Page } from "@playwright/test";
import { signInAs } from "../../fixtures";
import { expect, Member, test } from "./fixtures";

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** The rail's Back and Forward, at its top. */
const arrows = (page: Page, { includeHidden = false } = {}) => {
  const rail = page.getByRole("navigation", { name: "Workspace" });
  return {
    back: rail.getByRole("button", { name: "Back", exact: true, includeHidden }),
    forward: rail.getByRole("button", { name: "Forward", exact: true, includeHidden }),
  };
};

const at = (path: string) => new RegExp(`${path}$`);

/** Opens `name` from the sidebar's rooms. */
const openRoom = (member: Member, name: string) => member.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: new RegExp(name) }).click();

test.describe("Back and Forward", () => {
  test("step back and on through the rooms and pages shown, but never out of Ember", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const { back, forward } = arrows(ada.page);
    const heading = ada.page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("general");
    // The first page this tab showed of Ember has none of Ember's behind it.
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    await openRoom(ada, "random");
    await expect(heading).toHaveText("random");
    await ada.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" }).click();
    await expect(ada.page).toHaveURL(/\/account\/edit$/);
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect(heading).toHaveText("random");
    await expect(forward).toBeEnabled();
    await back.click();
    await expect(ada.page).toHaveURL(at(`/rooms/${rooms.general.id}`));
    await expect(heading).toHaveText("general");
    await expect(back).toBeDisabled();

    await forward.click();
    await expect(heading).toHaveText("random");
    await forward.click();
    await expect(ada.page).toHaveURL(/\/account\/edit$/);
    await expect(forward).toBeDisabled();
  });

  test("keep both through a reload, and on the pages Back and Forward go to after one", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const { back, forward } = arrows(ada.page);
    const heading = ada.page.getByRole("heading", { level: 1 });
    await openRoom(ada, "random");
    await expect(heading).toHaveText("random");
    await back.click();
    await expect(heading).toHaveText("general");

    await ada.page.reload();
    await expect(heading).toHaveText("general");
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(ada.page).toHaveURL(at(`/rooms/${rooms.random.id}`));
    await expect(heading).toHaveText("random");
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await ada.page.reload();
    await expect(heading).toHaveText("random");
    await back.click();
    await expect(heading).toHaveText("general");
    await expect(forward).toBeEnabled();
  });

  test("ask before leaving a room's changed settings, as the browser's Back does", async ({ page, rooms, session }) => {
    // As the person who made this test's rooms, who can change them.
    await signInAs(page, session);
    await page.goto(`/rooms/${rooms.general.id}`);
    await new Member(page, session).connected();
    await page.getByRole("link", { name: "Settings for this room" }).click();
    const name = page.getByRole("textbox", { name: "Room name" });
    await name.fill("Working draft");
    const unsaved = page.getByRole("dialog", { name: "Unsaved Changes" });
    const { back, forward } = arrows(page);

    await back.click();
    await expect(unsaved).toBeVisible();
    await expect(page).toHaveURL(at(`/rooms/opens/${rooms.general.id}/edit`));
    await unsaved.getByRole("button", { name: "Keep editing" }).click();
    await expect(name).toHaveValue("Working draft");
    await expect(forward).toBeDisabled();

    await back.click();
    await unsaved.getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(at(`/rooms/${rooms.general.id}`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(forward).toBeEnabled();
  });

  test("name themselves and the browser's keys for them in their tooltips", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const { back, forward } = arrows(ada.page);
    await expect(back).toHaveAttribute("aria-keyshortcuts", /^(Meta\+\[|Alt\+ArrowLeft)$/);
    await expect(forward).toHaveAttribute("aria-keyshortcuts", /^(Meta\+\]|Alt\+ArrowRight)$/);
    await openRoom(ada, "random");
    await back.hover();
    await expect(ada.page.getByRole("tooltip")).toHaveText(/^Back\s*(⌘\s*\[|Alt\s*←)$/);
  });

  test("stay out of a phone's drawer, since fingers have their own way back", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    await ada.page.getByRole("button", { name: "Open conversations" }).click();
    const drawer = ada.page.getByRole("dialog", { name: "Conversations" });
    await expect(drawer.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Home", exact: true })).toBeVisible();
    const { back, forward } = arrows(ada.page, { includeHidden: true });
    await expect(back).toBeAttached();
    await expect(back).toBeHidden();
    await expect(forward).toBeHidden();
  });
});

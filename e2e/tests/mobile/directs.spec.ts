import type { Sidebar, SidebarRoom } from "@ember/protocol";
import { openRoom, signInAs } from "../../fixtures";
import { settle } from "./audits";
import { expect, hasDrawerLayout, test } from "./fixtures";

test.beforeEach(async ({ page, session, room }) => {
  await signInAs(page, session);
  await openRoom(page, room);
});

test.describe("New direct message dialog", () => {
  test("New direct message fits, with someone picked, and Cancel closes it", async ({ page, room, screenIsFine }) => {
    await page.goto("/rooms/directs/new");
    const dialog = page.getByRole("dialog", { name: "New direct message" });
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}$`));
    await expect(dialog).toBeVisible();
    await dialog.getByRole("option").first().tap();
    await expect(dialog.getByRole("group", { name: "Selected people" })).toBeVisible();
    await settle(page);
    await screenIsFine();
    await dialog.getByRole("button", { name: "Cancel" }).tap();
    await expect(dialog).toBeHidden();
  });

  test("New direct message opens from the drawer, which closes, and gives focus back to the menu button", async ({ page }) => {
    test.skip(!hasDrawerLayout(page), "Wider than 900px the rail and sidebar are always on screen");
    const menu = page.getByRole("button", { name: "Open conversations" });
    await menu.tap();
    await page.getByRole("dialog", { name: "Conversations" }).getByRole("link", { name: "DMs" }).tap();
    const dialog = page.getByRole("dialog", { name: "New direct message" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Conversations" })).toBeHidden();
    await expect(dialog.getByRole("combobox", { name: "Search people" })).toBeFocused();
    await dialog.getByRole("button", { name: "Close" }).tap();
    await expect(dialog).toBeHidden();
    await expect(menu).toBeFocused();
  });

  test("New direct message, opened from the drawer, keeps focus and what's typed as the drawer goes", async ({ page }) => {
    test.skip(!hasDrawerLayout(page), "Wider than 900px the rail and sidebar are always on screen");
    await page.getByRole("button", { name: "Open conversations" }).tap();
    // Where focus is sent each time it leaves something: the dialog's focus trap can turn it back before it gets there.
    await page.evaluate(() => {
      const sentTo: (string | null)[] = ((window as unknown as { sentTo: (string | null)[] }).sentTo = []);
      document.addEventListener("focusout", (event) => sentTo.push((event.relatedTarget as Element | null)?.getAttribute("aria-label") ?? null));
    });
    await page.getByRole("dialog", { name: "Conversations" }).getByRole("link", { name: "DMs" }).tap();
    const search = page.getByRole("dialog", { name: "New direct message" }).getByRole("combobox", { name: "Search people" });
    await expect(search).toBeFocused();
    await page.keyboard.type("Ad");
    // Radix gives focus back a timer tick after the drawer goes.
    await expect(page.locator("[data-slot=sheet-content]")).toHaveCount(0);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    // Never to the menu button behind the dialog, which the dialog took it back from, selecting what was typed.
    expect(await page.evaluate(() => (window as unknown as { sentTo: (string | null)[] }).sentTo)).not.toContain("Open conversations");
    await expect(search).toBeFocused();
    await page.keyboard.type("a");
    await expect(search).toHaveValue("Ada");
  });
});

test.describe("DMs in the sidebar", () => {
  test("the DMs fit under their heading, a long name and all, and are easy to tap", async ({ page, room, session, screenIsFine }) => {
    // This test's room, and a DM with someone made up, whose row is all that's looked at.
    const direct: SidebarRoom = {
      id: `${room.id}-direct`,
      kind: "direct",
      members: [session.user, { id: `${session.user.id}-grace`, name: "Grace Brewster Murray Hopper, Rear Admiral" }],
      activeAt: new Date().toISOString(),
      unread: false,
      involvement: "everything",
    };
    await page.route("**/api/sidebar", (route) =>
      route.fulfill({ json: { rooms: [{ ...room, kind: "open", icon: null, unread: false, involvement: "mentions" }, direct], favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {} } satisfies Sidebar }),
    );
    await openRoom(page, room);
    if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open conversations" }).tap();
    await expect(page.getByRole("region", { name: "DMs" }).getByRole("link", { name: /^Direct message with / })).toBeVisible();
    await settle(page);
    await screenIsFine();
  });
});

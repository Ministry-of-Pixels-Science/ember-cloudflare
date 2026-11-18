import type { Sidebar, SidebarRoom } from "@ember/protocol";
import { allowNotifications, isolateRoom, openRoom, signInAs } from "../../fixtures";
import { expect, test } from "./fixtures";

const LONG_NAME = "quarterly-planning-and-retrospective-for-the-platform-team";

test.beforeEach(async ({ page, session }) => {
  await signInAs(page, session);
});

test.describe("Notification levels", () => {
  test("the header's bell fits the phone beside a long room name, and a tap moves it on, confirming the level under it", async ({ page, room, screenIsFine }) => {
    await allowNotifications(page.context());
    const named = { ...room, name: LONG_NAME };
    await isolateRoom(page, named);
    await openRoom(page, named);
    const bell = page.getByRole("navigation", { name: "Page" }).getByRole("checkbox");
    await expect(bell).toHaveAccessibleName("Notifying about @ mentions");
    await screenIsFine();

    await bell.tap();
    await expect(bell).toHaveAccessibleName("Notifying about all messages");
    // With the level it saved confirmed under it, on the screen.
    const tooltip = page.getByRole("navigation", { name: "Page" }).locator("[data-notification-tooltip]");
    await expect(tooltip).toHaveText("Notifying about all messages");
    await expect(tooltip).toBeVisible();
    await screenIsFine();
  });
});

test.describe("Turn on notifications", () => {
  test("Enable notifications fits the phone beside a long room name, and so does its setup dialog, with its help's one section open", async ({ page, room, screenIsFine }) => {
    // As in Safari on an iPhone, which only has push once Ember is on the Home Screen.
    await page.addInitScript(() => Reflect.deleteProperty(window, "PushManager"));
    const named = { ...room, name: LONG_NAME };
    await isolateRoom(page, named);
    await openRoom(page, named);
    await screenIsFine();

    await page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Enable notifications", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "Notification setup" });
    await expect(dialog.getByRole("heading", { level: 1 })).toHaveText("Notifications aren’t available here");
    await expect(dialog.locator("details[open]")).toHaveCount(1);
    await screenIsFine();
  });
});

test.describe("Levels on your profile", () => {
  test("your conversation notifications fit the phone, with long names and a room you've hidden", async ({ page, room, session, screenIsFine }) => {
    const rooms: SidebarRoom[] = [
      { ...room, kind: "open", icon: null, unread: false, involvement: "mentions" },
      { id: `${room.id}-hidden`, name: LONG_NAME, kind: "open", icon: null, unread: false, involvement: "invisible" },
      {
        id: `${room.id}-direct`,
        kind: "direct",
        members: [session.user, { id: `${session.user.id}-grace`, name: "Grace Brewster Murray Hopper, Rear Admiral" }],
        activeAt: new Date().toISOString(),
        unread: false,
        involvement: "everything",
      },
    ];
    await page.route("**/api/sidebar", (route) =>
      route.fulfill({ json: { rooms, favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {}, blocks: { userIds: [], version: 0 } } satisfies Sidebar }),
    );
    await page.goto("/users/me/profile");
    const list = page.getByRole("list", { name: "Conversation notifications" });
    await expect(list.getByRole("checkbox")).toHaveText(["Notifying about @ mentions", "Notifications are off and room invisible in sidebar", "Notifying about all messages"]);
    await list.scrollIntoViewIfNeeded();
    await screenIsFine();
  });
});

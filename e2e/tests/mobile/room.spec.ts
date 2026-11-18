import { REACTIONS, type Sidebar } from "@ember/protocol";
import { isolateRoom, keepOtherRoomsOut, openRoom, signInAs } from "../../fixtures";
import { settle } from "./audits";
import { expect, hasDrawerLayout, REACTION_PILLS, test } from "./fixtures";

test.beforeEach(async ({ page, session }) => {
  await signInAs(page, session);
});

test("an empty room fits the phone", async ({ page, room, screenIsFine }) => {
  await openRoom(page, room);
  await expect(page.getByRole("heading", { name: `Welcome to #${room.name}` })).toBeVisible();
  await screenIsFine();
});

test("the page for someone in no rooms fits the phone", async ({ page, screenIsFine }) => {
  await page.route("**/api/sidebar", (route) => route.fulfill({ json: { rooms: [], favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {}, blocks: { userIds: [], version: 0 } } satisfies Sidebar }));
  await keepOtherRoomsOut(page, []);
  await page.goto("/");
  await expect(page).toHaveTitle("No rooms yet");
  await expect(page.getByRole("main").locator("svg")).toBeVisible();
  await screenIsFine();
});

test("the welcome card fits the phone", async ({ page, room, screenIsFine }) => {
  await isolateRoom(page, room, { joinCode: "aB3d-Ef5h-iJ7k" });
  await openRoom(page, room);
  await expect(page.getByRole("heading", { name: "Welcome to Ember" })).toBeVisible();
  await screenIsFine();
});

test("the join link's QR code fits the phone", async ({ page, room, screenIsFine }) => {
  await isolateRoom(page, room, { joinCode: "aB3d-Ef5h-iJ7k" });
  await openRoom(page, room);
  await page.getByRole("link", { name: "Show join link QR code" }).click();
  const viewer = page.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
  await expect(viewer.locator("img[src^='/qr_code/']")).toBeVisible();
  await screenIsFine();
});

test("a busy room fits the phone", async ({ page, room, participant, screenIsFine }) => {
  const ada = await participant("Ada");
  const longName = await participant("Bartholomew Featherstonehaugh-Montgomery III");
  for (const name of ["Grace", "Linus", "Margaret", "Tim"]) await participant(name);

  await ada.say(`Here's the link: https://example.com/${"really-long-path-segment-".repeat(8)}end`);
  const busy = await longName.say("A message from someone whose name takes most of a phone's width, to check that the header wraps rather than overflows.");
  const unbroken = await ada.say(`${"Supercalifragilisticexpialidocious".repeat(4)} — one unbroken word`);
  await ada.say("Line one\nLine two\n\nLine four after a blank line");
  await ada.say("🔥🔥🔥");
  // Reactions under a message followed by someone else's, and under one followed by more of the same
  // person's, where the next message's Message options rises into them either way.
  for (const message of [busy, unbroken]) for (const [emoji] of REACTIONS) await ada.boost(message.id, emoji);

  await openRoom(page, room);
  await expect(page.getByText("🔥🔥🔥")).toBeVisible();
  // Four faces, then a count for everyone else, though up to 500px wide only screen readers hear who's here.
  const header = page.getByRole("navigation", { name: "Page" });
  await expect(header.getByText("7 here now")).toBeAttached();
  if (page.viewportSize()!.width > 500) await expect(header.getByText("+3")).toBeVisible();
  // So the faces never squeeze out the room's name, which keeps its first few letters even 320px wide.
  expect((await header.getByRole("heading", { level: 1 }).boundingBox())!.width).toBeGreaterThan(40);
  await screenIsFine({ denseTargets: [REACTION_PILLS] });
});

test("the room's star, and a starred room's row in the drawer, fit the phone", async ({ page, room, screenIsFine }) => {
  await isolateRoom(page, room);
  await openRoom(page, room);
  const star = page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Favorite room" });
  await star.tap();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await screenIsFine();

  if (!hasDrawerLayout(page)) return;
  await page.getByRole("button", { name: "Open conversations" }).tap();
  await expect(page.getByRole("dialog").getByRole("link", { name: room.name }).getByRole("img", { name: "Favorite" })).toBeVisible();
  await screenIsFine();
});

test("a star that can't be saved says so on the phone, however long the room's name", async ({ page, room, screenIsFine }) => {
  // A long name pushes the star to the end of its row, where a note hung from its left edge runs off.
  const named = { ...room, name: "quarterly-planning-and-retrospective-for-the-platform-team" };
  await isolateRoom(page, named);
  await page.route("**/api/rooms/*/favorite", (route) => route.fulfill({ status: 503, json: { error: "Workspace unavailable" } }));
  await openRoom(page, named);
  await page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Favorite room" }).tap();
  await expect(page.getByRole("status").filter({ hasText: "Couldn’t save your favorite. Please try again." })).toBeVisible();
  await screenIsFine();
});

test("long room names are truncated, not overflowing", async ({ page, room, screenIsFine }) => {
  const name = "quarterly-planning-and-retrospective-for-the-platform-team";
  await isolateRoom(page, { ...room, name });
  await openRoom(page, { ...room, name });
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await screenIsFine();

  if (hasDrawerLayout(page)) {
    await page.getByRole("button", { name: "Open conversations" }).tap();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  await expect(page.getByRole("link", { name })).toBeVisible();
  await screenIsFine();
});

test("the rail's appearance menu fits the phone", async ({ page, room, screenIsFine }) => {
  await openRoom(page, room);
  const rail = page.getByRole("navigation", { name: "Workspace" });
  if (hasDrawerLayout(page)) {
    await page.getByRole("button", { name: "Open conversations" }).tap();
    // Once it has slid in, as a person would wait: tapping a button that's still sliding in has
    // Playwright scroll it into view first, which can move it up from the bottom of the screen.
    await settle(page);
  }

  // Where the rail scrolls, as on a phone in landscape, start with the button at the bottom of the
  // screen, where its menu is most likely to open under the home indicator.
  const appearance = rail.getByRole("button", { name: "Appearance: System" });
  await appearance.evaluate((button) => button.scrollIntoView({ block: "end" }));
  await appearance.tap();
  const menu = page.getByRole("dialog", { name: "Appearance" });
  await expect(menu).toBeVisible();
  await screenIsFine();
  await menu.getByText("Dark", { exact: true }).tap();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

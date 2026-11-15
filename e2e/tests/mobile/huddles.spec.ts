import type { LiveHuddle, User } from "@ember/protocol";
import type { HuddleServerFrame } from "@ember/protocol/huddles";
import type { Page } from "@playwright/test";
import { changeTheWorkspace, isolateRoom, listing, openRoom, signInAs, type TestRoom } from "../../fixtures";
import { expect, hasDrawerLayout, test } from "./fixtures";

// A room's huddle on a phone: its button in the room's header, the preview it starts from, and the
// huddle the tab is in, opened and as its bar. The main test server has no huddles, whose keys Cloudflare
// would be asked about, so these pages are told that huddles are on, and the huddle a tab joins is the
// test's own.

/** A huddle's socket, for `page.routeWebSocket`. */
const HUDDLE_SOCKET = /\/api\/rooms\/[^/]+\/huddle/;

// A microphone and a camera for the preview to open, which a page may use without asking anyone.
test.use({
  launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

test.beforeEach(async ({ page, session }) => {
  await signInAs(page, session);
});

/**
 * Opens `room`, the only one its page lists, on a page told that huddles are on wherever the server
 * says whether they are, and that `huddle`, given one, is going on in the room.
 */
async function openRoomWithHuddlesOn(page: Page, room: TestRoom, huddle?: LiveHuddle): Promise<void> {
  await isolateRoom(page, room, { huddle });
  await changeTheWorkspace(page, (account) => ({ ...account, huddles: true }), listing([room.id]));
  await openRoom(page, room);
}

/** The room's header. */
const header = (page: Page) => page.getByRole("navigation", { name: "Page" });

/** Has the huddle the page joins welcome its person, `you`, after `others`, and say nothing more. */
async function standInHuddle(page: Page, you: User, others: User[] = []): Promise<void> {
  const people = [...others, you].map((user) => ({ user, muted: false, audio: false, video: false }));
  await page.routeWebSocket(HUDDLE_SOCKET, (ws) => ws.send(JSON.stringify({ type: "huddle.welcome", you, people, startedAt: new Date().toISOString() } satisfies HuddleServerFrame)));
}

test("a room's huddle button fits the phone", async ({ page, room, screenIsFine }) => {
  await openRoomWithHuddlesOn(page, room);
  await expect(header(page).getByRole("button", { name: "Start huddle", exact: true })).toBeVisible();
  // Under 430px the header has no room for Search as well, which the drawer's rail has too.
  await expect(header(page).getByRole("link", { name: "Search messages" })).toBeVisible({ visible: page.viewportSize()!.width >= 430 });
  // And the room's name keeps its first few letters even 320px wide.
  expect((await header(page).getByRole("heading", { level: 1 }).boundingBox())!.width).toBeGreaterThan(40);
  await screenIsFine();
});

test("the button of a huddle going on, which says how many are in it, fits the phone", async ({ page, room, screenIsFine }) => {
  // As many as the header counts in two figures, which is as wide as its button gets. It only counts them.
  const userIds = Array.from({ length: 48 }, (_, index) => `someone-${index}`);
  await openRoomWithHuddlesOn(page, room, { startedAt: new Date().toISOString(), userIds });
  const join = header(page).getByRole("button", { name: "Join huddle, 48 in it" });
  await expect(join).toBeVisible();
  // Under 360px only its green ring says so, and the room's name keeps its first few letters.
  await expect(join.getByText("48")).toBeVisible({ visible: page.viewportSize()!.width >= 360 });
  expect((await header(page).getByRole("heading", { level: 1 }).boundingBox())!.width).toBeGreaterThan(40);
  await screenIsFine();
});

test("the sidebar's row of a room with a huddle going on, which ends with who's in it, fits the phone", async ({ page, room, participant, screenIsFine }) => {
  const userIds = await Promise.all(["Ada", "Grace", "Linus"].map(async (name) => (await participant(name)).session.user.id));
  await openRoomWithHuddlesOn(page, room, { startedAt: new Date().toISOString(), userIds });
  if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open conversations" }).tap();
  const row = page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: room.name, exact: true });
  const mark = row.locator("[title]");
  await expect(mark).toHaveAttribute("title", "Ada, Grace, and Linus are in the huddle");
  // The first two faces, the headphones and how many are in it, with the room's name before them.
  await expect(mark.locator("img")).toHaveCount(2);
  await expect(mark.getByText("3", { exact: true })).toBeVisible();
  expect((await row.getByText(room.name, { exact: true }).boundingBox())!.width).toBeGreaterThan(40);
  await screenIsFine();
});

test("the preview a huddle starts from, with its microphone and speaker to choose, and its camera once that's on, fits the phone", async ({ page, room, screenIsFine }) => {
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  const preview = page.getByRole("dialog", { name: `Start a huddle in ${room.name}` });
  await expect(preview.getByRole("combobox", { name: "Microphone" })).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Speaker" })).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Camera" })).toHaveCount(0);
  await screenIsFine();

  await preview.getByRole("button", { name: "Turn on camera" }).tap();
  await expect(preview.getByLabel("Your camera")).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Camera" })).toBeVisible();
  await screenIsFine();
});

test("the preview of a huddle going on, for someone with no microphone to use, fits the phone", async ({ page, room, participant, screenIsFine }) => {
  // As a browser answers once its person has said no.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  const userIds = await Promise.all(["Ada", "Grace", "Linus"].map(async (name) => (await participant(name)).session.user.id));
  await openRoomWithHuddlesOn(page, room, { startedAt: new Date().toISOString(), userIds });
  await header(page).getByRole("button", { name: "Join huddle, 3 in it" }).tap();
  const preview = page.getByRole("dialog", { name: `Join the huddle in ${room.name}` });
  await expect(preview).toContainText("Ada, Grace, and Linus are in it now.");
  await expect(preview.getByRole("status")).toContainText("Ember has no microphone to use, so you'll only listen.");
  await expect(preview.getByRole("button", { name: "Join Huddle" })).toBeEnabled();
  await screenIsFine();
});

test("the huddle you're in fits the phone, opened with a tile for each person and minimized to its bar", async ({ page, room, session, participant, screenIsFine }) => {
  const others = await Promise.all(["Ada", "Grace"].map(async (name) => (await participant(name)).session.user));
  await standInHuddle(page, session.user, others);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  // It opens over the page, with everyone in it in sight.
  const opened = page.locator("#huddle");
  await expect(opened).toContainText("3 people");
  const tiles = opened.getByRole("list", { name: "In the huddle" }).getByRole("listitem");
  await expect(tiles).toHaveCount(3);
  for (const tile of await tiles.all()) await expect(tile).toBeInViewport({ ratio: 1 });
  await screenIsFine();
  // Their own camera takes their tile.
  await opened.getByRole("button", { name: "Turn on camera" }).tap();
  await expect(tiles.last().getByLabel("Your camera")).toBeVisible();
  await screenIsFine();

  // Minimized, it's a bar along the base of the page.
  await opened.getByRole("button", { name: "Minimize huddle" }).tap();
  const bar = page.getByRole("region", { name: `Huddle in ${room.name}` });
  await expect(bar).toContainText("Ada, Grace, and you are in the huddle");
  await expect(bar.getByRole("button", { name: "Mute microphone" })).toBeVisible();
  await expect(header(page).getByRole("button", { name: "Leave huddle", exact: true })).toBeVisible();
  await screenIsFine();

  await bar.getByRole("button", { name: "Leave", exact: true }).tap();
  await expect(bar).toHaveCount(0);
});

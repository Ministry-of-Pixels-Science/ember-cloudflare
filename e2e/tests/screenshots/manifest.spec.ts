import path from "node:path";
import type { RoomIconName, Sidebar } from "@ember/protocol";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { cookieHeader, createSession, expect, keepOtherRoomsOut, openRoom, Participant, signInAs, test, type Session, type TestRoom } from "../../fixtures";
import { settle } from "../mobile/audits";

// The web app manifest's screenshots, which an install prompt shows: Ember on a phone. `pnpm
// screenshots` saves them over apps/web/public/screenshots/, and any other run with the test's results,
// so the suite keeps them working.

const SAVED = path.resolve(import.meta.dirname, "../../../apps/web/public/screenshots");

test.describe("Web app manifest", () => {
  test("Ember on a phone: a room, the conversations drawer, and a room in dark mode", async ({ page, request, baseURL }, testInfo) => {
    const maya = await createSession(request, "Maya Chen");
    const sam = await createSession(request, "Sam Rivera");
    const priya = await createSession(request, "Priya Patel");
    const leo = await createSession(request, "Leo Park");
    const jordan = await createSession(request, "Jordan Lee");
    const everyone = { maya, sam, priya, leo, jordan };

    const general = await createRoom(request, maya, "general");
    const launch = await createRoom(request, maya, "Launch", "rocket");
    const design = await createRoom(request, maya, "Design", "palette");
    const support = await createRoom(request, maya, "Support", "life-buoy");
    const random = await createRoom(request, maya, "random", "coffee");
    const starred = await request.put(`/api/rooms/${launch.id}/favorite`, { data: { favorite: true }, headers: { Cookie: cookieHeader(maya) } });
    expect(starred.status(), await starred.text()).toBe(200);
    const withSam = await startDirect(request, maya, sam);
    const withPriya = await startDirect(request, maya, priya);

    await talk(baseURL!, launch.id, everyone, async ({ maya, sam, priya, leo, jordan }) => {
      await sam.say("The new build is up on staging 🚀");
      await priya.say("Running through the checklist now.");
      await priya.say("Works great on my phone.");
      await leo.say("The new room icons are in too.");
      const shipIt = await maya.say("Great work, everyone! Let's ship it Thursday morning.");
      const announcement = await jordan.say("I'll write up the announcement.");
      await sam.post(mentioning(everyone.maya, " can you give the release notes a last read?"));
      await maya.say("On it 👍");
      for (const person of [sam, priya, leo]) await person.boost(shipIt.id, "🎉");
      await maya.boost(announcement.id, "👍");
    });
    await talk(baseURL!, design.id, { sam, priya, leo, jordan }, async ({ sam, priya, leo, jordan }) => {
      await leo.say("Here's where the new onboarding screens are headed.");
      await leo.say("Bigger avatars, calmer type, and every room gets an icon.");
      await priya.say("Love it. Could we try a warmer accent color?");
      await leo.say("Sure, that's one line of custom CSS.");
      const dark = await jordan.say("And it looks fantastic in dark mode 😍");
      await sam.boost(dark.id, "😍");
      await priya.boost(dark.id, "💯");
      await priya.post(mentioning(everyone.maya, " what do you think?"));
    });
    await talk(baseURL!, general.id, { priya, jordan }, async ({ priya, jordan }) => {
      await jordan.say("Welcome to the team, Priya! 👋");
      await priya.say("Thanks! Happy to be here.");
    });
    await talk(baseURL!, support.id, { sam }, async ({ sam }) => {
      await sam.say("A customer asked about single sign-on. Who knows our setup best?");
    });
    await talk(baseURL!, withSam, { sam }, async ({ sam }) => {
      await sam.say("Lunch after the launch? 🍜");
    });
    await talk(baseURL!, withPriya, { maya }, async ({ maya }) => {
      await maya.say("Thanks for testing everything today!");
    });

    // Every other test's open rooms take everyone in too, so the sidebar lists just these.
    const listed = new Set([general.id, launch.id, design.id, support.id, random.id, withSam, withPriya]);
    await page.route("**/api/sidebar", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const sidebar = (await response.json()) as Sidebar;
      await route.fulfill({ response, json: { ...sidebar, rooms: sidebar.rooms.filter(({ id }) => listed.has(id)) } });
    });
    await keepOtherRoomsOut(page, listed);
    await signInAs(page, maya);

    await openRoom(page, launch);
    await screenshot(page, testInfo, "chat.png");

    await page.getByRole("button", { name: "Open conversations" }).tap();
    await expect(page.getByRole("dialog", { name: "Conversations" })).toBeVisible();
    await screenshot(page, testInfo, "sidebar.png");

    await page.emulateMedia({ colorScheme: "dark" });
    await openRoom(page, design);
    await screenshot(page, testInfo, "dark-mode.png");
  });
});

/**
 * Saves what `page` shows as `name`, once its pictures and fonts have loaded and anything sliding has
 * stopped: over the manifest's own with `--update-snapshots`, as `pnpm screenshots` runs it, and
 * otherwise with the test's results.
 */
async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  const updating = testInfo.config.updateSnapshots === "all" || testInfo.config.updateSnapshots === "changed";
  await page.screenshot({ path: updating ? path.join(SAVED, name) : testInfo.outputPath(name) });
}

/** Creates an open room as `session`'s person, with `icon`, or `#` for none. Everyone is in it. */
async function createRoom(request: APIRequestContext, session: Session, name: string, icon: RoomIconName | "" = ""): Promise<TestRoom> {
  const response = await request.post("/api/rooms", { data: { kind: "open", name, icon }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  const { room } = (await response.json()) as { room: TestRoom };
  return { id: room.id, name: room.name };
}

/** Starts a DM between `session`'s person and `other`'s, and returns its id. */
async function startDirect(request: APIRequestContext, session: Session, other: Session): Promise<string> {
  const response = await request.post("/api/directs", { data: { userIds: [other.user.id] }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { room: { id: string } }).room.id;
}

/** Connects `sessions`' people to the room `roomId`, has them `say` what they do, then disconnects them. */
async function talk<Name extends string>(baseURL: string, roomId: string, sessions: Record<Name, Session>, say: (people: Record<Name, Participant>) => Promise<void>): Promise<void> {
  const joined = await Promise.all(Object.entries<Session>(sessions).map(async ([name, session]) => [name, await Participant.join(baseURL, session, roomId)] as const));
  try {
    await say(Object.fromEntries(joined) as Record<Name, Participant>);
  } finally {
    for (const [, participant] of joined) participant.close();
  }
}

/** A message that starts by mentioning `person`, then says `text`, as the composer sends one. */
function mentioning(person: Session, text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p><action-text-attachment sgid="${mentionSgid(person.user.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>${escaped}</p>`;
}

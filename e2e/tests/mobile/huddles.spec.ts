import type { DirectRoom, LiveHuddle, Message, RoomSettings, ServerFrame, Sidebar, SidebarRoom, User } from "@ember/protocol";
import type { HuddleClientFrame, HuddleServerFrame, MessageHuddle } from "@ember/protocol/huddles";
import type { APIRequestContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import { changeTheWorkspace, cookieHeader, editorField, huddleTilesKeepClear, isolateRoom, listing, openRoom, ROOM_SOCKET, signInAs, type Session, type Tells, type TestRoom } from "../../fixtures";
import { auditScreen } from "./audits";
import { expect, hasDrawerLayout, openKeyboard, test } from "./fixtures";

// A huddle on a phone: its button in the header of a room or a DM, its message in the room, the preview
// it starts from, the invitation into one, and the huddle the tab is in, opened and as its bar, which
// switches between the phone's cameras, keeps its screen awake, invites people from the menu of its
// More button, and has reactions and stickers. The main test server has no huddles, whose keys
// Cloudflare would be asked about, so these pages are told that huddles are on, and the huddle a tab
// joins is the test's own, as is the message of one.

/** A huddle's socket, for `page.routeWebSocket`. */
const HUDDLE_SOCKET = /\/api\/rooms\/[^/]+\/huddle/;

// A microphone and a camera for the preview to open, which a page may use without asking anyone.
test.use({
  launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

test.beforeEach(async ({ page, session }) => {
  // A phone's browser has no screen to share, which the desktop Chromium that stands in for it has.
  await page.addInitScript(() => Reflect.deleteProperty(MediaDevices.prototype, "getDisplayMedia"));
  await signInAs(page, session);
});

/**
 * Opens `room`, the only one its page lists, on a page told that huddles are on wherever the server
 * says whether they are, and that `huddle`, given one, is going on in the room. Answers how to tell the
 * page what the Workspace would.
 */
async function openRoomWithHuddlesOn(page: Page, room: TestRoom, huddle?: LiveHuddle): Promise<Tells> {
  await isolateRoom(page, room, { huddle });
  const tell = await changeTheWorkspace(page, (account) => ({ ...account, huddles: true }), listing([room.id]));
  await openRoom(page, room);
  return tell;
}

/**
 * Opens the DM `session`'s person has with `other`, which its page lists after `room`, on a page told
 * that huddles are on, and that `huddle`, given one, is going on in the DM.
 */
async function openDirectWithHuddlesOn(page: Page, request: APIRequestContext, room: TestRoom, session: Session, other: User, huddle?: LiveHuddle): Promise<void> {
  const started = await request.post("/api/directs", { data: { userIds: [other.id] }, headers: { Cookie: cookieHeader(session) } });
  expect(started.status(), await started.text()).toBe(201);
  const { room: direct } = (await started.json()) as { room: DirectRoom };
  const rooms: SidebarRoom[] = [
    { ...room, kind: "open", icon: null, unread: false, involvement: "mentions" },
    { ...direct, unread: false, involvement: "everything" },
  ];
  await page.route("**/api/sidebar", (route) =>
    route.fulfill({ json: { rooms, favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: huddle ? { [direct.id]: huddle } : {} } satisfies Sidebar }),
  );
  await changeTheWorkspace(page, (account) => ({ ...account, huddles: true }), listing([room.id]));
  await page.goto(`/rooms/${direct.id}`);
  await expect(page.getByRole("log", { name: `Messages with ${other.name}` })).not.toHaveAttribute("aria-busy");
}

/** The room's header. */
const header = (page: Page) => page.getByRole("navigation", { name: "Page" });

/**
 * Has the huddle the page joins welcome its person, `you`, after `others`, tell the page of its own
 * reactions, as a room tells everyone in its huddle, and say nothing more. Answers what the page says
 * to it, in order.
 */
async function standInHuddle(page: Page, you: User, others: User[] = []): Promise<HuddleClientFrame[]> {
  const people = [...others, you].map((user) => ({ user, muted: false, audio: false, video: false, screen: false }));
  const said: HuddleClientFrame[] = [];
  await page.routeWebSocket(HUDDLE_SOCKET, (ws) => {
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as HuddleClientFrame;
      said.push(frame);
      if (frame.type === "huddle.react") ws.send(JSON.stringify({ type: "huddle.reacted", userId: you.id, emoji: frame.emoji } satisfies HuddleServerFrame));
    });
    ws.send(JSON.stringify({ type: "huddle.welcome", you, people, startedAt: new Date().toISOString() } satisfies HuddleServerFrame));
  });
  return said;
}

/**
 * Has `room` welcome the page with the message of a huddle `starter` started, after its own messages,
 * which says `huddle` of it. Answers how to have the message say something else of its huddle.
 */
async function standInHuddleMessage(page: Page, room: TestRoom, starter: User, huddle: MessageHuddle): Promise<(huddle: MessageHuddle) => void> {
  const [text, at] = ["A huddle started", huddle.startedAt];
  const message: Message = { id: "z".repeat(16), clientMessageId: crypto.randomUUID(), roomId: room.id, creator: starter, body: `<p>${text}</p>`, plainText: text, mentions: [], createdAt: at, updatedAt: at, editedAt: null, boosts: [], huddle };
  let tab: WebSocketRoute | undefined;
  let seq = 0;
  await page.routeWebSocket(ROOM_SOCKET, (ws) => {
    tab = ws;
    ws.connectToServer().onMessage((frame) => {
      const parsed = JSON.parse(String(frame)) as ServerFrame;
      if (parsed.type !== "welcome") return ws.send(frame);
      seq = parsed.seq;
      ws.send(JSON.stringify({ ...parsed, messages: [...parsed.messages, message] } satisfies ServerFrame));
    });
  });
  return (huddle) => tab!.send(JSON.stringify({ type: "message.updated", message: { ...message, huddle }, seq: ++seq } satisfies ServerFrame));
}

/** Has `room`'s settings answer the page that `members` are in the room and `others`, whom they list as well, aren't. */
async function listRoomPeople(page: Page, room: TestRoom, members: User[], others: User[] = []): Promise<void> {
  const people = [...members.map((user) => ({ ...user, member: true })), ...others.map((user) => ({ ...user, member: false }))];
  await page.route(`**/api/rooms/${room.id}/settings`, (route) => route.fulfill({ json: { room: { ...room, kind: "open", icon: null }, canAdminister: false, people } satisfies RoomSettings }));
}

/** The button Invite people opens from in the huddle `page` has opened: More, or its own where the huddle is beside the sidebar, as on the largest phone held on its side. */
const inviteOpener = (page: Page) => page.locator("#huddle").getByRole("button", { name: hasDrawerLayout(page) ? "More" : "Invite people", exact: true });

/** Opens Invite people from the huddle `page` has opened, by More's menu or its own button, and answers its list. */
async function openInvitePeople(page: Page): Promise<Locator> {
  await inviteOpener(page).tap();
  if (hasDrawerLayout(page)) await page.getByRole("menu", { name: "More", exact: true }).getByRole("menuitem", { name: "Invite people" }).tap();
  return page.getByRole("dialog", { name: "Invite people" });
}

/** The invitations the page has asked its huddle to send, in order. */
const invitationsSent = (said: HuddleClientFrame[]) => said.filter(({ type }) => type === "huddle.invite");

/** Where a page keeps what its huddle asked the browser's cameras for, and what the browser handed it for a screen it keeps awake. */
type PhoneWindow = Window & { camerasAsked?: MediaTrackConstraints[]; screensKept?: WakeLockSentinel[] };

/**
 * In the page, before it loads: has the browser be a phone's, with a camera over its screen and one on
 * its back, each of which says which way it faces, and of which it opens one at a time, as a phone
 * does. Each shows the picture of the browser's made-up camera. What the page asks of them is kept for
 * the test.
 */
function phoneCameras(): void {
  const cameras = [
    { deviceId: "front", label: "Front Camera", facingMode: "user" },
    { deviceId: "back", label: "Back Camera", facingMode: "environment" },
  ];
  const media = navigator.mediaDevices;
  const [open, list] = [media.getUserMedia.bind(media), media.enumerateDevices.bind(media)];
  const opened: MediaStreamTrack[] = [];
  const asked: MediaTrackConstraints[] = ((window as PhoneWindow).camerasAsked = []);
  const exactly = (constraint: ConstrainDOMString | undefined) => (constraint as { exact?: string } | undefined)?.exact;
  media.getUserMedia = async (constraints) => {
    if (!constraints?.video) return open(constraints);
    const video = constraints.video === true ? {} : constraints.video;
    asked.push(video);
    const [facingMode, deviceId] = [exactly(video.facingMode), exactly(video.deviceId)];
    const camera = cameras.find((listed) => (facingMode ? listed.facingMode === facingMode : !deviceId || listed.deviceId === deviceId));
    if (!camera) throw new DOMException("No such camera", "OverconstrainedError");
    if (opened.some((track) => track.readyState === "live")) throw new DOMException("Could not start video source", "NotReadableError");
    const stream = await open({ video: { width: video.width, height: video.height } });
    const track = stream.getVideoTracks()[0]!;
    const settings = track.getSettings.bind(track);
    track.getSettings = () => ({ ...settings(), deviceId: camera.deviceId, facingMode: camera.facingMode });
    opened.push(track);
    return stream;
  };
  media.enumerateDevices = async () => [
    ...(await list()).filter(({ kind }) => kind !== "videoinput"),
    ...cameras.map(({ deviceId, label }) => ({ kind: "videoinput", deviceId, label, groupId: "" }) as MediaDeviceInfo),
  ];
}

/** In the page, before it loads: keeps what the browser hands the page each time the page has it keep the screen awake, for the test. */
function keepWhatKeepsAwake(): void {
  const kept: WakeLockSentinel[] = ((window as PhoneWindow).screensKept = []);
  const request = navigator.wakeLock.request.bind(navigator.wakeLock);
  navigator.wakeLock.request = async (type) => {
    const lock = await request(type);
    kept.push(lock);
    return lock;
  };
}

/**
 * Has the browser keep the screen awake for a page that asks it to, as a phone's does without asking
 * its person. The headless Chromium these tests run in on CI refuses a page it hasn't been told to let.
 * Telling it so refuses the page whatever isn't named, so the microphone and the camera are named
 * too, and it holds for as long as the session that said it, which is left to end with the page.
 */
async function letScreenBeKeptAwake(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.grantPermissions", { permissions: ["wakeLockScreen", "audioCapture", "videoCapture"], browserContextId: targetInfo.browserContextId });
}

/** Where a page keeps the connection that stands in for the SFU's, which sends it the screens it watches. */
type SentScreens = Window & { screensSent?: RTCPeerConnection };

/**
 * In the page: a connection of its own that sends it `count` screens, as the SFU's would, each the
 * picture of its made-up camera, as wide as a screen is. Answers its offer of them, which names an
 * address of its own, as the SFU's does, and the media section each is on.
 */
async function offerScreens(count: number): Promise<{ sdp: string; mids: string[] }> {
  const picture = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
  const connection = new RTCPeerConnection();
  const sent = Array.from({ length: count }, () => connection.addTransceiver(picture.getVideoTracks()[0]!.clone(), { direction: "sendonly" }));
  await connection.setLocalDescription(await connection.createOffer());
  if (!connection.localDescription!.sdp.includes("a=candidate:")) await new Promise((resolve) => connection.addEventListener("icecandidate", resolve, { once: true }));
  (window as SentScreens).screensSent = connection;
  return { sdp: connection.localDescription!.sdp, mids: sent.map(({ mid }) => mid!) };
}

/**
 * Has the huddle the page joins welcome its person, `you`, after `sharing`, each of whom shares a
 * screen, and `others`, who share none. It offers the page the screens when it asks to watch them on a
 * connection it has yet to make, as it does once it shows the huddle opened, and whenever it shows it
 * opened again.
 */
async function standInHuddleWithScreens(page: Page, you: User, sharing: User[], others: User[] = []): Promise<void> {
  const people = [...sharing.map((user) => ({ user, screen: true })), ...[...others, you].map((user) => ({ user, screen: false }))].map((person) => ({ ...person, muted: false, audio: false, video: false }));
  await page.routeWebSocket(HUDDLE_SOCKET, (ws) => {
    const say = (frame: HuddleServerFrame) => ws.send(JSON.stringify(frame));
    say({ type: "huddle.welcome", you, people, startedAt: new Date().toISOString() });
    ws.onMessage(async (message) => {
      const frame = JSON.parse(String(message)) as HuddleClientFrame;
      if (frame.type === "huddle.listen" && frame.kind === "screen" && frame.fresh && frame.watch?.length === sharing.length) {
        const { sdp, mids } = await page.evaluate(offerScreens, sharing.length);
        say({ type: "huddle.offer", kind: "screen", sdp, tracks: sharing.map(({ id }, index) => ({ mid: mids[index]!, kind: "screen", userId: id })) });
      } else if (frame.type === "huddle.answer" && frame.kind === "screen") {
        await page.evaluate((sdp) => (window as SentScreens).screensSent!.setRemoteDescription({ type: "answer", sdp }), frame.sdp);
        say({ type: "huddle.listening", kind: "screen" });
      } else if (frame.type === "huddle.listen" && frame.kind === "screen") {
        say({ type: "huddle.listening", kind: "screen" });
      }
    });
  });
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

test("a DM's huddle button fits the phone, and so does its row in the sidebar, which ends with who's in its huddle", async ({ page, request, room, session, participant, screenIsFine }) => {
  // With someone whose name is long, who's in the DM's huddle.
  const grace = (await participant("Grace Brewster Murray Hopper, Rear Admiral")).session.user;
  await openDirectWithHuddlesOn(page, request, room, session, grace, { startedAt: new Date().toISOString(), userIds: [grace.id] });
  await expect(header(page).getByRole("button", { name: "Join huddle, 1 in it" })).toBeVisible();
  // Under 430px the header has no room for Search as well, as a room's hasn't, and her name keeps its first few letters.
  await expect(header(page).getByRole("link", { name: "Search messages" })).toBeVisible({ visible: page.viewportSize()!.width >= 430 });
  expect((await header(page).getByRole("heading", { level: 1 }).boundingBox())!.width).toBeGreaterThan(40);
  await screenIsFine();

  if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open conversations" }).tap();
  const row = page.getByRole("region", { name: "DMs" }).getByRole("link", { name: `Direct message with ${grace.name}`, exact: true });
  const mark = row.locator("[title]");
  await expect(mark).toHaveAttribute("title", "Grace is in the huddle");
  // Her face, the headphones and how many are in it, with her name before them.
  await expect(mark.locator("img")).toHaveCount(1);
  await expect(mark.getByText("1", { exact: true })).toBeVisible();
  expect((await row.getByText(grace.name).boundingBox())!.width).toBeGreaterThan(40);
  await screenIsFine();
});

test("a huddle's message fits the phone, with who's in it and Join easy to tap while the huddle goes on, and who was in it and for how long once it's over", async ({ page, room, participant, screenIsFine }) => {
  // With more people in it than it shows faces of, the first of them by a name that's one long word, which is the widest it says.
  const people = await Promise.all(["Wolfeschlegelsteinhausenbergerdorff", "Grace", "Linus", "Margaret", "Katherine"].map(async (name) => (await participant(name)).session.user));
  const startedAt = new Date(Date.now() - 24 * 60_000).toISOString();
  const say = await standInHuddleMessage(page, room, people[0]!, { startedAt });
  const tell = await openRoomWithHuddlesOn(page, room, { startedAt, userIds: people.map(({ id }) => id) });
  const message = page.getByRole("log").getByRole("article").filter({ has: page.getByRole("heading", { name: /^A huddle / }) });
  await expect(message.getByRole("heading")).toContainText("A huddle is happeningLIVE");
  await expect(message).toContainText("Wolfeschlegelsteinhausenbergerdorff, Grace, Linus, and 2 others are in the huddle");
  await expect(message.locator("img")).toHaveCount(4);
  await screenIsFine();

  // Join opens the preview the huddle is joined from.
  await message.getByRole("button", { name: "Join", exact: true }).tap();
  const preview = page.getByRole("dialog", { name: `Join the huddle in ${room.name}` });
  await expect(preview.getByRole("button", { name: "Join Huddle" })).toBeVisible();
  await preview.getByRole("button", { name: "Cancel", exact: true }).last().tap();
  await expect(preview).toHaveCount(0);

  // Everyone leaves: the Workspace says the huddle is over, and the room what its message says of it now.
  tell({ type: "room.huddle", roomId: room.id, huddle: null });
  say({ startedAt, endedAt: new Date().toISOString(), people });
  await expect(message.getByRole("heading")).toContainText("A huddle happened");
  await expect(message).toContainText("Wolfeschlegelsteinhausenbergerdorff, Grace, Linus, and 2 others were in the huddle for 24 minutes");
  await expect(message.getByRole("button", { name: "Join", exact: true })).toHaveCount(0);
  await screenIsFine();
});

test("an invitation into a huddle fits the phone, under the header of the page it came to, with Decline and Join easy to tap", async ({ page, room, participant, screenIsFine }) => {
  // From someone whose name is long, into a room's huddle, which is the longer an invitation says.
  const grace = (await participant("Grace Brewster Murray Hopper, Rear Admiral")).session.user;
  const tell = await openRoomWithHuddlesOn(page, room);
  tell({ type: "huddle.invited", roomId: room.id, by: grace.id });
  const invitation = page.getByRole("group", { name: `${grace.name} invites you to a huddle in ${room.name}`, exact: true });
  await expect(invitation).toBeInViewport({ ratio: 1 });
  const [under, shown] = [(await header(page).boundingBox())!, (await invitation.boundingBox())!];
  expect(shown.y).toBeGreaterThanOrEqual(under.y + under.height);
  await screenIsFine();
  // What's beside it is the page's still, where a tap goes through to it.
  await editorField(page, "Write a message").tap({ trial: true });

  await invitation.getByRole("button", { name: "Decline", exact: true }).tap();
  await expect(invitation).toHaveCount(0);
});

test("more invitations than the phone is tall enough for are a scroll away, under the header, whose buttons stay in reach", async ({ page, room, participant, safeArea }) => {
  const grace = (await participant("Grace Hopper")).session.user;
  // Into rooms of this page's own, more of them than any phone shows at once, the last into the room it has open.
  const names = Array.from({ length: 8 }, (_, index) => `Launch ${index + 1}`);
  const others = names.map((name, index): SidebarRoom => ({ id: `invited-${index + 1}`, name, kind: "open", icon: null, unread: false, involvement: "mentions" }));
  const rooms: SidebarRoom[] = [{ ...room, kind: "open", icon: null, unread: false, involvement: "mentions" }, ...others];
  await page.route("**/api/sidebar", (route) => route.fulfill({ json: { rooms, favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {} } satisfies Sidebar }));
  const tell = await changeTheWorkspace(page, (account) => ({ ...account, huddles: true }), listing([room.id]));
  await openRoom(page, room);
  for (const { id } of [...others, room]) tell({ type: "huddle.invited", roomId: id, by: grace.id });
  const into = (name: string) => page.getByRole("group", { name: `${grace.name} invites you to a huddle in ${name}`, exact: true });
  await expect(page.getByRole("region", { name: "Huddle invitations" }).getByRole("group")).toHaveCount(rooms.length);
  const [first, last] = [into(names[0]!), into(room.name)];
  await expect(first).toBeInViewport({ ratio: 1 });
  await expect(last).not.toBeInViewport();
  // They cover the page under them for as long as they ring, so what's asked of the screen leaves out
  // that each of the page's controls is easy to tap: none of them is cut off where no scrolling reaches.
  const stacked = await auditScreen(page, safeArea);
  expect.soft(stacked.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
  expect.soft(stacked.safeArea, "Nothing sits under the notch, rounded corners or home indicator").toEqual([]);
  const startHuddle = header(page).getByRole("button", { name: "Start huddle", exact: true });
  await startHuddle.tap({ trial: true });

  // A wheel over one scrolls them, as a finger on one does, and under the header, not over it.
  await first.hover();
  await page.mouse.wheel(0, 4000);
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(first).not.toBeInViewport();
  await startHuddle.tap({ trial: true });
  const scrolled = await auditScreen(page, safeArea);
  expect.soft(scrolled.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
  expect.soft(scrolled.safeArea, "Nothing sits under the notch, rounded corners or home indicator").toEqual([]);
  await last.getByRole("button", { name: "Decline", exact: true }).tap();
  await expect(last).toHaveCount(0);
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
  // Skip to main content, which leads to the huddle, shows over it once it has the focus.
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await skip.focus();
  expect(await skip.evaluate((link) => document.elementFromPoint(link.getBoundingClientRect().x + 4, link.getBoundingClientRect().y + 4) === link)).toBe(true);
  await opened.focus();

  // Minimized, it's a bar along the base of the page.
  await opened.getByRole("button", { name: "Minimize huddle" }).tap();
  const bar = page.getByRole("region", { name: `Huddle in ${room.name}` });
  await expect(bar).toContainText("Ada, Grace, and you are in the huddle");
  await expect(bar.getByRole("button", { name: "Mute microphone" })).toBeVisible();
  await expect(header(page).getByRole("button", { name: "Leave huddle", exact: true })).toBeVisible();
  await screenIsFine();

  // Opened again over a page of community settings, whose links have a row of their own on a phone, it fills the screen as before.
  await header(page).getByRole("link", { name: "Settings for this room" }).tap();
  await expect(page).toHaveURL(/\/edit$/);
  await bar.getByTitle("Open huddle").first().tap();
  await expect(tiles).toHaveCount(3);
  expect((await opened.boundingBox())!.height).toBeCloseTo(page.viewportSize()!.height, 0);
  for (const tile of await tiles.all()) await expect(tile).toBeInViewport({ ratio: 1 });
  await screenIsFine();

  await opened.getByRole("button", { name: "Leave", exact: true }).tap();
  await expect(opened).toHaveCount(0);
  await expect(bar).toHaveCount(0);
});

test("the huddle you're in switches between the phone's front camera and its back one, which shows as it is, and its button for that fits the phone", async ({ page, room, session, screenIsFine }) => {
  await page.addInitScript(phoneCameras);
  await standInHuddle(page, session.user);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  const opened = page.locator("#huddle");
  const yours = opened.getByLabel("Your camera");
  /** Which of the phone's cameras the huddle shows its person, once its picture plays, and whether as a mirror would. */
  const shown = () =>
    yours.evaluate((video: HTMLVideoElement) => ({
      camera: video.paused || video.videoWidth === 0 ? "none yet" : (video.srcObject as MediaStream).getVideoTracks()[0]!.getSettings().deviceId,
      mirrored: parseFloat(getComputedStyle(video).scale) < 0,
    }));
  const asked = () => page.evaluate(() => (window as PhoneWindow).camerasAsked!.map(({ facingMode, deviceId }) => facingMode ?? deviceId ?? "its own choice"));
  // The button is there in the place of the camera's arrow, which the huddle has where it's beside the sidebar, as on the largest phone held on its side.
  const button = opened.getByRole("button", { name: "Switch camera" });
  const arrow = opened.getByRole("button", { name: "Camera", exact: true });
  const byButton = hasDrawerLayout(page);
  /** Switches to the camera called `label`: by the button, or from the arrow's menu. */
  const switchTo = async (label: string) => {
    if (byButton) return button.tap();
    await arrow.tap();
    await page.getByRole("menu", { name: "Camera", exact: true }).getByRole("menuitemradio", { name: label }).tap();
  };

  // With the camera off there's no camera to switch from.
  await expect(button).toBeHidden();
  await opened.getByRole("button", { name: "Turn on camera" }).tap();
  await expect.poll(shown).toEqual({ camera: "front", mirrored: true });
  await expect(button).toBeVisible({ visible: byButton });
  await expect(arrow).toBeVisible({ visible: !byButton });
  await screenIsFine();

  // The back camera's picture shows as it is. The phone would open neither camera while the other was open.
  await switchTo("Back Camera");
  await expect.poll(shown).toEqual({ camera: "back", mirrored: false });
  await screenIsFine();
  await switchTo("Front Camera");
  await expect.poll(shown).toEqual({ camera: "front", mirrored: true });
  expect(await asked()).toEqual(byButton ? ["its own choice", { exact: "environment" }, { exact: "user" }] : ["its own choice", { exact: "back" }, { exact: "front" }]);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The camera it's left on is the one its next huddle starts with.
  await opened.getByRole("button", { name: "Leave", exact: true }).tap();
  await expect(opened).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("ember:huddle-camera"))).toBe("front");
});

test("a huddle keeps the phone's screen awake from when you join it until you leave", async ({ page, room, session }) => {
  await page.addInitScript(keepWhatKeepsAwake);
  await letScreenBeKeptAwake(page);
  await standInHuddle(page, session.user);
  await openRoomWithHuddlesOn(page, room);
  /** What the page has had the browser keep awake, and whether each is kept awake still. */
  const kept = () => page.evaluate(() => (window as PhoneWindow).screensKept!.map(({ type, released }) => ({ type, released })));
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  const preview = page.getByRole("dialog", { name: `Start a huddle in ${room.name}` });
  await expect(preview.getByRole("combobox", { name: "Microphone" })).toBeVisible();
  // The preview keeps nothing awake.
  expect(await kept()).toEqual([]);

  await preview.getByRole("button", { name: "Start Huddle" }).tap();
  const opened = page.locator("#huddle");
  await expect(opened.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
  await expect.poll(kept).toEqual([{ type: "screen", released: false }]);

  await opened.getByRole("button", { name: "Leave", exact: true }).tap();
  await expect(opened).toHaveCount(0);
  await expect.poll(kept).toEqual([{ type: "screen", released: true }]);
});

test("Invite people, from the More button of the huddle you're in, lists the room's people to tick and fits the phone, and the huddle's buttons take taps again once it closes", async ({ page, room, session, participant, screenIsFine }) => {
  const ada = (await participant("Ada")).session.user;
  // Two to invite, one of whose names is long, besides the phone's person and Ada, who are in the huddle, and someone who isn't in the room.
  const [grace, linus, margaret] = [
    { id: "invite-grace", name: "Grace Brewster Murray Hopper, Rear Admiral" },
    { id: "invite-linus", name: "Linus Torvalds" },
    { id: "invite-margaret", name: "Margaret Hamilton" },
  ];
  await listRoomPeople(page, room, [session.user, ada, grace, linus], [margaret]);
  const said = await standInHuddle(page, session.user, [ada]);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  const opened = page.locator("#huddle");
  await expect(opened).toContainText("2 people");

  // A phone's huddle has More, the last of its buttons before Leave, whose menu has Invite people. Where
  // the huddle is beside the sidebar, Invite people is a button of its own, the first of them.
  const byMenu = hasDrawerLayout(page);
  const opener = inviteOpener(page);
  const tools = opened.locator("footer").getByRole("button");
  await expect(opened.getByRole("button", { name: "More", exact: true })).toBeVisible({ visible: byMenu });
  await expect(opened.getByRole("button", { name: "Invite people", exact: true })).toBeVisible({ visible: !byMenu });
  await expect(byMenu ? tools.nth(-2) : tools.first()).toHaveAccessibleName(byMenu ? "More" : "Invite people");
  await screenIsFine();
  await opener.tap();
  if (byMenu) {
    const menu = page.getByRole("menu", { name: "More", exact: true });
    // The narrowest phone has React there too, which it has no room to give a button.
    await expect(menu.getByRole("menuitem")).toHaveText(page.viewportSize()!.width < 360 ? ["React", "Invite people"] : ["Invite people"]);
    await screenIsFine();
    await menu.getByRole("menuitem", { name: "Invite people" }).tap();
    await expect(menu).toHaveCount(0);
  }

  // The list opens once the menu has gone, at its title, with the two to invite by name, neither ticked.
  const inviting = page.getByRole("dialog", { name: "Invite people" });
  await expect(inviting.getByRole("heading", { name: "Invite people" })).toBeFocused();
  await expect(inviting.getByRole("listitem")).toHaveText([grace.name, linus.name]);
  // A long name wraps, so the list scrolls no way but down.
  expect(await inviting.getByRole("list", { name: "People" }).evaluate((list) => list.parentElement!.scrollWidth <= list.parentElement!.clientWidth)).toBe(true);
  await expect(inviting.getByRole("status")).toHaveText("Choose one or more people.");
  await expect(inviting.getByRole("button", { name: "Send Invite" })).toBeDisabled();
  await screenIsFine();
  await inviting.getByRole("checkbox", { name: grace.name }).tap();
  await expect(inviting.getByRole("status")).toHaveText("1 person selected.");
  await screenIsFine();

  // Cancel sends nothing, and gives the focus back to the button it opened from. The huddle's buttons take taps again.
  await inviting.getByRole("button", { name: "Cancel", exact: true }).last().tap();
  await expect(inviting).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opened.getByRole("button", { name: "Mute microphone" }).tap();
  await expect(opened.getByRole("button", { name: "Unmute microphone" })).toBeVisible();
  expect(invitationsSent(said)).toEqual([]);

  // Opened again, nobody is ticked. Send Invite asks the room to invite whoever is, and says so over the
  // huddle, whose buttons take taps again.
  await expect(await openInvitePeople(page)).toBeVisible();
  await expect(inviting.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await inviting.getByRole("checkbox", { name: linus.name }).tap();
  await inviting.getByRole("button", { name: "Send Invite" }).tap();
  await expect(inviting).toHaveCount(0);
  const flash = page.getByRole("alert");
  await expect(flash).toHaveText("Linus is invited.");
  await expect(flash).toBeInViewport({ ratio: 1 });
  // It lets taps through to what's under it, so what's on top is asked while it takes them.
  expect(
    await flash.evaluate((alert: HTMLElement) => {
      alert.style.pointerEvents = "auto";
      const { x, y, width, height } = alert.getBoundingClientRect();
      const onTop = document.elementFromPoint(x + width / 2, y + height / 2);
      alert.style.pointerEvents = "";
      return alert.contains(onTop);
    }),
  ).toBe(true);
  await expect.poll(() => invitationsSent(said)).toEqual([{ type: "huddle.invite", userIds: [linus.id] }]);
  await expect(opener).toBeFocused();
  await opened.getByRole("button", { name: "Unmute microphone" }).tap();
  await expect(opened.getByRole("button", { name: "Mute microphone" })).toBeVisible();
});

test("a huddle's reactions and stickers, from React among its buttons, or in More's menu on the narrowest phone, fit the phone and leave its keyboard down", async ({ page, room, session, participant, screenIsFine }) => {
  const ada = (await participant("Ada")).session.user;
  const said = await standInHuddle(page, session.user, [ada]);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  const opened = page.locator("#huddle");
  await expect(opened).toContainText("2 people");
  const own = opened.getByRole("list", { name: "In the huddle" }).getByRole("listitem").last();
  /** The picker's emoji, which are as close together as Slack's picker has them. */
  const EMOJI = "[data-slot=emoji-picker-emoji]";

  // React is among the huddle's buttons, but on a phone too narrow to give it one, which has it in More's
  // menu. Raise hand isn't: a phone's stickers are in React's panel. Where the huddle is beside the
  // sidebar, as on the largest phone held on its side, it has Raise hand and its arrow, as a computer does.
  const narrow = page.viewportSize()!.width < 360;
  const opener = opened.getByRole("button", { name: narrow ? "More" : "React", exact: true });
  await expect(opened.getByRole("button", { name: "React", exact: true })).toBeVisible({ visible: !narrow });
  for (const name of ["Raise hand", "Stickers"]) await expect(opened.getByRole("button", { name, exact: true })).toBeVisible({ visible: !hasDrawerLayout(page) });
  await screenIsFine();
  const open = async () => {
    await opener.tap();
    if (narrow) await page.getByRole("menu", { name: "More", exact: true }).getByRole("menuitem", { name: "React" }).tap();
  };
  await open();

  // The reactions and stickers open between the huddle's header and its buttons, clear of both and of
  // the screen's sides, on Reactions, with the phone's keyboard left down: the cursor isn't in the
  // search. A phone held on its side is too short for their tabs over the emoji, which are beside them
  // there, and the shortest shows two rows of emoji at the least.
  const panel = page.getByRole("dialog", { name: "React" });
  /** The least room the panel leaves the huddle's header over it, its buttons under it and the screen's sides, which is none or more where it's between them. */
  const roomAround = async () => {
    const [over, head, tool] = await Promise.all([panel, opened.locator(":scope > header"), opened.getByRole("button", { name: "Mute microphone" })].map(async (each) => (await each.boundingBox())!));
    return Math.min(over!.y - (head!.y + head!.height), tool!.y - (over!.y + over!.height), over!.x, page.viewportSize()!.width - (over!.x + over!.width));
  };
  await expect(panel.getByRole("tab", { selected: true })).toHaveText("Reactions");
  const grinning = panel.getByRole("gridcell", { name: "Grinning face", exact: true });
  await expect(grinning).toBeVisible();
  await expect(panel.getByLabel("Search all emoji")).not.toBeFocused();
  await expect.poll(roomAround).toBeGreaterThanOrEqual(0);
  const onItsSide = page.viewportSize()!.height < 500;
  await expect(panel.getByRole("tablist")).toHaveAttribute("aria-orientation", onItsSide ? "vertical" : "horizontal");
  await expect(panel.getByRole("gridcell", { name: "Upside-down face", exact: true })).toBeInViewport({ ratio: 0.99 });
  const size = await panel.boundingBox();
  await screenIsFine({ denseTargets: [EMOJI] });

  // An emoji tapped is sent as a reaction and closes the panel, which is over the people on a phone. Once
  // the room has told of it, the reaction rises over the person's name from the base of the people in
  // the huddle, in sight, and no tile has it. The focus is back on the button the panel opened from.
  await grinning.tap();
  await expect(panel).toHaveCount(0);
  const people = opened.getByRole("list", { name: "In the huddle" }).locator("xpath=../..");
  const rising = people.locator('span[aria-hidden="true"]').filter({ has: page.getByText("😀", { exact: true }) });
  await expect(rising).toBeInViewport();
  await expect(rising).toHaveText(`😀${session.user.name}`);
  // Where the people have under 672px, their reactions are across more of them than right of their
  // middle, where a computer's are, and under 448px, as on a phone held upright, they stop short of the
  // pills in the corner: the first is from left of the middle.
  const [among, risen] = [(await people.boundingBox())!, (await rising.boundingBox())!];
  expect(((risen.x + risen.width / 2 - among.x) / among.width) * 100).toBeCloseTo(among.width < 448 ? 37.5 : among.width < 672 ? 45 : 57.5, 0);
  await expect(own.getByText("😀")).toHaveCount(0);
  expect(said.filter(({ type }) => type === "huddle.react")).toEqual([{ type: "huddle.react", emoji: "😀" }]);
  await expect(opener).toBeFocused();

  // While it rises, its emoji has a pill in the corner of the people, easy to tap, which sends it again
  // and counts that. With less motion asked of the phone, the reactions hold still, so what's on the
  // screen is looked over while they and the pill are on it.
  const pill = opened.getByRole("list", { name: "Reactions", exact: true }).getByRole("button");
  await expect(pill).toHaveText("You😀");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pill.tap();
  await expect(pill).toHaveText("You+ 1😀");
  await screenIsFine();
  await expect(pill).toBeInViewport({ ratio: 1 });
  expect(said.filter(({ type }) => type === "huddle.react")).toHaveLength(2);
  await page.emulateMedia({ reducedMotion: null });
  await expect(pill).toHaveCount(0, { timeout: 10_000 });

  // Opened again, its other tab lists the stickers, each easy to tap, in a panel as large as it was,
  // where they scroll if it's too short for them all. One chosen closes the panel, gives the focus back
  // to the button it opened from, and shows in the corner of the person's tile over their name, within
  // it, with what it's called where the tile is wide enough for that.
  await open();
  await panel.getByRole("tab", { name: "Stickers" }).tap();
  await expect(panel.getByRole("listitem")).toHaveText([/Raise hand$/, /Be right back$/, /Yes$/, /No$/, /Done$/]);
  await expect.poll(() => panel.boundingBox()).toEqual(size);
  await screenIsFine();
  const last = panel.getByRole("button", { name: "Done" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 0.99 });
  await screenIsFine();
  await panel.getByRole("button", { name: "Raise hand" }).tap();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
  const sticker = own.getByRole("button", { name: "Remove sticker: Raise hand", exact: true });
  await expect(sticker).toBeInViewport({ ratio: 1 });
  await expect(sticker).toHaveText("✋Raise hand");
  const tile = (await own.boundingBox())!;
  await expect(sticker.getByText("Raise hand", { exact: true })).toBeVisible({ visible: tile.width >= 176 });
  const shown = (await sticker.boundingBox())!;
  expect(shown.x + shown.width).toBeLessThanOrEqual(tile.x + tile.width);
  await expect.poll(() => said.filter(({ type }) => type === "huddle.sticker")).toEqual([{ type: "huddle.sticker", sticker: "hand" }]);
  await screenIsFine();

  // The huddle's buttons take taps again. Opened again, Stickers marks the raised hand, which a tap takes off.
  await opened.getByRole("button", { name: "Mute microphone" }).tap();
  await expect(opened.getByRole("button", { name: "Unmute microphone" })).toBeVisible();
  await open();
  await panel.getByRole("tab", { name: "Stickers" }).tap();
  await expect(panel.getByRole("button", { pressed: true })).toHaveText(/Raise hand$/);
  await panel.getByRole("button", { name: "Raise hand" }).tap();
  await expect(sticker).toHaveCount(0);
  expect(said.filter(({ type }) => type === "huddle.sticker").at(-1)).toEqual({ type: "huddle.sticker", sticker: null });

  // Another is taken off by a tap on it, on the person's own tile.
  await open();
  await panel.getByRole("tab", { name: "Stickers" }).tap();
  await panel.getByRole("button", { name: "Done" }).tap();
  const done = own.getByRole("button", { name: "Remove sticker: Done", exact: true });
  await expect(done).toHaveText("✅Done");
  await done.tap();
  await expect(done).toHaveCount(0);
  expect(said.filter(({ type }) => type === "huddle.sticker").slice(-2)).toEqual([
    { type: "huddle.sticker", sticker: "done" },
    { type: "huddle.sticker", sticker: null },
  ]);
});

test("Invite people, with more people to invite than it lists at once, has a search by name, which stays in sight over the phone's keyboard, and Show more people, and fits the phone", async ({ page, room, session, screenIsFine }) => {
  // 45 to invite, which is more than two pages of them.
  const people = Array.from({ length: 45 }, (_, index) => ({ id: `invite-${index + 1}`, name: `Person ${String(index + 1).padStart(2, "0")}` }));
  await listRoomPeople(page, room, [session.user, ...people]);
  const said = await standInHuddle(page, session.user);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  const inviting = await openInvitePeople(page);
  const listed = inviting.getByRole("listitem");
  await expect(listed).toHaveCount(20);
  const search = inviting.getByRole("textbox", { name: "Search people" });
  await expect(search).toBeVisible();
  await screenIsFine();

  // Show more people, at the end of the list, which scrolls by itself, lists the next 20 under them,
  // and then the last 5, which leaves no more to show. The focus goes to the first of those, not to
  // the search, so the phone's keyboard stays shut.
  const more = inviting.getByRole("button", { name: "Show more people" });
  await more.scrollIntoViewIfNeeded();
  await screenIsFine();
  await more.tap();
  await expect(listed).toHaveCount(40);
  await expect(listed.nth(20)).toBeInViewport();
  await more.tap();
  await expect(listed).toHaveCount(45);
  await expect(more).toHaveCount(0);
  await expect(inviting.getByRole("checkbox", { name: "Person 41" })).toBeFocused();
  await screenIsFine();

  // With the keyboard open the search is in sight still, and what's typed in it lists who has that in their name, from the top.
  await search.tap();
  await openKeyboard(page);
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport({ ratio: 1 });
  await page.keyboard.type("person 4");
  await expect(listed).toHaveText(["Person 40", "Person 41", "Person 42", "Person 43", "Person 44", "Person 45"]);
  await inviting.getByRole("checkbox", { name: "Person 42" }).tap();
  await expect(inviting.getByRole("status")).toHaveText("1 person selected.");
  await inviting.getByRole("button", { name: "Send Invite" }).tap();
  await expect(inviting).toHaveCount(0);
  await expect.poll(() => invitationsSent(said)).toEqual([{ type: "huddle.invite", userIds: ["invite-42"] }]);
});

test("the screens people share in the huddle you're in fit the phone, one large and the other among the huddle's tiles, under it or beside it", async ({ page, room, session, participant, screenIsFine }) => {
  const sharing = await Promise.all(["Ada", "Grace"].map(async (name) => (await participant(name)).session.user));
  await standInHuddleWithScreens(page, session.user, sharing);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  const opened = page.locator("#huddle");
  /** Whether the huddle shows the screen it labels `label`, whose picture plays and has a size, which a frame gives it. */
  const shows = (label: string) => opened.getByLabel(label, { exact: true }).evaluate((video: HTMLVideoElement) => !video.paused && video.videoWidth > 0 && video.currentTime > 0);

  // Ada's, who joined first, shows large, all of it on the screen, under whose it is.
  const stage = opened.getByRole("figure");
  await expect(stage).toContainText("Ada's screen");
  await expect.poll(() => shows("Ada's screen"), { timeout: 15_000 }).toBe(true);
  await expect(stage).toBeInViewport({ ratio: 1 });
  // The tiles are under it on a phone held upright, and beside it on one held on its side, clear of one another. Grace's screen is the first of them.
  const list = opened.getByRole("list", { name: "In the huddle" });
  const tiles = list.getByRole("listitem");
  await expect(tiles).toHaveCount(4);
  await expect(tiles.first()).toHaveText("Grace's screen");
  await expect(tiles.first()).toBeInViewport({ ratio: 1 });
  const [large, small] = [(await stage.boundingBox())!, (await tiles.first().boundingBox())!];
  const { width, height } = page.viewportSize()!;
  if (width > height) expect(small.x).toBeGreaterThanOrEqual(large.x + large.width);
  else expect(small.y).toBeGreaterThanOrEqual(large.y + large.height);
  expect(await huddleTilesKeepClear(list)).toBe(true);
  // A phone has no screen to share, so its huddle has no button for one.
  await expect(opened.getByRole("button", { name: "Mute microphone" })).toBeVisible();
  await expect(opened.getByRole("button", { name: /screen$/ })).toHaveCount(0);
  await screenIsFine();

  // A tap on Grace's tile shows hers large, and Ada's takes the tile.
  await tiles.first().getByRole("button", { name: "Show Grace's screen larger" }).tap();
  await expect(stage).toContainText("Grace's screen");
  await expect(tiles.first()).toHaveText("Ada's screen");
  await expect.poll(() => shows("Grace's screen"), { timeout: 15_000 }).toBe(true);
  await screenIsFine();

  // Minimized, the huddle's bar says who's sharing, and opened again it shows the screens again.
  await opened.getByRole("button", { name: "Minimize huddle" }).tap();
  const bar = page.getByRole("region", { name: `Huddle in ${room.name}` });
  await expect(bar).toContainText("Ada and Grace are sharing screens");
  await screenIsFine();
  await bar.getByTitle("Open huddle").first().tap();
  await expect.poll(() => shows("Ada's screen"), { timeout: 15_000 }).toBe(true);
  await expect(tiles).toHaveCount(4);
});

test("a huddle with more people in it than the phone shows beside a shared screen, or under it, scrolls its tiles by themselves", async ({ page, room, session, participant, screenIsFine }) => {
  const ada = (await participant("Ada")).session.user;
  const others = Array.from({ length: 9 }, (_, index) => ({ id: `someone-${index}`, name: `Someone ${index + 1}` }));
  await standInHuddleWithScreens(page, session.user, [ada], others);
  await openRoomWithHuddlesOn(page, room);
  await header(page).getByRole("button", { name: "Start huddle", exact: true }).tap();
  await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).tap();
  const opened = page.locator("#huddle");
  const stage = opened.getByRole("figure");
  await expect(stage).toContainText("Ada's screen");
  const list = opened.getByRole("list", { name: "In the huddle" });
  const tiles = list.getByRole("listitem");
  await expect(tiles).toHaveCount(11);

  // The tiles keep their size, clear of one another, so the list has more of them than it shows at once.
  await expect(tiles.first()).toBeInViewport({ ratio: 1 });
  await expect(tiles.last()).not.toBeInViewport({ ratio: 1 });
  expect(await huddleTilesKeepClear(list)).toBe(true);
  expect(await list.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
  await screenIsFine();
  // It scrolls to the last of them, the phone's own person, under the screen or beside it, which stays where it was.
  // All of the tile shows but a part of a pixel, where the list's height isn't a whole number of them.
  const before = await stage.boundingBox();
  await tiles.last().scrollIntoViewIfNeeded();
  await expect(tiles.last()).toBeInViewport({ ratio: 0.99 });
  await expect(tiles.last()).toContainText("(you)");
  expect(await stage.boundingBox()).toEqual(before);
  await expect(stage).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

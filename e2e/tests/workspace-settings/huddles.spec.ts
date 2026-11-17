import type { AccountSettings, Me, WorkspaceSettings } from "@ember/protocol";
import { APP_ID_UNKNOWN, APP_SECRET_UNKNOWN, CAMERAS_OFF, RELAY_API_TOKEN_UNKNOWN, RELAY_KEY_ID_UNKNOWN, RELAY_TTL_S, SCREENS_FULL, SCREENS_OFF } from "@ember/protocol/huddles";
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { administratorSession, cookieHeader, editorField, expect, huddleTilesKeepClear, newAddress, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress, type TestRoom } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT, SFU_APP, TURN_KEY } from "../../projects/workspace-settings";
import { startFakeSfu, type FakeSfu, type IceServer } from "./fake-sfu";

// The Huddles tab's cards, Set up huddles and Set up the relay, and a huddle itself, on the second test
// server, which asks the Realtime SFU this spec fakes: to start a session with the keys it's given, and
// to carry what the people in a huddle say, what their cameras show and the screens they share, which
// the fake does through a page of its own. It asks the fake for the relay's servers too, as it asks
// Cloudflare's TURN service. Each test leaves the workspace as a new one is: huddles off, with no
// relay, and cameras and screen sharing allowed in them, and the SFU taking a camera in each size it's
// sent in.

let sfu: FakeSfu;
let relay: Page;
test.beforeAll(async ({ browser }) => {
  relay = await browser.newPage();
  sfu = await startFakeSfu(relay);
});
test.afterAll(async () => {
  // The page first, which answers whatever the SFU is still asked, so nothing keeps it open.
  await relay.close();
  await sfu.close();
});
test.afterEach(async ({ request }) => {
  Object.assign(sfu, { oneSize: false, fixedSizes: false });
  const forgotten = await request.delete("/api/account/huddles", { headers: await asAdministrator(request) });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
  await switchHuddles(request, { huddleCameras: true, huddleScreens: true });
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** Says what people may do in huddles as the administrator, as the Huddles tab's switches do. */
async function switchHuddles(request: APIRequestContext, settings: Pick<AccountSettings, "huddleCameras" | "huddleScreens">): Promise<void> {
  const switched = await request.patch("/api/account", { data: { settings }, headers: await asAdministrator(request) });
  expect(switched.status(), await switched.text()).toBe(200);
}

/** The workspace as its settings have it, which says whether cameras may go on in huddles and screens be shared. */
const workspaceNow = async (request: APIRequestContext) => ((await (await request.get("/api/account", { headers: await asAdministrator(request) })).json()) as WorkspaceSettings).account;

/** The Huddles tab's card on the page. */
const huddlesCard = (page: Page) => page.getByRole("region", { name: "Audio and video chat", exact: true });

/** The card under it, which the tab has while huddles are on: its Cameras row, and its Screen sharing row. */
const camerasCard = (page: Page) => page.getByRole("region", { name: "Cameras", exact: true });
const screensRow = (page: Page) => page.getByRole("region", { name: "Screen sharing", exact: true });

/** The card under those, which the tab has while huddles are on too: whether they have a relay. */
const relayCard = (page: Page) => page.getByRole("region", { name: "Relay for strict networks", exact: true });

/** Where Ember asks the TURN service for a tab's servers, as the TURN key the spec gives it, and what it asks with. */
const TURN_SERVERS_ASKED = { method: "POST", path: `/v1/turn/keys/${TURN_KEY.keyId}/credentials/generate-ice-servers`, authorization: `Bearer ${TURN_KEY.apiToken}`, ttl: RELAY_TTL_S };

/** Opens community settings' Huddles tab as the administrator, answering its card. */
async function openHuddles(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#huddles-settings");
  await signInAsAdministrator(page);
  return huddlesCard(page);
}

test.describe("Set up huddles", () => {
  test("the administrator gives Ember an SFU app's keys, which Cloudflare starts a session with, and Ember keeps them", async ({ page }) => {
    const huddles = await openHuddles(page);
    await expect(huddles).toContainText("Huddles let people in a room talk to each other live.");
    const huddlesSwitch = huddles.getByRole("switch", { name: "Audio and video chat" });
    await expect(huddlesSwitch).not.toBeChecked();
    await expect(camerasCard(page)).toHaveCount(0);
    await expect(screensRow(page)).toHaveCount(0);
    await huddlesSwitch.click();

    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up huddles");
    // The dashboard opens at the account Ember is deployed to.
    await expect(setup.getByRole("link", { name: "Open Cloudflare's dashboard" })).toHaveAttribute(
      "href",
      `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/realtime/sfu`,
    );
    const [appId, appSecret] = [setup.getByRole("textbox", { name: "App ID" }), setup.getByRole("textbox", { name: "App Secret" })];
    const save = setup.getByRole("button", { name: "Save" });
    // The secret shows as dots, in a field that's no password's, which no password manager offers to keep.
    await expect(appSecret).toHaveCSS("-webkit-text-security", "disc");
    await expect(appSecret).toHaveJSProperty("type", "text");

    // An app Cloudflare doesn't know comes back to its field, as does a secret that isn't the app's.
    await appId.fill("0".repeat(32));
    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(APP_ID_UNKNOWN);
    await expect(appId).toHaveAccessibleDescription(APP_ID_UNKNOWN);
    await appId.fill(SFU_APP.appId);
    await appSecret.fill("f".repeat(64));
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(APP_SECRET_UNKNOWN);
    await expect(appSecret).toHaveAccessibleDescription(APP_SECRET_UNKNOWN);

    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(setup).toHaveAccessibleName("Huddles are on");
    expect(sfu.asked.at(-1)).toEqual({ method: "POST", path: `/v1/apps/${SFU_APP.appId}/sessions/new`, authorization: `Bearer ${SFU_APP.appSecret}` });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(huddles).toContainText(`Huddles run through the Realtime SFU app ${SFU_APP.appId} in your Cloudflare account.`);
    await expect(huddlesSwitch).toBeChecked();
    // What people may do in a huddle comes with them: turn their camera on and share their screen, which are both on.
    await expect(camerasCard(page).getByRole("switch", { name: "Cameras" })).toBeChecked();
    await expect(screensRow(page).getByRole("switch", { name: "Screen sharing" })).toBeChecked();

    // Ember keeps the keys, and Change keys starts from the app's ID, asking for its secret again.
    await page.reload();
    await expect(huddlesCard(page).getByRole("switch", { name: "Audio and video chat" })).toBeChecked();
    await huddlesCard(page).getByRole("button", { name: "Change keys" }).click();
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "App ID" })).toHaveValue(SFU_APP.appId);
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "App Secret" })).toHaveValue("");
    await expect(page.getByRole("dialog")).toContainText("Ember has an app's keys already.");
  });

  test("the administrator turns huddles off, once they're sure, which forgets the app's keys", async ({ page, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const huddles = await openHuddles(page);
    page.once("dialog", (dialog) => void dialog.accept());
    const huddlesSwitch = huddles.getByRole("switch", { name: "Audio and video chat" });
    await expect(huddlesSwitch).toBeChecked();
    await huddlesSwitch.click();
    await expect(huddlesSwitch).not.toBeChecked();
    await expect(huddlesSwitch).toBeEnabled();
    await expect(huddles.getByRole("button", { name: "Change keys" })).toHaveCount(0);
    await expect(camerasCard(page)).toHaveCount(0);
    await expect(screensRow(page)).toHaveCount(0);
    await page.reload();
    await expect(huddlesCard(page).getByRole("switch", { name: "Audio and video chat" })).not.toBeChecked();
  });

  test("the administrator turns cameras off for huddles, and on again, which Ember keeps", async ({ page, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    await openHuddles(page);
    const cameras = camerasCard(page);
    await expect(cameras).toContainText("People can turn their camera on in a huddle.");
    const camerasSwitch = cameras.getByRole("switch", { name: "Cameras" });
    await expect(camerasSwitch).toBeChecked();

    // It's saved as it's switched, with nothing to press.
    await camerasSwitch.click();
    await expect(camerasSwitch).not.toBeChecked();
    await expect.poll(() => workspaceNow(request)).toMatchObject({ huddleCameras: false, huddleScreens: true });
    await page.reload();
    await expect(camerasSwitch).not.toBeChecked();
    await camerasSwitch.click();
    await expect(camerasSwitch).toBeChecked();
    await expect.poll(() => workspaceNow(request)).toMatchObject({ huddleCameras: true, huddleScreens: true });
  });

  test("the administrator turns screen sharing off for huddles, and on again, which Ember keeps, with cameras as they were", async ({ page, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    await openHuddles(page);
    // It's the second row of the card that Cameras is on.
    const screens = screensRow(page);
    await expect(screens).toContainText("People can share their screen in a huddle, from a computer.");
    expect((await screens.boundingBox())!.y).toBeGreaterThan((await camerasCard(page).boundingBox())!.y);
    const screensSwitch = screens.getByRole("switch", { name: "Screen sharing" });
    await expect(screensSwitch).toBeChecked();

    await screensSwitch.click();
    await expect(screensSwitch).not.toBeChecked();
    await expect.poll(() => workspaceNow(request)).toMatchObject({ huddleCameras: true, huddleScreens: false });
    await page.reload();
    await expect(screensSwitch).not.toBeChecked();
    await expect(camerasCard(page).getByRole("switch", { name: "Cameras" })).toBeChecked();
    await screensSwitch.click();
    await expect(screensSwitch).toBeChecked();
    await expect.poll(() => workspaceNow(request)).toMatchObject({ huddleCameras: true, huddleScreens: true });
  });

  test("the administrator gives Ember a TURN key for the relay, which Cloudflare makes its servers with, and Ember keeps it until they turn the relay off", async ({ page, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const huddles = await openHuddles(page);
    const relay = relayCard(page);
    await expect(relay).toContainText("With a relay, people on them connect through Cloudflare's TURN service, with a TURN key in your Cloudflare account.");
    const relaySwitch = relay.getByRole("switch", { name: "Relay for strict networks" });
    await expect(relaySwitch).not.toBeChecked();
    await relaySwitch.click();

    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up the relay");
    // The dashboard opens at the account Ember is deployed to.
    await expect(setup.getByRole("link", { name: "Open Cloudflare's dashboard" })).toHaveAttribute("href", `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/calls`);
    const [keyId, apiToken] = [setup.getByRole("textbox", { name: "TURN Token ID" }), setup.getByRole("textbox", { name: "API Token" })];
    const save = setup.getByRole("button", { name: "Save" });
    // The token shows as dots, in a field that's no password's, as the app's secret does.
    await expect(apiToken).toHaveCSS("-webkit-text-security", "disc");
    await expect(apiToken).toHaveJSProperty("type", "text");

    // A key Cloudflare doesn't know comes back to its field, as does a token that isn't the key's.
    const made = sfu.turnServers.length;
    await keyId.fill("0".repeat(32));
    await apiToken.fill(TURN_KEY.apiToken);
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(RELAY_KEY_ID_UNKNOWN);
    await expect(keyId).toHaveAccessibleDescription(RELAY_KEY_ID_UNKNOWN);
    await keyId.fill(TURN_KEY.keyId);
    await apiToken.fill("not-the-keys-token");
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(RELAY_API_TOKEN_UNKNOWN);
    await expect(apiToken).toHaveAccessibleDescription(RELAY_API_TOKEN_UNKNOWN);
    expect(sfu.turnServers).toHaveLength(made);

    // The right one is kept once Cloudflare has made servers with it, which it's asked for as it is for each tab's.
    await apiToken.fill(TURN_KEY.apiToken);
    await save.click();
    await expect(setup).toHaveAccessibleName("The relay is on");
    expect(sfu.asked.at(-1)).toEqual(TURN_SERVERS_ASKED);
    expect(sfu.turnServers).toHaveLength(made + 1);
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(relay).toContainText(`by the TURN key ${TURN_KEY.keyId} in your Cloudflare account.`);
    await expect(relaySwitch).toBeChecked();

    // Ember keeps the key, and Change key starts from its ID, asking for its token again.
    await page.reload();
    await expect(relaySwitch).toBeChecked();
    await relay.getByRole("button", { name: "Change key" }).click();
    await expect(setup.getByRole("textbox", { name: "TURN Token ID" })).toHaveValue(TURN_KEY.keyId);
    await expect(setup.getByRole("textbox", { name: "API Token" })).toHaveValue("");
    await expect(setup).toContainText("Ember has a TURN key already.");
    await setup.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(setup).toBeHidden();

    // Turning the relay off, once they're sure, forgets the key, and leaves huddles on.
    page.once("dialog", (dialog) => void dialog.accept());
    await relaySwitch.click();
    await expect(relaySwitch).not.toBeChecked();
    await expect(relaySwitch).toBeEnabled();
    await expect(relay.getByRole("button", { name: "Change key" })).toHaveCount(0);
    await page.reload();
    await expect(relaySwitch).not.toBeChecked();
    await expect(huddles.getByRole("switch", { name: "Audio and video chat" })).toBeChecked();
  });
});

/** The huddle `page` is in, opened over the page, which is how it starts. */
const huddleOpened = (page: Page, room: TestRoom) => page.getByRole("region", { name: `Huddle in ${room.name}` }).and(page.locator("#huddle"));

/** The bar of the huddle `page` is in, along the window's base, once it's minimized. */
const huddleBar = (page: Page, room: TestRoom) => page.getByRole("region", { name: `Huddle in ${room.name}` }).and(page.locator(":not(#huddle)"));

/** The screen a huddle shows large, under whose it is. */
const stage = (huddle: Locator) => huddle.getByRole("figure");

/** The list of a huddle's tiles, and the tiles, in order. */
const tileList = (huddle: Locator) => huddle.getByRole("list", { name: "In the huddle" });
const tiles = (huddle: Locator) => tileList(huddle).getByRole("listitem");

/** Whether `page` shows the camera or the screen its huddle labels `label`: its track is live, and its picture plays and has a size, which a frame gives it. */
const sees = (page: Page, label: string) =>
  page.evaluate((label) => {
    const video = [...document.querySelectorAll<HTMLVideoElement>("#huddle video")].find((video) => video.ariaLabel === label);
    const [track] = video?.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks() : [];
    return track !== undefined && track.readyState === "live" && !video!.paused && video!.videoWidth > 0 && video!.currentTime > 0;
  }, label);

/** Whether `page` plays the voice of `userId`: their track brings sound, and its audio runs. */
const hears = (page: Page, userId: string) =>
  page.evaluate((userId) => {
    const audio = document.querySelector<HTMLAudioElement>(`[data-huddle-voices] audio[data-user-id="${userId}"]`);
    const [track] = audio?.srcObject instanceof MediaStream ? audio.srcObject.getAudioTracks() : [];
    return track !== undefined && !track.muted && track.readyState === "live" && !audio!.paused && audio!.currentTime > 0;
  }, userId);

/** The green ring a huddle's tile for `name` has while they speak. */
const speakingIn = (huddle: Locator, name: string) => tiles(huddle).filter({ hasText: name }).getByRole("img", { name: "Speaking" });

/** What Chromium calls the devices it makes up, its own choice of each first. A connection sends the first camera's picture and the third's. */
const MICROPHONES = ["Fake Default Audio Input", "Fake Audio Input 1", "Fake Audio Input 2"] as const;
const SPEAKERS = ["Fake Default Audio Output", "Fake Audio Output 1", "Fake Audio Output 2"] as const;
const CAMERAS = ["fake_device_0", "fake_device_1", "fake_device_2"] as const;

/** The menu the arrow called `name` opens in a huddle, of the devices the button beside it uses. */
const devicesMenu = (page: Page, name: string) => page.getByRole("menu", { name, exact: true });

/** Opens it in the huddle `page` has open, and answers it. */
async function openDevices(page: Page, room: TestRoom, name: string): Promise<Locator> {
  await huddleOpened(page, room).getByRole("button", { name, exact: true }).click();
  await expect(devicesMenu(page, name)).toBeVisible();
  return devicesMenu(page, name);
}

/** The devices such a menu has under `heading` to choose among, and the one of them it ticks, which the huddle uses. */
const devicesIn = (menu: Locator, heading: string) => menu.getByRole("group", { name: heading, exact: true }).getByRole("menuitemradio");
const tickedIn = (menu: Locator, heading: string) => menu.getByRole("group", { name: heading, exact: true }).getByRole("menuitemradio", { checked: true });

/** Chooses the device called `label` under `heading` in such a menu, which shuts it. */
async function choose(menu: Locator, heading: string, label: string): Promise<void> {
  await devicesIn(menu, heading).filter({ hasText: label }).click();
  await expect(menu).toBeHidden();
}

/** Whether `page` plays the voice of `userId` through the speaker its browser calls `label`. */
const playsThrough = (page: Page, userId: string, label: string) =>
  page.evaluate(
    async ({ userId, label }) => {
      const audio = document.querySelector<HTMLAudioElement>(`[data-huddle-voices] audio[data-user-id="${userId}"]`);
      const speaker = (await navigator.mediaDevices.enumerateDevices()).find((device) => device.kind === "audiooutput" && device.label === label);
      return audio !== null && speaker !== undefined && audio.sinkId === speaker.deviceId;
    },
    { userId, label },
  );

/** How many pictures `page` has shown so far of the camera its huddle labels `label`. */
const picturesOf = (page: Page, label: string) =>
  page.evaluate((label) => [...document.querySelectorAll<HTMLVideoElement>("#huddle video")].find((video) => video.ariaLabel === label)?.getVideoPlaybackQuality().totalVideoFrames ?? 0, label);

/** How wide the pictures are that `page` shows of the camera its huddle labels `label`: nothing until it has one. */
const widthOf = (page: Page, label: string) =>
  page.evaluate((label) => [...document.querySelectorAll<HTMLVideoElement>("#huddle video")].find((video) => video.ariaLabel === label)?.videoWidth ?? 0, label);

/** Where `refuseDevices` has a page keep what lets it use its devices after all. */
type RefusesDevices = Window & { letUseDevices(): void };

/** Has `page`'s browser refuse it a microphone, as one answers once its person has said no, until the page's `letUseDevices` is called. */
const refuseDevices = (page: Page) =>
  page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const open = media.getUserMedia.bind(media);
    Object.assign(window, { letUseDevices: () => void (media.getUserMedia = open) });
    media.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });

/** Where `keepSounds` has a page keep the `<audio>`s it plays. */
type KeepsSounds = Window & { huddleSoundsPlayed: HTMLMediaElement[] };

/** Has `page` keep each `<audio>` it plays of the huddle's own sounds, most of which are never in the page. */
const keepSounds = (page: Page) =>
  page.addInitScript(() => {
    const played: HTMLMediaElement[] = [];
    Object.assign(window, { huddleSoundsPlayed: played });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.dataset.huddleSound) played.push(this);
      return play.call(this);
    };
  });

/** The huddle's own sounds `page` has played, in order: those that played to their end, and its music, which has none, once it has run. */
const soundsHeard = (page: Page) =>
  page.evaluate(() => (window as unknown as KeepsSounds).huddleSoundsPlayed.flatMap((audio) => (audio.ended || (audio.loop && audio.currentTime > 0) ? audio.dataset.huddleSound! : [])));

/** The huddle's music in `page`: how far into it the page is, and whether it's playing, in the page, where it is while it plays. */
const musicIn = (page: Page) =>
  page.evaluate(() => {
    const audio = (window as unknown as KeepsSounds).huddleSoundsPlayed.filter(({ dataset }) => dataset.huddleSound === "music").at(-1);
    return { at: audio?.currentTime ?? 0, playing: audio !== undefined && audio.isConnected && !audio.paused };
  });

/** Where `keepConnections` has a page keep what it made each of its connections by. */
type KeepsConnections = Window & { huddleConnectionsMadeBy: Array<RTCConfiguration | undefined> };

/** Has `page` keep what it makes each of its connections by. */
const keepConnections = (page: Page) =>
  page.addInitScript(() => {
    const madeBy: Array<RTCConfiguration | undefined> = [];
    Object.assign(window, {
      huddleConnectionsMadeBy: madeBy,
      RTCPeerConnection: class extends RTCPeerConnection {
        constructor(configuration?: RTCConfiguration) {
          super(configuration);
          madeBy.push(configuration);
        }
      },
    });
  });

/** The servers `page` has made each of its connections by, in the order it made them. */
const serversOf = (page: Page) => page.evaluate(() => (window as unknown as KeepsConnections).huddleConnectionsMadeBy.map((configuration) => configuration?.iceServers));

/** What a tab is given of the servers the TURN service made for it: all but the address at the port browsers won't connect to. */
const givenOf = (servers: IceServer[]) => servers.map((server) => ({ ...server, urls: server.urls.filter((url) => !url.includes(":53?")) }));

/** What the room's row in the sidebar ends with while a huddle is going on in it, which says who's in it under a pointer. */
const sidebarMark = (page: Page, room: TestRoom) => page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: room.name, exact: true }).locator("[title]");

/** The huddle of a direct message `page` is in, opened over the page: `name` is who it's with, as the page's person reads them. */
const directHuddle = (page: Page, name: string) => page.getByRole("region", { name: `Huddle with ${name}` }).and(page.locator("#huddle"));

/** What the row of the direct message with `name` ends with in `page`'s sidebar while a huddle is going on in it. */
const directMark = (page: Page, name: string) => page.getByRole("region", { name: "DMs" }).getByRole("link", { name: `Direct message with ${name}`, exact: true }).locator("[title]");

/** The invitation `page` shows into the huddle of a direct message, from `name`. */
const invitationFrom = (page: Page, name: string) => page.getByRole("group", { name: `${name} invites you to a huddle`, exact: true });

/** The invitation `page` shows into the huddle of `room`, which people share, from `name`. */
const roomInvitationFrom = (page: Page, name: string, room: TestRoom) => page.getByRole("group", { name: `${name} invites you to a huddle in ${room.name}`, exact: true });

/** Whether `page` rings for an invitation into a huddle: its sound plays there, over and over, and has for more than `seconds`. */
const rings = (page: Page, seconds = 0) =>
  page.evaluate(
    (seconds) => (window as unknown as KeepsSounds).huddleSoundsPlayed.some((audio) => audio.dataset.huddleSound === "invited" && audio.loop && !audio.paused && audio.currentTime > seconds),
    seconds,
  );

/** Those of `pages` that ring for an invitation into a huddle. */
async function ringing(pages: Page[]): Promise<Page[]> {
  const rung = await Promise.all(pages.map((page) => rings(page)));
  return pages.filter((_, index) => rung[index]);
}

/** The huddle's own sounds `page` has started to play, in order, whether or not its browser let it. */
const soundsStarted = (page: Page) => page.evaluate(() => (window as unknown as KeepsSounds).huddleSoundsPlayed.map((audio) => audio.dataset.huddleSound));

/** A room of the test's own, which everyone is in. */
async function roomOfItsOwn(request: APIRequestContext): Promise<TestRoom> {
  const created = await request.post("/api/rooms", { data: { kind: "open", name: `Standup ${crypto.randomUUID().slice(0, 8)}` }, headers: await asAdministrator(request) });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { room: TestRoom }).room;
}

/** A room of the test's own, which only `members` are in. */
async function roomOfJust(request: APIRequestContext, members: { id: string }[]): Promise<TestRoom> {
  const created = await request.post("/api/rooms", {
    data: { kind: "closed", name: `Launch ${crypto.randomUUID().slice(0, 8)}`, memberIds: members.map(({ id }) => id) },
    headers: await asAdministrator(request),
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { room: TestRoom }).room;
}

/** Someone new, who joins Ember with the join link under `firstName`: who they are, and a browser of their own. */
async function newcomer(browser: Browser, baseURL: string | undefined, request: APIRequestContext, firstName: string): Promise<{ user: Me; context: BrowserContext }> {
  const { joinCode } = (await (await request.get("/api/account", { headers: await asAdministrator(request) })).json()) as WorkspaceSettings;
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const joined = await context.request.post(`/api/join/${joinCode}`, {
    data: { name: `${firstName} ${crypto.randomUUID().slice(0, 8)}`, emailAddress: `${crypto.randomUUID()}@example.com`, password: "compiler error" },
    headers: { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN },
  });
  expect(joined.status(), await joined.text()).toBe(201);
  return { user: ((await joined.json()) as { user: Me }).user, context };
}

/** Has `page`'s person join the huddle going on in `room`, by its link and the preview, and answers the huddle opened over their page. */
async function joinByLink(page: Page, room: TestRoom): Promise<Locator> {
  await useOwnAddress(page);
  await page.goto(`/rooms/${room.id}/huddle`);
  await page.getByRole("dialog", { name: `Join the huddle in ${room.name}` }).getByRole("button", { name: "Join Huddle" }).click();
  return huddleOpened(page, room);
}

/** The SFU's sessions that have carried a track, each of which is a connection of some tab's. */
const sessionsCarried = () => new Set(sfu.asked.flatMap(({ method, path }) => (method === "POST" ? (/\/sessions\/([^/]+)\/tracks\/new$/.exec(path)?.[1] ?? []) : [])));

/** Those of them the room hasn't had the SFU close a track of. */
const sessionsLeftOpen = () => [...sessionsCarried()].filter((sessionId) => !sfu.asked.some(({ method, path }) => method === "PUT" && path.endsWith(`/sessions/${sessionId}/tracks/close`)));

/** How many tracks the SFU has been asked for: to take one a browser publishes, or to give a browser one. */
const tracksAsked = () => sfu.asked.filter(({ method, path }) => method === "POST" && path.endsWith("/tracks/new")).length;

/** The sizes the SFU has been asked for since its request number `since`, in order: with a track it gives a browser, or of one it gives already. */
const sizesAsked = (since: number) => sfu.asked.slice(since).flatMap(({ path, sizes = [] }) => sizes.map((size) => `${path.endsWith("/tracks/update") ? "changed to" : "asked for in"} ${size}`));

test.describe("A huddle", () => {
  test("two people start and join a room's huddle, which their sidebars show, hear and see each other and hear its sounds, and leave it", async ({ page, browser, baseURL, request }) => {
    // Their voices and their cameras, and the huddle's music twice, which waits five seconds each time.
    test.slow();
    const administrator = await administratorSession(request);
    const headers = { Cookie: cookieHeader(administrator), ...SAME_ORIGIN };
    const room = await roomOfItsOwn(request);

    // Ada has the room open as huddles are turned on, which gives its header the huddle button.
    await keepSounds(page);
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);
    const start = page.getByRole("button", { name: "Start huddle", exact: true });
    await expect(start).toHaveCount(0);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers });
    expect(saved.status(), await saved.text()).toBe(200);
    // She starts the room's huddle from it, by the preview, which has her microphone open.
    await start.click();
    const starting = page.getByRole("dialog", { name: `Start a huddle in ${room.name}` });
    await expect(starting.getByRole("combobox", { name: "Microphone" })).toBeVisible();
    await starting.getByRole("button", { name: "Start Huddle" }).click();
    // The huddle opens over the room, with a tile for her, and takes the focus.
    const adasHuddle = huddleOpened(page, room);
    await expect(adasHuddle).toContainText("1 person");
    await expect(adasHuddle.getByRole("listitem")).toHaveText([`${administrator.user.name} (you)`]);
    await expect(adasHuddle).toBeFocused();
    const adasBar = huddleBar(page, room);
    await expect(adasBar).toHaveCount(0);
    // The room's row in her sidebar ends with the headphones, her face and how many are in it.
    await expect(sidebarMark(page, room)).toHaveAttribute("title", "Just you in the huddle");
    await expect(sidebarMark(page, room).getByText("1", { exact: true })).toBeVisible();
    await expect(sidebarMark(page, room).locator("img")).toHaveCount(1);
    // She hears herself join, and then, as she's alone in it, the huddle's music.
    await expect.poll(() => soundsHeard(page), { timeout: 15_000 }).toEqual(["joined", "music"]);

    // Grace, who joins Ember with the join link, sees it going on in the room's header and at the end of
    // its row in her sidebar, and its link opens the room at the preview.
    const { user: her, context } = await newcomer(browser, baseURL, request, "Grace");
    const grace = await context.newPage();
    await keepSounds(grace);
    await useOwnAddress(grace);
    await grace.goto(`/rooms/${room.id}`);
    await expect(grace.getByRole("button", { name: "Join huddle, 1 in it" })).toBeVisible();
    await expect(sidebarMark(grace, room)).toHaveAttribute("title", "Ada is in the huddle");
    await grace.goto(`/rooms/${room.id}/huddle`);
    const joining = grace.getByRole("dialog", { name: `Join the huddle in ${room.name}` });
    await expect(joining).toContainText("Ada is in it now.");
    await expect(grace).toHaveURL(`${baseURL}/rooms/${room.id}`);
    // She turns her camera on in the preview, which shows her its picture and lets her choose it, and joins with it on.
    await expect(joining.getByRole("combobox", { name: "Camera" })).toHaveCount(0);
    await joining.getByRole("button", { name: "Turn on camera" }).click();
    await expect(joining.getByLabel("Your camera")).toBeVisible();
    await expect(joining.getByRole("combobox", { name: "Camera" })).toBeVisible();
    await joining.getByRole("button", { name: "Join Huddle" }).click();
    const gracesHuddle = huddleOpened(grace, room);
    await expect(gracesHuddle).toContainText("2 people");
    await expect(adasHuddle).toContainText("2 people");
    await expect(adasHuddle.getByRole("listitem")).toHaveText([`${administrator.user.name} (you)`, her.name]);
    await expect(sidebarMark(grace, room)).toHaveAttribute("title", "Ada and you are in the huddle");
    await expect(sidebarMark(page, room)).toHaveAttribute("title", "Grace and you are in the huddle");
    await expect(sidebarMark(page, room).getByText("2", { exact: true })).toBeVisible();
    await expect(sidebarMark(page, room).locator("img")).toHaveCount(2);

    // Each hears the other, through the SFU. Ada heard Grace join, which stopped her music.
    await expect.poll(() => hears(grace, administrator.user.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => hears(page, her.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => soundsHeard(page)).toEqual(["joined", "music", "joined"]);
    const stopped = await musicIn(page);
    expect(stopped.playing).toBe(false);
    expect(stopped.at).toBeGreaterThan(0);
    // A browser's made-up microphone beeps, so each of them shows as speaking: in her own huddle by her
    // microphone, and in the other's by her voice, as the SFU brings it.
    for (const huddle of [adasHuddle, gracesHuddle]) {
      for (const name of [administrator.user.name, her.name]) await expect(speakingIn(huddle, name)).toHaveCount(1, { timeout: 15_000 });
    }

    // Each sees her own camera, and Ada sees Grace's, through the SFU. Ada turns hers on from the huddle, and Grace sees it.
    const [adasCamera, gracesCamera] = [`${administrator.user.name}'s camera`, `${her.name}'s camera`];
    await expect.poll(() => sees(grace, "Your camera"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => sees(page, gracesCamera), { timeout: 15_000 }).toBe(true);
    await adasHuddle.getByRole("button", { name: "Turn on camera" }).click();
    await expect.poll(() => sees(page, "Your camera"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => sees(grace, adasCamera), { timeout: 15_000 }).toBe(true);
    // The tiles show all of both without scrolling.
    expect(await adasHuddle.getByRole("list").evaluate((tiles) => tiles.parentElement!.scrollHeight <= tiles.parentElement!.clientHeight)).toBe(true);

    // Ada minimizes the huddle to its bar, which gets the focus, and shows the room again. Her camera stays on for Grace.
    await adasHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await expect(adasBar).toContainText("Grace and you are in the huddle");
    await expect(adasBar.getByRole("button", { name: /^Huddle in/ })).toBeFocused();
    await expect(adasHuddle).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Leave huddle", exact: true })).toBeVisible();
    await expect(adasBar.getByRole("button", { name: "Turn off camera" })).toBeVisible();
    expect(await sees(grace, adasCamera)).toBe(true);

    // She mutes from the bar, and unmutes with the keys, which the button she pressed doesn't take as a press.
    await adasBar.getByRole("button", { name: "Mute microphone" }).click();
    await expect(adasBar.getByRole("button", { name: "Unmute microphone" })).toBeFocused();
    // Muted, she no longer shows as speaking in Grace's huddle, and does again once she has unmuted.
    await expect(tiles(gracesHuddle).filter({ hasText: administrator.user.name }).getByRole("img", { name: "Muted" })).toBeVisible();
    await expect(speakingIn(gracesHuddle, administrator.user.name)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+Space");
    await expect(adasBar.getByRole("button", { name: "Mute microphone" })).toBeVisible();
    await expect(speakingIn(gracesHuddle, administrator.user.name)).toHaveCount(1, { timeout: 15_000 });

    // She opens it again from the bar, and sees Grace again. Then she turns her camera off, and Grace sees her avatar.
    await adasBar.getByRole("button", { name: "Open huddle", exact: true }).click();
    await expect(adasHuddle).toBeFocused();
    await expect.poll(() => sees(page, gracesCamera), { timeout: 15_000 }).toBe(true);
    await adasHuddle.getByRole("button", { name: "Turn off camera" }).click();
    await expect(adasHuddle.getByLabel("Your camera")).toHaveCount(0);
    await expect(gracesHuddle.getByLabel(adasCamera)).toHaveCount(0);
    await expect(gracesHuddle.getByRole("listitem").first().locator("img")).toBeVisible();

    // An administrator turns cameras off. Grace's goes off, which she's told, so Ada sees her avatar, and
    // neither has a camera button until cameras are on again.
    await switchHuddles(request, { huddleCameras: false });
    await expect(grace.getByRole("alert").filter({ hasText: CAMERAS_OFF })).toBeVisible();
    await expect(gracesHuddle.getByLabel("Your camera")).toHaveCount(0);
    await expect(adasHuddle.getByLabel(gracesCamera)).toHaveCount(0);
    for (const huddle of [adasHuddle, gracesHuddle]) await expect(huddle.getByRole("button", { name: /camera/ })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: CAMERAS_OFF })).toHaveCount(0);
    await switchHuddles(request, { huddleCameras: true });
    for (const huddle of [adasHuddle, gracesHuddle]) await expect(huddle.getByRole("button", { name: "Turn on camera" })).toBeVisible();

    // Grace leaves from her huddle. It goes on for Ada, who no longer hears her, or sees her.
    await gracesHuddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(gracesHuddle).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "Join huddle, 1 in it" })).toBeVisible();
    await expect(sidebarMark(grace, room)).toHaveAttribute("title", "Ada is in the huddle");
    await expect(adasHuddle).toContainText("1 person");
    await expect(page.locator("[data-huddle-voices] audio[data-user-id]")).toHaveCount(0);
    await expect(adasHuddle.locator("video")).toHaveCount(0);
    // Each heard Grace leave. Ada, alone again, hears the music go on from where it stopped.
    await expect.poll(() => soundsHeard(grace)).toEqual(["joined", "left"]);
    await expect.poll(() => soundsHeard(page), { timeout: 15_000 }).toEqual(["joined", "music", "joined", "left", "music"]);
    await expect.poll(async () => (await musicIn(page)).playing).toBe(true);
    expect((await musicIn(page)).at).toBeGreaterThanOrEqual(stopped.at);

    // Ada minimizes the huddle and leaves from the room's header, which ends it, and its keys offer to start another.
    await adasHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await expect(adasBar).toContainText("Just you in the huddle");
    await page.getByRole("button", { name: "Leave huddle", exact: true }).click();
    await expect(adasBar).toHaveCount(0);
    await expect.poll(() => soundsHeard(page)).toEqual(["joined", "music", "joined", "left", "music", "left"]);
    expect((await musicIn(page)).playing).toBe(false);
    await expect(grace.getByRole("button", { name: "Start huddle", exact: true })).toBeVisible();
    await expect(sidebarMark(grace, room)).toHaveCount(0);
    await expect(sidebarMark(page, room)).toHaveCount(0);
    await page.keyboard.press("Control+Alt+Shift+H");
    await expect(starting).toBeVisible();
    await starting.getByRole("button", { name: "Cancel", exact: true }).last().click();
    await expect(starting).toBeHidden();

    // The room had the SFU close what each of them published, a microphone and a camera, and what each heard and saw.
    expect(sessionsCarried().size).toBeGreaterThanOrEqual(8);
    await expect.poll(sessionsLeftOpen).toEqual([]);

    // Turning huddles off takes the button from the headers of the rooms people have open.
    const forgotten = await request.delete("/api/account/huddles", { headers });
    expect(forgotten.status(), await forgotten.text()).toBe(200);
    await expect(grace.getByRole("button", { name: "Start huddle", exact: true })).toHaveCount(0);
    await expect(start).toHaveCount(0);
    await context.close();
  });

  test("a huddle has a message in its room, which says it's happening and who's in it, offers Join, has a thread, and says who was in it and for how long once everyone has left", async ({ page, browser, baseURL, request }) => {
    const administrator = await administratorSession(request);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
    expect(saved.status(), await saved.text()).toBe(200);
    const room = await roomOfItsOwn(request);
    /** The huddle's message among the room's, as `of` shows it. */
    const message = (of: Page) => of.getByRole("log").getByRole("article").filter({ has: of.getByRole("heading", { name: /^A huddle / }) });
    const joinFrom = (of: Page) => message(of).getByRole("button", { name: "Join", exact: true });

    // Grace, who joins Ember with the join link, has the room open before anyone huddles in it.
    const { context } = await newcomer(browser, baseURL, request, "Grace");
    const grace = await context.newPage();
    await useOwnAddress(grace);
    await grace.goto(`/rooms/${room.id}`);
    await expect(grace.getByRole("heading", { level: 1 })).toHaveText(room.name);
    await expect(message(grace)).toHaveCount(0);

    // Ada starts a huddle there, which the room writes a message of: Grace sees it happening, with Ada in it.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await expect(adasHuddle).toContainText("1 person");
    await expect(message(grace).getByRole("heading")).toContainText("A huddle is happeningLIVE");
    await expect(message(grace)).toContainText("Ada is in the huddle");
    await expect(message(grace)).not.toContainText("A huddle started");

    // She joins from the message, by the preview. Behind her huddle, the message names them both, with nothing to join.
    await joinFrom(grace).click();
    await grace.getByRole("dialog", { name: `Join the huddle in ${room.name}` }).getByRole("button", { name: "Join Huddle" }).click();
    const gracesHuddle = huddleOpened(grace, room);
    await expect(gracesHuddle).toContainText("2 people");
    await gracesHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await expect(message(grace)).toContainText("Ada and you are in the huddle");
    await expect(joinFrom(grace)).toHaveCount(0);
    await adasHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await expect(message(page)).toContainText("Grace and you are in the huddle");
    await expect(joinFrom(page)).toHaveCount(0);

    // Its thread is the huddle's: Grace replies in it, which the message sums up for them both.
    await grace.getByRole("heading", { level: 1 }).hover();
    await message(grace).hover();
    await message(grace).getByRole("group", { name: "Message actions" }).getByRole("link", { name: "Reply in thread" }).click();
    const thread = grace.getByRole("complementary", { name: "Thread" });
    await expect(thread.getByRole("article").first()).toContainText("A huddle is happeningLIVE");
    await editorField(thread, "Write a reply").fill("Notes from the huddle");
    await editorField(thread, "Write a reply").press("Enter");
    await expect(thread.getByRole("article").filter({ hasText: "Notes from the huddle" })).toBeVisible();
    for (const of of [page, grace]) await expect(message(of).getByRole("link", { name: /^1 reply\b/ })).toBeVisible();
    await thread.getByRole("link", { name: "Close thread" }).click();

    // Grace leaves, and can join again from the message. Then Ada does, which ends the huddle: the message
    // says that it happened, who was in it, and for how long, to each of them and to whoever opens the room later.
    await grace.getByRole("button", { name: "Leave huddle", exact: true }).click();
    await expect(message(grace)).toContainText("Ada is in the huddle");
    await expect(joinFrom(grace)).toBeVisible();
    await expect(message(page)).toContainText("Just you in the huddle");
    await page.getByRole("button", { name: "Leave huddle", exact: true }).click();
    for (const [of, who] of [[page, "Grace and you"], [grace, "Ada and you"]] as const) {
      await expect(message(of).getByRole("heading")).toContainText("A huddle happened");
      await expect(message(of)).not.toContainText("LIVE");
      await expect(message(of)).toContainText(new RegExp(`${who} were in the huddle for (less than a minute|1 minute)`));
      await expect(joinFrom(of)).toHaveCount(0);
      await expect(message(of).getByRole("link", { name: /^1 reply\b/ })).toBeVisible();
    }
    await grace.reload();
    await expect(message(grace)).toContainText(/Ada and you were in the huddle for (less than a minute|1 minute)/);
    await expect(message(grace)).toHaveCount(1);
    await context.close();
  });

  test("a huddle shows its thread beside the people in it, where they write to one another whatever page is under the huddle, which reads nothing of the room, and the room keeps the thread under the huddle's message", async ({ page, browser, baseURL, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const [room, other] = [await roomOfItsOwn(request), await roomOfItsOwn(request)];
    const threadOf = (huddle: Locator) => huddle.getByRole("complementary", { name: "Huddle thread" });
    const threadTool = (huddle: Locator) => huddle.getByRole("button", { name: "Thread", exact: true });
    const replyBox = (huddle: Locator) => editorField(threadOf(huddle), "Write a reply");
    const replies = (huddle: Locator) => threadOf(huddle).getByRole("article");
    const reply = async (huddle: Locator, text: string) => {
      await replyBox(huddle).fill(text);
      await replyBox(huddle).press("Enter");
    };
    /** A room's row in `of`'s sidebar, which says when the room is unread. */
    const rowOf = (of: Page, { name }: TestRoom) => of.getByRole("region", { name: "Rooms" }).getByRole("link", { name, exact: true });

    // Ada starts the room's huddle, which shows its thread beside her tile, saying what it's for where a
    // thread has its message, with Thread lit among the huddle's buttons.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await expect(threadOf(adasHuddle).getByRole("heading", { name: "Thread" })).toBeVisible();
    await expect(threadOf(adasHuddle)).toContainText("Every huddle has a thread");
    await expect(threadOf(adasHuddle)).toContainText(`stay as a thread in ${room.name} once it ends.`);
    await expect(threadTool(adasHuddle)).toHaveAttribute("aria-pressed", "true");
    const [people, beside] = [(await tileList(adasHuddle).boundingBox())!, (await threadOf(adasHuddle).boundingBox())!];
    expect(beside.width).toBe(340);
    expect(beside.x).toBeGreaterThanOrEqual(people.x + people.width);
    // Its composer is there to write in, and has left the focus on the huddle, which took it as it opened.
    await expect(replyBox(adasHuddle)).toBeVisible();
    await expect(adasHuddle).toBeFocused();
    // The panel is narrower than a room's thread, so Also send to the room has a line of its own over the composer's buttons, and isn't cut short.
    const alsoSend = threadOf(adasHuddle).getByRole("checkbox", { name: `Also send to #${room.name}` });
    expect(await alsoSend.evaluate((box) => box.nextElementSibling!.scrollWidth <= box.nextElementSibling!.clientWidth)).toBe(true);

    // Grace joins by the huddle's link, and has its thread too. What Ada writes there she reads, and Ada what she answers.
    const { user: her, context } = await newcomer(browser, baseURL, request, "Grace");
    const grace = await context.newPage();
    const gracesHuddle = await joinByLink(grace, room);
    await expect(gracesHuddle).toContainText("2 people");
    await reply(adasHuddle, "Here's the checklist");
    await expect(replies(gracesHuddle)).toHaveText([/Here's the checklist/]);
    await reply(gracesHuddle, "Docs are ready");
    for (const huddle of [adasHuddle, gracesHuddle]) await expect(replies(huddle)).toHaveText([/Here's the checklist/, /Docs are ready/]);
    // Both have the room open, under their huddles.
    const hereNow = page.getByText(/^\d+ here now$/);
    await expect(hereNow).toHaveText("2 here now");

    // Close thread takes it away, and leaves the focus on Thread, which is lit no longer, and shows it again, to write in.
    await threadOf(adasHuddle).getByRole("button", { name: "Close thread" }).click();
    await expect(threadOf(adasHuddle)).toHaveCount(0);
    await expect(threadTool(adasHuddle)).toBeFocused();
    await expect(threadTool(adasHuddle)).toHaveAttribute("aria-pressed", "false");
    await threadTool(adasHuddle).click();
    await expect(replies(adasHuddle)).toHaveText([/Here's the checklist/, /Docs are ready/]);
    await expect(replyBox(adasHuddle)).toBeFocused();
    await expect(threadTool(adasHuddle)).toHaveAttribute("aria-pressed", "true");

    // The people @ lists show above the line being written: under it the panel ends, over the huddle's own buttons, where they'd be cut off.
    await replyBox(adasHuddle).pressSequentially(`@${her.name.split(" ")[1]}`);
    const listed = threadOf(adasHuddle).getByRole("listbox");
    await expect(listed.getByRole("option")).toHaveText([her.name]);
    const [line, list] = [(await replyBox(adasHuddle).locator("p").first().boundingBox())!, (await listed.boundingBox())!];
    expect(list.y + list.height).toBeLessThan(line.y + line.height);
    await replyBox(adasHuddle).fill("");
    await expect(listed).toBeHidden();

    // A window narrower than 1180px has no room for the thread beside the people, so its huddle has neither it nor Thread.
    await page.setViewportSize({ width: 1179, height: 720 });
    await expect(threadOf(adasHuddle)).toHaveCount(0);
    await expect(threadTool(adasHuddle)).toHaveCount(0);
    await page.setViewportSize({ width: 1180, height: 720 });
    await expect(replies(adasHuddle)).toHaveCount(2);
    await expect(threadTool(adasHuddle)).toBeVisible();

    // In a window too short for the thread, it keeps to its place over the huddle's own buttons, which stay clear to press, and scrolls there, as far as its composer's buttons.
    await page.setViewportSize({ width: 1280, height: 330 });
    await adasHuddle.getByRole("button", { name: "Leave", exact: true }).click({ trial: true });
    const send = threadOf(adasHuddle).getByRole("button", { name: "Send Message" });
    await expect(send).not.toBeInViewport();
    await threadOf(adasHuddle).hover();
    await page.mouse.wheel(0, 330);
    await expect(send).toBeInViewport({ ratio: 1 });
    await page.setViewportSize({ width: 1280, height: 720 });

    // Grace minimizes her huddle, goes to another room, and opens the huddle over it, where its thread is still the huddle's.
    await gracesHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await rowOf(grace, other).click();
    await expect(grace.getByRole("heading", { level: 1 })).toHaveText(other.name);
    await huddleBar(grace, room).getByRole("button", { name: "Open huddle", exact: true }).click();
    await expect(replies(gracesHuddle)).toHaveText([/Here's the checklist/, /Docs are ready/]);
    await expect(rowOf(grace, room)).not.toHaveAccessibleDescription(/\bUnread\b/);
    // Having the thread before her isn't being in its room, where Ada is alone now.
    await expect(hereNow).toHaveText("1 here now");

    // What Ada says in the room is the room's, and not its thread's. Grace has the thread before her and
    // not the room, which she finds unread. Behind Ada's huddle, the room's message of it counts the replies.
    await adasHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await editorField(page, "Write a message").fill("Lunch after this?");
    await editorField(page, "Write a message").press("Enter");
    await expect(rowOf(grace, room)).toHaveAccessibleDescription(/\bUnread\b/);
    await expect(replies(gracesHuddle)).toHaveCount(2);
    const message = page.getByRole("log", { name: `Messages in ${room.name}` }).getByRole("article").filter({ has: page.getByRole("heading", { name: /^A huddle / }) });
    await expect(message.getByRole("link", { name: /^2 replies\b/ })).toBeVisible();

    // Ada opens the thread beside the room, and begins a reply there. Her huddle, opened again over it, has
    // the thread as she left it, with what she began, which she goes on with there.
    await message.getByRole("link", { name: /^2 replies\b/ }).click();
    const roomsThread = page.getByRole("complementary", { name: "Thread", exact: true });
    const roomsReplyBox = editorField(roomsThread, "Write a reply");
    await roomsReplyBox.fill("Shipping on");
    const openHuddle = huddleBar(page, room).getByRole("button", { name: "Open huddle", exact: true });
    await openHuddle.click();
    await expect(replies(adasHuddle)).toHaveCount(2);
    await expect(replyBox(adasHuddle)).toHaveText("Shipping on");
    await replyBox(adasHuddle).fill("Shipping on Friday");
    // It's one reply that she's writing, so the thread beside the room has it as she left it in the huddle.
    await adasHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    await expect(roomsReplyBox).toHaveText("Shipping on Friday");
    // She sends it from the huddle, which Grace reads over the other room.
    await openHuddle.click();
    await replyBox(adasHuddle).press("Enter");
    await expect(replies(gracesHuddle)).toHaveText([/Here's the checklist/, /Docs are ready/, /Shipping on Friday/]);

    // They leave, which ends the huddle. The room keeps its thread, under the message that says a huddle
    // happened. Beside the room, nothing of the reply that's sent is left to send, and the next is written as ever.
    for (const huddle of [gracesHuddle, adasHuddle]) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await expect(message.getByRole("heading")).toContainText("A huddle happened");
    await expect(message.getByRole("link", { name: /^3 replies\b/ })).toBeVisible();
    await expect(roomsThread.getByRole("article")).toHaveText([/A huddle happened/, /Here's the checklist/, /Docs are ready/, /Shipping on Friday/]);
    await expect(roomsReplyBox).toHaveText("");
    await roomsReplyBox.fill("Thanks, both");
    await roomsReplyBox.press("Enter");
    await expect(roomsThread.getByRole("article")).toHaveText([/A huddle happened/, /Here's the checklist/, /Docs are ready/, /Shipping on Friday/, /Thanks, both/]);
    await expect(roomsReplyBox).toHaveText("");
    await context.close();
  });

  test("people share their screens in a huddle, two at once, which the others see large beside everyone in it, until an administrator turns screen sharing off", async ({ page, browser, baseURL, request }) => {
    // Three browsers, two of which send a screen to the other two.
    test.slow();
    const administrator = await administratorSession(request);
    const room = await roomOfItsOwn(request);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const carriedBefore = sessionsCarried().size;

    // Ada starts the room's huddle, and Grace and Linus join it.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await expect(adasHuddle).toContainText("1 person");
    // She closes its thread, which leaves her huddle the room to show a screen with its tiles beside it.
    await adasHuddle.getByRole("button", { name: "Close thread" }).click();
    const [her, him] = [await newcomer(browser, baseURL, request, "Grace"), await newcomer(browser, baseURL, request, "Linus")];
    const [grace, linus] = [await her.context.newPage(), await him.context.newPage()];
    const gracesHuddle = await joinByLink(grace, room);
    await expect(adasHuddle).toContainText("2 people");
    const linusHuddle = await joinByLink(linus, room);
    const everyones = [adasHuddle, gracesHuddle, linusHuddle];
    // Nobody shares a screen yet: each has the button for it, and the huddle is its tiles.
    for (const huddle of everyones) {
      await expect(huddle).toContainText("3 people");
      await expect(huddle.getByRole("button", { name: "Share screen" })).toBeVisible();
      await expect(stage(huddle)).toHaveCount(0);
    }

    // Grace shares hers, which her browser gives without asking her which. She sees it among the tiles, first of them.
    const [adasName, gracesScreen, linusScreen] = [`${administrator.user.name} (you)`, `${her.user.name}'s screen`, `${him.user.name}'s screen`];
    await gracesHuddle.getByRole("button", { name: "Share screen" }).click();
    await expect(gracesHuddle.getByRole("button", { name: "Stop sharing screen" })).toBeVisible();
    await expect(tiles(gracesHuddle)).toHaveText(["Your screen", administrator.user.name, `${her.user.name} (you)`, him.user.name]);
    await expect.poll(() => sees(grace, "Your screen"), { timeout: 15_000 }).toBe(true);
    await expect(stage(gracesHuddle)).toHaveCount(0);
    // Ada and Linus see it large, through the SFU, under whose it is, with everyone's tiles small in a strip beside it.
    for (const [watcher, huddle] of [[page, adasHuddle], [linus, linusHuddle]] as const) {
      await expect(stage(huddle)).toContainText(gracesScreen);
      await expect.poll(() => sees(watcher, gracesScreen), { timeout: 15_000 }).toBe(true);
      await expect(tiles(huddle)).toHaveCount(3);
    }
    const [large, small] = [(await stage(adasHuddle).boundingBox())!, (await tiles(adasHuddle).first().boundingBox())!];
    expect(large.width).toBeGreaterThan(3 * small.width);
    expect(small.x).toBeGreaterThanOrEqual(large.x + large.width);
    // The screen keeps its own shape, 16 by 9, under the line that says whose it is.
    const picture = (await stage(adasHuddle).getByLabel(gracesScreen).boundingBox())!;
    expect(picture.width / picture.height).toBeCloseTo(16 / 9, 1);
    expect(picture.width).toBeCloseTo(large.width, -1);
    // And all three tiles show beside it, clear of one another, each one's avatar over its name.
    for (const tile of await tiles(adasHuddle).all()) await expect(tile).toBeInViewport({ ratio: 1 });
    expect(await huddleTilesKeepClear(tileList(adasHuddle))).toBe(true);
    // Linus's huddle still shows its thread, which leaves the screen less room across: his tiles are under it.
    const [linusLarge, linusSmall] = [(await stage(linusHuddle).boundingBox())!, (await tiles(linusHuddle).first().boundingBox())!];
    expect(linusSmall.y).toBeGreaterThanOrEqual(linusLarge.y + linusLarge.height);

    // Minimized, Ada's huddle says who's sharing on its bar, and opened again it shows her the screen again.
    await adasHuddle.getByRole("button", { name: "Minimize huddle" }).filter({ visible: true }).click();
    const adasBar = huddleBar(page, room);
    await expect(adasBar).toContainText("Grace is sharing a screen");
    await adasBar.getByRole("button", { name: "Open huddle", exact: true }).click();
    await expect.poll(() => sees(page, gracesScreen), { timeout: 15_000 }).toBe(true);

    // Linus shares his as well. Ada still sees Grace's large, who joined before him, and his among the tiles, first of them.
    await linusHuddle.getByRole("button", { name: "Share screen" }).click();
    await expect(tiles(adasHuddle)).toHaveText([linusScreen, adasName, her.user.name, him.user.name]);
    await expect(stage(adasHuddle)).toContainText(gracesScreen);
    await expect.poll(() => sees(page, linusScreen), { timeout: 15_000 }).toBe(true);
    // Grace sees his large, and Linus hers, each with their own among the tiles.
    await expect(stage(gracesHuddle)).toContainText(linusScreen);
    await expect.poll(() => sees(grace, linusScreen), { timeout: 15_000 }).toBe(true);
    await expect(tiles(gracesHuddle).first()).toHaveText("Your screen");
    await expect(stage(linusHuddle)).toContainText(gracesScreen);
    await expect(tiles(linusHuddle).first()).toHaveText("Your screen");
    await expect.poll(() => sees(linus, "Your screen"), { timeout: 15_000 }).toBe(true);

    // A click on his tile shows Ada his large in place of hers, which takes its tile.
    await adasHuddle.getByRole("button", { name: `Show ${linusScreen} larger` }).click();
    await expect(stage(adasHuddle)).toContainText(linusScreen);
    await expect(tiles(adasHuddle)).toHaveText([gracesScreen, adasName, her.user.name, him.user.name]);
    for (const screen of [gracesScreen, linusScreen]) await expect.poll(() => sees(page, screen), { timeout: 15_000 }).toBe(true);

    // Two are as many as a huddle shows, so Ada is told why hers isn't shared, before her browser gives it.
    await adasHuddle.getByRole("button", { name: "Share screen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: SCREENS_FULL })).toBeVisible();
    await expect(adasHuddle.getByRole("button", { name: "Share screen" })).toBeVisible();

    // Linus stops sharing. Ada sees Grace's large again, and Grace, who alone shares one, the tiles as they were, with hers.
    await linusHuddle.getByRole("button", { name: "Stop sharing screen" }).click();
    await expect(linusHuddle.getByRole("button", { name: "Share screen" })).toBeVisible();
    await expect(stage(adasHuddle)).toContainText(gracesScreen);
    await expect(tiles(adasHuddle)).toHaveCount(3);
    await expect(stage(gracesHuddle)).toHaveCount(0);
    await expect(tiles(gracesHuddle)).toHaveCount(4);
    await expect.poll(() => sees(linus, gracesScreen), { timeout: 15_000 }).toBe(true);

    // In a window as narrow as a phone held upright, the tiles go under the screen, and nothing is wider than the window.
    await linus.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await tiles(linusHuddle).first().boundingBox())!.y >= (await stage(linusHuddle).boundingBox())!.y + (await stage(linusHuddle).boundingBox())!.height).toBe(true);
    expect(await linus.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(stage(linusHuddle)).toBeInViewport({ ratio: 1 });
    expect(await huddleTilesKeepClear(tileList(linusHuddle))).toBe(true);
    // In one as short as a phone held on its side, they're beside the screen again, two to a row, which shows them all.
    await linus.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => (await tiles(linusHuddle).first().boundingBox())!.x >= (await stage(linusHuddle).boundingBox())!.x + (await stage(linusHuddle).boundingBox())!.width).toBe(true);
    await expect(stage(linusHuddle)).toBeInViewport({ ratio: 1 });
    for (const tile of await tiles(linusHuddle).all()) await expect(tile).toBeInViewport({ ratio: 1 });
    expect((await tiles(linusHuddle).nth(1).boundingBox())!.y).toBe((await tiles(linusHuddle).first().boundingBox())!.y);
    expect(await huddleTilesKeepClear(tileList(linusHuddle))).toBe(true);

    // An administrator turns screen sharing off. Grace's stops, which she's told, so nobody sees it, and
    // nobody has the button until it's on again, when no screen is shared by itself.
    await switchHuddles(request, { huddleScreens: false });
    await expect(grace.getByRole("alert").filter({ hasText: SCREENS_OFF })).toBeVisible();
    for (const huddle of everyones) {
      await expect(stage(huddle)).toHaveCount(0);
      await expect(tiles(huddle)).toHaveCount(3);
      await expect(huddle.getByRole("button", { name: /screen/ })).toHaveCount(0);
    }
    await expect(page.getByRole("alert").filter({ hasText: SCREENS_OFF })).toHaveCount(0);
    await switchHuddles(request, { huddleScreens: true });
    for (const huddle of everyones) {
      await expect(huddle.getByRole("button", { name: "Share screen" })).toBeVisible();
      await expect(tiles(huddle)).toHaveCount(3);
    }

    // They leave, and the room has had the SFU close what each of them published, a microphone each and
    // two screens, and what each heard and saw of the others.
    for (const huddle of everyones) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    expect(sessionsCarried().size - carriedBefore).toBeGreaterThanOrEqual(11);
    await expect.poll(sessionsLeftOpen).toEqual([]);
    await her.context.close();
    await him.context.close();
  });

  test("people change their microphone, speaker and camera inside a huddle, which the other goes on hearing and seeing them through, and someone who only listens takes up a microphone", async ({ page, browser, baseURL, request }) => {
    // Two browsers, and what each of them sends changed under its connection.
    test.slow();
    const administrator = await administratorSession(request);
    const room = await roomOfItsOwn(request);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);

    // Ada starts the room's huddle with her browser's own choice of microphone. Grace, whose browser refuses her one, joins to listen.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    const starting = page.getByRole("dialog", { name: `Start a huddle in ${room.name}` });
    await starting.getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await expect(adasHuddle).toContainText("1 person");
    const { user: her, context } = await newcomer(browser, baseURL, request, "Grace");
    const grace = await context.newPage();
    await refuseDevices(grace);
    const gracesHuddle = await joinByLink(grace, room);
    for (const huddle of [adasHuddle, gracesHuddle]) await expect(huddle).toContainText("2 people");
    await expect.poll(() => hears(grace, administrator.user.id), { timeout: 15_000 }).toBe(true);
    await expect(gracesHuddle.getByRole("button", { name: "No microphone" })).toBeDisabled();
    await expect(page.locator(`[data-huddle-voices] audio[data-user-id="${her.id}"]`)).toHaveCount(0);

    // Her browser lets her use one after all. The arrow beside her microphone lists the browser's, none of them ticked, and
    // she takes up her second. It reaches Ada through the SFU, muted until she unmutes it, when Ada hears her.
    await grace.evaluate(() => (window as unknown as RefusesDevices).letUseDevices());
    const gracesDevices = await openDevices(grace, room, "Microphone and speaker");
    await expect(devicesIn(gracesDevices, "Microphone")).toHaveText(MICROPHONES);
    await expect(tickedIn(gracesDevices, "Microphone")).toHaveCount(0);
    await choose(gracesDevices, "Microphone", MICROPHONES[1]);
    await expect.poll(() => hears(page, her.id), { timeout: 15_000 }).toBe(true);
    await expect(tiles(adasHuddle).filter({ hasText: her.name }).getByRole("img", { name: "Muted" })).toBeVisible();
    await gracesHuddle.getByRole("button", { name: "Unmute microphone" }).click();
    for (const huddle of [adasHuddle, gracesHuddle]) await expect(speakingIn(huddle, her.name)).toHaveCount(1, { timeout: 15_000 });
    await expect(tickedIn(await openDevices(grace, room, "Microphone and speaker"), "Microphone")).toHaveText(MICROPHONES[1]);
    await grace.keyboard.press("Escape");
    await expect(gracesDevices).toBeHidden();

    // Ada mutes, and opens the menu beside her microphone with the keys, which has her browser's own choice of microphone
    // and of speaker ticked, and the first of them under the keys. With them she chooses her third microphone.
    await adasHuddle.getByRole("button", { name: "Mute microphone" }).click();
    await expect(tiles(gracesHuddle).filter({ hasText: administrator.user.name }).getByRole("img", { name: "Muted" })).toBeVisible();
    await expect(speakingIn(gracesHuddle, administrator.user.name)).toHaveCount(0);
    const askedBefore = tracksAsked();
    const adasArrow = adasHuddle.getByRole("button", { name: "Microphone and speaker", exact: true });
    await adasArrow.press("Enter");
    const adasDevices = devicesMenu(page, "Microphone and speaker");
    await expect(devicesIn(adasDevices, "Microphone").first()).toBeFocused();
    await expect(tickedIn(adasDevices, "Microphone")).toHaveText(MICROPHONES[0]);
    await expect(devicesIn(adasDevices, "Speaker")).toHaveText(SPEAKERS);
    await expect(tickedIn(adasDevices, "Speaker")).toHaveText(SPEAKERS[0]);
    for (const next of [1, 2]) {
      await page.keyboard.press("ArrowDown");
      await expect(devicesIn(adasDevices, "Microphone").nth(next)).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(adasDevices).toBeHidden();
    await expect(adasArrow).toBeFocused();
    // It leaves her as muted as she was, and the menu ticks it once the huddle speaks through it. There she chooses her
    // second speaker as well, which she hears Grace through from then.
    await expect(adasHuddle.getByRole("button", { name: "Unmute microphone" })).toBeVisible();
    await expect(tickedIn(await openDevices(page, room, "Microphone and speaker"), "Microphone")).toHaveText(MICROPHONES[2]);
    await choose(adasDevices, "Speaker", SPEAKERS[1]);
    await expect.poll(() => playsThrough(page, her.id, SPEAKERS[1])).toBe(true);
    await expect(tickedIn(await openDevices(page, room, "Microphone and speaker"), "Speaker")).toHaveText(SPEAKERS[1]);
    await page.keyboard.press("Escape");
    await expect(adasDevices).toBeHidden();
    // Unmuted, she shows as speaking in Grace's huddle again, by the microphone she chose, as the one before it is
    // closed. The SFU wasn't asked for it: her connection carries it in place of the other.
    await adasHuddle.getByRole("button", { name: "Unmute microphone" }).click();
    await expect(speakingIn(gracesHuddle, administrator.user.name)).toHaveCount(1, { timeout: 15_000 });
    expect(await hears(grace, administrator.user.id)).toBe(true);
    expect(tracksAsked()).toBe(askedBefore);

    // Her camera is off, so the menu beside it ticks none of her browser's. Choosing her third turns it on with
    // that one, which Grace sees.
    const adasCamera = `${administrator.user.name}'s camera`;
    const adasCameras = await openDevices(page, room, "Camera");
    await expect(devicesIn(adasCameras, "Camera")).toHaveText(CAMERAS);
    await expect(tickedIn(adasCameras, "Camera")).toHaveCount(0);
    await choose(adasCameras, "Camera", CAMERAS[2]);
    await expect.poll(() => sees(page, "Your camera"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => sees(grace, adasCamera), { timeout: 15_000 }).toBe(true);
    await expect(tickedIn(await openDevices(page, room, "Camera"), "Camera")).toHaveText(CAMERAS[2]);
    // She chooses her first in its place, which the SFU isn't asked for either. Grace goes on seeing her, by the
    // pictures that reach her once the camera before it is closed.
    const askedWithCamera = tracksAsked();
    await choose(adasCameras, "Camera", CAMERAS[0]);
    await expect(tickedIn(await openDevices(page, room, "Camera"), "Camera")).toHaveText(CAMERAS[0]);
    await page.keyboard.press("Escape");
    await expect(adasCameras).toBeHidden();
    const shownBefore = await picturesOf(grace, adasCamera);
    await expect.poll(() => picturesOf(grace, adasCamera), { timeout: 15_000 }).toBeGreaterThan(shownBefore + 10);
    expect(await sees(page, "Your camera")).toBe(true);
    expect(tracksAsked()).toBe(askedWithCamera);

    // They leave, and the room has had the SFU close what each of them published and what each heard and saw. The
    // preview of Ada's next huddle starts with the microphone and the speaker she chose in this one.
    for (const huddle of [gracesHuddle, adasHuddle]) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await expect.poll(sessionsLeftOpen).toEqual([]);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await expect(starting.getByRole("combobox", { name: "Microphone" }).locator("option:checked")).toHaveText(MICROPHONES[2]);
    await expect(starting.getByRole("combobox", { name: "Speaker" }).locator("option:checked")).toHaveText(SPEAKERS[1]);
    await starting.getByRole("button", { name: "Cancel", exact: true }).last().click();
    await expect(starting).toBeHidden();
    await context.close();
  });

  test("a camera is sent in two sizes, and someone watching is sent the one their tiles show: the smaller in small tiles, and the larger again in large ones", async ({ page, browser, baseURL, request }) => {
    // Two browsers, one of which sends its camera twice over.
    test.slow();
    const administrator = await administratorSession(request);
    const room = await roomOfItsOwn(request);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const askedBefore = sfu.asked.length;
    /** How tall Grace's tiles are, and whether the pictures she's shown of Ada's camera are the larger size's, wider than the smaller's 320px, or the smaller's. */
    const tileHeight = async () => (await tiles(gracesHuddle).first().boundingBox())!.height;
    const shownLarge = async () => (await widthOf(grace, adasCamera)) > 320;
    const shownSmall = async () => {
      const width = await widthOf(grace, adasCamera);
      return width > 0 && width <= 320;
    };

    // Ada starts the room's huddle and turns her camera on. Grace joins, in a window whose tiles are tall, and is sent the larger size.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await adasHuddle.getByRole("button", { name: "Turn on camera" }).click();
    await expect.poll(() => sees(page, "Your camera"), { timeout: 15_000 }).toBe(true);
    const { context } = await newcomer(browser, baseURL, request, "Grace");
    const grace = await context.newPage();
    const gracesHuddle = await joinByLink(grace, room);
    const adasCamera = `${administrator.user.name}'s camera`;
    await expect.poll(shownLarge, { timeout: 15_000 }).toBe(true);
    expect(await tileHeight()).toBeGreaterThan(180);
    expect(sizesAsked(askedBefore)).toEqual(["asked for in a"]);

    // Her window gets short, and its tiles no taller than the smaller size. The SFU is asked to send her that one in place
    // of the other, on the track it sends her already, and she goes on seeing Ada.
    const tracksBefore = tracksAsked();
    await grace.setViewportSize({ width: 1280, height: 330 });
    await expect.poll(tileHeight).toBeLessThanOrEqual(180);
    await expect.poll(shownSmall, { timeout: 15_000 }).toBe(true);
    expect(sizesAsked(askedBefore)).toEqual(["asked for in a", "changed to b"]);
    // And the larger again once her window is as tall as it was.
    await grace.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(shownLarge, { timeout: 15_000 }).toBe(true);
    expect(sizesAsked(askedBefore)).toEqual(["asked for in a", "changed to b", "changed to a"]);
    expect(tracksAsked()).toBe(tracksBefore);

    // An SFU that won't make a camera larger has it closed, and is asked for it anew, as it would send it, so
    // that her tall tiles aren't left the smaller size. It's asked for no size of hers from then on.
    await grace.setViewportSize({ width: 1280, height: 330 });
    await expect.poll(shownSmall, { timeout: 15_000 }).toBe(true);
    sfu.fixedSizes = true;
    await grace.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(shownLarge, { timeout: 15_000 }).toBe(true);
    const sizesChanged = ["asked for in a", "changed to b", "changed to a", "changed to b", "changed to a"];
    expect(sizesAsked(askedBefore)).toEqual(sizesChanged);
    expect(tracksAsked()).toBe(tracksBefore + 1);
    sfu.fixedSizes = false;
    await grace.setViewportSize({ width: 1280, height: 330 });
    await expect.poll(tileHeight).toBeLessThanOrEqual(180);
    await grace.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(tileHeight).toBeGreaterThan(180);

    // An SFU that takes a camera in one size is sent it whole, and not the smaller of the two it was offered, which
    // is all a browser goes on sending then. Nothing is asked about its size, whatever the tiles'.
    sfu.oneSize = true;
    await adasHuddle.getByRole("button", { name: "Turn off camera" }).click();
    await expect(gracesHuddle.getByLabel(adasCamera)).toHaveCount(0);
    await adasHuddle.getByRole("button", { name: "Turn on camera" }).click();
    await expect.poll(shownLarge, { timeout: 15_000 }).toBe(true);
    await grace.setViewportSize({ width: 1280, height: 330 });
    await expect.poll(tileHeight).toBeLessThanOrEqual(180);
    const shownBefore = await picturesOf(grace, adasCamera);
    await expect.poll(() => picturesOf(grace, adasCamera), { timeout: 15_000 }).toBeGreaterThan(shownBefore + 10);
    expect(await shownLarge()).toBe(true);
    expect(sizesAsked(askedBefore)).toEqual(sizesChanged);

    // They leave, and the room has had the SFU close what each of them published, the camera's two sizes as one, and what each heard and saw.
    for (const huddle of [gracesHuddle, adasHuddle]) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await expect.poll(sessionsLeftOpen).toEqual([]);
    await context.close();
  });

  test("with a relay, each tab makes its connections by the servers Cloudflare made for it as it joined, on which people hear each other, and by Ember's own once the relay is off", async ({ page, browser, baseURL, request }) => {
    const administrator = await administratorSession(request);
    const headers = await asAdministrator(request);
    const room = await roomOfItsOwn(request);
    for (const [path, data] of [
      ["/api/account/huddles", SFU_APP],
      ["/api/account/huddles/relay", TURN_KEY],
    ] as const) {
      const saved = await request.put(path, { data, headers });
      expect(saved.status(), await saved.text()).toBe(200);
    }
    // Cloudflare made servers once as the key was checked, which nobody is given.
    const made = sfu.turnServers.length;
    const asked = sfu.asked.length;

    // Ada starts the room's huddle. Her microphone goes out on a connection made by the servers Cloudflare made for her tab.
    await keepConnections(page);
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await expect(adasHuddle).toContainText("1 person");
    await expect.poll(() => serversOf(page)).toHaveLength(1);
    expect(sfu.turnServers).toHaveLength(made + 1);
    const adas = givenOf(sfu.turnServers[made]!);
    expect(await serversOf(page)).toEqual([adas]);
    // They're the TURN service's less the address no browser reaches, and carry what her tab uses the relay with.
    expect(adas.flatMap(({ urls }) => urls).filter((url) => url.includes(":53"))).toEqual([]);
    expect(adas.at(-1)).toMatchObject({ username: `e2e-turn-${made + 1}`, credential: "e2e-only-not-a-credential" });

    // Grace joins, by servers made for her own tab. Each hears the other, on connections their tabs made by their own.
    const { user: her, context } = await newcomer(browser, baseURL, request, "Grace");
    const grace = await context.newPage();
    await keepConnections(grace);
    const gracesHuddle = await joinByLink(grace, room);
    await expect(gracesHuddle).toContainText("2 people");
    await expect.poll(() => hears(grace, administrator.user.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => hears(page, her.id), { timeout: 15_000 }).toBe(true);
    expect(sfu.turnServers).toHaveLength(made + 2);
    const graces = givenOf(sfu.turnServers[made + 1]!);
    expect(graces).not.toEqual(adas);
    for (const [tab, theirs] of [
      [page, adas],
      [grace, graces],
    ] as const) {
      // The connection its microphone goes out on, and the one that brings the other's voice.
      const madeBy = await serversOf(tab);
      expect(madeBy.length).toBeGreaterThanOrEqual(2);
      for (const servers of madeBy) expect(servers).toEqual(theirs);
    }
    // Cloudflare was asked for each tab's as the TURN key huddles were given, to last a day.
    expect(sfu.asked.slice(asked).filter(({ path }) => path.includes("/turn/"))).toEqual([TURN_SERVERS_ASKED, TURN_SERVERS_ASKED]);

    // The relay is turned off. Grace leaves and joins again, and her tab makes its connections as it did
    // before huddles had one, which Cloudflare isn't asked for. Ada goes on hearing her.
    const forgotten = await request.delete("/api/account/huddles/relay", { headers });
    expect(forgotten.status(), await forgotten.text()).toBe(200);
    await gracesHuddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(gracesHuddle).toHaveCount(0);
    await expect(adasHuddle).toContainText("1 person");
    const before = (await serversOf(grace)).length;
    await grace.getByRole("button", { name: "Join huddle, 1 in it" }).click();
    await grace.getByRole("dialog", { name: `Join the huddle in ${room.name}` }).getByRole("button", { name: "Join Huddle" }).click();
    await expect(gracesHuddle).toContainText("2 people");
    await expect.poll(() => hears(grace, administrator.user.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => hears(page, her.id), { timeout: 15_000 }).toBe(true);
    const since = (await serversOf(grace)).slice(before);
    expect(since.length).toBeGreaterThanOrEqual(2);
    for (const servers of since) expect(servers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    expect(sfu.turnServers).toHaveLength(made + 2);

    for (const huddle of [gracesHuddle, adasHuddle]) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await expect.poll(sessionsLeftOpen).toEqual([]);
    await context.close();
  });

  test("someone starts a huddle in a direct message, which invites the other person in it on every tab they have open, one of which rings, until they decline it in one of them, or join by it", async ({ page, browser, baseURL, request }) => {
    const administrator = await administratorSession(request);
    const headers = { Cookie: cookieHeader(administrator), ...SAME_ORIGIN };
    const room = await roomOfItsOwn(request);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers });
    expect(saved.status(), await saved.text()).toBe(200);

    // Grace, who joins Ember with the join link, has a room open in two tabs, and has clicked in each, so
    // her browser lets either of them play a sound.
    const { user: her, context } = await newcomer(browser, baseURL, request, "Grace");
    const tabs = [await context.newPage(), await context.newPage()];
    for (const tab of tabs) {
      await keepSounds(tab);
      await useOwnAddress(tab);
      await tab.goto(`/rooms/${room.id}`);
      await tab.getByRole("heading", { level: 1, name: room.name }).click();
    }

    // Ada starts a direct message with her, whose header has the huddle button. Its preview says who the
    // huddle is with, and that starting it invites her.
    const started = await request.post("/api/directs", { data: { userIds: [her.id] }, headers });
    expect(started.status(), await started.text()).toBe(201);
    const direct = ((await started.json()) as { room: { id: string } }).room;
    await useOwnAddress(page);
    await page.goto(`/rooms/${direct.id}`);
    await signInAsAdministrator(page);
    const start = page.getByRole("button", { name: "Start huddle", exact: true });
    await start.click();
    const starting = page.getByRole("dialog", { name: `Start a huddle with ${her.name}` });
    await expect(starting).toContainText("Grace is invited once it starts.");
    await starting.getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = directHuddle(page, her.name);
    await expect(adasHuddle).toContainText("1 person");

    // Each of Grace's tabs shows Ada's invitation, over the room it has open, and one of them rings for
    // it. A second into its ring, the other has played nothing.
    const invitations = tabs.map((tab) => invitationFrom(tab, administrator.user.name));
    for (const invitation of invitations) await expect(invitation).toBeVisible();
    await expect.poll(async () => (await ringing(tabs)).length).toBe(1);
    const [rung] = await ringing(tabs);
    const silent = tabs.find((tab) => tab !== rung)!;
    await expect.poll(() => rings(rung!, 1)).toBe(true);
    expect(await soundsStarted(silent)).toEqual([]);

    // She declines in the tab that's silent, which takes the invitation from both and stops the other's
    // ring. Ada isn't told, and stays in the huddle.
    await invitationFrom(silent, administrator.user.name).getByRole("button", { name: "Decline", exact: true }).click();
    for (const invitation of invitations) await expect(invitation).toHaveCount(0);
    await expect.poll(() => ringing(tabs)).toEqual([]);
    await expect(adasHuddle).toContainText("1 person");

    // Ada leaves, which ends the huddle, and starts another, which invites Grace again. Grace closes the
    // tab that rings, and the other rings in its place.
    await adasHuddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await start.click();
    await starting.getByRole("button", { name: "Start Huddle" }).click();
    await expect(adasHuddle).toContainText("1 person");
    for (const invitation of invitations) await expect(invitation).toBeVisible();
    await expect.poll(async () => (await ringing(tabs)).length).toBe(1);
    const [closed] = await ringing(tabs);
    const grace = tabs.find((tab) => tab !== closed)!;
    await closed!.close();
    await expect.poll(() => rings(grace)).toBe(true);

    // She joins by the invitation, which stops the ring and opens the huddle's preview over the room she
    // has open. Joining from it puts her in the huddle with Ada, where each hears the other.
    const invitation = invitationFrom(grace, administrator.user.name);
    await invitation.getByRole("button", { name: "Join", exact: true }).click();
    const joining = grace.getByRole("dialog", { name: `Join the huddle with ${administrator.user.name}` });
    await expect(joining).toContainText("Ada is in it now.");
    await expect(invitation).toHaveCount(0);
    await expect.poll(() => rings(grace)).toBe(false);
    await expect(grace).toHaveURL(`${baseURL}/rooms/${room.id}`);
    await joining.getByRole("button", { name: "Join Huddle" }).click();
    const gracesHuddle = directHuddle(grace, administrator.user.name);
    await expect(gracesHuddle).toContainText("2 people");
    await expect(adasHuddle).toContainText("2 people");
    await expect.poll(() => hears(grace, administrator.user.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => hears(page, her.id), { timeout: 15_000 }).toBe(true);
    // The direct message's row in each of their sidebars ends with the huddle's mark.
    await expect(directMark(page, her.name)).toHaveAttribute("title", "Grace and you are in the huddle");
    await expect(directMark(grace, administrator.user.name)).toHaveAttribute("title", "Ada and you are in the huddle");

    for (const huddle of [gracesHuddle, adasHuddle]) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await expect.poll(sessionsLeftOpen).toEqual([]);
    await context.close();
  });

  test("someone in a room's huddle invites others of the room from Invite people, which rings those who keep its notifications on, to decline or join by, and lists whoever isn't in the huddle yet", async ({ page, browser, baseURL, request }) => {
    const administrator = await administratorSession(request);
    const headers = { Cookie: cookieHeader(administrator), ...SAME_ORIGIN };
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers });
    expect(saved.status(), await saved.text()).toBe(200);

    // A room of just Ada, Grace and Linus, who each joined Ember with the join link. Each of the two has
    // it open, and has clicked in it, so their browser lets it play a sound. Linus has turned the room's
    // notifications off.
    const { user: her, context } = await newcomer(browser, baseURL, request, "Grace");
    const { user: him, context: his } = await newcomer(browser, baseURL, request, "Linus");
    const room = await roomOfJust(request, [administrator.user, her, him]);
    const [grace, linus] = [await context.newPage(), await his.newPage()];
    for (const tab of [grace, linus]) {
      await keepSounds(tab);
      await useOwnAddress(tab);
      await tab.goto(`/rooms/${room.id}`);
      await tab.getByRole("heading", { level: 1, name: room.name }).click();
    }
    const turnedOff = await his.request.put(`/api/rooms/${room.id}/involvement`, { data: { involvement: "nothing" }, headers: SAME_ORIGIN });
    expect(turnedOff.status(), await turnedOff.text()).toBe(200);

    // Ada starts the room's huddle, which invites nobody. Its buttons begin with Invite people, and it
    // has no More button, which a phone's has in its place.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await page.getByRole("button", { name: "Start huddle", exact: true }).click();
    await page.getByRole("dialog", { name: `Start a huddle in ${room.name}` }).getByRole("button", { name: "Start Huddle" }).click();
    const adasHuddle = huddleOpened(page, room);
    await expect(adasHuddle).toContainText("1 person");
    const invite = adasHuddle.getByRole("button", { name: "Invite people", exact: true });
    await expect(adasHuddle.locator(":scope > footer").getByRole("button").first()).toHaveAccessibleName("Invite people");
    await expect(adasHuddle.getByRole("button", { name: "More", exact: true })).toBeHidden();

    // It lists the room's other two by name, neither ticked, and sends no invitation until one is.
    await invite.click();
    const inviting = page.getByRole("dialog", { name: "Invite people" });
    await expect(inviting.getByRole("heading", { name: "Invite people" })).toBeFocused();
    await expect(inviting).toContainText(`People in ${room.name} who aren’t in the huddle.`);
    await expect(inviting.getByRole("listitem")).toHaveText([her.name, him.name]);
    await expect(inviting.getByRole("status")).toHaveText("Choose one or more people.");
    const send = inviting.getByRole("button", { name: "Send Invite" });
    await expect(send).toBeDisabled();
    // She ticks both and sends it, which closes the list, says who's invited, and gives the button the focus back.
    for (const { name } of [her, him]) await inviting.getByRole("checkbox", { name }).check();
    await expect(inviting.getByRole("status")).toHaveText("2 people selected.");
    await send.click();
    await expect(inviting).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveText("Grace and Linus are invited.");
    await expect(invite).toBeFocused();

    // Grace's tab shows Ada's invitation into the room's huddle, and rings for it. A second into its
    // ring, Linus's has shown none and played nothing, as it is with a mention of him there.
    const invitation = roomInvitationFrom(grace, administrator.user.name, room);
    await expect(invitation).toBeVisible();
    await expect.poll(() => rings(grace, 1)).toBe(true);
    await expect(roomInvitationFrom(linus, administrator.user.name, room)).toHaveCount(0);
    expect(await soundsStarted(linus)).toEqual([]);

    // She declines, which Ada isn't told. Ada invites her again, by herself, and she joins by it.
    await invitation.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(invitation).toHaveCount(0);
    await expect.poll(() => rings(grace)).toBe(false);
    await expect(adasHuddle).toContainText("1 person");
    await invite.click();
    await inviting.getByRole("checkbox", { name: her.name }).check();
    await expect(inviting.getByRole("status")).toHaveText("1 person selected.");
    await send.click();
    await expect(page.getByRole("alert")).toHaveText("Grace is invited.");
    await expect(invitation).toBeVisible();
    await invitation.getByRole("button", { name: "Join", exact: true }).click();
    await grace.getByRole("dialog", { name: `Join the huddle in ${room.name}` }).getByRole("button", { name: "Join Huddle" }).click();
    const gracesHuddle = huddleOpened(grace, room);
    await expect(gracesHuddle).toContainText("2 people");
    await expect(adasHuddle).toContainText("2 people");

    // Now that she's in it, the list has Linus alone, ticked already as the only one to invite. Escape
    // closes it, and sends nothing.
    await invite.click();
    await expect(inviting.getByRole("listitem")).toHaveText([him.name]);
    await expect(inviting.getByRole("checkbox", { name: him.name })).toBeChecked();
    await expect(inviting.getByRole("status")).toHaveText("1 person selected.");
    await page.keyboard.press("Escape");
    await expect(inviting).toHaveCount(0);
    await expect(invite).toBeFocused();
    // Grace, who can't change the room, may invite from it as well, and her list is the same.
    await gracesHuddle.getByRole("button", { name: "Invite people", exact: true }).click();
    const hers = grace.getByRole("dialog", { name: "Invite people" });
    await expect(hers.getByRole("listitem")).toHaveText([him.name]);
    await hers.getByRole("button", { name: "Cancel", exact: true }).last().click();
    await expect(hers).toHaveCount(0);

    for (const huddle of [gracesHuddle, adasHuddle]) await huddle.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(adasHuddle).toHaveCount(0);
    await expect.poll(sessionsLeftOpen).toEqual([]);
    await context.close();
    await his.close();
  });
});

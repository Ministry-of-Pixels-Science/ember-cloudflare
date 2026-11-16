import type { Me, WorkspaceSettings } from "@ember/protocol";
import { APP_ID_UNKNOWN, APP_SECRET_UNKNOWN, CAMERAS_OFF } from "@ember/protocol/huddles";
import type { APIRequestContext, Page } from "@playwright/test";
import { administratorSession, cookieHeader, expect, newAddress, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress, type TestRoom } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT, SFU_APP } from "../../projects/workspace-settings";
import { startFakeSfu, type FakeSfu } from "./fake-sfu";

// The Huddles tab's card and Set up huddles, and a huddle itself, on the second test server, which asks
// the Realtime SFU this spec fakes: to start a session with the keys it's given, and to carry what the
// people in a huddle say and what their cameras show, which the fake does through a page of its own.
// Each test leaves the workspace as a new one is: huddles off, and cameras allowed in them.

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
  const forgotten = await request.delete("/api/account/huddles", { headers: await asAdministrator(request) });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
  await switchCameras(request, true);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** Turns Cameras on or off as the administrator, as its switch on the Huddles tab does. */
async function switchCameras(request: APIRequestContext, huddleCameras: boolean): Promise<void> {
  const switched = await request.patch("/api/account", { data: { settings: { huddleCameras } }, headers: await asAdministrator(request) });
  expect(switched.status(), await switched.text()).toBe(200);
}

/** Whether cameras may go on in huddles, as the workspace's settings have it. */
const camerasAllowed = async (request: APIRequestContext) =>
  ((await (await request.get("/api/account", { headers: await asAdministrator(request) })).json()) as WorkspaceSettings).account.huddleCameras;

/** The Huddles tab's card on the page. */
const huddlesCard = (page: Page) => page.getByRole("region", { name: "Audio and video chat", exact: true });

/** The card under it, which the tab has while huddles are on. */
const camerasCard = (page: Page) => page.getByRole("region", { name: "Cameras", exact: true });

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
    // What people may do in a huddle comes with them: cameras, which are on.
    await expect(camerasCard(page).getByRole("switch", { name: "Cameras" })).toBeChecked();

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
    await expect.poll(() => camerasAllowed(request)).toBe(false);
    await page.reload();
    await expect(camerasSwitch).not.toBeChecked();
    await camerasSwitch.click();
    await expect(camerasSwitch).toBeChecked();
    await expect.poll(() => camerasAllowed(request)).toBe(true);
  });
});

/** The huddle `page` is in, opened over the page, which is how it starts. */
const huddleOpened = (page: Page, room: TestRoom) => page.getByRole("region", { name: `Huddle in ${room.name}` }).and(page.locator("#huddle"));

/** The bar of the huddle `page` is in, along the window's base, once it's minimized. */
const huddleBar = (page: Page, room: TestRoom) => page.getByRole("region", { name: `Huddle in ${room.name}` }).and(page.locator(":not(#huddle)"));

/** Whether `page` shows the camera its huddle labels `label`: its track is live, and its picture plays and has a size, which a frame gives it. */
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

/** What the room's row in the sidebar ends with while a huddle is going on in it, which says who's in it under a pointer. */
const sidebarMark = (page: Page, room: TestRoom) => page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: room.name, exact: true }).locator("[title]");

test.describe("A huddle", () => {
  test("two people start and join a room's huddle, which their sidebars show, hear and see each other and hear its sounds, and leave it", async ({ page, browser, baseURL, request }) => {
    // Their voices and their cameras, and the huddle's music twice, which waits five seconds each time.
    test.slow();
    const administrator = await administratorSession(request);
    const headers = { Cookie: cookieHeader(administrator), ...SAME_ORIGIN };
    // In a room of the test's own, which everyone is in.
    const created = await request.post("/api/rooms", { data: { kind: "open", name: `Standup ${crypto.randomUUID().slice(0, 8)}` }, headers });
    expect(created.status(), await created.text()).toBe(201);
    const { room } = (await created.json()) as { room: TestRoom };

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
    const { joinCode } = (await (await request.get("/api/account", { headers })).json()) as WorkspaceSettings;
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const joined = await context.request.post(`/api/join/${joinCode}`, {
      data: { name: `Grace ${crypto.randomUUID().slice(0, 8)}`, emailAddress: `${crypto.randomUUID()}@example.com`, password: "compiler error" },
      headers: { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN },
    });
    expect(joined.status(), await joined.text()).toBe(201);
    const { user: her } = (await joined.json()) as { user: Me };
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
    await page.keyboard.press("Control+Shift+Space");
    await expect(adasBar.getByRole("button", { name: "Mute microphone" })).toBeVisible();

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
    await switchCameras(request, false);
    await expect(grace.getByRole("alert").filter({ hasText: CAMERAS_OFF })).toBeVisible();
    await expect(gracesHuddle.getByLabel("Your camera")).toHaveCount(0);
    await expect(adasHuddle.getByLabel(gracesCamera)).toHaveCount(0);
    for (const huddle of [adasHuddle, gracesHuddle]) await expect(huddle.getByRole("button", { name: /camera/ })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: CAMERAS_OFF })).toHaveCount(0);
    await switchCameras(request, true);
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
    const carried = new Set(sfu.asked.flatMap(({ method, path }) => (method === "POST" ? (/\/sessions\/([^/]+)\/tracks\/new$/.exec(path)?.[1] ?? []) : [])));
    expect(carried.size).toBeGreaterThanOrEqual(8);
    const closed = (sessionId: string) => sfu.asked.some(({ method, path }) => method === "PUT" && path.endsWith(`/sessions/${sessionId}/tracks/close`));
    await expect.poll(() => [...carried].filter((sessionId) => !closed(sessionId))).toEqual([]);

    // Turning huddles off takes the button from the headers of the rooms people have open.
    const forgotten = await request.delete("/api/account/huddles", { headers });
    expect(forgotten.status(), await forgotten.text()).toBe(200);
    await expect(grace.getByRole("button", { name: "Start huddle", exact: true })).toHaveCount(0);
    await expect(start).toHaveCount(0);
    await context.close();
  });
});

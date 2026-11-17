import { MAX_PUSH_SUBSCRIPTIONS, type PushSubscriptions } from "@ember/protocol";
import { devices, type Page } from "@playwright/test";
import { administratorOn, allowNotifications, logOut, PUSH_KEYS, uniqueEndpoint, VAPID_PUBLIC_KEY } from "../../fixtures";
import { expect, startDirect, test, unique } from "./fixtures";

const MENTIONS = "Notifying about @ mentions";
const EVERYTHING = "Notifying about all messages";
const NOTHING = "Notifications are off";
const INVISIBLE = "Notifications are off and room invisible in sidebar";

/** The bell in the header of the room or DM shown, named for your level there. */
const headerBell = (page: Page) => page.getByRole("navigation", { name: "Page" }).getByRole("checkbox");

/** What the header's bell shows under itself as a press saves a level, which only the eye gets: its status says the same. */
const bellTooltip = (page: Page) => page.getByRole("navigation", { name: "Page" }).locator("[data-notification-tooltip]");

/** The sidebar's rows for rooms, top to bottom. */
const roomRows = (page: Page) => page.getByRole("region", { name: "Rooms" }).getByRole("link");

/** Signs a member in on a browser that has turned notifications on, so the room header's bell is their level's. */
const notificationsOn = { beforeOpen: (page: Page) => allowNotifications(page.context()) };

/** The rail's Activity, whose description counts the conversations marked unread. */
const activity = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Activity" });

/** Opens your profile from the rail, where your rooms and DMs are listed with their bells. */
async function openYourProfile(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).click();
  await expect(page).toHaveURL(/\/users\/me\/profile$/);
  return page.getByRole("list", { name: "Conversation notifications" });
}

test.describe("Notification levels", () => {
  test("goes round a room's levels from its header, which every tab of yours shows, and the server keeps", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", notificationsOn);
    const grace = await members.signIn("Grace", notificationsOn);
    const secondTab = await grace.page.context().newPage();
    await secondTab.goto(`/rooms/${rooms.general.id}`);
    const bell = headerBell(grace.page);
    await expect(bell).toHaveAccessibleName(MENTIONS);
    await expect(bell).toBeChecked();

    for (const level of [EVERYTHING, NOTHING]) {
      await bell.click();
      for (const page of [grace.page, secondTab]) await expect(headerBell(page)).toHaveAccessibleName(level);
      await expect(bell).toBeFocused();
    }
    // Ada's level is her own.
    await expect(headerBell(ada.page)).toHaveAccessibleName(MENTIONS);

    await grace.page.reload();
    await expect(headerBell(grace.page)).toHaveAccessibleName(NOTHING);
  });

  test("confirms each level saved under the bell, at once after a key's press, until Escape, and says when one couldn't be saved", async ({ members }) => {
    const grace = await members.signIn(unique("Grace"), notificationsOn);
    const bell = headerBell(grace.page);
    const tooltip = bellTooltip(grace.page);
    const status = grace.page.getByRole("navigation", { name: "Page" }).getByRole("status");
    await expect(bell).toHaveAccessibleName(MENTIONS);
    await expect(tooltip).toBeHidden();

    await bell.click();
    await expect(tooltip).toHaveText(EVERYTHING);
    await expect(tooltip).toBeVisible();
    await expect(status).toHaveText(EVERYTHING);
    // It goes by itself.
    await expect(tooltip).toBeHidden();

    await bell.press("Enter");
    await expect(tooltip).toHaveText(NOTHING);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS("transition-property", "none");
    await expect(bell).toBeFocused();
    await grace.page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();

    await grace.page.route("**/api/rooms/*/involvement", (route) => route.fulfill({ status: 500, json: { error: "Something went wrong" } }));
    await bell.click();
    await expect(tooltip).toHaveText("Couldn’t update notifications. Try again.");
    await expect(tooltip).toBeVisible();
    await expect(status).toHaveText("Couldn’t update notifications. Try again.");
    await expect(bell).toHaveAccessibleName(NOTHING);
    // Rather than the workspace's alert.
    await expect(grace.page.getByRole("alert")).toHaveCount(0);
  });

  test("goes between all messages and off in a DM", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"), notificationsOn);
    const roomId = await startDirect(request, ada, [grace]);
    await grace.page.goto(`/rooms/${roomId}`);
    await grace.connected();
    const bell = headerBell(grace.page);
    await expect(bell).toHaveAccessibleName(EVERYTHING);

    await bell.click();
    await expect(bell).toHaveAccessibleName(NOTHING);
    await bell.click();
    await expect(bell).toHaveAccessibleName(EVERYTHING);
  });
});

test.describe("Hide a room", () => {
  test("hides the room shown from every tab's sidebar, keeping it open at its address, until it's shown again", async ({ members, rooms }) => {
    const grace = await members.signIn("Grace", notificationsOn);
    const secondTab = await grace.page.context().newPage();
    await secondTab.goto(`/rooms/${rooms.random.id}`);
    await expect(roomRows(secondTab)).toHaveText(["#general", "#random"]);
    const bell = headerBell(grace.page);

    for (const level of [EVERYTHING, NOTHING, INVISIBLE]) {
      await bell.click();
      await expect(bell).toHaveAccessibleName(level);
    }
    for (const page of [grace.page, secondTab]) await expect(roomRows(page)).toHaveText(["#random"]);
    await expect(grace.page.getByRole("heading", { level: 1 })).toHaveText("general");
    await grace.send("Still here");
    await expect(grace.message("Still here")).toBeVisible();
    await expect(grace.message("Still here")).not.toHaveAttribute("aria-busy");

    // The server keeps it hidden, and it still opens at its address.
    for (const page of [grace.page, secondTab]) await page.reload();
    await grace.connected();
    await expect(grace.page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(bell).toHaveAccessibleName(INVISIBLE);
    for (const page of [grace.page, secondTab]) await expect(roomRows(page)).toHaveText(["#random"]);

    await bell.click();
    await expect(bell).toHaveAccessibleName(MENTIONS);
    for (const page of [grace.page, secondTab]) await expect(roomRows(page)).toHaveText(["#general", "#random"]);
  });
});

test.describe("Turn on notifications", () => {
  const enableButton = (page: Page) => page.getByRole("button", { name: "Enable notifications", exact: true });
  const setup = (page: Page) => page.getByRole("dialog", { name: "Notification setup" });

  test("Enable notifications explains that the server has no Web Push keys, and Close closes it", async ({ members }) => {
    const grace = await members.signIn(unique("Grace"));
    await expect(headerBell(grace.page)).toHaveCount(0);
    await enableButton(grace.page).click();
    const dialog = setup(grace.page);
    await expect(dialog.getByRole("heading", { level: 1 })).toHaveText("Notifications aren’t configured");
    await expect(dialog.getByRole("status")).toHaveText("Ask your workspace administrator to configure Web Push on this server.");
    // None of the help shows: it's in the page, hidden, as two sections in Safari.
    await expect(dialog.locator("details").filter({ visible: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(enableButton(grace.page)).toBeVisible();
  });

  test("turns them on: registers the service worker, subscribes with the server's key and saves the subscription, then shows your level", async ({ members }) => {
    const endpoint = uniqueEndpoint();
    const grace = await members.signIn(unique("Grace"), { beforeOpen: (page) => allowNotifications(page.context(), { endpoint, on: false }) });
    const saving = grace.page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/push-subscriptions");
    await enableButton(grace.page).click();
    expect((await saving).postDataJSON()).toEqual({ endpoint, p256dhKey: PUSH_KEYS.p256dh, authKey: PUSH_KEYS.auth });
    // The level's bell takes over, and focus with it.
    await expect(headerBell(grace.page)).toHaveAccessibleName(MENTIONS);
    await expect(headerBell(grace.page)).toBeFocused();
    await expect(setup(grace.page)).toBeHidden();

    const browser = await grace.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const key = (await registration!.pushManager.getSubscription())!.options.applicationServerKey!;
      return { worker: registration!.active!.scriptURL, key: [...new Uint8Array(key)] };
    });
    expect(browser).toEqual({ worker: new URL("/service-worker.js", grace.page.url()).href, key: [...Buffer.from(VAPID_PUBLIC_KEY, "base64url")] });
    const { subscriptions } = (await (await grace.page.request.get("/api/push-subscriptions")).json()) as PushSubscriptions;
    expect(subscriptions.map(({ endpoint }) => endpoint)).toEqual([endpoint]);
  });

  test("gives the help for this browser when they aren't available, its one section open", async ({ members }) => {
    // The help is picked by what the browser says it is, Desktop Chrome here in either engine.
    const grace = await members.signIn(unique("Grace"), {
      context: { userAgent: devices["Desktop Chrome"].userAgent },
      beforeOpen: async (page) => void (await page.addInitScript(() => Reflect.deleteProperty(window, "PushManager"))),
    });
    await enableButton(grace.page).click();
    const dialog = setup(grace.page);
    await expect(dialog.getByRole("heading", { level: 1 })).toHaveText("Notifications aren’t available here");
    // Desktop Chrome says it's Chrome on Windows, whose own settings are the one section a browser tab gives.
    const help = dialog.locator("details");
    await expect(help).toHaveCount(1);
    await expect(help).toHaveAttribute("open");
    await expect(help.locator("summary")).toHaveText("Check your Chrome settings");
    await expect(help.getByRole("heading", { level: 2 })).toHaveText(["Turn on notifications for this website.", "Turn on notifications for Chrome."]);
    await expect(help.getByRole("listitem").filter({ hasText: "Start" })).toHaveText("Click Start, then Settings.");
  });
});

test.describe("Levels on your profile", () => {
  test("lists your rooms by name, then your DMs, each with its bell, and dims a room you hide there, leaving it out of Activity", async ({ members, request, rooms }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"), { path: `/rooms/${rooms.random.id}` });
    await startDirect(request, ada, [grace]);
    await ada.send("Lunch?");
    await expect(activity(grace.page)).toHaveAccessibleDescription("1 unread");

    const list = await openYourProfile(grace.page);
    await expect(list.getByRole("link")).toHaveText(["general", "random", ada.name]);
    // Each bell's name is its label's text.
    await expect(list.getByRole("checkbox")).toHaveText([MENTIONS, MENTIONS, EVERYTHING]);
    // A rule between the rooms and the DMs.
    expect(await list.evaluate((menu) => [...menu.children].map((child) => child.tagName))).toEqual(["LI", "LI", "HR", "LI"]);
    await expect(list.getByRole("link", { name: "general", exact: true })).toHaveAttribute("href", `/rooms/${rooms.general.id}`);

    const general = list.getByRole("listitem").filter({ has: grace.page.getByRole("link", { name: "general", exact: true }) });
    const bell = general.getByRole("checkbox");
    for (const level of [EVERYTHING, NOTHING, INVISIBLE]) {
      await bell.click();
      await expect(bell).toHaveAccessibleName(level);
    }
    await expect(general).toHaveCSS("opacity", "0.5");
    await expect(roomRows(grace.page)).toHaveText(["#random"]);
    await expect(activity(grace.page)).not.toHaveAttribute("aria-description");

    // Shown again, it's still marked unread from before it was hidden.
    await bell.click();
    await expect(bell).toHaveAccessibleName(MENTIONS);
    await expect(general).toHaveCSS("opacity", "1");
    await expect(roomRows(grace.page)).toHaveText(["#general", "#random"]);
    await expect(activity(grace.page)).toHaveAccessibleDescription("1 unread");
  });
});

test.describe("Save push subscriptions", () => {
  test("Log out ends this browser's push subscription, and the server forgets it, but not another browser's", async ({ browser, baseURL, rooms }) => {
    const laptop = await administratorOn(browser, baseURL!, rooms.general);
    const phone = await administratorOn(browser, baseURL!, rooms.general);
    try {
      const [laptops, phones] = [uniqueEndpoint(), uniqueEndpoint()];
      for (const endpoint of [laptops, phones]) {
        const keys = { p256dhKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", authKey: "BTBZMqHH6r4Tts7J_aSIgg" };
        const response = await laptop.request.post("/api/push-subscriptions", { data: { endpoint, ...keys } });
        expect(response.status(), await response.text()).toBe(204);
      }
      // The laptop's browser is subscribed at its endpoint, as turning notifications on leaves it.
      let unsubscribed = false;
      await laptop.exposeFunction("unsubscribed", () => (unsubscribed = true));
      await laptop.evaluate((endpoint) => {
        const subscription = { endpoint, unsubscribe: () => (window as unknown as { unsubscribed(): Promise<boolean> }).unsubscribed() };
        Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => ({ pushManager: { getSubscription: async () => subscription } }) });
      }, laptops);

      const signingOut = laptop.waitForRequest((request) => request.method() === "DELETE" && new URL(request.url()).pathname === "/api/session");
      await logOut(laptop);
      expect((await signingOut).postDataJSON()).toEqual({ pushSubscriptionEndpoint: laptops });
      await expect(laptop.getByRole("heading", { name: "Sign in to Ember" })).toBeVisible();
      expect(unsubscribed).toBe(true);

      const { subscriptions } = (await (await phone.request.get("/api/push-subscriptions")).json()) as PushSubscriptions;
      const phonesOnly = subscriptions.filter(({ endpoint }) => endpoint === laptops || endpoint === phones);
      expect(phonesOnly.map(({ endpoint }) => endpoint)).toEqual([phones]);
      expect((await phone.request.delete(`/api/push-subscriptions/${phonesOnly[0]!.id}`)).status()).toBe(204);
    } finally {
      await Promise.all([laptop.context().close(), phone.context().close()]);
    }
  });

  test("saves this browser's subscription again as the workspace opens, bringing it back after other browsers' newer ones pushed it out", async ({ members }) => {
    const endpoint = uniqueEndpoint();
    const grace = await members.signIn(unique("Grace"), { beforeOpen: (page) => allowNotifications(page.context(), { endpoint }) });
    const endpoints = async () => {
      const { subscriptions } = (await (await grace.page.request.get("/api/push-subscriptions")).json()) as PushSubscriptions;
      return subscriptions.map((subscription) => subscription.endpoint);
    };
    await expect.poll(endpoints).toEqual([endpoint]);

    // As many other browsers turn notifications on as Grace keeps, the newest last.
    const others = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS }, () => uniqueEndpoint());
    for (const other of others) {
      const response = await grace.page.request.post("/api/push-subscriptions", { data: { endpoint: other, p256dhKey: PUSH_KEYS.p256dh, authKey: PUSH_KEYS.auth } });
      expect(response.status(), await response.text()).toBe(204);
    }
    expect(await endpoints()).toEqual(others);

    const saved = grace.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/push-subscriptions");
    await grace.page.reload();
    expect((await saved).request().postDataJSON()).toEqual({ endpoint, p256dhKey: PUSH_KEYS.p256dh, authKey: PUSH_KEYS.auth });
    expect((await saved).status()).toBe(204);
    await expect(headerBell(grace.page)).toHaveAccessibleName(MENTIONS);
    await expect.poll(endpoints).toEqual([...others.slice(1), endpoint]);
  });
});

test.describe("Push subscriptions page", () => {
  test("lists the browser that turned them on at /users/me/push_subscriptions, where a test push fails while the server has no Web Push keys, and deletes it", async ({ members, browserName }) => {
    const endpoint = uniqueEndpoint();
    const grace = await members.signIn(unique("Grace"), { beforeOpen: (page) => allowNotifications(page.context(), { endpoint, on: false }) });
    const saved = grace.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/push-subscriptions");
    await grace.page.getByRole("button", { name: "Enable notifications", exact: true }).click();
    expect((await saved).status()).toBe(204);

    // Loaded from the Worker, which answers the page's address with the app.
    await grace.page.goto("/users/me/push_subscriptions");
    await expect(grace.page).toHaveTitle("Push notification subscriptions");
    await expect(grace.page.getByRole("heading", { level: 1 })).toHaveText("Push Notification Subscriptions");
    const rows = grace.page.getByRole("list", { name: "Push Notification Subscriptions" }).getByRole("listitem");
    await expect(rows).toHaveCount(1);
    // Desktop Chrome or Desktop Safari, as the user_agent gem names them.
    await expect(rows.locator("strong")).toHaveText(browserName === "webkit" ? /^Safari [\d.]+ on Macintosh$/ : /^Chrome [\d.]+ on Windows$/);
    await expect(rows).toContainText(endpoint);

    await rows.getByRole("button", { name: "Send test notification" }).click();
    await expect(grace.page.getByRole("alert")).toHaveText("Something went wrong");

    await rows.getByRole("button", { name: "Delete subscription" }).click();
    await expect(rows).toHaveCount(0);
    await grace.page.reload();
    await expect(grace.page.locator("main section")).toHaveAttribute("aria-busy", "false");
    await expect(rows).toHaveCount(0);
  });

  test("turns notifications off in the browser whose own subscription it deletes, so the bell can turn them on again", async ({ members }) => {
    const endpoint = uniqueEndpoint();
    const grace = await members.signIn(unique("Grace"), { beforeOpen: (page) => allowNotifications(page.context(), { endpoint }) });
    // The subscription the browser turned notifications on with.
    const saving = await grace.page.request.post("/api/push-subscriptions", { data: { endpoint, p256dhKey: PUSH_KEYS.p256dh, authKey: PUSH_KEYS.auth } });
    expect(saving.status()).toBe(204);
    await grace.page.goto("/users/me/push_subscriptions");
    const rows = grace.page.getByRole("list", { name: "Push Notification Subscriptions" }).getByRole("listitem");
    await rows.getByRole("button", { name: "Delete subscription" }).click();
    await expect(rows).toHaveCount(0);

    await grace.page.getByRole("link", { name: "Go Back" }).click();
    const saved = grace.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/push-subscriptions");
    await grace.page.getByRole("button", { name: "Enable notifications", exact: true }).click();
    expect((await saved).status()).toBe(204);
    await expect(headerBell(grace.page)).toHaveAccessibleName(MENTIONS);
    const { subscriptions } = (await (await grace.page.request.get("/api/push-subscriptions")).json()) as PushSubscriptions;
    expect(subscriptions.map((subscription) => subscription.endpoint)).toEqual([endpoint]);
  });
});

/** A badge set on the app's icon, or "cleared" for one taken off. */
type Badge = number | "cleared";

/** Gives the page the Badging API, as an installed app has it, keeping the badges it sets in `badges`. */
const keepBadges = async (page: Page) => {
  await page.addInitScript(() => {
    const badges: Badge[] = [];
    Object.assign(window, { badges });
    Navigator.prototype.setAppBadge = async (count = 0) => void badges.push(count);
    Navigator.prototype.clearAppBadge = async () => void badges.push("cleared");
  });
};

/** The badges `page` has set on the app's icon, in order. */
const badges = (page: Page) => page.evaluate(() => (window as unknown as { badges: Badge[] }).badges);

test.describe("App icon badge", () => {
  test("badges the app with the conversations marked unread, as Activity counts them, and clears the badge once they're read", async ({ members, rooms }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"), { path: `/rooms/${rooms.random.id}`, beforeOpen: keepBadges });
    await expect.poll(() => badges(grace.page)).toEqual(["cleared"]);

    await ada.send("Lunch?");
    await expect(activity(grace.page)).toHaveAccessibleDescription("1 unread");
    await expect.poll(() => badges(grace.page)).toEqual(["cleared", 1]);

    await roomRows(grace.page).filter({ hasText: "general" }).click();
    await expect(grace.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect.poll(() => badges(grace.page)).toEqual(["cleared", 1, "cleared"]);
  });
});

test.describe("Service worker", () => {
  test("is public at /service-worker.js, as JavaScript a page can register", async ({ page, request }) => {
    const response = await request.get("/service-worker.js");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/javascript; charset=utf-8");

    await page.goto("/session/new");
    const active = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/service-worker.js");
      const { active } = await navigator.serviceWorker.ready;
      // Ready as soon as it starts activating.
      while (active && active.state !== "activated") await new Promise((settle) => active.addEventListener("statechange", settle, { once: true }));
      await registration.unregister();
      return active && { scriptURL: active.scriptURL, state: active.state };
    });
    expect(active).toEqual({ scriptURL: new URL("/service-worker.js", page.url()).href, state: "activated" });
  });
});

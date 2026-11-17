import { PASSWORD_TOO_SHORT, SIGN_IN_REJECTED } from "@ember/protocol";
import type { Page } from "@playwright/test";
import { ADMINISTRATOR, administratorOn, drawnPicture, editorField, invitation, logOut, shownPicture, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { expect, test, unique } from "./fixtures";

const signInHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Sign in to Ember" });

test.describe("Sign in with email and password", () => {
  test.beforeEach(({ page }) => useOwnAddress(page));

  test("signs in with an email address and password, and opens the page asked for", async ({ page, rooms }) => {
    await page.goto(`/rooms/${rooms.general.id}`);
    await expect(page).toHaveURL(/\/session\/new$/);
    await expect(page).toHaveTitle("Sign in");
    await expect(signInHeading(page)).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeFocused();

    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", ADMINISTRATOR.name);
    expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  });

  test("says at the top of the form that the email or password is wrong, keeping the email address", async ({ page }) => {
    await page.goto("/session/new");
    await signInAsAdministrator(page, "incorrect horse battery");
    // In the form.
    const alert = page.locator("form").getByRole("alert");
    await expect(alert).toHaveText(SIGN_IN_REJECTED);
    await expect(page.getByLabel("Email address")).toHaveValue(ADMINISTRATOR.emailAddress);
    await expect(page.getByLabel("Password")).toHaveValue("");
    await expect(page.getByLabel("Password")).toBeFocused();
    await expect(page).toHaveURL(/\/session\/new$/);
  });

  test("fills in the email address its link gives", async ({ page }) => {
    await page.goto(`/session/new?email_address=${encodeURIComponent(ADMINISTRATOR.emailAddress)}`);
    await expect(page.getByLabel("Email address")).toHaveValue(ADMINISTRATOR.emailAddress);
  });
});

test.describe("Sign up with the join link", () => {
  test.beforeEach(({ page }) => useOwnAddress(page));

  /** Fills in the join form and sends it. */
  async function join(page: Page, emailAddress: string) {
    await page.getByLabel("Name").fill("Grace Hopper");
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("Password").fill("compiler");
    await page.getByRole("button", { name: "Create account" }).click();
  }

  test("someone new joins with the welcome card's link, signs out and signs back in", async ({ browser, baseURL, page, request, rooms, session }) => {
    const { roomId } = await invitation(request, session);
    const administrator = await administratorOn(browser, baseURL!, { id: roomId, name: "general" });
    const link = await administrator.getByRole("textbox", { name: "Share to invite more people" }).inputValue();
    await administrator.context().close();

    await page.goto(link);
    await expect(page).toHaveTitle("Sign up");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join Ember");
    await expect(page.getByLabel("Name")).toBeFocused();
    const emailAddress = `grace-${crypto.randomUUID()}@example.com`;
    await join(page, emailAddress);
    // Home, which is their oldest room, since this browser has shown them none yet.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Grace Hopper");

    await logOut(page);
    await expect(signInHeading(page)).toBeVisible();
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("Password").fill("compiler");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Grace Hopper");
  });

  test("someone new joins with a photo, which is their avatar from then on", async ({ page, request, session }) => {
    await page.goto(`/join/${(await invitation(request, session)).joinCode}`);
    const preview = page.getByRole("img", { name: "Your profile photo" });
    await expect(page.getByText("Optional", { exact: true })).toBeVisible();
    await page.getByLabel("Upload photo").setInputFiles(await drawnPicture(page, "portrait.png", 300, 600));
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await join(page, `grace-${crypto.randomUUID()}@example.com`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");

    // The variant their browser made of it, within 512×512, which needs no scaling down.
    const avatar = page.getByRole("link", { name: "Your profile" }).locator("img");
    expect(await shownPicture(avatar)).toEqual({ type: "image/webp", width: 256, height: 512 });
  });

  test("takes a password as long as first run's, saying why one is refused", async ({ page, request, session }) => {
    await page.goto(`/join/${(await invitation(request, session)).joinCode}`);
    let joins = 0;
    page.on("request", (sent) => void (sent.url().includes("/api/join/") && joins++));
    await page.getByLabel("Name").fill("Grace Hopper");
    await page.getByLabel("Email address").fill(`grace-${crypto.randomUUID()}@example.com`);
    const password = page.getByLabel("Password");
    await password.fill("1234567");
    await page.getByRole("button", { name: "Create account" }).click();
    // The browser keeps the form, as it keeps first run's.
    expect(await password.evaluate((field: HTMLInputElement) => field.validity.tooShort)).toBe(true);

    // Eight UTF-16 units satisfy the browser's minlength, but the server counts four characters.
    await password.fill("🔐🔐🔐🔐");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toHaveText(PASSWORD_TOO_SHORT);
    await expect(page.getByLabel("Name")).toHaveValue("Grace Hopper");
    expect(joins).toBe(1);
  });

  test("sends an email address that has an account to sign in with it filled in", async ({ page, request, session }) => {
    await page.goto(`/join/${(await invitation(request, session)).joinCode}`);
    await join(page, ADMINISTRATOR.emailAddress);
    await expect(signInHeading(page)).toBeVisible();
    expect(new URL(page.url()).search).toBe("?email_address=ada%40example.com");
    await expect(page.getByLabel("Email address")).toHaveValue(ADMINISTRATOR.emailAddress);
  });

  test("answers any other code with an empty 404", async ({ page }) => {
    // Asked as the signed-out page, since a browser shows its own error page for it.
    const response = await page.request.get("/join/AAAA-BBBB-CCCC");
    expect(response.status()).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("sends someone who's signed in home", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    await ada.page.goto(`/join/${(await invitation(request, ada.session)).joinCode}`);
    // Home, which is the room they were in.
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
  });
});

test.describe("Version", () => {
  test("shows the version under the sign-in and join cards, and nobody's email address", async ({ page, request, session }) => {
    for (const path of ["/session/new", `/join/${(await invitation(request, session)).joinCode}`]) {
      await page.goto(path);
      await expect(page.getByText(/^Ember version/)).toHaveText(/^Ember version \d+\.\d+/);
      await expect(page.getByText(ADMINISTRATOR.emailAddress)).toHaveCount(0);
    }
  });
});

test.describe("Sign in with a display name", () => {
  test("signs in with a display name and opens the first room", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Join with just a name" }).click();
    await expect(page.getByRole("heading", { name: "Welcome to Ember" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join" })).toBeDisabled();

    await page.getByLabel("Your name").fill("  Ada Lovelace  ");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Ada Lovelace");
    // The session's cookie is out of the page's reach, and nothing else holds it.
    expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
    expect(await page.evaluate(() => localStorage.getItem("ember:session"))).toBeNull();
  });
});

test.describe("Stay signed in, per device", () => {
  test("stays signed in across reloads", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.reload();
    await ada.connected();
    await expect(ada.page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Ada");
  });

  test("goes back to sign-in when the session cookie is no good", async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: "session_token", value: "A".repeat(43), url: baseURL! }]);
    await page.goto("/");
    await expect(signInHeading(page)).toBeVisible();
  });

  test("opens the page asked for once someone signs in there with a session cookie that's no good", async ({ page, baseURL, rooms }) => {
    await useOwnAddress(page);
    // The Worker has the browser preload the room's sidebar and people with the page, for that cookie.
    await page.context().addCookies([{ name: "session_token", value: "A".repeat(43), url: baseURL! }]);
    await page.goto(`/rooms/${rooms.general.id}`);
    await expect(signInHeading(page)).toBeVisible();
    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
  });
});

test.describe("Private sign-in link", () => {
  const YOURS = "Use this link to login automatically on another device";
  const THEIRS = "Share to get them back into their account";

  test("your profile's link signs you in on another device, and goes on to the page it was sent to sign in from", async ({ members, page, rooms }) => {
    const grace = await members.signIn(unique("Grace"));
    await grace.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).click();
    const link = await grace.page.getByRole("textbox", { name: YOURS }).inputValue();
    const { pathname, hash } = new URL(link);
    expect(pathname).toBe("/session/transfers");
    expect(hash).toMatch(new RegExp(`^#token=${grace.session.user.id}\\.`));
    const transferId = hash.slice("#token=".length);
    // What a log can hold of each request: its address, which browsers send without the fragment, and the page it's from.
    const sent: string[] = [];
    page.on("request", (request) => sent.push(request.url().replace(/#.*/, ""), request.headers().referer ?? ""));

    // Another device, signed out, sent to sign in from the test's general.
    await page.goto(`/rooms/${rooms.general.id}`);
    await expect(signInHeading(page)).toBeVisible();
    const signIn = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/session/transfers");
    await page.goto(link);
    expect((await signIn).postDataJSON()).toEqual({ transferId });
    await expect(page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", grace.name);
    expect(sent.filter((logged) => logged.includes(transferId))).toEqual([]);

    // The link works as often as it's opened until it expires, and Grace's first device stays signed in.
    await logOut(page);
    await expect(signInHeading(page)).toBeVisible();
    await page.goto(link);
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", grace.name);
    await grace.page.reload();
    await expect(grace.page.getByLabel("Name", { exact: true })).toHaveValue(grace.name);
  });

  test("an administrator's link for someone gets them back into their account, on any device", async ({ browser, baseURL, members, page }) => {
    const grace = await members.signIn(unique("Grace"));
    await useOwnAddress(page);
    await page.goto(`/users/${grace.session.user.id}`);
    await signInAsAdministrator(page);
    const link = await page.getByRole("textbox", { name: THEIRS }).inputValue();

    const device = await browser.newContext({ baseURL });
    try {
      const other = await device.newPage();
      await other.goto(link);
      await expect(other.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", grace.name);
    } finally {
      await device.close();
    }
    // The administrator stays signed in as themselves.
    await page.reload();
    await expect(page.getByRole("textbox", { name: THEIRS })).toBeVisible();
  });

  test("leaves the page blank for a link that doesn't work, signing nobody in", async ({ page }) => {
    await page.goto("/session/transfers#token=nonsense");
    await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("main")).toBeEmpty();
    await expect(page).toHaveURL(/\/session\/transfers$/);
    await page.goto("/");
    await expect(signInHeading(page)).toBeVisible();
  });
});

test.describe("QR codes for links", () => {
  test("draws a sign-in link's QR code in the page, so the link never reaches the Worker", async ({ members }) => {
    const grace = await members.signIn(unique("Grace"));
    await grace.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).click();
    const asked: string[] = [];
    grace.page.on("request", (request) => asked.push(new URL(request.url()).pathname));

    await grace.page.getByRole("button", { name: "Show auto-login QR code" }).click();
    const viewer = grace.page.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    await expect(viewer.locator("img[src^='blob:']")).toBeVisible();
    const download = grace.page.waitForEvent("download");
    await viewer.getByRole("link", { name: "Download file" }).click();
    expect((await download).suggestedFilename()).toBe("QR code.svg");
    expect(asked.filter((path) => path.startsWith("/qr_code/"))).toEqual([]);
  });
});

test.describe("Sign out", () => {
  test("logs out from your profile, which the rail's avatar opens, and stays signed out", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.getByRole("link", { name: "Your profile" }).click();
    await expect(ada.page.getByRole("heading", { level: 1, name: "Your profile" })).toBeVisible();
    await ada.page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Log out" }).click();
    await expect(signInHeading(ada.page)).toBeVisible();
    await expect(ada.page).toHaveURL(/\/session\/new$/);

    await ada.page.reload();
    await expect(signInHeading(ada.page)).toBeVisible();
  });

  test("sends this browser's other tabs to sign in, and leaves other devices signed in", async ({ browser, baseURL, rooms }) => {
    const laptop = await administratorOn(browser, baseURL!, rooms.general);
    const phone = await administratorOn(browser, baseURL!, rooms.general);
    try {
      const otherTab = await laptop.context().newPage();
      await otherTab.goto(`/rooms/${rooms.general.id}`);
      await expect(otherTab.getByRole("log", { name: "Messages in general" })).toBeVisible();

      await logOut(laptop);
      await expect(signInHeading(laptop)).toBeVisible();
      // The room closed the other tab's socket, so it found out without being touched.
      await expect(signInHeading(otherTab)).toBeVisible();

      const composer = editorField(phone, "Write a message");
      await composer.fill("Still signed in on the phone");
      await composer.press("Enter");
      await expect(phone.getByRole("article").filter({ hasText: "Still signed in on the phone" })).toBeVisible();
      await phone.reload();
      await expect(phone.getByRole("heading", { level: 1 })).toHaveText("general");
    } finally {
      await Promise.all([laptop.context().close(), phone.context().close()]);
    }
  });
});

test.describe("One live connection per tab outside the open room", () => {
  test("sends another tab to sign in from a page with no room open, through its workspace connection", async ({ browser, baseURL, rooms }) => {
    const laptop = await administratorOn(browser, baseURL!, rooms.general);
    try {
      const settings = await laptop.context().newPage();
      // Its listener goes on as the socket opens, so it can't miss the welcome.
      const welcomed = new Promise<void>((resolve) =>
        settings.on("websocket", (ws) => void (new URL(ws.url()).pathname === "/api/socket" && ws.once("framereceived", () => resolve()))),
      );
      await settings.goto("/account/edit");
      await welcomed;

      await logOut(laptop);
      await expect(signInHeading(laptop)).toBeVisible();
      await expect(signInHeading(settings)).toBeVisible();
    } finally {
      await laptop.context().close();
    }
  });
});

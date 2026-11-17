import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, expectsPolicyViolation, test } from "../../fixtures";

// What the Worker answers whoever asks: its headers, /up, its error pages, and the page for browsers
// too old to run Ember. These start signed out and need no rooms, so they use Playwright's own fixtures: with the
// app's, making a test's rooms would ask the API as the old browsers below, and get the upgrade page.

/** Chrome 119, a version short of what Campfire allows. */
const OLD_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.199 Safari/537.36";
/** Apple Messages fetching a link's preview: Safari 9's engine, naming the crawlers it stands in for. */
const APPLE_MESSAGES =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";

const upgradeHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Upgrade to a supported web browser" });
const signInHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Sign in to Ember" });

/** One of the files the web app serves as it is, from apps/web/public/. */
const publicFile = (name: string) => readFileSync(resolve(import.meta.dirname, "../../../apps/web/public", name), "utf8");

test.describe("Supported browsers", () => {
  test.describe("on an old browser", () => {
    test.use({ userAgent: OLD_CHROME });

    test("asks to upgrade instead of opening the app, naming the browsers that work", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveTitle("Unsupported browser");
      await expect(upgradeHeading(page)).toBeVisible();
      await expect(page.getByText("Ember requires a modern web browser.")).toBeVisible();
      await expect(page.locator(".browser")).toHaveText(["Safari 17.2+", "Chrome 120+", "Firefox 121+", "Opera 104+"]);
      for (const logo of await page.locator(".browser img").all()) {
        await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      }
    });

    test("asks wherever a link leads", async ({ page }) => {
      for (const path of ["/rooms/general", "/session/new", "/join/AAAA-BBBB-CCCC", "/first_run"]) {
        await page.goto(path);
        await expect(upgradeHeading(page)).toBeVisible();
      }
    });

    test("is dark when the app was left dark, or the device is", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/");
      await expect(page.locator("html")).toHaveCSS("background-color", "rgb(28, 28, 28)");

      await page.evaluate(() => localStorage.setItem("ember:appearance", "light"));
      await page.reload();
      await expect(page.locator("html")).toHaveCSS("background-color", "rgb(250, 250, 250)");

      await page.emulateMedia({ colorScheme: "light" });
      await page.evaluate(() => localStorage.setItem("ember:appearance", "dark"));
      await page.reload();
      await expect(page.locator("html")).toHaveCSS("background-color", "rgb(28, 28, 28)");
    });
  });

  test.describe("in Apple Messages", () => {
    test.use({ userAgent: APPLE_MESSAGES });

    test("previews a link as Ember rather than as a warning", async ({ page }) => {
      await page.goto("/rooms/general");
      await expect(page).toHaveTitle("Ember");
      await expect(upgradeHeading(page)).toBeVisible();
    });
  });
});

test.describe("Security headers and HTTPS", () => {
  test("pages come with Rails' default headers", async ({ page }) => {
    const response = await page.goto("/session/new");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Ember" })).toBeVisible();
    expect(response!.headers()).toMatchObject({
      "x-frame-options": "SAMEORIGIN",
      "x-xss-protection": "0",
      "x-content-type-options": "nosniff",
      "x-permitted-cross-domain-policies": "none",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
  });

  test("only the app itself can show it in a frame", async ({ page, baseURL, browserName }) => {
    const showInFrame = (src: string) =>
      page.evaluate((src) => document.body.append(Object.assign(document.createElement("iframe"), { src })), src);
    await page.goto("/up");
    await showInFrame("/session/new");
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Sign in to Ember" })).toBeVisible();

    // Another site on this machine, with a page of its own, since a page of Ember's couldn't try: its
    // policy lets it frame only Ember. (Chrome lets no site elsewhere reach this machine's addresses.)
    const site = createServer((_, response) => response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Another site</title>"));
    await new Promise<void>((resolve) => site.listen(0, resolve));
    expectsPolicyViolation("frame-ancestors");
    try {
      await page.goto(`http://localhost:${(site.address() as AddressInfo).port}/`);
      const framed = page.waitForResponse(`${baseURL}/session/new`);
      const refused = page.waitForEvent("console", (message) => message.text().includes("frame-ancestors"));
      await showInFrame(`${baseURL}/session/new`);
      const headers = (await framed).headers();
      expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'");
      // The browser says it refused, and Chrome shows its error page in the frame, where WebKit leaves the address.
      await refused;
      if (browserName === "chromium") await expect.poll(() => page.frames()[1]?.url()).toMatch(/^chrome-error:/);
    } finally {
      site.close();
    }
  });
});

test.describe("Version", () => {
  test("pages say which version answered them", async ({ page, request }) => {
    const response = await page.goto("/session/new");
    const { version } = (await (await request.get("/api/bootstrap")).json()) as { version: string };
    expect(response!.headers()["x-version"]).toBe(version);
  });
});

test.describe("Health check", () => {
  // Uptime checks come from anything, so /up answers even an old browser.
  test.use({ userAgent: OLD_CHROME });

  test("/up shows Rails' green page", async ({ page }) => {
    const response = await page.goto("/up");
    expect(response!.status()).toBe(200);
    expect(response!.headers()["x-version"]).toBeUndefined();
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(0, 128, 0)");
  });

  test("/up.json says so in JSON", async ({ request }) => {
    const response = await request.get("/up.json");
    expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ status: "up", timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) });
  });
});

test.describe("Error pages", () => {
  test("an address Ember has no page at answers 404 with Campfire's page, whose Go back goes home", async ({ page }) => {
    const response = await page.goto("/no-such-page");
    expect(response!.status()).toBe(404);
    expect(await response!.text()).toBe(publicFile("404.html"));
    await expect(page).toHaveTitle("We can’t find that (404)");
    await expect(page.getByLabel("Not found")).toBeVisible();
    const back = page.getByRole("link", { name: "Go back" });
    await expect(back).toBeFocused();
    await back.click();
    await expect(signInHeading(page)).toBeVisible();
  });

  test("so do Rails' unused actions, and a write to a page", async ({ request }) => {
    for (const path of ["/rooms/new", "/rooms/all-talk/edit", "/rooms/all-talk/extra", "/messages"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
      expect(await response.text(), path).toBe(publicFile("404.html"));
    }
    const write = await request.post("/rooms/all-talk");
    expect(write.status()).toBe(404);
    expect(await write.text()).toBe(publicFile("404.html"));
  });

  test("every address the app shows a page at still loads it", async ({ request }) => {
    const pages = ["/", "/rooms", "/rooms/all-talk", "/rooms/opens/all-talk", "/rooms/opens/new", "/rooms/closeds/new", "/rooms/opens/all-talk/edit"];
    for (const path of [...pages, "/account/edit", "/session/new", "/users/me/profile"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(await response.text(), path).toContain('<div id="root">');
    }
  });

  test("a page's address with a trailing slash goes to the page's own", async ({ page }) => {
    await page.goto("/session/new/");
    await expect(page).toHaveURL(/\/session\/new$/);
    await expect(signInHeading(page)).toBeVisible();
  });

  test("Campfire's 500 page is there for failures, and its 422 page has Try again too", async ({ page }) => {
    await page.goto("/500");
    await expect(page).toHaveTitle("Something went wrong (500)");
    await expect(page.getByLabel("Server error")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go back" })).toHaveAttribute("href", "/");

    await page.goto("/422");
    await expect(page).toHaveTitle("That didn’t work (422)");
    await expect(page.getByLabel("That didn’t work")).toBeVisible();
    const reloaded = page.waitForRequest((request) => new URL(request.url()).pathname === "/422");
    await page.getByRole("link", { name: "Try again" }).click();
    await reloaded;
  });

  test("follows the device into dark mode, as Campfire's pages do", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.locator("body")).toHaveCSS("background-color", "oklch(1 0 0)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("body")).toHaveCSS("background-color", "oklch(0 0 0)");
  });

  test("/robots.txt is Campfire's, which allows everything", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(await response.text()).toBe(publicFile("robots.txt"));
  });
});

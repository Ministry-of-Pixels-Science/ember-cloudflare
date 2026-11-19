import { createHash } from "node:crypto";
import { expect, test } from "./fixtures";

/**
 * The SHA-256 of each icon the manifest lists: Ember's app icons and, for the shortcuts, Iconoir's plus
 * and user, as the project's owner chose, where Campfire lists its add and person (app/assets/images/).
 */
const ICONS: Record<string, string> = {
  "/logos/app-icon-192.png": "49ff9160e2e167043fe948e7b78695c1b55270dff701479ebc6f574eedff6126",
  "/logos/app-icon.png": "d93bfb957863d1aca5ab6ca4e2f81d592e5ed101df6850b89ac792f6f67d88f3",
  "/shortcuts/plus.svg": "dbd0c9ec345745994d219d9bf30252abe534304e8f006316e14c32c8dbf3fb79",
  "/shortcuts/user.svg": "53e6505904aafd797da6ea432aa148b7858104454e4e9b65895a879e74451ea3",
};

interface Manifest {
  icons: Array<{ src: string }>;
  shortcuts: Array<{ icons: Array<{ src: string }> }>;
  screenshots: Array<{ src: string; sizes: string }>;
}

test.describe("Web app manifest", () => {
  test("Chrome reads the manifest the page links without errors, and can install Ember", async ({ playwright, baseURL, browserName }) => {
    test.skip(browserName !== "chromium", "Chrome's own reading of the manifest, which the Chromium run checks");
    // Chrome installs nothing from an incognito window, which every context Playwright opens is, so
    // this opens a profile of its own.
    const context = await playwright.chromium.launchPersistentContext("", { baseURL, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const logged: string[] = [];
      page.on("console", (message) => logged.push(message.text()));
      await page.goto("/session/new");
      const cdp = await context.newCDPSession(page);
      const { url, errors } = await cdp.send("Page.getAppManifest", {});
      expect(url).toBe(new URL("/webmanifest.json", baseURL).href);
      expect(errors).toEqual([]);
      await expect.poll(async () => (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
      // Chrome warns that apple-mobile-web-app-capable is deprecated unless mobile-web-app-capable is there too.
      expect(logged.filter((text) => text.includes("web-app-capable"))).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("lists Ember's icons, and Iconoir's for its shortcuts, byte for byte", async ({ request }) => {
    const manifest = (await (await request.get("/webmanifest.json")).json()) as Manifest;
    const sources = [...manifest.icons, ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons)].map((icon) => icon.src);
    expect(new Set(sources)).toEqual(new Set(Object.keys(ICONS)));
    for (const source of sources) {
      const response = await request.get(source);
      expect(response.status(), source).toBe(200);
      expect(createHash("sha256").update(await response.body()).digest("hex"), source).toBe(ICONS[source]);
    }
  });

  test("lists Ember's own screenshots, each a PNG of the size it says", async ({ request }) => {
    const manifest = (await (await request.get("/webmanifest.json")).json()) as Manifest;
    expect(manifest.screenshots.map((screenshot) => screenshot.src)).toEqual(["/screenshots/chat.png", "/screenshots/sidebar.png", "/screenshots/dark-mode.png"]);
    for (const { src, sizes } of manifest.screenshots) {
      const response = await request.get(src);
      expect(response.status(), src).toBe(200);
      expect(response.headers()["content-type"], src).toBe("image/png");
      const png = await response.body();
      // A PNG starts with its signature and then its IHDR chunk, which holds its width and height.
      expect(png.subarray(1, 4).toString("latin1"), src).toBe("PNG");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, src).toBe(sizes);
    }
  });
});

test.describe("Installable page head", () => {
  test("every page links the manifest and Ember's icons, with the theme colors", async ({ page, request }) => {
    for (const path of ["/", "/session/new", "/rooms/all-talk"]) {
      const html = await (await request.get(path)).text();
      // The page as the server sends it, since its script recolors the theme at once (ui.appearance).
      const tags = await page.evaluate((html) => {
        const head = new DOMParser().parseFromString(html, "text/html").head;
        const tags = head.querySelectorAll('meta[name="theme-color"], meta[name$="mobile-web-app-capable"], link[rel="manifest"], link[rel="icon"], link[rel="apple-touch-icon"]');
        return [...tags].map((tag) => Object.fromEntries([...tag.attributes].map(({ name, value }) => [name, value])));
      }, html);
      expect(tags, path).toEqual([
        { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
        { name: "theme-color", content: "#000000", media: "(prefers-color-scheme: dark)" },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "mobile-web-app-capable", content: "yes" },
        { rel: "manifest", href: "/webmanifest.json" },
        { rel: "icon", type: "image/png", sizes: "48x48", href: "/logos/app-icon-48.png" },
        { rel: "apple-touch-icon", href: "/logos/app-icon.png" },
      ]);
    }
  });
});

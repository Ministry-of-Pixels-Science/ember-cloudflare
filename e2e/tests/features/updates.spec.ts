import { expect, test } from "./fixtures";

// A tab left open as Ember is updated goes on running the Ember it loaded, so it asks for the
// app-version.json the build writes beside the app, as it's shown again and every minute while it's
// shown, and says Ember has been updated once that names files it never loaded (apps/web/src/lib/updates.ts).

/** The files a build after an update loads, named anew, as a build names its files for what's in them. */
const UPDATED = { assets: ["/assets/index-Dk2o9XyZ.js", "/assets/index-a0Zq3Wbn.css"] };

test.describe("Updates", () => {
  test("names the page's own script and stylesheet in app-version.json, served as a static file", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const response = await ada.page.request.get("/app-version.json");
    expect(response.ok()).toBe(true);
    // Without the headers the Worker gives every answer of its own, as asking each minute costs it nothing.
    expect(response.headers()["x-version"]).toBeUndefined();
    const { assets } = (await response.json()) as { assets: string[] };
    const loaded = await ada.page.evaluate(() =>
      [...document.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]')].map((element) => element.getAttribute("src") ?? element.getAttribute("href")),
    );
    expect(assets.length).toBeGreaterThan(0);
    for (const path of assets) expect(loaded).toContain(path);

    // A tab shown again while it's Ember as it's deployed says nothing.
    await ada.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(ada.page.getByText("Ember has been updated.")).toHaveCount(0);
  });

  test("tells a tab left open that Ember has been updated as it's shown again, and reloads it when asked", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.route("**/app-version.json", (route) => route.fulfill({ json: UPDATED }));
    await ada.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const notice = ada.page.getByRole("status").filter({ hasText: "Ember has been updated." });
    await expect(notice).toBeVisible();

    // The reloaded page is Ember as it's deployed.
    await ada.page.unroute("**/app-version.json");
    const reloaded = ada.page.waitForEvent("load");
    await notice.getByRole("button", { name: "Reload" }).click();
    await reloaded;
    await expect(ada.composer()).toBeVisible();
    await ada.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(ada.page.getByText("Ember has been updated.")).toHaveCount(0);
  });

  test("keeps it closed once it's closed", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.route("**/app-version.json", (route) => route.fulfill({ json: UPDATED }));
    await ada.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const notice = ada.page.getByRole("status").filter({ hasText: "Ember has been updated." });
    await notice.getByRole("button", { name: "Close" }).click();
    await expect(notice).toHaveCount(0);
    await ada.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(notice).toHaveCount(0);
  });
});

import type { Bootstrap } from "@ember/protocol";
import { APP_SECRET_UNKNOWN } from "@ember/protocol/huddles";
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { ADMINISTRATOR, drawnPicture, SAME_ORIGIN, shownPicture, variantType } from "../../fixtures";
import { SETUP_TOKEN } from "../../projects/first-run";
import { AI_GATEWAY_ACCOUNT, SETTINGS_FIRST_RUN, SFU_APP } from "../../projects/workspace-settings";
import { startFakeSfu } from "../workspace-settings/fake-sfu";

// Each test server starts empty, so this sets it up through the Set up Ember page before any other suite
// runs; they then find the workspace, its general and random rooms, and its administrator there. The
// server has a setup token, as a deployed Worker has, so the page takes the setup link that carries it,
// which `wrangler dev` on localhost without one wouldn't ask for.
//
// Setup asks whether to turn huddles on before it opens Ember. The main test server has no SFU of the
// tests' to ask, so there the answer is Not now. The second asks the Realtime SFU the huddles spec fakes,
// so there setup turns huddles on, and the test turns them off again once it has seen them on, which
// leaves the workspace as the other suites expect a new one: huddles off.

/** Answers setup's question by setting huddles up: the two steps, with the app's keys the faked SFU knows, and on to Ember. */
async function setUpHuddles(page: Page) {
  const sfu = await startFakeSfu();
  try {
    await page.getByRole("button", { name: "Set up huddles" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Set up huddles" })).toBeFocused();
    // The dashboard opens at the account Ember is deployed to.
    await expect(page.getByRole("link", { name: "Open Cloudflare's dashboard" })).toHaveAttribute("href", `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/realtime/sfu`);
    const [appId, appSecret] = [page.getByRole("textbox", { name: "App ID" }), page.getByRole("textbox", { name: "App Secret" })];
    await expect(appSecret).toHaveCSS("-webkit-text-security", "disc");
    const save = page.getByRole("button", { name: "Save and continue" });
    await expect(save).toBeDisabled();

    // A secret that isn't the app's comes back to its field, once Cloudflare has been asked.
    await appId.fill(SFU_APP.appId);
    await appSecret.fill("f".repeat(64));
    await save.click();
    await expect(page.getByRole("alert")).toHaveText(APP_SECRET_UNKNOWN);
    await expect(appSecret).toHaveAccessibleDescription(APP_SECRET_UNKNOWN);

    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(page.getByRole("heading", { level: 1, name: "Huddles are on" })).toBeFocused();
    expect(sfu.asked.at(-1)).toEqual({ method: "POST", path: `/v1/apps/${SFU_APP.appId}/sessions/new`, authorization: `Bearer ${SFU_APP.appSecret}` });
    await expect(page).toHaveURL(/\/first_run$/);
    await page.getByRole("button", { name: "Open Ember" }).click();
  } finally {
    await sfu.close();
  }
}

test.describe("Set up the workspace", () => {
  test("whoever has the setup link sets up Ember and lands in general as its administrator", async ({ page, request }) => {
    const { setup, setupAccess } = (await (await request.get("/api/bootstrap")).json()) as Bootstrap;
    test.skip(setup === "complete", "The test server was set up by an earlier run, which reuseExistingServer kept");
    expect(setupAccess).toBe("link");

    // Without the link, the page says to open it, and the form's post is refused before it's read.
    await page.goto("/");
    await expect(page).toHaveURL(/\/first_run$/);
    await expect(page).toHaveTitle("Set up Ember");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up Ember");
    await expect(page.getByText("Ember is waiting for its administrator.")).toBeVisible();
    await expect(page.getByText(`${new URL(page.url()).origin}/first_run#token=…`)).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveCount(0);
    // Sent as the app's own page would send it, since over HTTPS a write that doesn't say so is refused as cross-site.
    const withoutLink = await request.post("/api/first_run", {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: { name: "Mallory", emailAddress: "mallory@example.com", password: "12345678" },
    });
    expect(withoutLink.status()).toBe(403);
    expect(await withoutLink.json()).toEqual({ error: "Open the setup link the deploy printed to set up Ember" });

    // The link's token leaves the address as the page opens, and goes with the form instead.
    await page.goto(`/first_run#token=${SETUP_TOKEN}`);
    await expect(page.getByLabel("Name")).toBeFocused();
    await expect(page).toHaveURL(/\/first_run$/);
    // The test server names no placeholders of its own, so the form suggests the defaults.
    await expect(page.getByLabel("Name")).toHaveAttribute("placeholder", "Kevin Rose");
    await expect(page.getByLabel("Email address")).toHaveAttribute("placeholder", "kevin@kevinrose.com");
    // With no header to show it under, Skip to main content shows at the page's top left, as basecoat's does.
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await skip.focus();
    expect(await skip.boundingBox()).toMatchObject({ x: 8, y: 8 });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    const password = page.getByLabel("Password", { exact: true });
    const preview = page.getByRole("img", { name: "Avatar preview" });
    await page.getByLabel("Upload profile image (optional)").setInputFiles(await drawnPicture(page, "portrait.png", 640, 960));
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await page.getByLabel("Name").fill(ADMINISTRATOR.name);
    await page.getByLabel("Email address").fill(ADMINISTRATOR.emailAddress);
    // Eight UTF-16 units satisfy the browser's minlength, but the server counts four characters.
    await password.fill("🔐🔐🔐🔐");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Password must be at least 8 characters.");
    await expect(password).toBeFocused();
    await expect(password).toHaveValue("");
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Name")).toHaveValue(ADMINISTRATOR.name);
    // The photo stays chosen too.
    await expect(preview).toHaveAttribute("src", /^blob:/);

    await password.fill(ADMINISTRATOR.password);
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    const length = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "Continue" }).click();

    // The workspace is made, and before it opens, setup asks about huddles, still at its own address.
    await expect(page.getByRole("heading", { level: 1, name: "Would you like to enable audio and video chat?" })).toBeFocused();
    await expect(page).toHaveURL(/\/first_run$/);
    await expect(page).toHaveTitle("Set up Ember");
    const withHuddles = test.info().project.name === SETTINGS_FIRST_RUN;
    if (withHuddles) await setUpHuddles(page);
    else await page.getByRole("button", { name: "Not now" }).click();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", ADMINISTRATOR.name);
    // general's header has the huddle button only where setup turned huddles on.
    const startHuddle = page.getByRole("button", { name: "Start huddle", exact: true });
    if (withHuddles) {
      await expect(startHuddle).toBeVisible();
      const forgotten = await page.request.delete("/api/account/huddles", { headers: SAME_ORIGIN });
      expect(forgotten.status(), await forgotten.text()).toBe(200);
    }
    await expect(startHuddle).toHaveCount(0);
    // Their avatar is the variant their browser made of the photo, within 512×512.
    expect(await shownPicture(page.getByRole("link", { name: "Your profile" }).locator("img"))).toEqual({ type: await variantType(page), width: 341, height: 512 });
    // Setup made the rooms general and random, and nothing else.
    const rooms = page.getByRole("region", { name: "Rooms" }).getByRole("link");
    await expect(rooms).toHaveCount(2);
    await expect(rooms).toContainText(["general", "random"]);
    // general, the first room, welcomes them with the link that invites everyone else.
    await expect(page.getByRole("heading", { level: 2, name: "Welcome to Ember" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Share to invite more people" })).toHaveValue(/\/join\/[A-Za-z\d]{4}-[A-Za-z\d]{4}-[A-Za-z\d]{4}$/);
    // Setup took the page's place, so Back doesn't return to it.
    expect(await page.evaluate(() => history.length)).toBe(length);

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    // Once it's set up, setup sends everyone home.
    await page.goto("/first_run");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("general");
    expect(new URL(page.url()).pathname).not.toBe("/first_run");
    // The link is spent: with its token the form is told Ember is set up, and without it nothing more.
    const again = await request.post("/api/first_run", {
      headers: { "Sec-Fetch-Site": "same-origin", Authorization: `Bearer ${SETUP_TOKEN}` },
      data: { name: "Mallory", emailAddress: "mallory@example.com", password: "12345678" },
    });
    expect(again.status()).toBe(409);
    const withoutLinkAgain = await request.post("/api/first_run", {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: { name: "Mallory", emailAddress: "mallory@example.com", password: "12345678" },
    });
    expect(withoutLinkAgain.status()).toBe(403);
  });
});

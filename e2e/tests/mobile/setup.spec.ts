import type { Bootstrap, NewWorkspace } from "@ember/protocol";
import { APP_ID_REFUSED, type HuddlesSaved } from "@ember/protocol/huddles";
import { expect, test } from "./fixtures";

const PENDING: Bootstrap = {
  setup: "pending",
  setupAccess: "open",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: true,
  signInWithMemberful: false,
  turnstileSiteKey: null,
  passwordResetCodes: false,
  account: { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
  version: "0.1",
  vapidPublicKey: null,
  platform: { ios: false, android: false, desktop: true, windows: false, chrome: false, firefox: false, safari: false, edge: false, browser: "Mozilla", operatingSystem: "" },
  user: null,
};

// The first-run project has set the server up by now, so these show the page as a new deployment
// would: the app's page at /first_run, told that Ember is waiting to be set up.
test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: PENDING }));
  await page.route("**/first_run", async (route) => route.fulfill({ response: await route.fetch({ url: new URL("/", baseURL).href }) }));
});

test("the Set up Ember screen fits the phone", async ({ page, screenIsFine }) => {
  await page.goto("/first_run");
  await expect(page.getByRole("heading", { name: "Set up Ember" })).toBeVisible();
  await screenIsFine();
});

test("the setup link screen fits the phone", async ({ page, screenIsFine }) => {
  // As a deployed Worker, opened without its setup link, shows it.
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...PENDING, setupAccess: "link" } }));
  await page.goto("/first_run");
  await expect(page.getByText("Ember is waiting for its administrator.")).toBeVisible();
  await expect(page.getByText("EMBER_SETUP_PASSWORD")).toBeVisible();
  await screenIsFine();
});

test("the setup password screen fits the phone, and so does a refused one", async ({ page, screenIsFine }) => {
  // As a Worker deployed with Deploy to Cloudflare, whose form asked for a setup password, shows it.
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...PENDING, setupAccess: "password" } }));
  await page.route("**/api/first_run/check", (route) => route.fulfill({ status: 403, json: { error: "That isn't this Ember's setup password" } }));
  await page.goto("/first_run");
  const field = page.getByLabel("Setup password");
  await expect(field).toBeFocused();
  await screenIsFine();

  await field.fill("not the setup password");
  await page.getByRole("button", { name: "Show password" }).tap();
  await page.getByRole("button", { name: "Continue" }).tap();
  await expect(page.getByRole("alert")).toHaveText("That isn't this Ember's setup password");
  await expect(field).toHaveValue("");
  await screenIsFine();
});

test("a password that's too short keeps the screen in shape", async ({ page, screenIsFine }) => {
  await page.route("**/api/first_run", (route) => route.fulfill({ status: 422, json: { error: "Password must be at least 8 characters.", field: "password" } }));
  await page.goto("/first_run");
  await page.getByLabel("Name").fill("Pat on a phone");
  await page.getByLabel("Email address").fill("pat@example.com");
  await page.getByLabel("Password", { exact: true }).fill("🔐🔐🔐🔐");
  await page.getByRole("button", { name: "Show password" }).tap();
  await page.getByRole("button", { name: "Continue" }).tap();
  await expect(page.getByRole("alert")).toHaveText("Password must be at least 8 characters.");
  await screenIsFine();
});

test("setup's question about huddles, its two steps with a key refused, and Huddles are on fit the phone", async ({ page, screenIsFine }) => {
  // As the Worker answers the form, and then the administrator it made, without making anything of either.
  const made: NewWorkspace = { user: { id: "u1", name: "Pat on a phone", administrator: true }, room: { id: "r1", name: "general", kind: "open", icon: null } };
  const app = { appId: "ca11".repeat(8), appSecret: "5ec7".repeat(16) };
  await page.route("**/api/first_run", (route) => route.fulfill({ status: 201, json: made }));
  await page.route("**/api/account", (route) => route.fulfill({ json: { cloudflareAccountId: null } }));
  await page.route("**/api/account/huddles", (route) => route.fulfill({ json: { huddles: { appId: app.appId, relayKeyId: null } } satisfies HuddlesSaved }));
  await page.goto("/first_run");
  await page.getByLabel("Name").fill("Pat on a phone");
  await page.getByLabel("Email address").fill("pat@example.com");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "Would you like to enable audio and video chat?" })).toBeFocused();
  await screenIsFine();

  await page.getByRole("button", { name: "Set up huddles" }).tap();
  await expect(page.getByRole("list", { name: "Steps to set up huddles" })).toBeVisible();
  await screenIsFine();

  // Keys that can't be an app's are refused on their field, in the longest words a refusal has.
  await page.getByRole("textbox", { name: "App ID" }).fill("my huddles app");
  await page.getByRole("textbox", { name: "App Secret" }).fill(app.appSecret);
  await page.getByRole("button", { name: "Save and continue" }).tap();
  await expect(page.getByRole("alert")).toHaveText(APP_ID_REFUSED);
  await screenIsFine();

  await page.getByRole("textbox", { name: "App ID" }).fill(app.appId);
  await page.getByRole("button", { name: "Save and continue" }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "Huddles are on" })).toBeFocused();
  await screenIsFine();
});

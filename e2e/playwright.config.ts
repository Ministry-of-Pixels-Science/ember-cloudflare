import path from "node:path";
import { defineConfig } from "@playwright/test";
import { featureProjects, RECOVERY_TOKEN } from "./projects/features";
import { FIRST_RUN, firstRunProjects, SETUP_TOKEN } from "./projects/first-run";
import { mobileProjects } from "./projects/mobile";
import { screenshotProjects } from "./projects/screenshots";
import {
  AI_GATEWAY_ACCOUNT,
  AI_GATEWAY_PORT,
  RESEND_API_PORT,
  SETTINGS_SERVER_PORT,
  SFU_PORT,
  SITEVERIFY_PORT,
  workspaceSettingsProjects,
} from "./projects/workspace-settings";
import type { MobileOptions } from "./tests/mobile/fixtures";

/**
 * The one Playwright config for every browser suite. Each suite adds its projects from ./projects/
 * and its specs under ./tests/<suite>/, and all of them share the server below.
 */

// Not 8787, so a running `pnpm dev` is never mistaken for the test server.
const port = Number(process.env.E2E_PORT ?? 8788);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig<MobileOptions>({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // CI installs the browser that matches @playwright/test. Sandboxes with a preinstalled
    // Chromium point at it instead: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
  // Every suite finds the server set up: the first-run project sets it up before the others start.
  projects: [
    ...firstRunProjects,
    ...workspaceSettingsProjects,
    ...[...featureProjects, ...mobileProjects, ...screenshotProjects].map((project) => ({ ...project, dependencies: [FIRST_RUN] })),
  ],
  // The production build and the API on one origin, served by `wrangler dev` the way the deployed
  // Worker serves them. State lives in e2e/.wrangler so tests never touch your local dev data, and
  // starts empty, since every open room a test makes takes in everyone who signs in after it.
  webServer: [
    {
      command: [
        `node -e "require('node:fs').rmSync('e2e/.wrangler/state', { recursive: true, force: true })"`,
        "pnpm --filter @ember/web build",
        `pnpm --filter @ember/worker exec wrangler dev -c ../../wrangler.jsonc --ip 127.0.0.1 --port ${port} --var SESSION_SECRET:e2e-only-not-a-secret --var EMBER_GUEST_SIGN_IN:true --var EMBER_RECOVERY_TOKEN:${RECOVERY_TOKEN} --var EMBER_SETUP_TOKEN:${SETUP_TOKEN} --persist-to ../../e2e/.wrangler/state`,
      ].join(" && "),
      cwd: path.resolve(import.meta.dirname, ".."),
      url: `${baseURL}/api/health`,
      env: { WRANGLER_SEND_METRICS: "false" },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    // The same build again, over HTTPS, for the workspace-settings projects, with the address of the
    // Resend API the email specs fake, which Ember sends email with once they give it the API key it
    // takes, as an administrator does in Set up email, the address of the siteverify the Turnstile spec
    // fakes, which Ember asks about checks once it's given a widget's keys in Set up Turnstile, the
    // address of the AI Gateway the Ember AI spec fakes, which Ember asks models through once it's
    // given an account in Set up Ember AI, and which serves the models file too, in place of the one on
    // Ember's main branch, the ID of the account Ember is deployed to, as `pnpm run deploy` gives it,
    // which Set up Ember AI fills in, and the address of the Realtime SFU the huddles spec fakes, which
    // Ember asks to start a session with an app's keys before it keeps them in Set up huddles, then to
    // carry what's said in a huddle, and, as Cloudflare's TURN service, for a relay's servers. Servers
    // start in turn, so the app is built by then.
    {
      command: [
        `node -e "require('node:fs').rmSync('e2e/.wrangler/settings-state', { recursive: true, force: true })"`,
        [
          `pnpm --filter @ember/worker exec wrangler dev -c ../../wrangler.jsonc --ip 127.0.0.1 --port ${SETTINGS_SERVER_PORT} --local-protocol https`,
          `--var SESSION_SECRET:e2e-only-not-a-secret --var EMBER_SETUP_TOKEN:${SETUP_TOKEN}`,
          `--var RESEND_API_URL:http://127.0.0.1:${RESEND_API_PORT} --var TURNSTILE_SITEVERIFY_URL:http://127.0.0.1:${SITEVERIFY_PORT}`,
          `--var AI_GATEWAY_URL:http://127.0.0.1:${AI_GATEWAY_PORT} --var CLOUDFLARE_ACCOUNT_ID:${AI_GATEWAY_ACCOUNT.accountId}`,
          `--var EMBER_MODELS_URL:http://127.0.0.1:${AI_GATEWAY_PORT}/models.json --var REALTIME_SFU_URL:http://127.0.0.1:${SFU_PORT}`,
          "--persist-to ../../e2e/.wrangler/settings-state",
        ].join(" "),
      ].join(" && "),
      cwd: path.resolve(import.meta.dirname, ".."),
      url: `https://127.0.0.1:${SETTINGS_SERVER_PORT}/api/health`,
      ignoreHTTPSErrors: true,
      env: { WRANGLER_SEND_METRICS: "false" },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});

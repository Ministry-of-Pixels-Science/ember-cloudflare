import { devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";

// Tests that change the whole workspace, such as its name, which every other suite's pages show.
// They have a second test server, which the first-run spec sets up as it does the main one, so the
// main test server's workspace stays as the other suites expect it, and take turns, since one
// regenerating the join link would stop another's new person joining through it.

export const SETTINGS_SERVER_PORT = Number(process.env.E2E_SETTINGS_PORT ?? 8789);
/** Where the Memberful site the Memberful specs fake listens. */
export const MEMBERFUL_SITE_PORT = Number(process.env.E2E_MEMBERFUL_PORT ?? 8790);
/** That site's address, which the Memberful specs give Ember in Set up Memberful. */
export const MEMBERFUL_SITE = `http://127.0.0.1:${MEMBERFUL_SITE_PORT}`;
/** The keys of that site's custom app and webhook, which the specs give Ember with it, and which the site checks. None is a secret. */
export const MEMBERFUL_KEYS = {
  clientId: "e2e",
  clientSecret: "e2e-only-not-a-secret",
  apiKey: "e2e-only-not-an-api-key",
  webhookSecret: "e2e-only-not-a-webhook-secret",
};
/** Where the Resend API the email specs fake listens, which the second server's RESEND_API_URL names. */
export const RESEND_API_PORT = Number(process.env.E2E_RESEND_PORT ?? 8791);
/** The Resend API key that API takes, which the email specs give Ember. It isn't a secret. */
export const RESEND_KEY = "re_e2e-only-not-a-key";
/** Where the siteverify the Turnstile spec fakes listens, which the second server's TURNSTILE_SITEVERIFY_URL names. */
export const SITEVERIFY_PORT = Number(process.env.E2E_SITEVERIFY_PORT ?? 8792);
/** Where the AI Gateway the Ember AI spec fakes listens, which the second server's AI_GATEWAY_URL names. */
export const AI_GATEWAY_PORT = Number(process.env.E2E_AI_GATEWAY_PORT ?? 8793);
/** The Cloudflare account that AI Gateway knows, and its API token, which the Ember AI spec gives Ember. Neither is real. */
export const AI_GATEWAY_ACCOUNT = { accountId: "e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0", apiToken: "e2e-only-not-a-cloudflare-api-token" };
/** Where the Realtime SFU the huddles spec fakes listens, which the second server's REALTIME_SFU_URL names. */
export const SFU_PORT = Number(process.env.E2E_SFU_PORT ?? 8794);
/** The SFU app that SFU knows, by its ID and its secret, which the huddles spec gives Ember. Neither is real. */
export const SFU_APP = { appId: "ca11".repeat(8), appSecret: "e2e0".repeat(16) };
/** The TURN key it knows as Cloudflare's TURN service, by its ID and its API token, which the huddles spec gives Ember too. Neither is real. */
export const TURN_KEY = { keyId: "7e1a".repeat(8), apiToken: "e2e-only-not-a-turn-key-api-token" };
/** The port the relay's servers it makes for that key are at, on this machine, where nothing listens. */
export const TURN_PORT = Number(process.env.E2E_TURN_PORT ?? 8795);
/** The project that sets the second server up. */
export const SETTINGS_FIRST_RUN = "workspace-settings-first-run";

/** A desktop Chromium on the second server, which is served over HTTPS, as a deployment is. */
const ON_SETTINGS_SERVER: Project<PlaywrightTestOptions, PlaywrightWorkerOptions>["use"] = {
  ...devices["Desktop Chrome"],
  browserName: "chromium",
  baseURL: `https://127.0.0.1:${SETTINGS_SERVER_PORT}`,
  // `wrangler dev` serves HTTPS with a certificate of its own making. Chromium's own flag accepts
  // it during the handshake, rather than refusing it first, which the server would log as an error.
  ignoreHTTPSErrors: true,
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: [
      "--ignore-certificate-errors",
      // For the huddles spec: microphones that beep, speakers, and three cameras with a made-up picture, which a page
      // may use without asking anyone. The second camera's picture is a depth camera's, which no connection sends.
      "--use-fake-device-for-media-stream=device-count=3",
      "--use-fake-ui-for-media-stream",
    ],
  },
};

export const workspaceSettingsProjects: Project<PlaywrightTestOptions, PlaywrightWorkerOptions>[] = [
  { name: SETTINGS_FIRST_RUN, testDir: "./tests/first-run", use: ON_SETTINGS_SERVER },
  {
    name: "workspace-settings",
    testDir: "./tests/workspace-settings",
    fullyParallel: false,
    workers: 1,
    dependencies: [SETTINGS_FIRST_RUN],
    use: ON_SETTINGS_SERVER,
  },
];

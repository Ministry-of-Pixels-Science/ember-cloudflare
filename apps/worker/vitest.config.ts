import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readdir, readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

// The Worker's suite runs inside workerd once per storage backend; the deploy scripts' tests run in Node.
const migrations = await readD1Migrations("./migrations");
const searchMigrations = await readD1Migrations("./search-migrations");
// The recorded images (test/fixtures/README.md), as Base64, since workerd can't read the disk.
const storageFiles = "./test/fixtures/storage";
const recordedImages = Object.fromEntries(
  await Promise.all((await readdir(storageFiles)).map(async (name) => [name, (await readFile(`${storageFiles}/${name}`)).toString("base64")])),
);

// A test gets 15 seconds where vitest allows 5: the slowest take 3, as one that checks a dozen passwords
// does, each a quarter of a second of scrypt, and a runner can take twice as long as it usually does.
const TEST_TIMEOUT_MS = 15_000;

const backend = (name: "do-sqlite" | "d1") => ({
  extends: true as const,
  test: { name, include: ["test/**/*.test.ts"], setupFiles: ["./test/waits.ts", ...(name === "d1" ? ["./test/apply-migrations.ts"] : [])], testTimeout: TEST_TIMEOUT_MS },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          SESSION_SECRET: "test-secret",
          STORAGE_BACKEND: name,
          EMBER_GUEST_SIGN_IN: "true",
          // No models file but the one Ember shipped with, unless a test serves one (assistant/offered.ts).
          EMBER_MODELS_URL: "",
          // The deploy's setup token, which test/support.ts's `api` sends to set Ember up.
          EMBER_SETUP_TOKEN: "fedcba9876543210".repeat(4),
          // The test keys the recorded push was signed with (test/fixtures/README.md), so push is on
          // unless a test turns it off.
          VAPID_PUBLIC_KEY: "BEYXTBB5_jNhNzXDmx5KEU55Vbbd-u--Lk9rM5OFQvUkPIBwZJ9QzAq0zdEzFw6yTV8cTriz_qYBVicY02_VxTQ=",
          VAPID_PRIVATE_KEY: "qfXLHghuG1rSHZUVo9SscNRI-0EIHRbIrfeGCqbAwak=",
          TEST_MIGRATIONS: migrations,
          TEST_SEARCH_MIGRATIONS: searchMigrations,
          TEST_RECORDED_IMAGES: recordedImages,
        },
        d1Databases: name === "d1" ? ["DB"] : [],
      },
    }),
  ],
});

export default defineConfig({
  test: {
    projects: [backend("do-sqlite"), backend("d1"), { test: { name: "scripts", include: ["scripts/**/*.test.ts"], environment: "node" } }],
    // The Worker goes on working once it has answered, as a room does sending the search index what was
    // just posted, and no test waits for that. When a test file ends while such work calls a Durable
    // Object, vitest refuses what the call still asks of it and counts that as an error
    // (EnvironmentTeardownError), which fails a run whose every test passed. It says nothing of what the
    // tests checked, so it isn't counted; any other error nothing caught still is.
    onUnhandledError: (error) => error.name !== "EnvironmentTeardownError",
  },
});

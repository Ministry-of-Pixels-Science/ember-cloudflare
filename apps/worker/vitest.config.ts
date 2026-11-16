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

const backend = (name: "do-sqlite" | "d1") => ({
  extends: true as const,
  test: { name, include: ["test/**/*.test.ts"], setupFiles: name === "d1" ? ["./test/apply-migrations.ts"] : [] },
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
  },
});

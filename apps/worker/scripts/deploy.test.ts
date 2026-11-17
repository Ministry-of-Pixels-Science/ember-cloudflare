import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataOf } from "./jsonc.ts";

const SCRIPT = fileURLToPath(new URL("./deploy.ts", import.meta.url));
const SECRET = /^[0-9a-f]{64}$/;
/** The secrets a Worker deployed before has. */
const EVERY_SECRET = ["SESSION_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "EMBER_SETUP_TOKEN"];
/** The address wrangler's record of the deploy names, as the fake wrangler below writes it. */
const WORKER_URL = "https://ember.example.workers.dev";
/** The setup link the deploy prints, ending in the token `token`, at the Worker's address or where one is unknown. */
const setupLink = (token: string, url = WORKER_URL) => `Set up Ember at ${url}/first_run#token=${token}`;

/** What `wrangler secret list` finds: the names of the Worker's secrets, no Worker yet, or a failure. */
type Listing = string[] | "no worker" | "error";

/**
 * Stands in for `pnpm exec wrangler`, noting each command in $OUT/calls: `secret list` answers as $LISTING
 * says, `whoami --json` answers $WHOAMI, the user and the accounts their credentials reach, or that nobody's
 * signed in without it, and `deploy` keeps what it was given in $OUT (its options, its secrets file's path,
 * mode and contents, and the config it names), records the deploy's targets, $TARGETS, as wrangler does, in
 * $WRANGLER_OUTPUT_FILE_PATH, unless $NO_URL says there's no record, and exits with $DEPLOY_STATUS. `d1`
 * commands, noted in $OUT/d1-calls too, find the account's databases in $D1_DATABASES, and the one bound
 * as DB as $D1_STATE says, "fresh", "migrated" or "set up", and apply migrations with $MIGRATIONS_STATUS.
 * The Worker's current deployment binds the D1 database $BOUND_D1 as DB, if it's set, unless
 * $DEPLOYMENTS_STATUS says reading it fails.
 */
const PNPM = `#!/usr/bin/env bash
[ "$1 $2" = "exec wrangler" ] || { echo "unexpected: $*" >&2; exit 2; }
shift 2
echo "$*" >> "$OUT/calls"
if [ "$1" = "d1" ]; then
  echo "$*" >> "$OUT/d1-calls"
  case "$2" in
    list) echo "\${D1_DATABASES:-[]}" ;;
    create) echo "Created $3" ;;
    execute)
      case "$*" in
        *sqlite_master*) [ "\${D1_STATE:-fresh}" = fresh ] && echo '[{"results":[]}]' || echo '[{"results":[{"name":"accounts"}]}]' ;;
        *) [ "$D1_STATE" = "set up" ] && echo '[{"results":[{"set_up":1}]}]' || echo '[{"results":[{"set_up":0}]}]' ;;
      esac ;;
    migrations) echo "CI=$CI" >> "$OUT/d1-calls"; exit "\${MIGRATIONS_STATUS:-0}" ;;
    *) echo "unexpected: $*" >&2; exit 2 ;;
  esac
elif [ "$1 $2" = "deployments status" ]; then
  [ -z "$DEPLOYMENTS_STATUS" ] || { echo "✘ [ERROR] A request to the Cloudflare API failed." >&2; exit 1; }
  echo '{"versions":[{"version_id":"0a1b2c3d","percentage":100}]}'
elif [ "$1 $2" = "versions view" ]; then
  if [ -n "$BOUND_D1" ]; then echo '{"resources":{"bindings":[{"type":"d1","name":"DB","id":"'"$BOUND_D1"'"}]}}'; else echo '{"resources":{"bindings":[]}}'; fi
elif [ "$1 $2" = "whoami --json" ]; then
  echo "$*" > "$OUT/whoami-args"
  if [ -z "$WHOAMI" ]; then echo; echo '{"loggedIn":false}'; exit 1; fi
  echo; echo "$WHOAMI"
elif [ "$1 $2" = "secret list" ]; then
  echo "$*" > "$OUT/list-args"
  case "$LISTING" in
    "no worker") echo "✘ [ERROR] A request to the Cloudflare API failed." >&2; echo 'Worker "ember" not found. [code: 10007]' >&2; exit 1 ;;
    error) echo "✘ [ERROR] Authentication error [code: 10000]" >&2; exit 1 ;;
    *) echo "$LISTING" ;;
  esac
elif [ "$1 $2" = "deploy --secrets-file" ]; then
  echo "$3" > "$OUT/secrets-path"
  { stat -c %a "$3" 2>/dev/null || stat -f %Lp "$3"; } > "$OUT/secrets-mode"
  cp "$3" "$OUT/secrets.json"
  shift 3
  echo "$*" > "$OUT/deploy-args"
  previous=""
  for arg in "$@"; do
    [ "$previous" = "--config" ] && cp "$arg" "$OUT/deploy-config.json"
    previous="$arg"
  done
  echo "Deployed ember"
  if [ -n "$WRANGLER_OUTPUT_FILE_PATH" ] && [ -z "$NO_URL" ]; then
    echo '{"version":1,"type":"deploy","targets":'"$TARGETS"'}' >> "$WRANGLER_OUTPUT_FILE_PATH"
  fi
  exit "\${DEPLOY_STATUS:-0}"
else
  echo "unexpected: $*" >&2; exit 2
fi
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deploy-"));
  writeFileSync(path.join(dir, "pnpm"), PNPM, { mode: 0o755 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const output = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8").trim() : null);

/** Has the script take its output for a terminal's, which the suite reads through a pipe. */
const AT_TERMINAL = ["--import", "data:text/javascript,process.stdout.isTTY=true"];

/**
 * Runs the script, or `script`, with `args` for a Worker whose secrets are `listing`, in a shell like a
 * terminal's unless `env` says it's CI's, Workers Builds' or GitHub Actions', or brings a setup token. Its
 * output is a terminal's there, and a log's in CI, unless `terminal` says otherwise.
 */
function deploy(
  listing: Listing,
  args: string[] = [],
  { deployStatus = 0, env = {}, script = SCRIPT, terminal = !env.CI }: { deployStatus?: number; env?: Record<string, string>; script?: string; terminal?: boolean } = {},
) {
  const LISTING = Array.isArray(listing) ? JSON.stringify(listing.map((name) => ({ name, type: "secret_text" }))) : listing;
  // The suite itself runs under CI, which the script must hear only from the test.
  const {
    CI: _ci,
    GITHUB_ACTIONS: _actions,
    WORKERS_CI: _workers,
    WORKERS_CI_BRANCH: _branch,
    EMBER_SETUP_TOKEN: _token,
    EMBER_SETUP_PASSWORD: _password,
    WRANGLER_OUTPUT_FILE_PATH: _output,
    MEMBERFUL_URL: _site,
    MEMBERFUL_CLIENT_ID: _client,
    MEMBERFUL_CLIENT_SECRET: _secret,
    MEMBERFUL_API_KEY: _apiKey,
    MEMBERFUL_WEBHOOK_SECRET: _webhookSecret,
    TURNSTILE_SITE_KEY: _siteKey,
    TURNSTILE_SECRET_KEY: _turnstileSecret,
    RESEND_API_KEY: _resendKey,
    CLOUDFLARE_ACCOUNT_ID: _accountId,
    EMBER_ADOPT_D1_DATABASE: _adopted,
    GIT_DIR: _gitDir,
    ...shell
  } = process.env;
  // The script reads git's origin, which for this repository's own script would be the origin of whichever clone runs the suite, so git there finds no repository.
  const git = script === SCRIPT ? { GIT_DIR: path.join(dir, "no-repository") } : {};
  const run = spawnSync(process.execPath, [...(terminal ? AT_TERMINAL : []), script, ...args], {
    env: { ...shell, ...git, PATH: `${dir}:${process.env.PATH}`, LISTING, OUT: dir, DEPLOY_STATUS: String(deployStatus), TARGETS: JSON.stringify([WORKER_URL]), ...env },
    encoding: "utf8",
  });
  const secrets = output("secrets.json");
  return {
    status: run.status,
    logs: run.stdout + run.stderr,
    deployed: output("deploy-args") !== null,
    secrets: secrets === null ? null : (JSON.parse(secrets) as Record<string, string>),
  };
}

describe("Deploy secrets", () => {
  it("makes the secrets for a Worker's first deploy, readable only by the deploy, and never prints them", () => {
    const { status, secrets, logs } = deploy("no worker");
    expect(status).toBe(0);
    expect(secrets).toEqual({
      SESSION_SECRET: expect.stringMatching(SECRET),
      VAPID_PUBLIC_KEY: expect.stringMatching(/^B[\w-]{86}$/),
      VAPID_PRIVATE_KEY: expect.stringMatching(/^[\w-]{43}$/),
      EMBER_SETUP_TOKEN: expect.stringMatching(SECRET),
    });
    expect(output("secrets-mode")).toBe("600");
    // Cloudflare's build logs mask nothing, so no secret may appear in them, not even masked; the
    // setup token is the one meant to be read, and goes in its link.
    for (const secret of [secrets!.SESSION_SECRET!, secrets!.VAPID_PRIVATE_KEY!]) expect(logs).not.toContain(secret);
    expect(logs).toContain("Deploying with new SESSION_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, EMBER_SETUP_TOKEN");
  });

  it("removes the secrets file once wrangler has deployed", () => {
    deploy("no worker");
    expect(existsSync(output("secrets-path")!)).toBe(false);
  });

  it("keeps the secrets the Worker has, so nobody is signed out or loses their push subscriptions", () => {
    const { status, secrets } = deploy(EVERY_SECRET);
    expect(status).toBe(0);
    expect(secrets).toEqual({});
  });

  it("stops when it can't list the Worker's secrets, rather than replacing them", () => {
    const { status, deployed, logs } = deploy("error");
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(logs).toContain("Authentication error");
  });

  it("passes its options to wrangler deploy, and the Worker's name to the secrets it lists", () => {
    deploy(EVERY_SECRET, ["--name", "ember-production", "--var", "GIT_REVISION:abc1234"]);
    expect(output("list-args")).toBe("secret list --name ember-production");
    expect(output("deploy-args")).toMatch(/^--name ember-production --var GIT_REVISION:abc1234 --config wrangler\.\d+\.deploy\.json$/);
  });

  it.each([
    [["--config", "wrangler.production.jsonc"], "secret list --config wrangler.production.jsonc"],
    [["-c=wrangler.production.jsonc", "--name", "ember-production", "--var", "A:b"], "secret list -c=wrangler.production.jsonc --name ember-production"],
  ])("lists the secrets of the Worker another config picks, as it deploys that one (%j)", (args, listed) => {
    deploy(EVERY_SECRET, args);
    expect(output("list-args")).toBe(listed);
    expect(output("deploy-args")).toBe(args.join(" "));
  });

  it.each([["--env", "staging"], ["-e=staging"]])("refuses an environment, which wrangler.jsonc doesn't have, before deploying (%j)", (...args) => {
    const { status, deployed, logs } = deploy(EVERY_SECRET, args);
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(output("list-args")).toBeNull();
    expect(logs).toContain("no environments");
  });

  it("lists the secrets of the Worker wrangler.jsonc names when it's given no name, as Deploy to Cloudflare runs it", () => {
    deploy(EVERY_SECRET);
    expect(output("list-args")).toBe("secret list");
  });

  it("fails when wrangler deploy does", () => {
    const { status } = deploy(EVERY_SECRET, [], { deployStatus: 1 });
    expect(status).toBe(1);
  });
});

describe("Installer-protected setup link", () => {
  const withoutSetupToken = EVERY_SECRET.filter((name) => name !== "EMBER_SETUP_TOKEN");

  it("makes a setup token for a Worker that has none, and prints the setup link that carries it, once wrangler has deployed", () => {
    const { status, secrets, logs } = deploy(withoutSetupToken);
    expect(status).toBe(0);
    expect(secrets).toEqual({ EMBER_SETUP_TOKEN: expect.stringMatching(SECRET) });
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!));
    expect(logs).toContain("printed only now");
    // A new token is made where the person sees it, then given to `wrangler secret put`, which asks for it: a pipe would hide it.
    expect(logs).toContain("make one with openssl rand -hex 32, give it to the Worker with pnpm exec wrangler secret put EMBER_SETUP_TOKEN, which asks for it");
    expect(logs).not.toContain("openssl rand -hex 32 |");
  });

  it("names the Worker deployed in how to make a new token, so it doesn't go to wrangler.jsonc's", () => {
    const { logs } = deploy(withoutSetupToken, ["--name", "ember-production", "--config=../wrangler.jsonc", "--var", "GIT_REVISION:abc1234"]);
    expect(logs).toContain("pnpm exec wrangler secret put EMBER_SETUP_TOKEN --name ember-production --config=../wrangler.jsonc, which asks for it");
  });

  it("reads this deploy's address from an output file that wrangler appended earlier deploys' records to", () => {
    const outputFile = path.join(dir, "kept-output.json");
    writeFileSync(outputFile, `${JSON.stringify({ version: 1, type: "deploy", targets: ["https://earlier.example.workers.dev"] })}\n`);
    const { secrets, logs } = deploy(withoutSetupToken, [], { env: { WRANGLER_OUTPUT_FILE_PATH: outputFile } });
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!));
    expect(logs).not.toContain("earlier.example");
    // And left the file for the environment that keeps it, with this deploy's record after the earlier one.
    expect(readFileSync(outputFile, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("keeps the setup token a Worker has, and says nothing of a link it can't know", () => {
    const { status, secrets, logs } = deploy(EVERY_SECRET);
    expect(status).toBe(0);
    expect(secrets).toEqual({});
    expect(logs).not.toContain("Set up Ember");
  });

  it("prints no link when wrangler fails to deploy", () => {
    const { status, logs } = deploy("no worker", [], { deployStatus: 1 });
    expect(status).toBe(1);
    expect(logs).not.toContain("Set up Ember");
  });

  it("names the Worker where wrangler recorded no address, rather than guessing one", () => {
    const { secrets, logs } = deploy(withoutSetupToken, [], { env: { NO_URL: "1" } });
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!, "https://<your Worker>"));
  });

  // wrangler records routes and custom domains as their patterns with notes, and queues and workflows in words.
  it.each([
    ["a custom domain", ["chat.example.com (custom domain - zone name: example.com)"], "https://chat.example.com"],
    ["a zone's route, among targets that aren't addresses", ["Producer for jobs", "example.com/* (zone id: 0123abcd)", "workflow: nightly"], "https://example.com"],
    ["the workers.dev address, before a custom domain", ["chat.example.com (custom domain)", "https://ember.example.workers.dev/"], WORKER_URL],
  ])("makes the setup link at %s", (_, targets, origin) => {
    const { secrets, logs } = deploy(withoutSetupToken, [], { env: { TARGETS: JSON.stringify(targets) } });
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!, origin));
  });

  it("names the Worker rather than a route Ember can't be opened at: one under a path, or on a wildcard host", () => {
    const targets = ["*.example.com/* (zone name: example.com)", "example.com/chat/* (zone name: example.com)", "...and 3 more routes"];
    const { secrets, logs } = deploy(withoutSetupToken, [], { env: { TARGETS: JSON.stringify(targets) } });
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!, "https://<your Worker>"));
  });

  it("takes the setup token the environment brings, and prints the link's shape without it, since its holder knows it", () => {
    const token = "ab".repeat(32);
    const { status, secrets, logs } = deploy(withoutSetupToken, [], { env: { EMBER_SETUP_TOKEN: ` ${token}\n` } });
    expect(status).toBe(0);
    expect(secrets).toEqual({ EMBER_SETUP_TOKEN: token });
    expect(logs).toContain(`Set up Ember at ${WORKER_URL}/first_run#token=<your EMBER_SETUP_TOKEN>`);
    expect(logs).not.toContain(token);
  });

  it.each(["hunter2", "AB".repeat(32), `${"ab".repeat(32)}0`])("refuses a setup token from the environment that can't be one (%j), before deploying", (token) => {
    const { status, deployed, logs } = deploy(withoutSetupToken, [], { env: { EMBER_SETUP_TOKEN: token } });
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(logs).toContain("EMBER_SETUP_TOKEN must be 64 lowercase hex characters");
  });

  it("ignores a setup token from the environment, whatever its shape, for a Worker that has one", () => {
    const { status, secrets } = deploy(EVERY_SECRET, [], { env: { EMBER_SETUP_TOKEN: "hunter2" } });
    expect(status).toBe(0);
    expect(secrets).toEqual({});
  });

  it("makes no setup token where the log may be public, as a CI's is, and says what to do instead", () => {
    const { status, secrets, logs } = deploy("no worker", [], { env: { CI: "true" } });
    expect(status).toBe(0);
    expect(secrets).toEqual({ SESSION_SECRET: expect.any(String), VAPID_PUBLIC_KEY: expect.any(String), VAPID_PRIVATE_KEY: expect.any(String) });
    expect(logs).not.toContain("Set up Ember at");
    expect(logs).toContain("this log may be public, so this deploy made no token");
    expect(logs).toContain(`Give it a setup password with pnpm exec wrangler secret put EMBER_SETUP_PASSWORD, which asks for it, and open ${WORKER_URL}/first_run;`);
    expect(logs).toContain(`${WORKER_URL}/first_run#token=<your EMBER_SETUP_TOKEN>`);
    expect(logs).toContain(`pnpm exec wrangler secret put EMBER_SETUP_TOKEN, which asks for it, and open ${WORKER_URL}/first_run#token=<the token>`);
    expect(logs).not.toContain("::notice::");
  });

  it("makes none where its output isn't a terminal's, as the log of a CI that doesn't say it's one isn't", () => {
    const { status, secrets, logs } = deploy("no worker", [], { terminal: false });
    expect(status).toBe(0);
    expect(secrets).not.toHaveProperty("EMBER_SETUP_TOKEN");
    expect(logs).not.toContain("Set up Ember at");
    expect(logs).toContain("this log may be public, so this deploy made no token");
  });

  it("makes none in a CI that gives it a terminal, either", () => {
    const { secrets, logs } = deploy("no worker", [], { env: { CI: "true" }, terminal: true });
    expect(secrets).not.toHaveProperty("EMBER_SETUP_TOKEN");
    expect(logs).not.toContain("Set up Ember at");
    expect(logs).toContain("this log may be public, so this deploy made no token");
  });

  it("says so as a notice under GitHub Actions, where it shows on the run", () => {
    const { logs } = deploy("no worker", [], { env: { CI: "true", GITHUB_ACTIONS: "true" } });
    expect(logs).toMatch(/^::notice::Nobody can set Ember up until the Worker has a setup password or an EMBER_SETUP_TOKEN secret/m);
  });

  it("takes the token a CI's environment brings, and keeps it out of the log", () => {
    const token = "cd".repeat(32);
    const { secrets, logs } = deploy("no worker", [], { env: { CI: "true", GITHUB_ACTIONS: "true", EMBER_SETUP_TOKEN: token } });
    expect(secrets!.EMBER_SETUP_TOKEN).toBe(token);
    expect(logs).toContain(`Set up Ember at ${WORKER_URL}/first_run#token=<your EMBER_SETUP_TOKEN>`);
    expect(logs).not.toContain(token);
  });

  it("prints the link under Workers Builds, whose log is the account's own, as Deploy to Cloudflare runs it", () => {
    const { secrets, logs } = deploy("no worker", [], { env: { CI: "true", WORKERS_CI: "1" } });
    expect(secrets!.EMBER_SETUP_TOKEN).toMatch(SECRET);
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!));
  });
});

describe("Setup password", () => {
  const PASSWORD = "correct horse battery staple";
  /** What the deploy says of setting Ember up with its setup password. */
  const withPassword = (url = WORKER_URL) => `Set up Ember at ${url}/first_run with its setup password, EMBER_SETUP_PASSWORD.`;

  it("makes no setup token for a Worker Deploy to Cloudflare's form gave a setup password, and says to set Ember up with it", () => {
    const { status, secrets, logs } = deploy(["EMBER_SETUP_PASSWORD"]);
    expect(status).toBe(0);
    expect(secrets).toEqual({ SESSION_SECRET: expect.stringMatching(SECRET), VAPID_PUBLIC_KEY: expect.any(String), VAPID_PRIVATE_KEY: expect.any(String) });
    expect(logs).toContain(withPassword());
    expect(logs).toContain("in the Worker's Settings under Variables and Secrets, or with pnpm exec wrangler secret put EMBER_SETUP_PASSWORD, which asks for it");
    expect(logs).not.toContain("#token=");
  });

  it("says nothing of setup on a later deploy, by which Ember may well be set up", () => {
    const { status, secrets, logs } = deploy([...EVERY_SECRET.filter((name) => name !== "EMBER_SETUP_TOKEN"), "EMBER_SETUP_PASSWORD"]);
    expect(status).toBe(0);
    expect(secrets).toEqual({});
    expect(logs).not.toContain("Set up Ember");
  });

  it.each([
    ["a terminal", {}],
    ["a CI whose log may be public", { CI: "true", GITHUB_ACTIONS: "true" }],
  ])("takes the setup password the environment brings in %s, without spaces around it, and keeps it out of the log", (_, env) => {
    const { status, secrets, logs } = deploy("no worker", ["--name", "ember-production"], { env: { ...env, EMBER_SETUP_PASSWORD: ` ${PASSWORD}\n` } });
    expect(status).toBe(0);
    expect(secrets).toEqual({ SESSION_SECRET: expect.any(String), VAPID_PUBLIC_KEY: expect.any(String), VAPID_PRIVATE_KEY: expect.any(String), EMBER_SETUP_PASSWORD: PASSWORD });
    expect(logs).toContain(withPassword());
    expect(logs).toContain("pnpm exec wrangler secret put EMBER_SETUP_PASSWORD --name ember-production, which asks for it");
    expect(logs).not.toContain("horse");
    expect(logs).not.toContain("::notice::");
  });

  it("keeps the setup password a Worker has over one the environment brings", () => {
    const { secrets } = deploy(["EMBER_SETUP_PASSWORD"], [], { env: { EMBER_SETUP_PASSWORD: PASSWORD } });
    expect(secrets).not.toHaveProperty("EMBER_SETUP_PASSWORD");
  });

  it("takes a setup password of any length from the environment, as the Worker does", () => {
    const { status, secrets, logs } = deploy("no worker", [], { env: { EMBER_SETUP_PASSWORD: "ünicode" } });
    expect(status).toBe(0);
    expect(secrets!.EMBER_SETUP_PASSWORD).toBe("ünicode");
    expect(logs).toContain(withPassword());
    expect(logs).not.toContain("ünicode");
  });

  it("makes a setup token, as without a password, where the environment's is blank", () => {
    const { secrets, logs } = deploy("no worker", [], { env: { EMBER_SETUP_PASSWORD: "  " } });
    expect(secrets!.EMBER_SETUP_TOKEN).toMatch(SECRET);
    expect(secrets).not.toHaveProperty("EMBER_SETUP_PASSWORD");
    expect(logs).toContain(setupLink(secrets!.EMBER_SETUP_TOKEN!));
  });
});

describe("Deploy to Cloudflare's form", () => {
  const ofEmber = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
  /** The secrets the form asks a deployer for: the lines of .dev.vars.example that aren't commented. */
  const asked = ofEmber(".dev.vars.example")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
  const { bindings } = JSON.parse(ofEmber("package.json")).cloudflare as { bindings: Record<string, { description: string }> };

  it("asks only for the setup password, since it won't deploy until every field it shows is filled in", () => {
    expect(asked).toEqual(["EMBER_SETUP_PASSWORD"]);
  });

  it("describes what it asks for in under 200 characters, as it leaves out a longer description", () => {
    for (const name of asked) expect(bindings[name]?.description).toBeTruthy();
    const tooLong = Object.entries(bindings).filter(([, { description }]) => description.length >= 200);
    expect(tooLong.map(([name]) => name)).toEqual([]);
  });

  it("describes each bucket and database it makes, and where messages live, which says whether the database is used", () => {
    const settings = dataOf(ofEmber("wrangler.jsonc")) as { r2_buckets: { binding: string }[]; d1_databases: { binding: string }[] };
    const made = [...settings.r2_buckets, ...settings.d1_databases].map(({ binding }) => binding);
    expect(made).toEqual(["FILES", "DB"]);
    for (const name of [...made, "STORAGE_BACKEND"]) expect(bindings[name]?.description).toBeTruthy();
  });
});

describe("Where messages live", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  /** A D1 database as Ember's wrangler.jsonc binds it, and as Deploy to Cloudflare writes it into a copy, with the id of the one it made. */
  const DATABASE = { binding: "DB", database_name: "ember", migrations_dir: "apps/worker/migrations" };
  const MADE = { ...DATABASE, database_id: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a98765432" };

  /** The options that deploy a copy's wrangler.jsonc, made in the test's folder, keeping messages in `backend`, with `databases`. */
  function copysConfig(backend: string, databases: object[] = [MADE]): string[] {
    const file = path.join(dir, "wrangler.jsonc");
    writeFileSync(file, `// A copy's settings.\n${JSON.stringify({ name: "ember", vars: { STORAGE_BACKEND: backend }, d1_databases: databases }, null, 2)}\n`);
    return ["--config", file];
  }

  /** The configs the deploy wrote for wrangler and left beside Ember's own. */
  const leftConfigs = () => readdirSync(ROOT).filter((name) => name.endsWith(".deploy.json"));

  /** The commands the deploy gave wrangler, in order, each by its first two words, but for `whoami`, which only finds the account's ID. */
  const commands = () =>
    (output("calls") ?? "")
      .split("\n")
      .map((line) => line.split(" ").slice(0, 2).join(" "))
      .filter((command) => command !== "whoami --json");

  it("deploys a Worker on DO SQLite without the D1 database the form made, which only d1 uses, and leaves no config behind", () => {
    const { status } = deploy(EVERY_SECRET);
    expect(status).toBe(0);
    const { d1_databases, ...rest } = dataOf(readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    expect(d1_databases).toEqual([DATABASE]);
    // Named for this deploy alone, so a deploy run beside it from the same checkout keeps its own.
    expect(output("deploy-args")).toMatch(/^--config wrangler\.\d+\.deploy\.json$/);
    expect(JSON.parse(output("deploy-config.json")!)).toEqual(rest);
    expect(leftConfigs()).toEqual([]);
    expect(commands()).toEqual(["secret list", "deploy --secrets-file"]);
  });

  it("removes the config it deployed from when wrangler fails to deploy, too", () => {
    deploy(EVERY_SECRET, [], { deployStatus: 1 });
    expect(output("deploy-config.json")).not.toBeNull();
    expect(leftConfigs()).toEqual([]);
  });

  it("deploys a config that binds no D1 database as it is", () => {
    const options = copysConfig("do-sqlite", []);
    deploy(EVERY_SECRET, options);
    expect(output("deploy-args")).toBe(options.join(" "));
  });

  it.each(["D1", "sqlite", ""])("refuses STORAGE_BACKEND %j, which the Worker would take for do-sqlite, before listing secrets or deploying", (backend) => {
    const { status, deployed, logs } = deploy(EVERY_SECRET, copysConfig(backend));
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(output("calls")).toBeNull();
    expect(logs).toContain(`STORAGE_BACKEND must be "do-sqlite" or "d1", not ${JSON.stringify(backend)}`);
  });

  it("applies Ember's migrations to a copy's D1 database before deploying the Worker that reads it, from the config as it is", () => {
    const options = copysConfig("d1");
    const { status } = deploy("no worker", options);
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "d1 execute", "d1 migrations", "deploy --secrets-file"]);
    // In CI, which answers wrangler's question before it applies them.
    expect(output("d1-calls")).toContain(`d1 migrations apply DB --remote --config ${options[1]}\nCI=true`);
    expect(output("deploy-args")).toBe(options.join(" "));
  });

  it("makes the D1 database a config names without an id, where the account has none of that name", () => {
    const options = copysConfig("d1", [DATABASE]);
    const { status, logs } = deploy("no worker", options);
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "d1 list", "d1 create", "d1 migrations", "deploy --secrets-file"]);
    expect(output("d1-calls")).toContain(`d1 create ember --no-update-config --config ${options[1]}`);
    expect(logs).toContain("Making the D1 database ember, which keeps this Ember's messages");
  });

  it("uses the account's D1 database of the name a config gives, as wrangler deploy binds it", () => {
    const D1_DATABASES = JSON.stringify([
      { name: "ember-other", uuid: "11111111-2222-4333-8444-555555555555" },
      { name: "ember", uuid: MADE.database_id },
    ]);
    const { status } = deploy("no worker", copysConfig("d1", [DATABASE]), { env: { D1_DATABASES } });
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "d1 list", "d1 execute", "d1 migrations", "deploy --secrets-file"]);
  });

  it("refuses a D1 database another Ember is set up in for a new Worker, before migrating it or deploying", () => {
    const { status, deployed, logs } = deploy("no worker", copysConfig("d1"), { env: { D1_STATE: "set up" } });
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(commands()).toEqual(["secret list", "d1 execute", "d1 execute"]);
    expect(logs).toContain("An Ember is already set up in the D1 database ember, which this Worker isn't bound to. Two Embers can't share a database");
    expect(logs).toContain("set EMBER_ADOPT_D1_DATABASE to its name in the deploy's environment, and deploy again");
  });

  it("refuses one for a Worker deployed before that isn't bound to it, as one on DO SQLite is bound to none", () => {
    const { status, deployed, logs } = deploy(EVERY_SECRET, copysConfig("d1"), { env: { D1_STATE: "set up" } });
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(commands()).toEqual(["secret list", "deployments status", "versions view", "d1 execute", "d1 execute"]);
    expect(logs).toContain("which this Worker isn't bound to");
  });

  it.each([
    ["name", "ember", 0],
    ["id", MADE.database_id, 0],
    ["name, when it's another database's", "ember-other", 1],
  ])("takes one the deploy's environment names, by its %s, as this Ember's own", (_, adopted, deployStatus) => {
    const { status } = deploy("no worker", copysConfig("d1"), { env: { D1_STATE: "set up", EMBER_ADOPT_D1_DATABASE: adopted } });
    expect(status).toBe(deployStatus);
  });

  it("takes a D1 database that's migrated but not set up, as a first deploy that failed after migrating leaves it", () => {
    const { status } = deploy("no worker", copysConfig("d1"), { env: { D1_STATE: "migrated" } });
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "d1 execute", "d1 execute", "d1 migrations", "deploy --secrets-file"]);
  });

  it("migrates the database a Worker deployed before is bound to without asking whether an Ember is set up in it, as its own is", () => {
    const { status } = deploy(EVERY_SECRET, copysConfig("d1"), { env: { D1_STATE: "set up", BOUND_D1: MADE.database_id } });
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "deployments status", "versions view", "d1 migrations", "deploy --secrets-file"]);
  });

  it("stops where it can't tell which D1 database a Worker deployed before is bound to", () => {
    const { status, deployed, logs } = deploy(EVERY_SECRET, copysConfig("d1"), { env: { D1_STATE: "set up", DEPLOYMENTS_STATUS: "1" } });
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(logs).toContain("Couldn't tell which D1 database the Worker uses");
  });

  it.each([[["--dry-run"]], [["--dry-run=true"]], [["--dry-run", "true"]]])("changes no D1 database on a dry run (%j)", (dryRun) => {
    const options = [...copysConfig("d1", [DATABASE]), ...dryRun];
    const { status } = deploy("no worker", options);
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "deploy --secrets-file"]);
    expect(output("deploy-args")).toBe(options.join(" "));
  });

  it.each([[["--dry-run=false"]], [["--dry-run", "false"]]])("readies the D1 database where the options turn the dry run off (%j)", (dryRun) => {
    const { status } = deploy("no worker", [...copysConfig("d1"), ...dryRun]);
    expect(status).toBe(0);
    expect(commands()).toEqual(["secret list", "d1 execute", "d1 migrations", "deploy --secrets-file"]);
  });

  it.each([[[]], [["--var", "STORAGE_BACKEND:d1"]]])(
    "deploys a TOML config as it is, since it reads only JSON and JSONC, and says what that leaves to the deployer (%j)",
    (vars) => {
      const file = path.join(dir, "wrangler.toml");
      writeFileSync(file, 'name = "ember"\n\n[vars]\nSTORAGE_BACKEND = "d1"\n');
      const { status, logs } = deploy(EVERY_SECRET, ["--config", file, ...vars]);
      expect(status).toBe(0);
      expect(commands()).toEqual(["secret list", "deploy --secrets-file"]);
      expect(output("deploy-args")).toBe(["--config", file, ...vars].join(" "));
      expect(logs).toContain("not TOML, so it deploys");
      expect(logs).toContain("Where it keeps messages in D1, apply Ember's migrations to the database with pnpm exec wrangler d1 migrations apply DB --remote --config");
    },
  );

  it("stops before deploying where the migrations fail, and says what D1 takes", () => {
    const { status, deployed, logs } = deploy(EVERY_SECRET, copysConfig("d1"), { env: { MIGRATIONS_STATUS: "1" } });
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(logs).toContain("wrangler d1 migrations failed. Keeping messages in D1 takes a Cloudflare API token that may edit D1");
  });

  it("refuses d1 where the config binds no D1 database as DB", () => {
    const { status, deployed, logs } = deploy(EVERY_SECRET, copysConfig("d1", [{ ...MADE, binding: "MESSAGES" }]));
    expect(status).toBe(1);
    expect(deployed).toBe(false);
    expect(logs).toContain(`STORAGE_BACKEND is "d1", but ${path.relative(ROOT, path.join(dir, "wrangler.jsonc"))} binds no D1 database as DB.`);
  });

  it.each([
    ["do-sqlite", "d1", ["secret list", "deployments status", "versions view", "d1 execute", "d1 migrations", "deploy --secrets-file"]],
    ["d1", "do-sqlite", ["secret list", "deploy --secrets-file"]],
  ])("keeps messages where a --var says, over a config's %s (%s)", (configured, given, expected) => {
    const { status } = deploy(EVERY_SECRET, [...copysConfig(configured), "--var", `STORAGE_BACKEND:${given}`]);
    expect(status).toBe(0);
    expect(commands()).toEqual(expected);
  });
});

describe("Updates for a copy made with Deploy to Cloudflare", () => {
  const WORKFLOW = ".github/workflows/update-ember.yml";
  // Ember's, as the deploy offers it: the copy beside the script, which CI keeps the same as .github's,
  // since a copy's .github keeps its own workflow, or none.
  const embersWorkflow = readFileSync(new URL("./update-ember.yml", import.meta.url), "utf8");

  /**
   * A checkout of a copy of Ember with this script, cloned from `origin` if one's given, and without the
   * Update Ember workflow unless `workflow`, as Deploy to Cloudflare's copies are, nor the beta workflow
   * unless `betaWorkflow`: answers the script there.
   */
  function checkout({ origin, workflow = false, betaWorkflow = false }: { origin?: string; workflow?: boolean; betaWorkflow?: boolean } = {}): string {
    const root = path.join(dir, "checkout");
    const scripts = path.join(root, "apps/worker/scripts");
    mkdirSync(scripts, { recursive: true });
    for (const file of ["deploy.ts", "jsonc.ts", "vapid-keys.ts", "update-ember.yml"]) copyFileSync(new URL(`./${file}`, import.meta.url), path.join(scripts, file));
    if (workflow || betaWorkflow) mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    if (workflow) writeFileSync(path.join(root, WORKFLOW), embersWorkflow);
    if (betaWorkflow) copyFileSync(new URL("./update-ember-beta.yml", import.meta.url), path.join(root, ".github/workflows/update-ember-beta.yml"));
    spawnSync("git", ["init", "--quiet"], { cwd: root });
    if (origin) spawnSync("git", ["remote", "add", "origin", origin], { cwd: root });
    return path.join(scripts, "deploy.ts");
  }

  /** The link to GitHub's editor for `repository` in the deploy's `logs`. */
  const editorLink = (logs: string, repository: string) => new URL(new RegExp(`https://github\\.com/${repository}/new/\\S+`).exec(logs)?.[0] ?? "https://missing.invalid/");

  it("links a copy without the workflow to GitHub's editor with Ember's filled in, keeping the clone's credentials out of the log", () => {
    const script = checkout({ origin: "https://x-access-token:ghs_clone-only@github.com/someone/my-ember.git" });
    const { status, logs } = deploy("no worker", [], { script, env: { CI: "true", WORKERS_CI: "1" } });
    expect(status).toBe(0);
    expect(logs).toContain("This copy of Ember has no Update Ember workflow, which Deploy to Cloudflare leaves out with the rest of the .github folder");
    const link = editorLink(logs, "someone/my-ember");
    expect(`${link.origin}${link.pathname}`).toBe("https://github.com/someone/my-ember/new/main");
    expect(link.searchParams.get("filename")).toBe(WORKFLOW);
    expect(link.searchParams.get("value")).toBe(embersWorkflow);
    // A line of its own, to copy whole.
    expect(logs).toMatch(/^https:\/\/github\.com\/someone\/my-ember\/new\/main\?\S+$/m);
    expect(logs).not.toContain("ghs_clone-only");
  });

  it.each([
    ["https://github.com/someone/my-ember", "main", "https://github.com/someone/my-ember/new/main"],
    ["git@github.com:someone/my-ember.git", "production", "https://github.com/someone/my-ember/new/production"],
    ["https://github.com/someone/my-ember.git", "release/v1#stable", "https://github.com/someone/my-ember/new/release/v1%23stable"],
  ])("opens the editor of the repository git cloned the copy from (%s) on the branch Workers Builds deploys (%s)", (origin, branch, editor) => {
    const { logs } = deploy(EVERY_SECRET, [], { script: checkout({ origin }), env: { CI: "true", WORKERS_CI: "1", WORKERS_CI_BRANCH: branch } });
    const link = editorLink(logs, "someone/my-ember");
    expect(`${link.origin}${link.pathname}`).toBe(editor);
    expect(link.searchParams.get("filename")).toBe(WORKFLOW);
  });

  it.each([
    ["git names no origin", undefined],
    ["the copy is on GitLab", "https://gitlab.com/someone/my-ember.git"],
    ["the checkout is of Ember's own repository", "https://github.com/NYLLON-SOFTWARE/ember-cloudflare.git"],
  ])("says where Ember's workflow is when %s, and how to update elsewhere, telling the Worker of no copy", (_, origin) => {
    const { logs } = deploy(EVERY_SECRET, [], { script: checkout({ origin }) });
    expect(logs).toContain(`On GitHub, add ${WORKFLOW} to it as Ember has it, https://github.com/NYLLON-SOFTWARE/ember-cloudflare/blob/main/${WORKFLOW}`);
    expect(logs).toContain("elsewhere, update it with apps/worker/scripts/update-ember.ts");
    expect(logs).not.toContain("/new/");
    expect(output("deploy-args")).toBe("");
  });

  it.each([
    [false, false, {}, "--var GITHUB_REPOSITORY:someone/my-ember --var GIT_BRANCH:main --var UPDATE_WORKFLOW:false --var BETA_WORKFLOW:false"],
    [true, false, { WORKERS_CI_BRANCH: "release/v1#stable" }, "--var GITHUB_REPOSITORY:someone/my-ember --var GIT_BRANCH:release/v1#stable --var UPDATE_WORKFLOW:true --var BETA_WORKFLOW:false"],
    [true, true, {}, "--var GITHUB_REPOSITORY:someone/my-ember --var GIT_BRANCH:main --var UPDATE_WORKFLOW:true --var BETA_WORKFLOW:true"],
    [false, true, {}, "--var GITHUB_REPOSITORY:someone/my-ember --var GIT_BRANCH:main --var UPDATE_WORKFLOW:false --var BETA_WORKFLOW:true"],
  ])(
    "tells the Worker the copy's repository, the branch that deploys and whether it has the workflow (%s) and the beta workflow (%s), without the clone's credentials, for the release card",
    (workflow, betaWorkflow, branch, vars) => {
      const script = checkout({ origin: "https://x-access-token:ghs_clone-only@github.com/someone/my-ember.git", workflow, betaWorkflow });
      expect(deploy(EVERY_SECRET, [], { script, env: { CI: "true", WORKERS_CI: "1", ...branch } }).status).toBe(0);
      expect(output("deploy-args")).toBe(vars);
    },
  );

  it("keeps the vars a deploy's options give over the copy's own", () => {
    const script = checkout({ origin: "git@github.com:someone/my-ember.git", workflow: true });
    deploy(EVERY_SECRET, ["--var", "GIT_BRANCH:production", "--var=UPDATE_WORKFLOW:false", "--var", "BETA_WORKFLOW:true"], { script });
    expect(output("deploy-args")).toBe("--var GIT_BRANCH:production --var=UPDATE_WORKFLOW:false --var BETA_WORKFLOW:true --var GITHUB_REPOSITORY:someone/my-ember");
  });

  it("says nothing of the workflow to a copy that has it, nor when wrangler fails to deploy", () => {
    const origin = "https://github.com/someone/my-ember.git";
    expect(deploy(EVERY_SECRET, [], { script: checkout({ origin, workflow: true }) }).logs).not.toContain("Update Ember workflow");
    rmSync(path.join(dir, "checkout"), { recursive: true });
    expect(deploy(EVERY_SECRET, [], { script: checkout({ origin }), deployStatus: 1 }).logs).not.toContain("Update Ember workflow");
  });
});

describe("Sign in with Memberful", () => {
  const keys = { MEMBERFUL_URL: "https://example.memberful.com", MEMBERFUL_CLIENT_ID: "client-id", MEMBERFUL_CLIENT_SECRET: "client-secret" };

  it("uploads the Memberful keys the environment gives with every deploy, so a changed one changes in the Worker, and never prints them", () => {
    const { status, secrets, logs } = deploy(EVERY_SECRET, [], { env: { ...keys, CI: "true", GITHUB_ACTIONS: "true" } });
    expect(status).toBe(0);
    expect(secrets).toEqual(keys);
    expect(logs).toContain("Deploying with MEMBERFUL_URL, MEMBERFUL_CLIENT_ID, MEMBERFUL_CLIENT_SECRET from the environment");
    expect(logs).not.toContain("client-secret");
  });

  it("names the secrets it made apart from the ones the environment gave", () => {
    const { secrets, logs } = deploy(["SESSION_SECRET", "EMBER_SETUP_TOKEN"], [], { env: { MEMBERFUL_CLIENT_SECRET: "client-secret" } });
    expect(Object.keys(secrets!)).toEqual(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "MEMBERFUL_CLIENT_SECRET"]);
    expect(logs).toContain("Deploying with new VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and MEMBERFUL_CLIENT_SECRET from the environment");
  });

  it("leaves the keys the environment doesn't give, as a workflow's missing secrets are empty, as the Worker has them", () => {
    const { secrets, logs } = deploy(EVERY_SECRET, [], { env: { MEMBERFUL_URL: "", MEMBERFUL_CLIENT_ID: "", MEMBERFUL_CLIENT_SECRET: "" } });
    expect(secrets).toEqual({});
    expect(logs).toContain("Deploying with the Worker's secrets as they are");
  });
});

describe("Memberful memberships", () => {
  it("uploads the custom app's API key and the webhook's secret the environment gives too, and never prints them", () => {
    const keys = { MEMBERFUL_API_KEY: "api-key", MEMBERFUL_WEBHOOK_SECRET: "webhook-secret" };
    const { status, secrets, logs } = deploy(EVERY_SECRET, [], { env: { ...keys, CI: "true", GITHUB_ACTIONS: "true" } });
    expect(status).toBe(0);
    expect(secrets).toEqual(keys);
    expect(logs).toContain("Deploying with MEMBERFUL_API_KEY, MEMBERFUL_WEBHOOK_SECRET from the environment");
    expect(logs).not.toContain("api-key");
    expect(logs).not.toContain("webhook-secret");
  });
});

describe("Sign up without a link", () => {
  it("uploads the Turnstile widget's keys the environment gives with every deploy, and never prints them", () => {
    const keys = { TURNSTILE_SITE_KEY: "0x4AAAAAAA-site-key", TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret-key" };
    const { status, secrets, logs } = deploy(EVERY_SECRET, [], { env: { ...keys, CI: "true", GITHUB_ACTIONS: "true" } });
    expect(status).toBe(0);
    expect(secrets).toEqual(keys);
    expect(logs).toContain("Deploying with TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY from the environment");
    expect(logs).not.toContain("0x4AAAAAAA");
  });
});

describe("Sending email", () => {
  it("uploads the Resend API key the environment gives with every deploy, and never prints it", () => {
    const { status, secrets, logs } = deploy(EVERY_SECRET, [], { env: { RESEND_API_KEY: "re_e2e-only-not-a-key", CI: "true", GITHUB_ACTIONS: "true" } });
    expect(status).toBe(0);
    expect(secrets).toEqual({ RESEND_API_KEY: "re_e2e-only-not-a-key" });
    expect(logs).toContain("Deploying with RESEND_API_KEY from the environment");
    expect(logs).not.toContain("re_e2e");
  });
});

describe("Set up Ember AI's account", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
  /** What `wrangler whoami --json` says of credentials that reach `accounts`. */
  const whoami = (...accounts: string[]) =>
    JSON.stringify({ loggedIn: true, authType: "User API Token", email: "someone@example.com", accounts: accounts.map((id, at) => ({ id, name: `Account ${at + 1}` })), tokenPermissions: [] });

  it("gives the Worker the account its environment names, as wrangler deploys there, and never prints it", () => {
    const { status, secrets, logs } = deploy(EVERY_SECRET, [], { env: { CLOUDFLARE_ACCOUNT_ID: ` ${ACCOUNT.toUpperCase()} `, CI: "true", GITHUB_ACTIONS: "true" } });
    expect(status).toBe(0);
    expect(secrets).toEqual({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(logs).toContain("Deploying with CLOUDFLARE_ACCOUNT_ID, the account's ID, for Set up Ember AI");
    expect(logs).not.toContain(ACCOUNT);
    // wrangler isn't asked about an account the environment names.
    expect(output("whoami-args")).toBeNull();
  });

  it("gives it the only account the deploy's credentials reach, as Workers Builds' token does, with every deploy", () => {
    const { secrets, logs } = deploy(["SESSION_SECRET", "EMBER_SETUP_TOKEN"], [], { env: { WHOAMI: whoami(ACCOUNT), WORKERS_CI: "1", CI: "true" } });
    expect(output("whoami-args")).toBe("whoami --json");
    expect(secrets).toEqual({ VAPID_PUBLIC_KEY: expect.any(String), VAPID_PRIVATE_KEY: expect.any(String), CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(logs).toContain("Deploying with new VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and CLOUDFLARE_ACCOUNT_ID, the account's ID, for Set up Ember AI");
    expect(logs).not.toContain(ACCOUNT);
  });

  it.each([
    ["the credentials reach several accounts, of which wrangler picks one without saying which", { WHOAMI: whoami(ACCOUNT, OTHER_ACCOUNT) }],
    ["nobody's signed in, as wrangler says", {}],
    ["wrangler names no account", { WHOAMI: whoami() }],
    ["wrangler's answer isn't what it should be", { WHOAMI: '{"loggedIn":true,"accounts":[{"id":"not-an-account"}]}' }],
    ["the environment's can't be an account's ID", { CLOUDFLARE_ACCOUNT_ID: "my-account", WHOAMI: whoami(ACCOUNT) }],
  ])("leaves it as the Worker has it when %s", (_, env) => {
    const { status, secrets, logs } = deploy(EVERY_SECRET, [], { env });
    expect(status).toBe(0);
    expect(secrets).toEqual({});
    expect(logs).toContain("Deploying with the Worker's secrets as they are");
  });
});

describe("Web Push configuration", () => {
  it("makes a VAPID key pair for a Worker that has neither key, and keeps the private key out of the logs", () => {
    const { status, secrets, logs } = deploy(["SESSION_SECRET", "EMBER_SETUP_TOKEN"]);
    expect(status).toBe(0);
    expect(secrets).toEqual({ VAPID_PUBLIC_KEY: expect.stringMatching(/^B[\w-]{86}$/), VAPID_PRIVATE_KEY: expect.stringMatching(/^[\w-]{43}$/) });
    expect(logs).not.toContain(secrets!.VAPID_PRIVATE_KEY!);
  });

  it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"])("leaves a Worker with only %s as it is, rather than replacing it", (key) => {
    const { status, secrets } = deploy(["SESSION_SECRET", "EMBER_SETUP_TOKEN", key]);
    expect(status).toBe(0);
    expect(secrets).toEqual({});
  });
});

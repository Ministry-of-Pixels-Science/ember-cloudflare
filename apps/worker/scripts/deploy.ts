// Deploys the Worker with the secrets it doesn't have yet, so a new deployment works without anyone
// making them. Deploy to Cloudflare's build runs it as `pnpm run deploy`, and the Preview workflow
// runs it with its own options, which go on to `wrangler deploy`:
//
//   node apps/worker/scripts/deploy.ts [--name <worker>] [--config <file>] [--var NAME:value ...]
//
// Sessions are stored keyed with SESSION_SECRET, so changing it would sign everyone out: the first
// deploy makes one and later ones keep it. Browsers subscribe to push notifications with
// VAPID_PUBLIC_KEY, so the first deploy makes a VAPID key pair too, and later ones keep it. Whoever
// deployed, and nobody else, sets Ember up (apps/worker/src/setup.ts) with its setup password,
// EMBER_SETUP_PASSWORD, which Deploy to Cloudflare's form asks them to make up, or which the deploy's
// environment gives. A Worker with neither that nor a setup token gets EMBER_SETUP_TOKEN, the one secret
// meant to be read: the deploy prints the setup link that carries it, which is spent once Ember is set
// up. The secrets go up with the code in one `wrangler deploy --secrets-file`, from a file only this
// deploy can read, and nothing else here prints them: Cloudflare's build logs mask nothing, as GitHub's
// would. A CI log can be public, as a public repository's Actions logs are, and not every CI says it's
// one, so there, and wherever its output isn't a terminal's, the deploy makes no setup token, and says
// so, unless EMBER_SETUP_TOKEN in its environment brings one the deployer keeps as a secret of their
// own. Workers Builds' log is the account's own, so it can carry the link. The keys of
// a Memberful custom app, for its members to sign in, in place of any given in Set up Memberful
// (apps/worker/src/memberful.ts), and of a Turnstile widget, for open sign-up's check, in place of any
// given in Set up Turnstile (apps/worker/src/turnstile.ts), go up with every deploy whose environment
// gives them, as the Preview workflow's does from the repository's secrets. So does the ID of the
// Cloudflare account the Worker goes to, as CLOUDFLARE_ACCOUNT_ID, which a Worker can't learn by itself,
// for Set up Ember AI to fill in. Deploy to Cloudflare's copy of Ember leaves out the .github folder,
// and with it the Update Ember workflow that offers the copy Ember's releases, so a deploy without that
// workflow ends by saying how to add it. A copy on GitHub tells the Worker its repository, the branch
// that deploys, and whether it has the workflow, as vars, for General's release card to link to running
// the workflow, or to adding it. Where STORAGE_BACKEND keeps messages in D1, the deploy makes the
// database the config names if the account has none, refuses one in which an Ember the Worker isn't
// bound to is set up, and applies Ember's migrations to it before the Worker that reads it deploys; on
// DO SQLite, it deploys without the D1 database that Deploy to Cloudflare's form makes for every copy.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataOf } from "./jsonc.ts";
import { vapidKeys } from "./vapid-keys.ts";

/** The repository's root, where wrangler.jsonc is. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Ember's repository, where its releases come from. */
const EMBER = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare";
/** The workflow that offers a copy Ember's releases (docs/self-hosting.md#updating), and Ember's, kept beside this script. */
const UPDATE_WORKFLOW = ".github/workflows/update-ember.yml";
/** And the beta workflow, which brings a copy Ember's newest beta when it's run (docs/self-hosting.md#betas). */
const BETA_WORKFLOW = ".github/workflows/update-ember-beta.yml";
const EMBERS_UPDATE_WORKFLOW = new URL("./update-ember.yml", import.meta.url);

/** Runs `pnpm exec wrangler` from the root, with its output captured or shown, and `env` besides this process's. */
function wrangler(args: string[], capture: boolean, env: Record<string, string> = {}) {
  return spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: capture ? "pipe" : "inherit", env: { ...process.env, ...env } });
}

/** The wrangler options that pick which Worker a command acts on, besides the ones wrangler.jsonc names. */
const TARGET_OPTIONS = ["--name", "--config", "-c"];

/** Whether `arg` is `option`, alone or with its value after `=`. */
const isOption = (arg: string, option: string) => arg === option || arg.startsWith(`${option}=`);

/**
 * The options among wrangler deploy's that pick its Worker, so `wrangler secret list` looks at the
 * same one. wrangler.jsonc has no environments, and an environment's Worker name depends on how it's
 * combined with `--name`, so `--env` is refused rather than guessed at.
 */
function targetOptions(args: string[]): string[] {
  if (args.some((arg) => isOption(arg, "--env") || isOption(arg, "-e"))) {
    throw new Error("wrangler.jsonc has no environments, so the deploy takes no --env.");
  }
  return args.flatMap((arg, at) => {
    if (TARGET_OPTIONS.includes(arg)) return args.slice(at, at + 2);
    return TARGET_OPTIONS.some((option) => isOption(arg, option)) ? [arg] : [];
  });
}

/**
 * The names of the Worker's secrets, or none when there's no Worker yet. Failing to list them for
 * any other reason throws, rather than replacing ones that may be there.
 */
function secretNames(target: string[]): string[] {
  const listed = wrangler(["secret", "list", ...target], true);
  if (listed.status === 0) return (JSON.parse(listed.stdout) as { name: string }[]).map(({ name }) => name);
  if (/Worker "[^"]+" not found/.test(listed.stdout + listed.stderr)) return [];
  throw new Error(`Couldn't list the Worker's secrets:\n${listed.stdout}${listed.stderr}`);
}

/** The shape of EMBER_SETUP_TOKEN, as the Worker checks it (apps/worker/src/secrets.ts): `openssl rand -hex 32`. */
const SETUP_TOKEN = /^[0-9a-f]{64}$/;

/**
 * Whether this deploy's output may be public: a CI log, or whatever else isn't a terminal, as the log of a
 * CI that doesn't say it's one, except Workers Builds', which is the account's own.
 */
const inPublicLog = () => (!!process.env.CI || !process.stdout.isTTY) && !process.env.WORKERS_CI;

/**
 * The keys of a Memberful custom app, and the secret its site signs webhooks with, then the single
 * sign-on provider's issuer and the app registered there, a Turnstile widget's keys, and a Resend API
 * key, which only the deployer can give.
 */
const GIVEN_KEYS = [
  "MEMBERFUL_URL",
  "MEMBERFUL_CLIENT_ID",
  "MEMBERFUL_CLIENT_SECRET",
  "MEMBERFUL_API_KEY",
  "MEMBERFUL_WEBHOOK_SECRET",
  "SSO_ISSUER",
  "SSO_CLIENT_ID",
  "SSO_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "RESEND_API_KEY",
];

/**
 * The keys the deploy's environment gives, which go up with every deploy, so a key changed where the
 * deployer keeps it changes in the Worker too. Ones it doesn't give stay as the Worker has them.
 */
function givenSecrets(): Record<string, string> {
  return Object.fromEntries(GIVEN_KEYS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

/** The shape of a Cloudflare account's ID: 32 hexadecimal digits, as the Worker checks it (`accountIdOf`). */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/**
 * The ID of the Cloudflare account the deploy goes to: the one its environment names, which wrangler
 * deploys to, else the only one its credentials reach, as a Workers Builds token's do, or null where
 * they reach several, and wrangler picks among them without saying which, or it can't say.
 */
function deployAccountId(): string | null {
  const named = process.env.CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
  if (named) return ACCOUNT_ID.test(named) ? named : null;
  const whoami = wrangler(["whoami", "--json"], true);
  if (whoami.status !== 0) return null;
  try {
    const { accounts } = JSON.parse(whoami.stdout) as { accounts?: unknown };
    const [only, ...others] = Array.isArray(accounts) ? (accounts as ({ id?: unknown } | null)[]) : [];
    const id = only?.id;
    return others.length === 0 && typeof id === "string" && ACCOUNT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** What the deploy says it uploads: the secrets it made, the ones its environment gave, and the account's ID, by name alone. */
function uploading(made: string[], given: string[], accountId: boolean): string {
  const secrets = [
    made.length ? `new ${made.join(", ")}` : "",
    given.length ? `${given.join(", ")} from the environment` : "",
    accountId ? "CLOUDFLARE_ACCOUNT_ID, the account's ID, for Set up Ember AI" : "",
  ].filter(Boolean);
  return secrets.length ? `Deploying with ${secrets.join(", and ")}` : "Deploying with the Worker's secrets as they are";
}

/**
 * What became of the Worker's setup token: made here, given by the environment, withheld from a public
 * log, or kept from before, or not needed, as the Worker has a setup password, which a first deploy says
 * how to use ("password"), and a later one doesn't ("kept").
 */
type SetupToken = "made" | "given" | "withheld" | "kept" | "password";

/** New values for the secrets a Worker that has `names` is missing, and what became of its setup token. */
async function missingSecrets(names: string[]): Promise<{ secrets: Record<string, string>; setupToken: SetupToken }> {
  const secrets: Record<string, string> = {};
  if (!names.includes("SESSION_SECRET")) secrets.SESSION_SECRET = randomBytes(32).toString("hex");
  // A Worker with only one of the pair keeps it, and says in /api/health why push is off.
  if (!names.includes("VAPID_PUBLIC_KEY") && !names.includes("VAPID_PRIVATE_KEY")) {
    const { publicKey, privateKey } = await vapidKeys();
    Object.assign(secrets, { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
  }
  let setupToken: SetupToken = "kept";
  const password = process.env.EMBER_SETUP_PASSWORD?.trim();
  if (names.includes("EMBER_SETUP_PASSWORD")) {
    // As Deploy to Cloudflare's form gives it. The first deploy makes SESSION_SECRET too; by a later
    // one, Ember may well be set up.
    if (!names.includes("SESSION_SECRET")) setupToken = "password";
  } else if (password) {
    [secrets.EMBER_SETUP_PASSWORD, setupToken] = [password, "password"];
  } else if (!names.includes("EMBER_SETUP_TOKEN")) {
    const given = process.env.EMBER_SETUP_TOKEN?.trim();
    if (given) {
      if (!SETUP_TOKEN.test(given)) throw new Error("EMBER_SETUP_TOKEN must be 64 lowercase hex characters, as `openssl rand -hex 32` makes.");
      [secrets.EMBER_SETUP_TOKEN, setupToken] = [given, "given"];
    } else if (inPublicLog()) {
      setupToken = "withheld";
    } else {
      [secrets.EMBER_SETUP_TOKEN, setupToken] = [randomBytes(32).toString("hex"), "made"];
    }
  }
  return { secrets, setupToken };
}

/**
 * The https origin a target of the deploy names, or null for one that names none. wrangler records
 * the workers.dev address as a URL, routes and custom domains as their patterns with notes after a
 * space (`chat.example.com (custom domain)`, `example.com/* (zone name: example.com)`), and queues,
 * workflows and the like in words (`Producer for jobs`). A route under a path, or with a wildcard
 * host, isn't an address Ember can be opened at.
 */
function originOf(target: string): string | null {
  if (URL.canParse(target)) {
    const url = new URL(target);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  }
  const host = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\*)?(?: |$)/i.exec(target)?.[1];
  return host === undefined ? null : `https://${host}`;
}

/**
 * The Worker's address, from wrangler's record of this deploy in `outputFile`, or null where it recorded
 * none it can be opened at. wrangler appends a record to the file for each deploy, so a file the environment
 * keeps may hold earlier deploys' records, maybe other Workers', before this one's: the last record is this deploy's.
 */
function deployedUrl(outputFile: string): string | null {
  if (!existsSync(outputFile)) return null;
  const records = readFileSync(outputFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { type?: string; targets?: string[] }];
      } catch {
        return [];
      }
    });
  const origins = (records.findLast((record) => record.type === "deploy")?.targets ?? []).flatMap((target) => originOf(target) ?? []);
  return origins.find((origin) => origin.endsWith(".workers.dev")) ?? origins[0] ?? null;
}

/**
 * Says how to set Ember up at `url`, with its setup password or link, as what became of the Worker's setup
 * token allows, naming the Worker as the deploy's `target` options do, so a new password or token goes to
 * the Worker deployed, not wrangler.jsonc's.
 */
function tellSetupLink(setupToken: SetupToken, token: string | undefined, url: string | null, target: string[]): void {
  const setup = `${url ?? "https://<your Worker>"}/first_run`;
  const page = `${setup}#token=`;
  // `wrangler secret put` asks for the value, so the person sees the token they make, which a pipe would hide.
  const newToken = `make one with openssl rand -hex 32, give it to the Worker with ${["pnpm exec wrangler secret put EMBER_SETUP_TOKEN", ...target].join(" ")}, which asks for it, and open ${page}<the token>`;
  const putPassword = `${["pnpm exec wrangler secret put EMBER_SETUP_PASSWORD", ...target].join(" ")}, which asks for it`;
  if (setupToken === "password") {
    console.log(
      `\nSet up Ember at ${setup} with its setup password, EMBER_SETUP_PASSWORD. If it's forgotten, give it a new one in the Cloudflare dashboard, in the Worker's Settings under Variables and Secrets, or with ${putPassword}.`,
    );
  } else if (setupToken === "made") {
    console.log(`\nSet up Ember at ${page}${token}\nThat link carries this deployment's setup token, printed only now, and is spent once Ember is set up. If it's lost, ${newToken}`);
  } else if (setupToken === "given") {
    console.log(`\nSet up Ember at ${page}<your EMBER_SETUP_TOKEN>`);
  } else if (setupToken === "withheld") {
    const notice = `Nobody can set Ember up until the Worker has a setup password or an EMBER_SETUP_TOKEN secret, and this log may be public, so this deploy made no token. Give it a setup password with ${putPassword}, and open ${setup}; or set EMBER_SETUP_TOKEN in the deploy's environment from a secret of your own (openssl rand -hex 32) and deploy again, then open ${page}<your EMBER_SETUP_TOKEN>; or ${newToken}`;
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::notice::${notice}` : `\n${notice}`);
  }
}

/**
 * The GitHub repository the checkout came from, as `owner/name`, or null where git's origin isn't one
 * on github.com. A build's origin may carry its clone's credentials, which go no further than this.
 */
function githubRepository(): string | null {
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" });
  if (origin.status !== 0) return null;
  return /^(?:https:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin.stdout.trim())?.[1] ?? null;
}

/** The repository of the copy of Ember the checkout is, on GitHub, or null where it's on GitHub as nothing but Ember's own. */
function copyRepository(): string | null {
  const repository = githubRepository();
  return repository && `https://github.com/${repository}`.toLowerCase() !== EMBER.toLowerCase() ? repository : null;
}

/** Whether the checkout has the Update Ember workflow. */
const hasUpdateWorkflow = () => existsSync(path.join(ROOT, UPDATE_WORKFLOW));
/** And the beta workflow. */
const hasBetaWorkflow = () => existsSync(path.join(ROOT, BETA_WORKFLOW));

/** The branch that deploys: the one Workers Builds deploys, else `main`. */
const deployBranch = () => process.env.WORKERS_CI_BRANCH || "main";

/**
 * The vars that tell the Worker of the copy it's deployed from, as `--var`s for wrangler deploy: its
 * repository on GitHub, the branch that deploys, and whether it has the Update Ember workflow and the
 * beta workflow, which General's release card links to, or to adding them. None for a checkout that
 * isn't a copy on GitHub, and none that `args` give themselves.
 */
function copyVars(args: string[]): string[] {
  const repository = copyRepository();
  if (!repository) return [];
  const given = varsGiven(args);
  const vars = { GITHUB_REPOSITORY: repository, GIT_BRANCH: deployBranch(), UPDATE_WORKFLOW: String(hasUpdateWorkflow()), BETA_WORKFLOW: String(hasBetaWorkflow()) };
  return Object.entries(vars).flatMap(([name, value]) => (given.has(name) ? [] : ["--var", `${name}:${value}`]));
}

/**
 * Says how to add the Update Ember workflow to a copy that has none, as Deploy to Cloudflare's don't:
 * on GitHub, with a link that opens the copy's editor with Ember's workflow in it, ready to commit, on a
 * line of its own to copy, as the whole workflow makes it long.
 */
function tellUpdateWorkflow(): void {
  if (hasUpdateWorkflow()) return;
  const repository = copyRepository();
  const missing = "\nThis copy of Ember has no Update Ember workflow, which Deploy to Cloudflare leaves out with the rest of the .github folder, so nothing offers it Ember's new releases.";
  if (repository && existsSync(EMBERS_UPDATE_WORKFLOW)) {
    // A branch's name may hold what a link can't, such as `#`, so each of its parts goes in encoded.
    const branch = deployBranch().split("/").map(encodeURIComponent).join("/");
    const editor = `https://github.com/${repository}/new/${branch}`;
    const workflow = new URLSearchParams({ filename: UPDATE_WORKFLOW, value: readFileSync(EMBERS_UPDATE_WORKFLOW, "utf8") });
    console.log(`${missing} To have each come as a pull request, commit the workflow in GitHub's editor, which this link opens with it filled in:\n${editor}?${workflow}`);
  } else {
    console.log(
      `${missing} On GitHub, add ${UPDATE_WORKFLOW} to it as Ember has it, ${EMBER}/blob/main/${UPDATE_WORKFLOW}, to have each come as a pull request; elsewhere, update it with apps/worker/scripts/update-ember.ts (docs/self-hosting.md#updating).`,
    );
  }
}

/** Where the Worker may keep messages, as STORAGE_BACKEND says (apps/worker/src/env.ts). */
const BACKENDS = ["do-sqlite", "d1"];
/** The binding of the D1 database the Worker keeps its tables in on D1 (apps/worker/src/db.ts). */
const D1_BINDING = "DB";
/**
 * The deploy environment's word that a D1 database it names, by name or id, is this Ember's own, though an
 * Ember is set up in it and the Worker isn't bound to it: after a time on DO SQLite, or with its Worker made again.
 */
const ADOPT_D1 = "EMBER_ADOPT_D1_DATABASE";

/** A wrangler config's settings, as much of them as the deploy reads. */
interface Settings {
  vars?: Record<string, unknown>;
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  [setting: string]: unknown;
}

/** The config wrangler deploys from: the one `args` name, from the root, as wrangler runs there, else the root's wrangler.jsonc. */
function configFileOf(args: string[]): string {
  const at = args.findIndex((arg) => isOption(arg, "--config") || isOption(arg, "-c"));
  if (at === -1) return path.join(ROOT, "wrangler.jsonc");
  const arg = args[at]!;
  return path.resolve(ROOT, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[at + 1] ?? ""));
}

/** `args` without the config they name, for the deploy to name its own. */
function withoutConfig(args: string[]): string[] {
  return args.filter((arg, at) => !(isOption(arg, "--config") || isOption(arg, "-c")) && !["--config", "-c"].includes(args[at - 1]!));
}

/**
 * The settings in `file`, or none where the deploy can't read it and so deploys it as it is: where there's
 * no such file, which wrangler goes on to say, or where it's TOML, which leaves D1's migrations to the deployer.
 */
function settingsOf(file: string): Settings | undefined {
  if (!existsSync(file)) return undefined;
  if (path.extname(file) === ".toml") {
    const config = path.relative(ROOT, file);
    console.log(
      `The deploy reads JSON and JSONC configs, not TOML, so it deploys ${config} as it is. Where it keeps messages in D1, apply Ember's migrations to the database with pnpm exec wrangler d1 migrations apply ${D1_BINDING} --remote --config ${config}`,
    );
    return undefined;
  }
  return dataOf(readFileSync(file, "utf8")) as Settings;
}

/** Whether `args` ask wrangler deploy for a dry run, which changes nothing: `--dry-run`, unless they give it as false. */
function isDryRun(args: string[]): boolean {
  const at = args.findLastIndex((arg) => isOption(arg, "--dry-run"));
  if (at === -1) return false;
  return (args[at] === "--dry-run" ? args[at + 1] : args[at]!.slice("--dry-run=".length)) !== "false";
}

/** The vars `args` give, as wrangler deploy takes them, `--var NAME:value` and then any more values after it, by name. */
function varsGiven(args: string[]): Map<string, string> {
  const vars = new Map<string, string>();
  let listing = false;
  for (const arg of args) {
    const value: string | undefined = arg.startsWith("--var=") ? arg.slice("--var=".length) : listing && !arg.startsWith("-") ? arg : undefined;
    listing = arg === "--var" || (listing && value !== undefined);
    if (value?.includes(":")) vars.set(value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1));
  }
  return vars;
}

/**
 * Where the deployed Worker keeps its messages: STORAGE_BACKEND as a `--var` gives it, else as the config's
 * vars do. Anything else stops the deploy, since the Worker would take a misspelled `d1` for `do-sqlite`.
 */
function backendOf(settings: Settings, args: string[]): string {
  const backend = varsGiven(args).get("STORAGE_BACKEND") ?? settings.vars?.STORAGE_BACKEND ?? "do-sqlite";
  if (typeof backend !== "string" || !BACKENDS.includes(backend)) {
    throw new Error(`STORAGE_BACKEND must be "do-sqlite" or "d1", not ${JSON.stringify(backend)}: set it in wrangler.jsonc's vars.`);
  }
  return backend;
}

/**
 * The config to deploy a Worker on DO SQLite from: `file` without its D1 databases, written beside it so its
 * paths mean what they did, under a name of this deploy's own, as another may run beside it, or `file` itself
 * where it binds none. Deploy to Cloudflare's form makes the
 * database for every deploy, as it can't make one only for D1, and only D1 uses it; bound, it would have
 * wrangler look for it by name, or make it, with a token that may not touch D1, as Workers Builds' own may not.
 */
function withoutD1(file: string, settings: Settings): string {
  if (!settings.d1_databases?.length) return file;
  const { d1_databases: _, ...rest } = settings;
  const deployed = path.join(path.dirname(file), `${path.parse(file).name}.${process.pid}.deploy.json`);
  writeFileSync(deployed, `${JSON.stringify(rest, null, 2)}\n`);
  return deployed;
}

/** Runs `wrangler d1` with `args`, and stops the deploy where it fails, saying what D1 takes. */
function d1(args: string[], capture: boolean, env: Record<string, string> = {}) {
  const result = wrangler(["d1", ...args], capture, env);
  if (result.status === 0) return result;
  throw new Error(
    `${capture ? `${result.stdout}${result.stderr}\n` : ""}wrangler d1 ${args[0]} failed. Keeping messages in D1 takes a Cloudflare API token that may edit D1, as Workers Builds' token may not: its permissions are in the dashboard, under My Profile, API Tokens.`,
  );
}

/** The id of the D1 database named `name` in the account that `file` deploys to, if it has one. */
const idOfDatabaseNamed = (file: string, name: string) =>
  (JSON.parse(d1(["list", "--json", "--config", file], true).stdout) as { uuid: string; name: string }[]).find((database) => database.name === name)?.uuid;

/** The rows `sql` reads from the D1 database bound as DB in `file`. */
function queryD1(file: string, sql: string): Record<string, unknown>[] {
  const answered = d1(["execute", D1_BINDING, "--remote", "--json", "--yes", "--command", sql, "--config", file], true);
  return (JSON.parse(answered.stdout) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
}

/** Whether an Ember is set up in the D1 database bound as DB in `file`: setting up makes its one account. */
function isSetUpIn(file: string): boolean {
  if (queryD1(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").length === 0) return false;
  return queryD1(file, "SELECT EXISTS (SELECT 1 FROM accounts) AS set_up")[0]?.set_up === 1;
}

/** Runs `wrangler` with `args` for the Worker the deploy's `target` options pick, and reads its JSON answer. */
function workerJson<T>(args: string[], target: string[]): T {
  const answered = wrangler([...args, "--json", ...target], true);
  if (answered.status !== 0) throw new Error(`Couldn't tell which D1 database the Worker uses:\n${answered.stdout}${answered.stderr}`);
  return JSON.parse(answered.stdout) as T;
}

/** The ids of the D1 databases the Worker's current deployment binds as DB: none on DO SQLite, whose deploys bind none. */
function databasesBound(target: string[]): string[] {
  const { versions } = workerJson<{ versions: { version_id: string }[] }>(["deployments", "status"], target);
  return versions.flatMap(({ version_id: version }) => {
    const { resources } = workerJson<{ resources: { bindings: { type: string; name: string; id?: string }[] } }>(["versions", "view", version], target);
    return resources.bindings.flatMap(({ type, name, id }) => (type === "d1" && name === D1_BINDING && id ? [id] : []));
  });
}

/**
 * Stops the deploy where an Ember is set up in the D1 database `id` and the Worker isn't bound to it, as it
 * wouldn't be to another Ember's, which the form may pick or a config may name: a new Worker is bound to none,
 * and one deployed before to what its current deployment binds. The deploy's environment may say it's this Ember's own.
 */
function refuseAnotherEmbers(file: string, database: { id: string; name?: string }, newWorker: boolean, target: string[]): void {
  const adopted = process.env[ADOPT_D1]?.trim();
  if (adopted && (adopted === database.id || adopted === database.name)) return;
  if (!newWorker && databasesBound(target).includes(database.id)) return;
  if (!isSetUpIn(file)) return;
  throw new Error(
    `An Ember is already set up in the D1 database ${database.name ?? database.id}, which this Worker isn't bound to. Two Embers can't share a database, as each would let in the other's people: give this one its own in ${path.relative(ROOT, file)}, a new database_name without a database_id, which the next deploy makes. If that database is this Ember's own, from before it was on DO SQLite or before its Worker was made again, set ${ADOPT_D1} to its name in the deploy's environment, and deploy again.`,
  );
}

/**
 * Readies the D1 database bound as DB in `file` for a Worker on D1, before the version that reads it deploys:
 * makes it where `file` names one the account doesn't have yet, refuses one another Ember may be set up in,
 * and applies Ember's migrations to it.
 */
function readyD1(file: string, settings: Settings, newWorker: boolean, target: string[]): void {
  const database = settings.d1_databases?.find(({ binding }) => binding === D1_BINDING);
  const name = database?.database_name;
  if (!database || (!database.database_id && !name)) {
    throw new Error(`STORAGE_BACKEND is "d1", but ${path.relative(ROOT, file)} binds no D1 database as ${D1_BINDING}.`);
  }
  const id = database.database_id ?? idOfDatabaseNamed(file, name!);
  if (id === undefined) {
    console.log(`Making the D1 database ${name}, which keeps this Ember's messages`);
    d1(["create", name!, "--no-update-config", "--config", file], false);
  } else {
    refuseAnotherEmbers(file, { id, name }, newWorker, target);
  }
  // CI answers yes to wrangler's question before it applies them.
  d1(["migrations", "apply", D1_BINDING, "--remote", "--config", file], false, { CI: "true" });
}

/**
 * Deploys with `args`, the missing secrets and the account's ID, where it's known, and the copy's vars,
 * on the storage STORAGE_BACKEND names, says how to set Ember up, and answers wrangler's exit status.
 */
async function deploy(args: string[]): Promise<number> {
  const target = targetOptions(args);
  const configFile = configFileOf(args);
  const settings = settingsOf(configFile);
  const backend = backendOf(settings ?? {}, args);
  const names = secretNames(target);
  const { secrets, setupToken } = await missingSecrets(names);
  const given = givenSecrets();
  const accountId = deployAccountId();
  const dir = mkdtempSync(path.join(tmpdir(), "ember-deploy-"));
  let config = configFile;
  try {
    // A Worker without a session secret has never deployed, so it's bound to no database.
    if (settings && backend === "d1" && !isDryRun(args)) readyD1(configFile, settings, !names.includes("SESSION_SECRET"), target);
    if (settings && backend !== "d1") config = withoutD1(configFile, settings);
    const file = path.join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify({ ...secrets, ...given, ...(accountId && { CLOUDFLARE_ACCOUNT_ID: accountId }) }), { mode: 0o600 });
    console.log(uploading(Object.keys(secrets), Object.keys(given), accountId !== null));
    // wrangler records what it deployed, the Worker's address among it, in the file the environment names, else one of this deploy's own.
    const output = process.env.WRANGLER_OUTPUT_FILE_PATH || path.join(dir, "wrangler-output.json");
    const options = [...(config === configFile ? args : [...withoutConfig(args), "--config", path.relative(ROOT, config)]), ...copyVars(args)];
    const status = wrangler(["deploy", "--secrets-file", file, ...options], false, { WRANGLER_OUTPUT_FILE_PATH: output }).status ?? 1;
    if (status === 0) {
      tellSetupLink(setupToken, secrets.EMBER_SETUP_TOKEN, deployedUrl(output), target);
      tellUpdateWorkflow();
    }
    return status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (config !== configFile) rmSync(config, { force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await deploy(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

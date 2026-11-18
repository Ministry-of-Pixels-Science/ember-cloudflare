// Brings a copy of Ember up to Ember's newest release. Deploy to Cloudflare copies Ember into a new
// repository without Ember's history, so the copy can't merge Ember's changes the usual way: this
// merges them itself, from the Ember commit the copy was made from, or the release its last update
// brought, so whatever the copy changed stays, such as the Worker's and bucket's names Deploy to
// Cloudflare wrote into wrangler.jsonc. The update is one commit on a branch named after the release,
// update-ember/v1.2.3, with conflict markers in any file where one of Ember's changes meets one of the
// copy's. A clone of Ember's repository shares its history, so it merges from where they part.
//
// The Update Ember workflow runs it every week with --publish, which pushes the branch and opens a
// pull request whose merge deploys the update (docs/self-hosting.md#updating). Without --publish, as
// for a copy on GitLab, run it in a clone of the copy, then push the branch it makes:
//
//   node apps/worker/scripts/update-ember.ts [--publish] [--beta]
//
// Ember's betas, such as v1.2.0-beta.1, which come before its releases, come only to a copy that asks
// for one, with --beta or the workflow's box for it, and to one that runs a beta already, which is
// brought the betas after it until a release passes it (docs/self-hosting.md#betas).

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { dataOf, type JsoncString, stringsOf } from "./jsonc.ts";

/** Ember's repository, where its releases are. */
const EMBER = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare";
/** Where to fetch Ember from, which the tests point at a repository of their own. */
const EMBER_REPOSITORY = process.env.EMBER_REPOSITORY || `${EMBER}.git`;
/**
 * Where Ember's main branch and release tags are fetched to, apart from the copy's own: a release is
 * refs/ember/v1.2.3, which git also knows as ember/v1.2.3, as conflict markers name it.
 */
const EMBER_REFS = "refs/ember/";
const EMBER_MAIN = `${EMBER_REFS}main`;
/** A release's tag, such as v1.2.3, or a beta's of it, such as v1.2.3-beta.4, which comes before the release. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;
/**
 * What names the release an update brought: the trailer in its commit's message, or the title of
 * its pull request, which a squash merge may keep alone.
 */
const RELEASE_NAMED = /^(?:Ember-Release: |Update Ember to )(v\d+\.\d+\.\d+(?:-beta\.\d+)?)\b/gm;
const UPDATE_TITLE = /^Update Ember to v\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
/** The release that an update's branch, update-ember/v1.2.3, or its issue's title, Update Ember to v1.2.3, offers. */
const OFFERED = /^(?:update-ember\/|Update Ember to )(v\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;
/** The trailer an update's commit has for each conflict git couldn't mark, which nothing in its file shows. */
const NOTED_CONFLICT = /^Ember-Conflict: (.+)$/gm;
/** A workflow's token can't change workflows, so a published update leaves the copy's as they are. */
const WORKFLOWS = ".github/workflows";
const UPDATE_WORKFLOW = `${WORKFLOWS}/update-ember.yml`;
/** The Worker's settings, where Deploy to Cloudflare writes what the deployer chose in its form. */
const WRANGLER = "wrangler.jsonc";
/** What Deploy to Cloudflare changes in what it copies: it writes names into the Worker's settings and the package's, and leaves out .github. */
const BUTTONS_CHANGES = [WRANGLER, "package.json", ".github"];
/** The settings Deploy to Cloudflare's form writes outside any binding: the Worker's name, and where its messages live. */
const DEPLOYERS_SETTINGS = ["name", "vars.STORAGE_BACKEND"];
/**
 * The members of a binding in each list whose values Deploy to Cloudflare's form writes, each with the one
 * the button adds it after when the file lacks it: a bucket's preview bucket after the bucket's name, and
 * the id of the database it makes after the database's name.
 */
const DEPLOYERS_MEMBERS: Record<string, Record<string, string | null>> = {
  r2_buckets: { bucket_name: null, preview_bucket_name: "bucket_name" },
  d1_databases: { database_name: null, database_id: "database_name", preview_database_id: "database_id" },
};
/** Where a binding's member is in wrangler.jsonc, by the binding's place in its list, such as `r2_buckets.0.bucket_name`. */
const BINDING_MEMBER = /^(\w+)\.(\d+)\.(\w+)$/;
/** A binding's member as `namesIn` names it, by the binding in place of its place: `r2_buckets.FILES.bucket_name`. */
const NAMED_MEMBER = /^(\w+)\.(\w+)\.(\w+)$/;
/** Where Ember says which release it is: a release's version is the one there. */
const VERSION_FILE = "apps/worker/package.json";
/** What GitHub answers a workflow that may not open pull requests, as a new repository's may not. */
const PULL_REQUESTS_NOT_PERMITTED = /not permitted to create or approve pull requests/i;
/**
 * Who gh says opened what a workflow opens with the token GitHub gives it, as this one's issues are: it
 * opens one only on the answer above, which GitHub gives that token alone. No person's login has a slash.
 */
const WORKFLOWS_AUTHOR = "app/github-actions";
/** The first git whose merge-tree takes --merge-base. */
const GIT_NEEDED = [2, 40, 0];

interface Release {
  tag: string;
  commit: string;
  /** Its numbers, then its beta's, which is Infinity for a release, as it comes after its betas. */
  version: number[];
}

interface Conflict {
  file: string;
  /** What git says of a conflict it couldn't mark in the file, as when one side deleted it, it isn't text, or a folder moved. */
  note?: string;
}

interface Update {
  release: Release;
  /** The Ember commit the copy's changes are measured from, and how to name it. */
  base: { commit: string; name: string };
  /** The releases it brings, oldest first. */
  releases: Release[];
  commit: string;
  conflicts: Conflict[];
  /** What a published update leaves as the copy has it: Ember's changes to its workflows, and whether its Update Ember differs. */
  workflows: { changed: boolean; updateDiffers: boolean };
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input?: string, env: Record<string, string> = {}): Result {
  const result = spawnSync(command, args, { encoding: "utf8", input, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `command` and answers its output, or throws with what it said if it fails. */
function check(command: string, args: string[], input?: string, env?: Record<string, string>): string {
  const result = run(command, args, input, env);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

const git = (args: string[], input?: string, env?: Record<string, string>) => check("git", args, input, env).trim();
/** Whether a git command whose exit status is its answer says yes. */
const gitSays = (args: string[]) => run("git", args).status === 0;
const isAncestor = (older: string, newer: string) => gitSays(["merge-base", "--is-ancestor", older, newer]);
const lastLine = (output: string) => output.trim().split("\n").at(-1) ?? "";

/** Orders versions by their numbers, first to last, so that a beta, whose last is its number, comes before its release. */
function compareVersions(a: number[], b: number[]): number {
  const at = a.findIndex((number, place) => number !== b[place]);
  return at === -1 ? 0 : a[at]! < b[at]! ? -1 : 1;
}

/** A tag's version, as `Release` has it, if it names one. */
function versionOf(tag: string): number[] | undefined {
  const [, ...numbers] = RELEASE_TAG.exec(tag) ?? [];
  return numbers.length > 0 ? numbers.map((number) => (number === undefined ? Infinity : Number(number))) : undefined;
}

const isBeta = (version: number[]) => version[3] !== Infinity;
const kindOf = (release: Release) => (isBeta(release.version) ? "beta" : "release");

function requireGit(): void {
  const version = git(["--version"]);
  const [major = 0, minor = 0] = /(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number) ?? [];
  if (compareVersions([major, minor, 0], GIT_NEEDED) < 0) {
    throw new Error(`Updating needs git ${GIT_NEEDED.slice(0, 2).join(".")} or newer, for merge-tree's --merge-base: this is ${version}.`);
  }
}

function fetchEmber(): void {
  git(["fetch", "--quiet", "--no-tags", "--force", EMBER_REPOSITORY, `+refs/heads/main:${EMBER_MAIN}`, `+refs/tags/v*:${EMBER_REFS}v*`]);
}

/** Ember's releases and betas, oldest first: its tags named for a version. */
function releases(): Release[] {
  const listing = git(["for-each-ref", "--format=%(refname:lstrip=2) %(objectname) %(*objectname)", EMBER_REFS]);
  return listing
    .split("\n")
    .flatMap((line) => {
      // A lightweight tag's object is its commit; an annotated tag's commit is the one it points at.
      const [tag = "", object = "", tagged] = line.split(" ");
      const version = versionOf(tag);
      return version ? [{ tag, commit: tagged || object, version }] : [];
    })
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * The commit of Ember's that Deploy to Cloudflare copied. A copy of a release or a beta, as a button
 * that names its tag makes, holds just what the tag does but for what the button changes, so it's the
 * commit of the tag that the copy's first commit says it's at. Any other is a copy of Ember's main,
 * made from the last commit there before the copy's first was made, since that commit's date is all
 * that ties the copy to Ember's history.
 */
function madeFrom(all: Release[]): string | undefined {
  const roots = git(["rev-list", "--max-parents=0", "HEAD"]).split("\n");
  const dates = git(["show", "--no-patch", "--format=%ct %cI %H", ...roots]).split("\n").map((line) => line.split(" "));
  const [, created, first = ""] = dates.sort(([a], [b]) => Number(a) - Number(b))[0]!;
  const tagged = all.find((release) => release.tag === tagAt(first));
  if (tagged && holdsTheSame(first, tagged.commit)) return tagged.commit;
  return git(["rev-list", "-1", "--first-parent", `--before=${created}`, EMBER_MAIN]) || undefined;
}

/** Whether the copy's commit `copied` holds just what Ember's `commit` does, but for what Deploy to Cloudflare changes. */
const holdsTheSame = (copied: string, commit: string) =>
  gitSays(["diff", "--quiet", commit, copied, "--", ...BUTTONS_CHANGES.map((changed) => `:(top,exclude)${changed}`)]);

/** The tag of the version that Ember's own file says `revision` is at, such as v1.2.3, if it says one. */
function tagAt(revision: string): string | undefined {
  try {
    const { version } = JSON.parse(fileAt(revision, VERSION_FILE) ?? "") as { version?: unknown };
    return versionOf(`v${String(version)}`) ? `v${String(version)}` : undefined;
  } catch {
    return undefined;
  }
}

/** The version the copy's code is at, as Ember's own file says, if it says one. */
const versionHere = () => versionOf(tagAt("HEAD") ?? "");

/**
 * The release to bring the copy up to: Ember's newest, or with `betas` asked for, its newest beta, where
 * that's newer. A copy that runs a beta is brought the betas after it too, until a release passes it,
 * which it's brought instead, and then releases alone.
 */
function newestFor(all: Release[], betas: boolean): Release | undefined {
  const newestRelease = all.filter((release) => !isBeta(release.version)).at(-1);
  const here = versionHere();
  const passed = here !== undefined && newestRelease !== undefined && compareVersions(newestRelease.version, here) > 0;
  const onBeta = here !== undefined && isBeta(here) && !passed;
  return betas || onBeta ? all.at(-1) : newestRelease;
}

/**
 * The releases the copy's updates brought, as their commits' messages name them, but those newer
 * than the copy's version, which reverting an update takes back with the rest of it.
 */
function releasesBrought(all: Release[]): Release[] {
  const named = new Set([...git(["log", "--format=%B", "HEAD"]).matchAll(RELEASE_NAMED)].map((match) => match[1]!));
  const version = versionHere();
  return all.filter((release) => named.has(release.tag) && (!version || compareVersions(release.version, version) <= 0));
}

/**
 * The Ember commit the copy's changes are measured from: the latest of where it parts from Ember's
 * history and the releases its updates brought, whose commits leave Ember's history out. A clone of
 * Ember's repository shares that history; a copy made with Deploy to Cloudflare parts from it at the
 * commit it was made from.
 */
function baseOf(newest: Release, all: Release[]): string {
  const shared = run("git", ["merge-base", "HEAD", newest.commit]);
  const parted = shared.status === 0 ? shared.stdout.trim() : madeFrom(all);
  const candidates = [parted, ...releasesBrought(all).map((release) => release.commit)];
  const known = candidates.filter((commit) => commit !== undefined);
  if (known.length === 0) throw new Error("This copy's first commit is older than Ember's, so it can't be a copy of Ember.");
  return known.reduce((latest, commit) => (isAncestor(latest, commit) ? commit : latest));
}

/** A base's name for people: its release's tag, or the commit's short hash. */
function nameOf(commit: string, all: Release[]): string {
  return all.find((release) => release.commit === commit)?.tag ?? `Ember's commit ${git(["rev-parse", "--short", commit])}`;
}

/** How git names a release fetched to refs/ember/. */
const refOf = (release: Release) => `ember/${release.tag}`;

/** Ember's changes from `base` to `release`, merged into the copy's as a tree, and where they conflict. */
function merge(base: string, release: Release): { tree: string; conflicts: Conflict[] } {
  const result = run("git", ["merge-tree", "--write-tree", "-z", "--name-only", `--merge-base=${base}`, "HEAD", refOf(release)]);
  // It answers 1 for a merge with conflicts, whose tree holds the markers, and more for one it couldn't make.
  if (result.status > 1) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
  // The tree, the files with conflicts, then after an empty field git's messages: each the number of
  // paths it's about, those paths, its type and its text.
  const fields = result.stdout.split("\0");
  const tree = fields.shift() ?? "";
  const files = fields.splice(0, fields.indexOf(""));
  fields.shift();
  const notes = new Map<string, string[]>();
  while (fields[0]) {
    const paths = fields.splice(0, Number(fields.shift()));
    const [type = "", text = ""] = fields.splice(0, 2);
    // A conflict in a file's lines leaves markers there, which say all there is to say.
    if (!type.startsWith("CONFLICT") || type === "CONFLICT (contents)") continue;
    // Some leave no file conflicted, as where git can't tell which folder a file belongs in: those go by their first path.
    const conflicted = paths.filter((file) => files.includes(file));
    for (const file of conflicted.length > 0 ? conflicted : paths.slice(0, 1)) notes.set(file, [...(notes.get(file) ?? []), text.trim()]);
  }
  const unlisted = [...notes.keys()].filter((file) => !files.includes(file));
  return { tree, conflicts: [...files, ...unlisted].map((file) => ({ file, note: notes.get(file)?.join(" ") })) };
}

/** `tree` as `edit` leaves it, edited in an index of its own. */
function edited(tree: string, edit: (env: Record<string, string>) => void): string {
  const scratch = mkdtempSync(path.join(tmpdir(), "update-ember-"));
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    git(["read-tree", tree], undefined, env);
    edit(env);
    return git(["write-tree"], undefined, env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `tree` with the copy's workflows in place of what the merge made of them. */
function withCopysWorkflows(tree: string): string {
  return edited(tree, (env) => {
    git(["rm", "-r", "--cached", "--force", "--quiet", "--ignore-unmatch", "--", WORKFLOWS], undefined, env);
    const workflows = check("git", ["ls-tree", "-r", "-z", "HEAD", "--", WORKFLOWS]);
    if (workflows) git(["update-index", "-z", "--index-info"], workflows, env);
  });
}

const withFile = (tree: string, file: string, content: string) =>
  edited(tree, (env) => git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", "--stdin"], content)},${file}`], undefined, env));

/** A file as `revision` has it, if it has it. */
function fileAt(revision: string, file: string): string | undefined {
  const result = run("git", ["show", `${revision}:${file}`]);
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * The names Deploy to Cloudflare writes into wrangler.jsonc, and where they are, by their path, with each
 * binding's place in its list given as the binding, which stays its resource's wherever it moves in the
 * list: `name`, `vars.STORAGE_BACKEND`, `r2_buckets.FILES.bucket_name`, `d1_databases.DB.database_id`.
 */
function namesIn(text: string): Map<string, JsoncString> {
  const strings = stringsOf(text);
  const bindings = new Map<string, string>();
  for (const { path, value } of strings) {
    const [, list, place, member] = BINDING_MEMBER.exec(path) ?? [];
    if (member === "binding") bindings.set(`${list}.${place}`, value);
  }
  const names = new Map<string, JsoncString>();
  for (const string of strings) {
    const [, list, place, member] = BINDING_MEMBER.exec(string.path) ?? [];
    const binding = bindings.get(`${list}.${place}`);
    if (DEPLOYERS_SETTINGS.includes(string.path)) names.set(string.path, string);
    else if (binding !== undefined && DEPLOYERS_MEMBERS[list!]?.[member!] !== undefined) names.set(`${list}.${binding}.${member}`, string);
  }
  return names;
}

const deployersNames = (text: string) => new Map([...namesIn(text)].map(([what, { value }]): [string, string] => [what, value]));

/**
 * Where in a file whose names are `here` the button would add the member that `what` names, which the file
 * lacks: after the nearest member before it that the file has, as a preview bucket goes after its bucket's
 * name. Anything else, and a member whose binding the file lacks, goes nowhere.
 */
function besideWhat(what: string, here: Map<string, JsoncString>): JsoncString | undefined {
  const [, list, binding, member] = NAMED_MEMBER.exec(what) ?? [];
  for (let before = DEPLOYERS_MEMBERS[list!]?.[member!]; before; before = DEPLOYERS_MEMBERS[list!]![before]) {
    const beside = here.get(`${list}.${binding}.${before}`);
    if (beside) return beside;
  }
  return undefined;
}

/**
 * `text` with the names of what `names` names set to theirs, and each member it lacks added after the one
 * Deploy to Cloudflare adds it after, as the button writes it.
 */
function withNames(text: string, names: Map<string, string>): string {
  const here = namesIn(text);
  const edits = [...names].flatMap(([what, name]) => {
    const named = here.get(what);
    if (named) return [{ start: named.start, end: named.end, text: JSON.stringify(name) }];
    const beside = besideWhat(what, here);
    return beside ? [{ start: beside.end, end: beside.end, text: `,${JSON.stringify(NAMED_MEMBER.exec(what)![3])}: ${JSON.stringify(name)}` }] : [];
  });
  // From the end back, so each edit's place is still where it was; members added after the same one go
  // in last first, which leaves them in the order `names` has them.
  return edits
    .map((edit, order) => ({ ...edit, order }))
    .sort((a, b) => b.start - a.start || b.order - a.order)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);
}

/** `text` without the members that name what `whats` name, nor the comma after each. */
function withoutNames(text: string, whats: string[]): string {
  const here = namesIn(text);
  const members = whats.flatMap((what) => here.get(what) ?? []).sort((a, b) => b.member - a.member);
  return members.reduce((result, { member, end }) => result.slice(0, member) + result.slice(end).replace(/^\s*,/, ""), text);
}

/**
 * Ember's wrangler.jsonc at `release` with what the copy's deployer chose in Deploy to Cloudflare's form,
 * its Worker's, bucket's and database's names and where its messages live, when those are all the copy
 * changed there, however the button laid the file out: they sit beside lines Ember changes, such as their
 * comments, where a merge would leave conflict markers. What the button adds, a bucket's preview bucket and
 * the id of the database it made, counts among them. A name whose binding the release lacks, as when
 * Ember renames one, is the merge's to place.
 */
function wranglerWithCopysNames(base: string, release: Release): string | undefined {
  const [ours, was, now] = ["HEAD", base, release.commit].map((revision) => fileAt(revision, WRANGLER));
  if (ours === undefined || was === undefined || now === undefined) return undefined;
  try {
    const names = deployersNames(ours);
    const added = [...names.keys()].filter((what) => !namesIn(was).has(what));
    const onlyNamed = isDeepStrictEqual(dataOf(withoutNames(withNames(ours, deployersNames(was)), added)), dataOf(was));
    const placed = [...names.keys()].every((what) => namesIn(now).has(what) || besideWhat(what, namesIn(now)) !== undefined);
    return onlyNamed && placed ? withNames(now, names) : undefined;
  } catch {
    // Not JSONC that this reads, so it's the merge's to make.
    return undefined;
  }
}

/** What a published update leaves of Ember's at `release`: whether it changed workflows since `base`, and its Update Ember from the copy's. */
function workflowsLeft(base: string, release: Release): Update["workflows"] {
  const changed = !gitSays(["diff", "--quiet", base, release.commit, "--", WORKFLOWS]);
  const blob = (revision: string) => run("git", ["rev-parse", "--verify", "--quiet", `${revision}:${UPDATE_WORKFLOW}`]).stdout.trim();
  return { changed, updateDiffers: blob("HEAD") !== blob(release.commit) };
}

/**
 * The update's commit, whose message names its release for the next update to measure from, and the
 * conflicts git couldn't mark, for a later run to find on its branch.
 */
function commitOf(tree: string, release: Release, base: Update["base"], conflicts: Conflict[]): string {
  const noted = conflicts.filter((conflict) => conflict.note).map((conflict) => `Ember-Conflict: ${JSON.stringify(conflict)}\n`);
  const message = `Update Ember to ${release.tag}\n\nBrings this copy up to Ember ${release.tag} from ${base.name}: ${EMBER}/compare/${base.commit}...${release.tag}\n\nEmber-Release: ${release.tag}\n${noted.join("")}`;
  return git(["commit-tree", tree, "-p", "HEAD", "-F", "-"], message);
}

const branchOf = (release: Release) => `update-ember/${release.tag}`;
const titleOf = (release: Release) => `Update Ember to ${release.tag}`;
const releaseLink = (release: Release) => `[${release.tag}](${EMBER}/releases/tag/${release.tag})`;

/** How to settle the update's conflicts: those git marked in their files, and those it has a note on. */
function conflictsHelp(update: Update): string {
  const markers = `conflict markers around both versions: your copy's lines after \`<<<<<<< HEAD\`, and Ember's after \`=======\` up to \`>>>>>>> ${refOf(update.release)}\``;
  const kept = "it kept your copy's version unless its note says otherwise";
  const marked = update.conflicts.some((conflict) => !conflict.note);
  const noted = update.conflicts.some((conflict) => conflict.note);
  const how = !noted ? `Git left ${markers}.` : !marked ? `Git couldn't mark where they meet, so ${kept}.` : `Where git could, it left ${markers}. Where it couldn't, ${kept}.`;
  return `On this branch, edit each of these files to keep what both need, and commit. ${how}`;
}

/** What the update brings and what it needs, for its pull request or issue. */
function details(update: Update): string[] {
  const { release, base } = update;
  const lines = [
    `What's new: ${update.releases.map(releaseLink).join(", ")}, and [every change](${EMBER}/compare/${base.commit}...${release.tag}). ` +
      "Whatever your copy changed stays as it is, such as your Worker's and bucket's names, and Ember's tables bring themselves up to date as each opens after the deploy.",
  ];
  if (isBeta(release.version)) {
    lines.push(
      "",
      "**This is a beta** of Ember's next release, which a copy is offered only when it asks for one or runs one already: " +
        "the betas after it come the same way, then the release, and from then on releases alone.",
    );
  }
  if (update.conflicts.length > 0) {
    lines.push(
      "",
      `**This needs a hand before it's merged.** Some of Ember's changes meet ones made in your copy. ${conflictsHelp(update)}`,
      "",
      ...update.conflicts.map(({ file, note }) => `- \`${file}\`${note ? `: \`${note}\`` : ""}`),
    );
  }
  if (update.workflows.updateDiffers) {
    lines.push(
      "",
      "GitHub doesn't let a workflow change workflows, so this leaves your copy's as they are. Ember's others run only in its own repository, " +
        `but the one that makes these updates has a new version: copy [Ember's](${EMBER}/blob/${release.tag}/${UPDATE_WORKFLOW}) over \`${UPDATE_WORKFLOW}\` to have it.`,
    );
  } else if (update.workflows.changed) {
    lines.push("", "GitHub doesn't let a workflow change workflows, so this leaves out Ember's changes to its own, which run only in Ember's repository.");
  }
  return lines;
}

function pullRequestBody(update: Update): string {
  const merging = update.conflicts.length > 0 ? "Once that's done, merging it" : "Merging it";
  const intro = `This brings your copy of Ember up to ${releaseLink(update.release)} from ${update.base.name}. ${merging} deploys the update, as every push to your main branch does.`;
  return [intro, "", ...details(update)].join("\n");
}

function issueBody(update: Update, openLink: string): string {
  return [
    `Ember ${releaseLink(update.release)} is out, and the branch \`${branchOf(update.release)}\` brings your copy up to it from ${update.base.name}. ` +
      `**[Open its pull request](${openLink})**, then merge it to deploy the update. This issue closes itself once your copy has it.`,
    "",
    "The Update Ember workflow can open the pull request itself once GitHub lets it: in your repository's **Settings**, under " +
      "**Actions** → **General** → **Workflow permissions**, tick **Allow GitHub Actions to create and approve pull requests**, and save.",
    "",
    ...details(update),
  ].join("\n");
}

/** GitHub's page for opening the update's pull request, with its title and description filled in. */
function openPullRequestLink(main: string, branch: string, title: string, body: string): string {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const query = `expand=1&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return `${server}/${process.env.GITHUB_REPOSITORY}/compare/${main}...${branch}?${query}`;
}

/** What a gh listing finds, or nothing if it can't look, as when the repository has no issues. */
function listed<T>(args: string[]): T[] {
  const result = run("gh", args);
  return result.status === 0 ? (JSON.parse(result.stdout) as T[]) : [];
}

/** A pull request as gh lists it, with whether its branch is in another repository than the copy's, as a fork's is. */
interface ListedPull {
  headRefName: string;
  isCrossRepository?: boolean;
}

/** An issue as gh lists it, with who opened it. */
interface ListedIssue {
  title: string;
  author?: { login?: string };
}

/**
 * Whether a pull request's branch is in the copy's own repository, where only those who may push to it
 * can make or change one. Anyone can open one from a fork, with a branch there named as an update's.
 */
const isFromCopy = (pull: ListedPull) => pull.isCrossRepository === false;

/** Whether an issue is one this workflow opened. Anyone who may open one can give it an update's title. */
const isWorkflows = (issue: ListedIssue) => issue.author?.login === WORKFLOWS_AUTHOR;

/**
 * Closes the pull requests and issues for updates the copy needs no more: those for older releases
 * than `newest`, which `where` offers, or once the copy has `newest`, those up to it. One for a newer
 * beta, which the copy asked for, stays open until a release passes it, and so does anyone else's
 * that looks like an update's, which isn't this workflow's to close.
 */
function closeStale(newest: Release, where?: string): void {
  const reason = where ? `Ember ${newest.tag} is out, so ${where} brings this copy up to it instead.` : `This copy has Ember's newest ${kindOf(newest)} now.`;
  const isStale = (offer: string) => {
    const version = versionOf(OFFERED.exec(offer)?.[1] ?? "");
    const order = version ? compareVersions(version, newest.version) : -1;
    return where ? order < 0 : order <= 0;
  };
  for (const pull of listed<ListedPull & { number: number }>(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,isCrossRepository"])) {
    if (pull.headRefName.startsWith("update-ember/") && isFromCopy(pull) && isStale(pull.headRefName)) {
      run("gh", ["pr", "close", String(pull.number), "--delete-branch", "--comment", reason]);
    }
  }
  const issues = listed<ListedIssue & { number: number }>(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,author"]);
  for (const issue of issues) {
    if (UPDATE_TITLE.test(issue.title) && isWorkflows(issue) && isStale(issue.title)) run("gh", ["issue", "close", String(issue.number), "--comment", reason]);
  }
}

/** Says what happened, in the log and, in a workflow, its run's summary. */
function report(message: string): void {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

/** Leaves the update on its branch, for whoever ran this to push, unless an earlier run left it there. */
function makeBranch(update: Update): void {
  const branch = branchOf(update.release);
  if (gitSays(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    // It may hold what whoever ran this fixed and committed there since.
    return report(`${branch} is made already: push it and merge it to update, or delete it (git branch -D ${branch}) and run this again to have it made anew.`);
  }
  git(["branch", branch, update.commit]);
  const files = update.conflicts.map((conflict) => conflict.file).join(", ");
  const conflicts = update.conflicts.length > 0 ? ` First fix the conflicts in ${files} on it and commit.` : "";
  const notes = update.conflicts.flatMap(({ file, note }) => (note ? [`${file}: ${note}`] : []));
  report(
    [
      `${branch} brings this copy up to Ember ${update.release.tag} from ${update.base.name}.${conflicts} ` +
        `Then push it (git push -u origin ${branch}) and merge it into your main branch to deploy it.`,
      ...notes,
    ].join("\n"),
  );
}

/**
 * The conflicts on origin's `branch`, which an earlier run pushed with the update to `release`: the
 * files that still have the markers it leaves, and those git couldn't mark, as its commit names them.
 */
function conflictsOn(branch: string, release: Release): Conflict[] {
  git(["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`]);
  // In a file one side renamed, each side's name has its path after it.
  const marker = `^>>>>>>> ${refOf(release).replaceAll(".", "\\.")}(:.*)?$`;
  const found = run("git", ["grep", "-l", "-z", "-E", "-e", marker, "FETCH_HEAD", "--"]);
  // It answers 1 when it finds none, and more when it couldn't look.
  if (found.status > 1) throw new Error(`git grep failed: ${found.stderr.trim()}`);
  const marked = found.stdout
    .split("\0")
    .filter(Boolean)
    .map((match) => match.slice("FETCH_HEAD:".length));
  // The branch's own commits, those the copy's main lacks, include the update's.
  const noted = [...git(["log", "--format=%B", "HEAD..FETCH_HEAD"]).matchAll(NOTED_CONFLICT)].map((match) => JSON.parse(match[1]!) as Conflict);
  return [...marked.filter((file) => !noted.some((conflict) => conflict.file === file)).map((file) => ({ file })), ...noted];
}

/**
 * The pull request or issue that offered `release` before, an open one rather than one closed: a pull
 * request for the update's branch in the copy's own repository, or an issue this workflow opened, and
 * no one else's that is named as one.
 */
function offerOf(release: Release): { url: string; state: string } | undefined {
  const branch = branchOf(release);
  const pulls = listed<ListedPull & { url: string; state: string }>(["pr", "list", "--head", branch, "--state", "all", "--json", "url,state,headRefName,isCrossRepository"]);
  const issues = listed<ListedIssue & { url: string; state: string }>(["issue", "list", "--state", "all", "--limit", "100", "--json", "url,state,title,author"]);
  const offers = [
    ...pulls.filter((pull) => pull.headRefName === branch && isFromCopy(pull)),
    ...issues.filter((issue) => issue.title === titleOf(release) && isWorkflows(issue)),
  ];
  return offers.find((offer) => offer.state === "OPEN") ?? offers[0];
}

/**
 * Pushes the update's branch and opens its pull request, once per release: closing it turns that
 * release down. A new repository doesn't let workflows open pull requests, so then it opens an issue
 * with a link that opens it in a click.
 */
function publish(update: Update): void {
  const branch = branchOf(update.release);
  const offer = offerOf(update.release);
  if (offer?.state === "OPEN") {
    closeStale(update.release, offer.url);
    return report(`${offer.url} offers this copy Ember ${update.release.tag} already.`);
  }
  // Closed, or merged and since reverted: either way, its release is turned down.
  if (offer) return report(`${offer.url} offered this copy Ember ${update.release.tag} and is ${offer.state.toLowerCase()} now, so this waits for Ember's next release.`);
  // A run that pushed the branch but couldn't offer it leaves it to offer now, with whatever it has
  // since, so the conflicts it describes are the branch's rather than this run's merge's. A conflict
  // git couldn't mark leaves nothing there to show it's settled, so its note stays.
  const pushed = gitSays(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
  if (!pushed) git(["push", "--quiet", "origin", `${update.commit}:refs/heads/${branch}`]);
  const offering = pushed ? { ...update, conflicts: conflictsOn(branch, update.release) } : update;
  const main = git(["symbolic-ref", "--short", "HEAD"]);
  const title = titleOf(update.release);
  const body = pullRequestBody(offering);
  const draft = offering.conflicts.length > 0 ? ["--draft"] : [];
  const opened = run("gh", ["pr", "create", "--base", main, "--head", branch, "--title", title, "--body-file", "-", ...draft], body);
  if (opened.status === 0) {
    const where = lastLine(opened.stdout);
    closeStale(update.release, where);
    return report(`Opened ${where}, which brings this copy up to Ember ${update.release.tag}.`);
  }
  if (!PULL_REQUESTS_NOT_PERMITTED.test(opened.stderr)) throw new Error(`gh pr create failed: ${opened.stderr.trim()}`);
  const link = openPullRequestLink(main, branch, title, body);
  const filed = run("gh", ["issue", "create", "--title", title, "--body-file", "-"], issueBody(offering, link));
  if (filed.status !== 0) {
    report(`GitHub doesn't let this workflow open pull requests, so open ${branch}'s yourself: ${link}`);
    throw new Error(`gh issue create failed too: ${filed.stderr.trim()}`);
  }
  const where = lastLine(filed.stdout);
  closeStale(update.release, where);
  report(`GitHub doesn't let this workflow open pull requests, so ${where} links to the one that brings this copy up to Ember ${update.release.tag}.`);
}

function update(args: string[]): void {
  const publishing = args.includes("--publish");
  // The Update Ember workflow's box for a beta, which running it from the Actions tab offers, says so as EMBER_BETA.
  const betas = args.includes("--beta") || process.env.EMBER_BETA === "true";
  requireGit();
  process.chdir(git(["rev-parse", "--show-toplevel"]));
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("This clone is shallow, so it lacks the copy's first commit: run git fetch --unshallow, then this again.");
  }
  fetchEmber();
  const all = releases();
  const newest = newestFor(all, betas);
  if (!newest) return report("Ember has no releases yet.");
  const base = baseOf(newest, all);
  if (isAncestor(newest.commit, base)) {
    if (publishing) closeStale(newest);
    return report(`This copy has everything in Ember's newest ${kindOf(newest)}, ${newest.tag}.`);
  }
  const merged = merge(base, newest);
  const wrangler = wranglerWithCopysNames(base, newest);
  const named = wrangler === undefined ? merged.tree : withFile(merged.tree, WRANGLER, wrangler);
  // A workflow's token can't push a commit that changes workflows, so a published update keeps the copy's.
  const tree = publishing ? withCopysWorkflows(named) : named;
  const conflicts = merged.conflicts.filter(({ file }) => !(wrangler !== undefined && file === WRANGLER) && !(publishing && file.startsWith(`${WORKFLOWS}/`)));
  const workflows = publishing ? workflowsLeft(base, newest) : { changed: false, updateDiffers: false };
  if (tree === git(["rev-parse", "HEAD^{tree}"])) {
    return report(`Ember ${newest.tag} changes nothing this copy has${workflows.changed ? " but Ember's own workflows" : ""}.`);
  }
  const from = { commit: base, name: nameOf(base, all) };
  // A release brings the releases since the base; a beta, the betas since it too.
  const brought = all.filter(
    (release) => compareVersions(release.version, newest.version) <= 0 && !isAncestor(release.commit, base) && (isBeta(newest.version) || !isBeta(release.version)),
  );
  const result = { release: newest, base: from, releases: brought, commit: commitOf(tree, newest, from, conflicts), conflicts, workflows };
  if (publishing) publish(result);
  else makeBranch(result);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    update(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./update-ember.ts", import.meta.url));
const WORKFLOW = ".github/workflows/update-ember.yml";

/**
 * Stands in for the GitHub CLI: it notes each call in $GH_LOG/calls and what it read in
 * $GH_LOG/<command>-body. `pr create` opens pull request 7, unless $GH_PR_FAILS has it fail saying
 * that, and `issue create` opens issue 8; the listings answer $GH_PULLS and $GH_ISSUES, or else what
 * it opened, listed as gh lists a workflow's: a pull request from a branch of the copy's own
 * repository, and an issue GitHub Actions opened.
 */
const GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG/calls"
# The value the arguments after the first give the option the first names.
option() { local name=$1; shift; while [ $# -gt 0 ] && [ "$1" != "$name" ]; do shift; done; echo "$2"; }
case "$1 $2" in
  "pr create")
    cat > "$GH_LOG/pr-body"
    if [ -n "$GH_PR_FAILS" ]; then echo "$GH_PR_FAILS" >&2; exit 1; fi
    printf '[{ "url": "https://github.com/me/chat/pull/7", "state": "OPEN", "headRefName": "%s", "isCrossRepository": false }]' "$(option --head "$@")" > "$GH_LOG/pulls"
    echo "https://github.com/me/chat/pull/7" ;;
  "issue create")
    cat > "$GH_LOG/issue-body"
    printf '[{ "url": "https://github.com/me/chat/issues/8", "state": "OPEN", "title": "%s", "author": { "is_bot": true, "login": "app/github-actions" } }]' "$(option --title "$@")" > "$GH_LOG/issues"
    echo "https://github.com/me/chat/issues/8" ;;
  "pr list") echo "\${GH_PULLS:-$(cat "$GH_LOG/pulls" 2>/dev/null || echo "[]")}" ;;
  "issue list") echo "\${GH_ISSUES:-$(cat "$GH_LOG/issues" 2>/dev/null || echo "[]")}" ;;
esac
`;
const PULL_REQUESTS_NOT_PERMITTED = "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)";
/** What gh lists of a pull request from a branch of the copy's own repository, and of one from a fork's. */
const FROM_COPY = { isCrossRepository: false };
const FROM_FORK = { isCrossRepository: true };
/** What gh lists of an issue the workflow opened, and of one somebody else did. */
const BY_WORKFLOW = { author: { is_bot: true, login: "app/github-actions" } };
const BY_SOMEONE = { author: { is_bot: false, login: "someone", id: "U_1", name: "" } };

let dir: string;
/** git's settings for these repositories alone, whatever the machine's say. */
let gitEnv: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "update-ember-test-"));
  writeFileSync(path.join(dir, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
  gitEnv = {
    GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    // So git says what it says of conflicts in English.
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs git in `repo`, with any commit it makes dated `date`, so a copy's history lines up with Ember's. */
function git(repo: string, args: string[], date = "2026-10-01T12:00:00Z"): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Writes `files` into `repo`, deleting those given null, and commits them on `date`. */
function commit(repo: string, date: string, files: Record<string, string | null>, message = "A change"): string {
  for (const [file, content] of Object.entries(files)) {
    const at = path.join(repo, file);
    if (content === null) {
      rmSync(at);
    } else {
      mkdirSync(path.dirname(at), { recursive: true });
      writeFileSync(at, content);
    }
  }
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "--message", message], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

const app = (second: string) => `one\n${second}\nthree\nfour\nfive\nsix\nseven\n`;
const wrangler = (name: string, bucket: string, date = "2026-09-01") =>
  `{\n  // The Worker.\n  "name": "${name}",\n  "main": "src/index.ts",\n  "compatibility_date": "${date}",\n  "assets": { "directory": "dist" },\n  // Its files.\n  "r2_buckets": [{ "binding": "FILES", "bucket_name": "${bucket}" }],\n}\n`;

/**
 * Ember's repository: v0.1.0 on October 1st, a change to main on the 5th, and v0.2.0 on the 10th,
 * which changes that line again, and its Worker's settings, and the workflow that makes updates.
 */
function ember(): string {
  const repo = path.join(dir, "ember");
  mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  commit(repo, "2026-10-01T12:00:00Z", {
    "wrangler.jsonc": wrangler("ember", "ember"),
    "src/app.ts": app("two"),
    "apps/worker/package.json": '{ "version": "0.1.0" }\n',
    [WORKFLOW]: "on: schedule\n",
    ".github/workflows/ci.yml": "on: push\n",
  });
  git(repo, ["tag", "v0.1.0"]);
  commit(repo, "2026-10-05T12:00:00Z", { "src/app.ts": app("TWO") });
  // What the copy below is made from.
  git(repo, ["branch", "copied"]);
  commit(repo, "2026-10-10T12:00:00Z", {
    "src/app.ts": app("Two!"),
    "src/new.ts": "export {};\n",
    "wrangler.jsonc": wrangler("ember", "ember", "2026-10-10"),
    "apps/worker/package.json": '{ "version": "0.2.0" }\n',
    [WORKFLOW]: "on: schedule # weekly\n",
  });
  git(repo, ["tag", "v0.2.0"]);
  return repo;
}

/** Ember's next release, v0.3.0, on the 20th, which changes the line once more. */
function releaseNext(repo: string): void {
  commit(repo, "2026-10-20T12:00:00Z", { "src/app.ts": app("2"), "apps/worker/package.json": '{ "version": "0.3.0" }\n' });
  git(repo, ["tag", "v0.3.0"]);
}

/** A beta of Ember's next release, v0.3.0-beta.1 on the 15th and so on, which changes the line on the way to it. */
function releaseBeta(repo: string, number = 1): void {
  commit(repo, `2026-10-${14 + number}T12:00:00Z`, { "src/app.ts": app(`beta ${number}`), "apps/worker/package.json": `{ "version": "0.3.0-beta.${number}" }\n` });
  git(repo, ["tag", `v0.3.0-beta.${number}`]);
}

/**
 * A copy as Deploy to Cloudflare makes one: a new repository whose one commit, on October 6th, holds
 * Ember's main of the 5th, with the Worker and bucket named as the deployer named them; or, on `date`,
 * Ember as it was at `made`.
 */
function deployedCopy(ember: string, settings = wrangler("my-chat", "my-files"), { made = "copied", date = "2026-10-06T09:00:00Z" } = {}): string {
  const copy = path.join(dir, "copy");
  mkdirSync(copy);
  git(copy, ["init", "--quiet"]);
  const files = Object.fromEntries(git(ember, ["ls-tree", "-r", "--name-only", made]).split("\n").map((file) => [file, git(ember, ["show", `${made}:${file}`]) + "\n"]));
  commit(copy, date, { ...files, "wrangler.jsonc": settings }, "Initial commit");
  return copy;
}

/** Runs the script in `repo` with `args`, fetching Ember from `ember`. */
function update(repo: string, ember: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv, EMBER_REPOSITORY: ember, ...env } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const show = (repo: string, revision: string, file: string) => git(repo, ["show", `${revision}:${file}`]);

describe("updating a copy made with Deploy to Cloudflare", () => {
  it("brings Ember's newest release onto a branch, keeping the copy's own changes", () => {
    const copy = deployedCopy(ember());
    const { status, output } = update(copy, path.join(dir, "ember"));
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.2.0 brings this copy up to Ember v0.2.0");
    const branch = "update-ember/v0.2.0";
    expect(git(copy, ["rev-parse", `${branch}~1`])).toBe(git(copy, ["rev-parse", "main"]));
    expect(show(copy, branch, "wrangler.jsonc")).toBe(wrangler("my-chat", "my-files", "2026-10-10").trim());
    expect(show(copy, branch, "src/new.ts")).toBe("export {};");
    // Without --publish, whoever runs it pushes it, so the workflows come too.
    expect(show(copy, branch, WORKFLOW)).toBe("on: schedule # weekly");
    expect(git(copy, ["log", "-1", "--format=%B", branch])).toMatch(/^Update Ember to v0\.2\.0\n[\s\S]*\nEmber-Release: v0\.2\.0$/);
  });

  it("measures the copy's changes from the commit it was made from, not the release before", () => {
    const copy = deployedCopy(ember());
    expect(update(copy, path.join(dir, "ember")).output).toContain("from Ember's commit");
    // From v0.1.0, the copy's line would look changed on both sides, and conflict.
    expect(show(copy, "update-ember/v0.2.0", "src/app.ts")).toBe(app("Two!").trim());
  });

  it("finds nothing to do once the update is merged", () => {
    const repo = ember();
    const copy = deployedCopy(repo);
    update(copy, repo);
    git(copy, ["merge", "--quiet", "--ff-only", "update-ember/v0.2.0"]);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("This copy has everything in Ember's newest release, v0.2.0.");
  });

  it("measures the next update from the release the last one brought, even squashed under its pull request's title", () => {
    const repo = ember();
    const copy = deployedCopy(repo);
    update(copy, repo);
    git(copy, ["checkout", "--quiet", "update-ember/v0.2.0", "--", "."]);
    git(copy, ["commit", "--quiet", "--message", "Update Ember to v0.2.0 (#3)"], "2026-10-12T12:00:00Z");
    releaseNext(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.3.0 brings this copy up to Ember v0.3.0 from v0.2.0.");
    expect(show(copy, "update-ember/v0.3.0", "src/app.ts")).toBe(app("2").trim());
  });

  it("measures the next update from before one the copy reverted", () => {
    const repo = ember();
    const copy = deployedCopy(repo);
    update(copy, repo);
    git(copy, ["merge", "--quiet", "--ff-only", "update-ember/v0.2.0"]);
    git(copy, ["revert", "--no-edit", "HEAD"], "2026-10-12T12:00:00Z");
    releaseNext(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.3.0 brings this copy up to Ember v0.3.0 from Ember's commit");
    // From v0.2.0, its new file would look deleted in the copy, and its line changed there.
    expect(show(copy, "update-ember/v0.3.0", "src/new.ts")).toBe("export {};");
    expect(show(copy, "update-ember/v0.3.0", "src/app.ts")).toBe(app("2").trim());
  });

  it("leaves conflict markers where one of Ember's changes meets one of the copy's", () => {
    const repo = ember();
    const copy = deployedCopy(repo);
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("First fix the conflicts in src/app.ts on it and commit.");
    expect(show(copy, "update-ember/v0.2.0", "src/app.ts")).toMatch(/<<<<<<< HEAD\n[\s\S]*our two[\s\S]*=======[\s\S]*Two![\s\S]*>>>>>>> ember\/v0\.2\.0/);
  });

  it("says what git kept where it couldn't mark a conflict", () => {
    const repo = ember();
    commit(repo, "2026-10-11T12:00:00Z", { "src/app.ts": null, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const copy = deployedCopy(repo);
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("First fix the conflicts in src/app.ts on it and commit.");
    expect(output).toContain("\nsrc/app.ts: CONFLICT (modify/delete): src/app.ts deleted in ember/v0.2.1 and modified in HEAD.");
    expect(show(copy, "update-ember/v0.2.1", "src/app.ts")).toBe(app("our two").trim());
  });

  it("leaves a branch an earlier run made as it is, with what was fixed on it", () => {
    const repo = ember();
    const copy = deployedCopy(repo);
    update(copy, repo);
    git(copy, ["switch", "--quiet", "update-ember/v0.2.0"]);
    const fixed = commit(copy, "2026-10-12T12:00:00Z", { "src/app.ts": app("fixed") });
    git(copy, ["switch", "--quiet", "main"]);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.2.0 is made already");
    expect(git(copy, ["rev-parse", "update-ember/v0.2.0"])).toBe(fixed);
  });

  it("keeps the copy's names for its Worker and bucket where Ember changes the lines beside them", () => {
    const repo = ember();
    const commented = wrangler("ember", "ember", "2026-10-10").replace("// The Worker.", "// The Worker, named.").replace("// Its files.", "// Its files, named.");
    commit(repo, "2026-10-11T12:00:00Z", { "wrangler.jsonc": commented, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const copy = deployedCopy(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).not.toContain("conflict markers");
    expect(show(copy, "update-ember/v0.2.1", "wrangler.jsonc")).toBe(wrangler("my-chat", "my-files", "2026-10-10").replace("// The Worker.", "// The Worker, named.").replace("// Its files.", "// Its files, named.").trim());
  });

  it("keeps the preview bucket Deploy to Cloudflare adds after the bucket's name, as the button writes it, where Ember changes the lines beside them", () => {
    const repo = ember();
    const commented = wrangler("ember", "ember", "2026-10-10").replace("// The Worker.", "// The Worker, named.").replace("// Its files.", "// Its files, named.");
    commit(repo, "2026-10-11T12:00:00Z", { "wrangler.jsonc": commented, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const asDeployed = (settings: string) => settings.replace('"name": "ember"', '"name": "my-chat"').replace('"bucket_name": "ember"', '"bucket_name": "my-files","preview_bucket_name": "my-files"');
    const copy = deployedCopy(repo, asDeployed(wrangler("ember", "ember")));
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).not.toContain("conflict");
    expect(show(copy, "update-ember/v0.2.1", "wrangler.jsonc")).toBe(asDeployed(commented).trim());
  });

  it("keeps the copy's D1 database, with the id Deploy to Cloudflare adds after its name, and where its messages live, where Ember changes the lines beside them", () => {
    const repo = ember();
    /** `settings` with messages kept on DO SQLite and a D1 database bound for D1, under `comment`. */
    const onD1 = (settings: string, comment: string) =>
      settings.replace(
        "  // Its files.",
        `  "vars": { "STORAGE_BACKEND": "do-sqlite" },\n  // ${comment}\n  "d1_databases": [{ "binding": "DB", "database_name": "ember", "migrations_dir": "migrations" }],\n  // Its files.`,
      );
    // v0.2.1 binds the database, and the copy is made from it; v0.2.2 changes the comment between the copy's choices.
    const bound = onD1(wrangler("ember", "ember", "2026-10-10"), "Its messages, on D1.");
    commit(repo, "2026-10-11T12:00:00Z", { "wrangler.jsonc": bound, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const commented = onD1(wrangler("ember", "ember", "2026-10-10"), "Its messages, when STORAGE_BACKEND is d1.");
    commit(repo, "2026-10-12T12:00:00Z", { "wrangler.jsonc": commented, "apps/worker/package.json": '{ "version": "0.2.2" }\n' });
    git(repo, ["tag", "v0.2.2"]);
    const asDeployed = (settings: string) =>
      settings
        .replace('"name": "ember"', '"name": "my-chat"')
        .replace('"STORAGE_BACKEND": "do-sqlite"', '"STORAGE_BACKEND": "d1"')
        .replace('"database_name": "ember"', '"database_name": "my-messages","database_id": "0f9e8d7c-6b5a-4f3e-9d2c-1b0a98765432"');
    const copy = deployedCopy(repo, asDeployed(bound), { made: "v0.2.1", date: "2026-10-11T18:00:00Z" });
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).not.toContain("conflict");
    expect(show(copy, "update-ember/v0.2.2", "wrangler.jsonc")).toBe(asDeployed(commented).trim());
  });

  it("gives a copy made before Ember bound a D1 database Ember's, and keeps where the copy's messages live", () => {
    const repo = ember();
    const withVars = (settings: string, backend: string) => settings.replace("  // Its files.", `  "vars": { "STORAGE_BACKEND": "${backend}" },\n  // Its files.`);
    // The copy is made from main on the 5th, with STORAGE_BACKEND as the form had it, and v0.2.1 binds the database.
    git(repo, ["switch", "--quiet", "copied"]);
    commit(repo, "2026-10-05T13:00:00Z", { "wrangler.jsonc": withVars(wrangler("ember", "ember"), "do-sqlite") });
    git(repo, ["branch", "--force", "main"]);
    git(repo, ["switch", "--quiet", "main"]);
    git(repo, ["tag", "--delete", "v0.2.0"]);
    const bound = withVars(wrangler("ember", "ember", "2026-10-10"), "do-sqlite").replace(
      "  // Its files.",
      '  "d1_databases": [{ "binding": "DB", "database_name": "ember" }],\n  // Its files.',
    );
    commit(repo, "2026-10-11T12:00:00Z", { "wrangler.jsonc": bound, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const copy = deployedCopy(repo, withVars(wrangler("my-chat", "my-files"), "d1"), { made: "main~1", date: "2026-10-06T09:00:00Z" });
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).not.toContain("conflict");
    expect(show(copy, "update-ember/v0.2.1", "wrangler.jsonc")).toBe(bound.replace('"name": "ember"', '"name": "my-chat"').replace('"bucket_name": "ember"', '"bucket_name": "my-files"').replace('"do-sqlite"', '"d1"').trim());
  });

  it("keeps the copy's bucket's name with its binding where Ember adds a bucket before it", () => {
    const repo = ember();
    const twoBuckets = wrangler("ember", "ember", "2026-10-10").replace('"r2_buckets": [', '"r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "ember-backups" }, ');
    commit(repo, "2026-10-11T12:00:00Z", { "wrangler.jsonc": twoBuckets, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const copy = deployedCopy(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    const named = twoBuckets.replace('"name": "ember"', '"name": "my-chat"').replace('"bucket_name": "ember" }', '"bucket_name": "my-files" }');
    expect(show(copy, "update-ember/v0.2.1", "wrangler.jsonc")).toBe(named.trim());
  });

  it("leaves the copy's bucket's name to the merge where Ember renames its binding", () => {
    const repo = ember();
    commit(repo, "2026-10-11T12:00:00Z", { "wrangler.jsonc": wrangler("ember", "ember", "2026-10-10").replace('"FILES"', '"UPLOADS"'), "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    const copy = deployedCopy(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("First fix the conflicts in wrangler.jsonc on it and commit.");
    expect(show(copy, "update-ember/v0.2.1", "wrangler.jsonc")).toMatch(/<<<<<<< HEAD\n[\s\S]*"FILES", "bucket_name": "my-files"[\s\S]*=======[\s\S]*"UPLOADS", "bucket_name": "ember"[\s\S]*>>>>>>> /);
  });

  it("takes Ember's settings with the copy's names however the copy laid its settings out", () => {
    const repo = ember();
    const settings = { name: "my-chat", main: "src/index.ts", compatibility_date: "2026-09-01", assets: { directory: "dist" }, r2_buckets: [{ binding: "FILES", bucket_name: "my-files" }] };
    const rewritten = `${JSON.stringify(settings, null, 2)}\n`;
    const copy = deployedCopy(repo, rewritten);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(show(copy, "update-ember/v0.2.0", "wrangler.jsonc")).toBe(wrangler("my-chat", "my-files", "2026-10-10").trim());
  });

  it("merges settings the copy changed beyond its names", () => {
    const repo = ember();
    const copy = deployedCopy(repo, wrangler("my-chat", "my-files").replace("src/index.ts", "src/ours.ts"));
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("First fix the conflicts in wrangler.jsonc on it and commit.");
    expect(show(copy, "update-ember/v0.2.0", "wrangler.jsonc")).toMatch(/<<<<<<< [\s\S]*src\/ours\.ts[\s\S]*=======[\s\S]*2026-10-10[\s\S]*>>>>>>> /);
  });

  it("waits for Ember's first release", () => {
    const repo = ember();
    git(repo, ["tag", "--delete", "v0.1.0", "v0.2.0"]);
    const { status, output } = update(deployedCopy(repo), repo);
    expect(status, output).toBe(0);
    expect(output).toContain("Ember has no releases yet.");
  });
});

describe("updating a clone of Ember's repository", () => {
  /** A clone of Ember's v0.1.0 whose main names its Worker and bucket. */
  function cloneOf(repo: string): string {
    const clone = path.join(dir, "clone");
    git(dir, ["clone", "--quiet", "--branch", "v0.1.0", repo, clone]);
    git(clone, ["switch", "--quiet", "--create", "main"]);
    commit(clone, "2026-10-02T12:00:00Z", { "wrangler.jsonc": wrangler("our-ember", "our-files") });
    return clone;
  }

  it("merges from where the clone and Ember part", () => {
    const repo = ember();
    const clone = cloneOf(repo);
    const { status, output } = update(clone, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("from v0.1.0");
    expect(show(clone, "update-ember/v0.2.0", "wrangler.jsonc")).toBe(wrangler("our-ember", "our-files", "2026-10-10").trim());
    expect(show(clone, "update-ember/v0.2.0", "src/app.ts")).toBe(app("Two!").trim());
  });

  it("measures the next update from the release the last one brought", () => {
    const repo = ember();
    const clone = cloneOf(repo);
    update(clone, repo);
    git(clone, ["merge", "--quiet", "--ff-only", "update-ember/v0.2.0"]);
    releaseNext(repo);
    const { status, output } = update(clone, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("from v0.2.0.");
    // From where they part, the clone's line would look changed as v0.2.0 changed it, and conflict.
    expect(show(clone, "update-ember/v0.3.0", "src/app.ts")).toBe(app("2").trim());
  });
});

describe("Ember's betas", () => {
  it("offers a copy on a release none of Ember's betas, however new", () => {
    const repo = ember();
    releaseBeta(repo);
    const copy = deployedCopy(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.2.0 brings this copy up to Ember v0.2.0");
    git(copy, ["merge", "--quiet", "--ff-only", "update-ember/v0.2.0"]);
    expect(update(copy, repo).output).toContain("This copy has everything in Ember's newest release, v0.2.0.");
  });

  it("brings Ember's newest beta to a copy that asks for one, as the workflow's box does", () => {
    const repo = ember();
    releaseBeta(repo);
    for (const asked of [{ args: ["--beta"] }, { args: [], env: { EMBER_BETA: "true" } }]) {
      const copy = deployedCopy(repo);
      const { status, output } = update(copy, repo, asked.args, asked.env);
      expect(status, output).toBe(0);
      expect(output).toContain("update-ember/v0.3.0-beta.1 brings this copy up to Ember v0.3.0-beta.1 from Ember's commit");
      expect(show(copy, "update-ember/v0.3.0-beta.1", "src/app.ts")).toBe(app("beta 1").trim());
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("brings a copy that runs a beta the betas after it, then the release, and releases alone from then on", () => {
    const repo = ember();
    releaseBeta(repo);
    const copy = deployedCopy(repo);
    update(copy, repo, ["--beta"]);
    git(copy, ["merge", "--quiet", "--ff-only", "update-ember/v0.3.0-beta.1"]);
    releaseBeta(repo, 2);
    let { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.3.0-beta.2 brings this copy up to Ember v0.3.0-beta.2 from v0.3.0-beta.1.");
    git(copy, ["merge", "--quiet", "--ff-only", "update-ember/v0.3.0-beta.2"]);
    releaseNext(repo);
    ({ status, output } = update(copy, repo));
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.3.0 brings this copy up to Ember v0.3.0 from v0.3.0-beta.2.");
    expect(show(copy, "update-ember/v0.3.0", "src/app.ts")).toBe(app("2").trim());
    git(copy, ["merge", "--quiet", "--ff-only", "update-ember/v0.3.0"]);
    commit(repo, "2026-10-25T12:00:00Z", { "src/app.ts": app("next"), "apps/worker/package.json": '{ "version": "0.4.0-beta.1" }\n' });
    git(repo, ["tag", "v0.4.0-beta.1"]);
    ({ status, output } = update(copy, repo));
    expect(status, output).toBe(0);
    expect(output).toContain("This copy has everything in Ember's newest release, v0.3.0.");
  });

  it("measures a copy Deploy to Cloudflare made of a beta's tag from the tag, though Ember's main had moved on", () => {
    const repo = ember();
    releaseBeta(repo);
    commit(repo, "2026-10-17T12:00:00Z", { "src/later.ts": "export const later = 1;\n" });
    // The button deploys the beta's tag on the 18th, so the copy has none of main's change of the 17th.
    const copy = deployedCopy(repo, wrangler("my-chat", "my-files", "2026-10-10"), { made: "v0.3.0-beta.1", date: "2026-10-18T09:00:00Z" });
    releaseNext(repo);
    const { status, output } = update(copy, repo);
    expect(status, output).toBe(0);
    expect(output).toContain("update-ember/v0.3.0 brings this copy up to Ember v0.3.0 from v0.3.0-beta.1.");
    // From main's commit before the copy was made, its new file would look deleted in the copy.
    expect(show(copy, "update-ember/v0.3.0", "src/later.ts")).toBe("export const later = 1;");
    expect(show(copy, "update-ember/v0.3.0", "wrangler.jsonc")).toBe(wrangler("my-chat", "my-files", "2026-10-10").trim());
  });

  it("waits for Ember's first release while it has betas alone, unless it's asked for one", () => {
    const repo = ember();
    git(repo, ["tag", "--delete", "v0.1.0", "v0.2.0"]);
    releaseBeta(repo);
    const copy = deployedCopy(repo);
    expect(update(copy, repo).output).toContain("Ember has no releases yet.");
    expect(update(copy, repo, ["--beta"]).output).toContain("update-ember/v0.3.0-beta.1 brings this copy up to Ember v0.3.0-beta.1");
  });
});

describe("publishing an update, as the Update Ember workflow does", () => {
  /** The copy with its repository on GitHub, a bare one here, and the GitHub CLI's stand-in on its PATH. */
  function published() {
    const repo = ember();
    const copy = deployedCopy(repo);
    const origin = path.join(dir, "origin.git");
    git(dir, ["init", "--quiet", "--bare", origin]);
    git(copy, ["remote", "add", "origin", origin]);
    git(copy, ["push", "--quiet", "origin", "main"]);
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "gh");
    mkdirSync(bin);
    mkdirSync(log);
    writeFileSync(path.join(bin, "gh"), GH);
    chmodSync(path.join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, GITHUB_REPOSITORY: "me/chat" };
    const calls = () => readFileSync(path.join(log, "calls"), "utf8").trim().split("\n");
    const body = (command: string) => readFileSync(path.join(log, `${command}-body`), "utf8");
    return { repo, copy, origin, env, calls, body };
  }

  it("pushes the branch, keeping the copy's workflows, and opens a pull request", () => {
    const { repo, copy, origin, env, calls, body } = published();
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(output).toContain("Opened https://github.com/me/chat/pull/7, which brings this copy up to Ember v0.2.0.");
    expect(show(origin, "update-ember/v0.2.0", "src/new.ts")).toBe("export {};");
    // The workflow's token can't push a change to a workflow.
    expect(show(origin, "update-ember/v0.2.0", WORKFLOW)).toBe("on: schedule");
    expect(calls()).toContain("pr create --base main --head update-ember/v0.2.0 --title Update Ember to v0.2.0 --body-file -");
    expect(body("pr")).toContain("This brings your copy of Ember up to [v0.2.0](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.2.0)");
    expect(body("pr")).toContain(`copy [Ember's](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/blob/v0.2.0/${WORKFLOW}) over \`${WORKFLOW}\``);
  });

  it("opens a draft when the update needs a hand", () => {
    const { repo, copy, env, calls, body } = published();
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], env).status).toBe(0);
    expect(calls()).toContain("pr create --base main --head update-ember/v0.2.0 --title Update Ember to v0.2.0 --body-file - --draft");
    expect(body("pr")).toContain("Git left conflict markers around both versions: your copy's lines after `<<<<<<< HEAD`, and Ember's after `=======` up to `>>>>>>> ember/v0.2.0`.\n\n- `src/app.ts`\n");
  });

  it("gives git's note on a conflict it couldn't mark", () => {
    const { repo, copy, env, body } = published();
    commit(repo, "2026-10-11T12:00:00Z", { "src/app.ts": null, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], env).status).toBe(0);
    expect(body("pr")).toContain("Git couldn't mark where they meet, so it kept your copy's version unless its note says otherwise.");
    expect(body("pr")).toContain("- `src/app.ts`: `CONFLICT (modify/delete): src/app.ts deleted in ember/v0.2.1 and modified in HEAD.");
  });

  it("gives git's note on a conflict that leaves no file conflicted, as where Ember moves a folder", () => {
    const { repo, copy, env, calls, body } = published();
    git(repo, ["mv", "src", "lib"]);
    commit(repo, "2026-10-11T12:00:00Z", { "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    // Git would move the copy's file in the folder to Ember's new one, but a file of the copy's is there.
    commit(copy, "2026-10-07T12:00:00Z", { "src/extra.ts": "export {};\n", "lib/extra.ts": "export {};\n" });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], env).status).toBe(0);
    expect(calls()).toContain("pr create --base main --head update-ember/v0.2.1 --title Update Ember to v0.2.1 --body-file - --draft");
    expect(body("pr")).toContain("- `lib/extra.ts`: `CONFLICT (implicit dir rename): Existing file/dir at lib/extra.ts in the way of implicit directory rename(s)");
  });

  it("opens an issue linking to the pull request when GitHub won't let it open one", () => {
    const { repo, copy, env, calls, body } = published();
    const { status, output } = update(copy, repo, ["--publish"], { ...env, GH_PR_FAILS: PULL_REQUESTS_NOT_PERMITTED });
    expect(status, output).toBe(0);
    expect(output).toContain("so https://github.com/me/chat/issues/8 links to the one that brings this copy up to Ember v0.2.0.");
    expect(calls()).toContain("issue create --title Update Ember to v0.2.0 --body-file -");
    expect(body("issue")).toContain("https://github.com/me/chat/compare/main...update-ember/v0.2.0?expand=1&title=Update%20Ember%20to%20v0.2.0&body=This%20brings");
    expect(body("issue")).toContain("Allow GitHub Actions to create and approve pull requests");
  });

  it("makes each update once", () => {
    const { repo, copy, env, calls } = published();
    update(copy, repo, ["--publish"], env);
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(output).toContain("https://github.com/me/chat/pull/7 offers this copy Ember v0.2.0 already.");
    expect(calls().filter((call) => call.startsWith("pr create"))).toHaveLength(1);
  });

  it("makes each update once where it opens an issue, taking the one it opened for the update's offer", () => {
    const { repo, copy, env, calls } = published();
    const notPermitted = { ...env, GH_PR_FAILS: PULL_REQUESTS_NOT_PERMITTED };
    update(copy, repo, ["--publish"], notPermitted);
    const { status, output } = update(copy, repo, ["--publish"], notPermitted);
    expect(status, output).toBe(0);
    expect(output).toContain("https://github.com/me/chat/issues/8 offers this copy Ember v0.2.0 already.");
    expect(calls().filter((call) => call.startsWith("issue create"))).toHaveLength(1);
  });

  it("offers an update an earlier run pushed but couldn't offer, as its branch has it", () => {
    const { repo, copy, origin, env, calls } = published();
    expect(update(copy, repo, ["--publish"], { ...env, GH_PR_FAILS: "HTTP 502: Bad Gateway" }).status).toBe(1);
    git(copy, ["fetch", "--quiet", "origin", "update-ember/v0.2.0"]);
    git(copy, ["switch", "--quiet", "--create", "fixing", "FETCH_HEAD"]);
    const fixed = commit(copy, "2026-10-12T12:00:00Z", { "src/app.ts": app("fixed") });
    git(copy, ["push", "--quiet", "origin", "fixing:update-ember/v0.2.0"]);
    git(copy, ["switch", "--quiet", "main"]);
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(output).toContain("Opened https://github.com/me/chat/pull/7");
    expect(git(origin, ["rev-parse", "update-ember/v0.2.0"])).toBe(fixed);
    expect(calls().filter((call) => call.startsWith("pr create"))).toHaveLength(2);
  });

  it("describes an update an earlier run pushed by the conflict markers left on its branch", () => {
    const { repo, copy, env, calls, body } = published();
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], { ...env, GH_PR_FAILS: "HTTP 502: Bad Gateway" }).status).toBe(1);
    // The copy's main settles its line as Ember's release has it, so this run's merge is clean.
    commit(copy, "2026-10-12T12:00:00Z", { "src/app.ts": app("Two!") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(calls().at(-3)).toBe("pr create --base main --head update-ember/v0.2.0 --title Update Ember to v0.2.0 --body-file - --draft");
    expect(body("pr")).toContain("Git left conflict markers around both versions");
    expect(body("pr")).toContain("- `src/app.ts`\n");
  });

  it("describes an update an earlier run pushed by git's notes on the conflicts it couldn't mark there", () => {
    const { repo, copy, env, calls, body } = published();
    commit(repo, "2026-10-11T12:00:00Z", { "src/app.ts": null, "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], { ...env, GH_PR_FAILS: "HTTP 502: Bad Gateway" }).status).toBe(1);
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(calls().at(-3)).toBe("pr create --base main --head update-ember/v0.2.1 --title Update Ember to v0.2.1 --body-file - --draft");
    expect(body("pr")).toContain("- `src/app.ts`: `CONFLICT (modify/delete): src/app.ts deleted in ember/v0.2.1 and modified in HEAD.");
  });

  it("finds the markers in a file Ember renamed on a branch an earlier run pushed", () => {
    const { repo, copy, env, calls, body } = published();
    git(repo, ["mv", "src/app.ts", "src/main.ts"]);
    commit(repo, "2026-10-11T12:00:00Z", { "apps/worker/package.json": '{ "version": "0.2.1" }\n' });
    git(repo, ["tag", "v0.2.1"]);
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], { ...env, GH_PR_FAILS: "HTTP 502: Bad Gateway" }).status).toBe(1);
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(calls().at(-3)).toBe("pr create --base main --head update-ember/v0.2.1 --title Update Ember to v0.2.1 --body-file - --draft");
    expect(body("pr")).toContain("- `src/main.ts`\n");
  });

  it("offers an update an earlier run pushed as ready once the markers on its branch are fixed", () => {
    const { repo, copy, env, calls, body } = published();
    commit(copy, "2026-10-07T12:00:00Z", { "src/app.ts": app("our two") });
    git(copy, ["push", "--quiet", "origin", "main"]);
    expect(update(copy, repo, ["--publish"], { ...env, GH_PR_FAILS: "HTTP 502: Bad Gateway" }).status).toBe(1);
    git(copy, ["fetch", "--quiet", "origin", "update-ember/v0.2.0"]);
    git(copy, ["switch", "--quiet", "--create", "fixing", "FETCH_HEAD"]);
    commit(copy, "2026-10-12T12:00:00Z", { "src/app.ts": app("our Two!") });
    git(copy, ["push", "--quiet", "origin", "fixing:update-ember/v0.2.0"]);
    git(copy, ["switch", "--quiet", "main"]);
    const { status, output } = update(copy, repo, ["--publish"], env);
    expect(status, output).toBe(0);
    expect(calls().at(-3)).toBe("pr create --base main --head update-ember/v0.2.0 --title Update Ember to v0.2.0 --body-file -");
    expect(body("pr")).not.toContain("needs a hand");
  });

  it("takes a closed pull request as turning its release down, until the next", () => {
    const { repo, copy, origin, env, calls } = published();
    const pulls = JSON.stringify([{ url: "https://github.com/me/chat/pull/3", state: "CLOSED", headRefName: "update-ember/v0.2.0", ...FROM_COPY }]);
    const declined = update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls });
    expect(declined.status, declined.output).toBe(0);
    expect(declined.output).toContain("https://github.com/me/chat/pull/3 offered this copy Ember v0.2.0 and is closed now, so this waits for Ember's next release.");
    expect(calls().some((call) => call.startsWith("pr create"))).toBe(false);
    expect(() => git(origin, ["rev-parse", "--verify", "--quiet", "refs/heads/update-ember/v0.2.0"])).toThrow();
    releaseNext(repo);
    const { status, output } = update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls });
    expect(status, output).toBe(0);
    expect(output).toContain("Opened https://github.com/me/chat/pull/7, which brings this copy up to Ember v0.3.0.");
  });

  it("takes neither a fork's closed pull request nor somebody else's closed issue as turning a release down", () => {
    const { repo, copy, origin, env } = published();
    const pulls = JSON.stringify([{ url: "https://github.com/me/chat/pull/3", state: "CLOSED", headRefName: "update-ember/v0.2.0", ...FROM_FORK }]);
    const issues = JSON.stringify([{ url: "https://github.com/me/chat/issues/4", state: "CLOSED", title: "Update Ember to v0.2.0", ...BY_SOMEONE }]);
    const { status, output } = update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls, GH_ISSUES: issues });
    expect(status, output).toBe(0);
    expect(output).toContain("Opened https://github.com/me/chat/pull/7, which brings this copy up to Ember v0.2.0.");
    expect(show(origin, "update-ember/v0.2.0", "src/new.ts")).toBe("export {};");
  });

  it("takes neither a fork's open pull request nor somebody else's open issue for the update's own, and closes none of theirs", () => {
    const { repo, copy, env, calls } = published();
    const pulls = JSON.stringify([
      { number: 3, url: "https://github.com/me/chat/pull/3", state: "OPEN", headRefName: "update-ember/v0.2.0", ...FROM_FORK },
      { number: 4, headRefName: "update-ember/v0.1.5", ...FROM_COPY },
      { number: 5, headRefName: "update-ember/v0.1.5", ...FROM_FORK },
    ]);
    const issues = JSON.stringify([
      { number: 9, url: "https://github.com/me/chat/issues/9", state: "OPEN", title: "Update Ember to v0.2.0", ...BY_SOMEONE },
      { number: 6, title: "Update Ember to v0.1.5", ...BY_WORKFLOW },
      { number: 10, title: "Update Ember to v0.1.5", ...BY_SOMEONE },
    ]);
    const { status, output } = update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls, GH_ISSUES: issues });
    expect(status, output).toBe(0);
    expect(output).toContain("Opened https://github.com/me/chat/pull/7, which brings this copy up to Ember v0.2.0.");
    const reason = "Ember v0.2.0 is out, so https://github.com/me/chat/pull/7 brings this copy up to it instead.";
    expect(calls().filter((call) => call.includes("close"))).toEqual([`pr close 4 --delete-branch --comment ${reason}`, `issue close 6 --comment ${reason}`]);
  });

  it("closes the pull requests and issues of the updates it replaces", () => {
    const { repo, copy, env, calls } = published();
    const pulls = JSON.stringify([{ number: 4, headRefName: "update-ember/v0.1.5", ...FROM_COPY }, { number: 5, headRefName: "fix-typo", ...FROM_COPY }]);
    const issues = JSON.stringify([{ number: 6, title: "Update Ember to v0.1.5", ...BY_WORKFLOW }, { number: 9, title: "Something else", ...BY_SOMEONE }]);
    expect(update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls, GH_ISSUES: issues }).status).toBe(0);
    const reason = "Ember v0.2.0 is out, so https://github.com/me/chat/pull/7 brings this copy up to it instead.";
    expect(calls()).toContain(`pr close 4 --delete-branch --comment ${reason}`);
    expect(calls()).toContain(`issue close 6 --comment ${reason}`);
    expect(calls().filter((call) => call.includes("close"))).toHaveLength(2);
  });

  it("says Update Ember's workflow has a new version until the copy has it", () => {
    const { repo, copy, env, body } = published();
    update(copy, repo, ["--publish"], env);
    git(copy, ["pull", "--quiet", "--ff-only", "origin", "update-ember/v0.2.0"]);
    releaseNext(repo);
    expect(update(copy, repo, ["--publish"], env).status).toBe(0);
    expect(body("pr")).toContain(`/blob/v0.3.0/${WORKFLOW}) over \`${WORKFLOW}\``);
  });

  it("says a beta's pull request is for a beta, and lists the releases and betas it brings", () => {
    const { repo, copy, env, calls, body } = published();
    releaseBeta(repo);
    expect(update(copy, repo, ["--publish"], { ...env, EMBER_BETA: "true" }).status).toBe(0);
    expect(calls()).toContain("pr create --base main --head update-ember/v0.3.0-beta.1 --title Update Ember to v0.3.0-beta.1 --body-file -");
    expect(body("pr")).toContain("What's new: [v0.2.0](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.2.0), [v0.3.0-beta.1](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.3.0-beta.1), and");
    expect(body("pr")).toContain("**This is a beta** of Ember's next release, which a copy is offered only when it asks for one or runs one already");
  });

  it("lists the releases a release brings, not the betas before it", () => {
    const { repo, copy, env, body } = published();
    releaseBeta(repo);
    releaseNext(repo);
    expect(update(copy, repo, ["--publish"], env).status).toBe(0);
    expect(body("pr")).toContain("What's new: [v0.2.0](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.2.0), [v0.3.0](https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.3.0), and");
    expect(body("pr")).not.toContain("beta");
  });

  it("leaves the pull request of a beta the copy asked for open until a release passes it", () => {
    const { repo, copy, env, calls } = published();
    update(copy, repo, ["--publish"], env);
    git(copy, ["pull", "--quiet", "--ff-only", "origin", "update-ember/v0.2.0"]);
    releaseBeta(repo);
    const pulls = JSON.stringify([{ number: 9, url: "https://github.com/me/chat/pull/9", state: "OPEN", headRefName: "update-ember/v0.3.0-beta.1", ...FROM_COPY }]);
    const issues = JSON.stringify([{ number: 10, url: "https://github.com/me/chat/issues/10", state: "OPEN", title: "Update Ember to v0.3.0-beta.1", ...BY_WORKFLOW }]);
    const held = update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls, GH_ISSUES: issues });
    expect(held.output).toContain("This copy has everything in Ember's newest release, v0.2.0.");
    expect(calls().filter((call) => call.includes("close"))).toEqual([]);
    releaseNext(repo);
    expect(update(copy, repo, ["--publish"], { ...env, GH_PULLS: pulls, GH_ISSUES: issues }).status).toBe(0);
    const reason = "Ember v0.3.0 is out, so https://github.com/me/chat/pull/7 brings this copy up to it instead.";
    expect(calls().filter((call) => call.includes("close"))).toEqual([`pr close 9 --delete-branch --comment ${reason}`, `issue close 10 --comment ${reason}`]);
  });

  it("closes what's left once the copy has the newest release", () => {
    const { repo, copy, env, calls } = published();
    update(copy, repo, ["--publish"], env);
    git(copy, ["pull", "--quiet", "--ff-only", "origin", "update-ember/v0.2.0"]);
    const issues = JSON.stringify([{ number: 8, title: "Update Ember to v0.2.0", ...BY_WORKFLOW }]);
    expect(update(copy, repo, ["--publish"], { ...env, GH_ISSUES: issues }).status).toBe(0);
    expect(calls()).toContain("issue close 8 --comment This copy has Ember's newest release now.");
  });
});

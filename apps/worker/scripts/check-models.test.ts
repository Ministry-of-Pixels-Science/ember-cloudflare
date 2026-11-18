import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkModels, fileText, makersIdOf, newerModelsOf, reportOf, type ModelsJson } from "./check-models.ts";

const SCRIPT = fileURLToPath(new URL("./check-models.ts", import.meta.url));
const MODELS_JSON = fileURLToPath(new URL("../../../models.json", import.meta.url));

/** A models file of two of Anthropic's, one of OpenAI's and one of xAI's. */
const FILE: ModelsJson = {
  about: "The models Ember offers besides Workers AI's.",
  version: 1,
  suggested: "anthropic/claude-haiku-5.5",
  models: [
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", price: { input: 2, output: 10 }, web: ["search", "read"] },
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", price: { input: 0.1, output: 0.5 }, web: ["search", "read"] },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", price: { input: 2, output: 10 }, web: ["search"] },
    { id: "xai/grok-4.7", name: "Grok 4.7", price: { input: 2, output: 6 }, web: ["search"] },
  ],
};

/** A models.dev entry, as its api.json lists one. */
const known = (id: string, name: string, input: number, output: number, release_date: string, more: Record<string, unknown> = {}) => ({
  id,
  name,
  cost: { input, output, cache_read: input / 10 },
  tool_call: true,
  reasoning: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  release_date,
  status: null,
  ...more,
});

/** models.dev's list, which agrees with FILE. */
const MODELS_DEV = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-5-5": known("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, "2026-09-28"),
      "claude-haiku-5-5": known("claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5, "2026-10-07"),
      "claude-opus-5": known("claude-opus-5", "Claude Opus 5", 5, 25, "2026-07-24"),
    },
  },
  openai: { id: "openai", name: "OpenAI", models: { "gpt-6.1-sol": known("gpt-6.1-sol", "GPT-6.1 Sol", 2, 10, "2026-09-29") } },
  xai: { id: "xai", name: "xAI", models: { "grok-4.7": known("grok-4.7", "Grok 4.7", 2, 6, "2026-09-21") } },
  google: { id: "google", name: "Google", models: { "gemini-5": known("gemini-5", "Gemini 5", 2, 12, "2026-11-01") } },
};

/** A LiteLLM entry, which gives prices for each token. */
const lite = (provider: string, input: number, output: number, more: Record<string, unknown> = {}) => ({
  litellm_provider: provider,
  mode: "chat",
  input_cost_per_token: input / 1e6,
  output_cost_per_token: output / 1e6,
  supports_function_calling: true,
  ...more,
});

/** LiteLLM's list, which agrees with FILE, keying xAI's by `xai/`. */
const LITELLM = {
  "claude-sonnet-5-5": lite("anthropic", 2, 10),
  "claude-haiku-5-5": lite("anthropic", 0.1, 0.5),
  "gpt-6.1-sol": lite("openai", 2, 10),
  "xai/grok-4.7": lite("xai", 2, 6),
};

/** `list` with `change` made to `maker`'s model `id`, as models.dev lists it. */
function modelsDevWith(maker: keyof typeof MODELS_DEV, id: string, change: Record<string, unknown> | null) {
  const { [id]: listed, ...others } = MODELS_DEV[maker].models as Record<string, Record<string, unknown>>;
  return { ...MODELS_DEV, [maker]: { ...MODELS_DEV[maker], models: change === null ? others : { ...others, [id]: { ...listed, ...change } } } };
}

describe("The models check", () => {
  it("names each model as its maker does, as models.dev and LiteLLM name it", () => {
    expect(makersIdOf("anthropic/claude-sonnet-5.5")).toEqual({ maker: "anthropic", model: "claude-sonnet-5-5" });
    expect(makersIdOf("openai/gpt-6.1-sol")).toEqual({ maker: "openai", model: "gpt-6.1-sol" });
    expect(makersIdOf("xai/grok-4.7")).toEqual({ maker: "xai", model: "grok-4.7" });
    expect(makersIdOf("google/gemini-5")).toBeNull();
    expect(makersIdOf("@cf/zai-org/glm-5.2")).toBeNull();
  });

  it("finds nothing to change while models.dev and LiteLLM agree with the file", () => {
    expect(checkModels(FILE, MODELS_DEV, LITELLM)).toEqual({ file: FILE, changes: [], notes: [], newer: [] });
  });

  it("changes a price models.dev and LiteLLM both say, as each gives it, saying so", () => {
    const { file, changes, notes } = checkModels(FILE, modelsDevWith("anthropic", "claude-sonnet-5-5", { cost: { input: 1.5, output: 7.5 } }), {
      ...LITELLM,
      "claude-sonnet-5-5": lite("anthropic", 1.5, 7.5),
    });
    expect(file.models[0]).toEqual({ ...FILE.models[0], price: { input: 1.5, output: 7.5 } });
    expect(file.models.slice(1)).toEqual(FILE.models.slice(1));
    expect(changes).toEqual(["Claude Sonnet 5.5 costs $1.5 / $7.5 now, not $2 / $10."]);
    expect(notes).toEqual([]);
  });

  it("leaves a price only one of them says, or that they disagree on, for someone to look at", () => {
    const onlyModelsDev = checkModels(FILE, modelsDevWith("openai", "gpt-6.1-sol", { cost: { input: 1.75, output: 14 } }), LITELLM);
    expect([onlyModelsDev.file, onlyModelsDev.changes]).toEqual([FILE, []]);
    expect(onlyModelsDev.notes).toEqual(["GPT-6.1 Sol costs $2 / $10 in models.json, but models.dev says $1.75 / $14, and LiteLLM $2 / $10."]);

    const { "xai/grok-4.7": _, ...withoutGrok } = LITELLM;
    const disagreeing = checkModels(FILE, modelsDevWith("xai", "grok-4.7", { cost: { input: 3, output: 15 } }), withoutGrok);
    expect([disagreeing.file, disagreeing.changes]).toEqual([FILE, []]);
    expect(disagreeing.notes).toEqual(["Grok 4.7 costs $2 / $6 in models.json, but models.dev says $3 / $15, and LiteLLM nothing."]);
  });

  it("notes a model neither lists, by its maker's ID", () => {
    const { "claude-haiku-5-5": _, ...withoutHaiku } = LITELLM;
    expect(checkModels(FILE, modelsDevWith("anthropic", "claude-haiku-5-5", null), withoutHaiku).notes).toEqual([
      "Neither models.dev nor LiteLLM lists Claude Haiku 5.5, `claude-haiku-5-5` at Anthropic.",
    ]);
  });

  it("gives a model the day LiteLLM says it stops running, and notes one models.dev says is deprecated without one", () => {
    const stopping = checkModels(FILE, MODELS_DEV, { ...LITELLM, "gpt-6.1-sol": lite("openai", 2, 10, { deprecation_date: "2027-03-01" }) });
    expect(stopping.file.models[2]).toEqual({ ...FILE.models[2], until: "2027-03-01" });
    expect(stopping.changes).toEqual(["GPT-6.1 Sol stops running on 2027-03-01, LiteLLM says."]);

    const deprecated = checkModels(FILE, modelsDevWith("xai", "grok-4.7", { status: "deprecated" }), LITELLM);
    expect([deprecated.file, deprecated.changes]).toEqual([FILE, []]);
    expect(deprecated.notes).toEqual(["models.dev says xAI has deprecated Grok 4.7, but not when it stops running."]);
  });

  it("changes nothing Ember wouldn't read so, noting what they said instead", () => {
    const priced = checkModels(FILE, modelsDevWith("anthropic", "claude-sonnet-5-5", { cost: { input: 2, output: 2_000 } }), {
      ...LITELLM,
      "claude-sonnet-5-5": lite("anthropic", 2, 2_000),
    });
    expect([priced.file, priced.changes]).toEqual([FILE, []]);
    expect(priced.notes).toEqual(["Claude Sonnet 5.5 costs $2 / $2000 now, not $2 / $10. But Ember wouldn't read that, so models.json says what it did."]);
  });

  it("lists each maker's newer models that read and write text and take tools, newest first, for someone to add", () => {
    const listing = {
      ...MODELS_DEV,
      anthropic: {
        ...MODELS_DEV.anthropic,
        models: {
          ...MODELS_DEV.anthropic.models,
          "claude-fable-5-2": known("claude-fable-5-2", "Claude Fable 5.2", 8, 40, "2026-11-09"),
          "claude-voice-1": known("claude-voice-1", "Claude Voice 1", 1, 1, "2026-11-10", { modalities: { input: ["audio"], output: ["audio"] } }),
          "claude-sonnet-5-6-preview": known("claude-sonnet-5-6-preview", "Claude Sonnet 5.6 Preview", 2, 10, "2026-11-11", { status: "beta" }),
        },
      },
      openai: {
        ...MODELS_DEV.openai,
        models: {
          ...MODELS_DEV.openai.models,
          "gpt-6.1-terra": known("gpt-6.1-terra", "GPT-6.1 Terra", 1, 5, "2026-10-26"),
          "gpt-image-3": known("gpt-image-3", "GPT Image 3", 5, 40, "2026-11-02", { tool_call: false }),
        },
      },
    };
    expect(newerModelsOf(FILE, listing)).toEqual([
      "Claude Fable 5.2, `claude-fable-5-2` at Anthropic, released 2026-11-09, at $8 / $40.",
      "GPT-6.1 Terra, `gpt-6.1-terra` at OpenAI, released 2026-10-26, at $1 / $5.",
    ]);
  });

  it("writes models.json as it's laid out, each model on a line of its own", () => {
    const text = readFileSync(MODELS_JSON, "utf8");
    expect(fileText(JSON.parse(text) as ModelsJson)).toBe(text);
  });

  it("says what it changed, what to look at, and the newer models, in sections of their own", () => {
    const report = reportOf({ file: FILE, changes: ["Claude Sonnet 5.5 costs $1.5 / $7.5 now, not $2 / $10."], notes: [], newer: ["GPT-7, `gpt-7` at OpenAI, released 2026-12-01."] });
    expect(report).toContain("### What this changes\n\n- Claude Sonnet 5.5 costs $1.5 / $7.5 now, not $2 / $10.\n\nMerging it changes what every copy offers within a day, without an update.");
    expect(report).not.toContain("### To look at");
    expect(report).toContain("### Newer models models.json doesn't list\n\n- GPT-7, `gpt-7` at OpenAI, released 2026-12-01.\n");
  });
});

/** Stands in for the GitHub CLI, keeping each call it's given, and what it was given to read. */
const GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG/calls"
case "$1 $2" in
  "pr create") cat > "$GH_LOG/pr-body"; if [ -n "$GH_PR_FAILS" ]; then echo "$GH_PR_FAILS" >&2; exit 1; fi; echo "https://github.com/me/ember/pull/7" ;;
  "issue create") cat > "$GH_LOG/issue-body"; echo "https://github.com/me/ember/issues/8" ;;
  "issue edit" | "pr edit") cat > "$GH_LOG/edit-body" ;;
  "pr list") echo "\${GH_PULLS:-[]}" ;;
  "issue list") echo "\${GH_ISSUES:-[]}" ;;
esac
`;

describe("publishing the check, as the Check models workflow does", () => {
  let dir: string;
  let repo: string;
  let origin: string;
  let env: Record<string, string>;

  /** Runs `command` in `cwd`, which has to work. */
  function check(cwd: string, command: string, args: string[]): string {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Runs the check with --publish, with models.dev and LiteLLM listing `modelsDev` and `liteLlm`, and `more` in its environment. */
  function publish(modelsDev: unknown, liteLlm: unknown, more: Record<string, string> = {}) {
    writeFileSync(path.join(dir, "models-dev.json"), JSON.stringify(modelsDev));
    writeFileSync(path.join(dir, "litellm.json"), JSON.stringify(liteLlm));
    const result = spawnSync(process.execPath, [SCRIPT, "--publish"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env, ...more } });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const calls = () => readFileSync(path.join(dir, "gh", "calls"), "utf8").trim().split("\n");
  const body = (made: "pr" | "issue" | "edit") => readFileSync(path.join(dir, "gh", `${made}-body`), "utf8");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "check-models-test-"));
    writeFileSync(path.join(dir, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
    mkdirSync(path.join(dir, "bin"));
    mkdirSync(path.join(dir, "gh"));
    writeFileSync(path.join(dir, "bin", "gh"), GH);
    chmodSync(path.join(dir, "bin", "gh"), 0o755);
    env = {
      PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
      GH_LOG: path.join(dir, "gh"),
      GITHUB_REPOSITORY: "me/ember",
      GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      EMBER_MODELS_DEV: path.join(dir, "models-dev.json"),
      EMBER_LITELLM: path.join(dir, "litellm.json"),
    };
    repo = path.join(dir, "ember");
    origin = path.join(dir, "origin.git");
    check(dir, "git", ["init", "--quiet", "--bare", origin]);
    check(dir, "git", ["init", "--quiet", repo]);
    writeFileSync(path.join(repo, "models.json"), fileText(FILE));
    check(repo, "git", ["add", "models.json"]);
    check(repo, "git", ["commit", "--quiet", "-m", "Models"]);
    check(repo, "git", ["remote", "add", "origin", origin]);
    check(repo, "git", ["push", "--quiet", "origin", "main"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const CHEAPER = modelsDevWith("anthropic", "claude-sonnet-5-5", { cost: { input: 1.5, output: 7.5 } });
  const CHEAPER_LITELLM = { ...LITELLM, "claude-sonnet-5-5": lite("anthropic", 1.5, 7.5) };

  it("pushes the change to a branch named after it and opens a pull request with it", () => {
    const { status, output } = publish(CHEAPER, CHEAPER_LITELLM);
    expect(status, output).toBe(0);
    expect(output).toContain("Opened https://github.com/me/ember/pull/7, which updates models.json.");
    const created = calls().find((call) => call.startsWith("pr create"))!;
    const branch = /--head (check-models\/[0-9a-f]{8})/.exec(created)?.[1];
    expect(created).toBe(`pr create --base main --head ${branch} --title Update models.json from models.dev and LiteLLM --body-file -`);
    const pushed = JSON.parse(check(repo, "git", ["--git-dir", origin, "show", `${branch}:models.json`])) as ModelsJson;
    expect(pushed.models[0]!.price).toEqual({ input: 1.5, output: 7.5 });
    expect(body("pr")).toContain("- Claude Sonnet 5.5 costs $1.5 / $7.5 now, not $2 / $10.");
  });

  it("only edits the pull request open with the same change, closing older ones", () => {
    expect(publish(CHEAPER, CHEAPER_LITELLM).status).toBe(0);
    const branch = /--head (check-models\/[0-9a-f]{8})/.exec(calls().find((call) => call.startsWith("pr create"))!)![1]!;
    const GH_PULLS = JSON.stringify([
      { number: 5, url: "https://github.com/me/ember/pull/5", headRefName: "check-models/0badc0de" },
      { number: 7, url: "https://github.com/me/ember/pull/7", headRefName: branch },
      { number: 9, url: "https://github.com/me/ember/pull/9", headRefName: "update-ember/v0.5.0" },
    ]);
    check(repo, "git", ["switch", "--quiet", "main"]);
    rmSync(path.join(dir, "gh", "calls"));
    const { status, output } = publish(CHEAPER, CHEAPER_LITELLM, { GH_PULLS });
    expect(status, output).toBe(0);
    expect(output).toContain("https://github.com/me/ember/pull/7 has these changes already.");
    expect(calls().filter((call) => !call.endsWith("list --state open --limit 100 --json number,url,headRefName") && !call.startsWith("issue list"))).toEqual([
      "pr edit 7 --body-file -",
      "pr close 5 --comment https://github.com/me/ember/pull/7 has these changes. --delete-branch",
    ]);
  });

  it("opens an issue with only something to look at, which the next week's edits, and closes once there's nothing", () => {
    const disagreeing = modelsDevWith("openai", "gpt-6.1-sol", { cost: { input: 1.75, output: 14 } });
    let { status, output } = publish(disagreeing, LITELLM);
    expect(status, output).toBe(0);
    expect(output).toContain("Nothing in models.json changes, and https://github.com/me/ember/issues/8 says what to look at.");
    expect(calls()).toContain("issue create --title Models to look at, from models.dev and LiteLLM --body-file -");
    expect(body("issue")).toContain("### To look at\n\n- GPT-6.1 Sol costs $2 / $10 in models.json, but models.dev says $1.75 / $14, and LiteLLM $2 / $10.");

    const GH_ISSUES = JSON.stringify([{ number: 8, url: "https://github.com/me/ember/issues/8", title: "Models to look at, from models.dev and LiteLLM" }]);
    ({ status, output } = publish(disagreeing, LITELLM, { GH_ISSUES }));
    expect(status, output).toBe(0);
    expect(calls()).toContain("issue edit 8 --body-file -");

    ({ status, output } = publish(MODELS_DEV, LITELLM, { GH_ISSUES }));
    expect(status, output).toBe(0);
    expect(output).toContain("models.json agrees with models.dev and LiteLLM, and they list no newer models.");
    expect(calls()).toContain("issue close 8 --comment models.json agrees with models.dev and LiteLLM now.");
  });

  it("opens an issue linking to the pull request to open when GitHub doesn't let the workflow open one", () => {
    const GH_PR_FAILS = "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)";
    const { status, output } = publish(CHEAPER, CHEAPER_LITELLM, { GH_PR_FAILS });
    expect(status, output).toBe(0);
    expect(output).toContain("GitHub doesn't let this workflow open pull requests, so https://github.com/me/ember/issues/8 links to the one that updates models.json.");
    expect(body("issue")).toMatch(/^GitHub doesn't let this repository's workflows open pull requests, so \[open the one for check-models\/[0-9a-f]{8}\]\(https:\/\/github\.com\/me\/ember\/compare\/main\.\.\.check-models\/[0-9a-f]{8}\?expand=1&title=/);
  });
});

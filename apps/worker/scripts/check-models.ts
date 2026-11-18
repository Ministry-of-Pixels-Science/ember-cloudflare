// Checks models.json, the file of Anthropic's, OpenAI's and xAI's models that every copy of Ember reads
// from Ember's main branch once a day (docs/models.md), against two lists that follow the providers'
// models: models.dev's and LiteLLM's. A price both say has changed is changed, as is the day LiteLLM says
// a model stops running. What only one of them says, and the makers' newer models that take tools, are
// listed for whoever reviews the change to look at, since a model is added by hand, with what it may do
// on the web, once it's been tried.
//
// The Check models workflow runs it every week in Ember's own repository with --publish, which pushes
// the change to a branch and opens a pull request with it, or, with nothing to change but something to
// look at, an issue, closing those earlier weeks left open. Without --publish, it changes models.json
// in place and says what it found:
//
//   node apps/worker/scripts/check-models.ts [--publish]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Relative, so that the workflow runs it without installing anything.
import { parseModelsFile } from "../../../packages/protocol/src/assistant.ts";

/** Where models.dev and LiteLLM list the models they know, which the tests point at files of their own. */
const MODELS_DEV = process.env.EMBER_MODELS_DEV || "https://models.dev/api.json";
const LITELLM = process.env.EMBER_LITELLM || "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Ember's repository, whose main branch every copy reads the file from. */
const EMBER = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare";

/** The file every copy of Ember reads, from the repository's root. */
const FILE = "models.json";

/** The makers whose models the file lists, as the start of Cloudflare's IDs for them names them, as models.dev and LiteLLM do. */
const MAKERS = { anthropic: "Anthropic", openai: "OpenAI", xai: "xAI" } as const;
type Maker = keyof typeof MAKERS;

/** What the check's pull requests are called, their branches start with, and what its issue is called. */
const TITLE = "Update models.json from models.dev and LiteLLM";
const BRANCHES = "check-models/";
const ISSUE_TITLE = "Models to look at, from models.dev and LiteLLM";

/** What the check says when it finds nothing to change or look at. */
const AGREES = "models.json agrees with models.dev and LiteLLM, and they list no newer models.";

/** What gh says when the repository's settings don't let workflows open pull requests. */
const PULL_REQUESTS_NOT_PERMITTED = /not permitted to create or approve pull requests/i;

/** A day, as models.json and LiteLLM write one. */
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** What a million tokens of a model cost, read and written, in US dollars. */
export interface Price {
  input: number;
  output: number;
}

/** A model as models.json lists it. */
export interface FileModel {
  id: string;
  name: string;
  price: Price;
  web: string[];
  until?: string;
}

/** models.json as it's written: what it's for, its version, the model it suggests, and its models. */
export interface ModelsJson {
  about?: string;
  version: number;
  suggested: string;
  models: FileModel[];
}

/** What the check found: the file as it should be, what changed in it, what to look at, and the newer models it doesn't list. */
export interface Findings {
  file: ModelsJson;
  changes: string[];
  notes: string[];
  newer: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The maker of the model whose ID at Cloudflare is `id`, and the maker's own ID for it, as AI Gateway's
 * endpoint for the maker names it (`modelIn` in src/assistant/gateway.ts): Anthropic's with dashes for its
 * dots, `claude-sonnet-5-5` for `anthropic/claude-sonnet-5.5`. models.dev and LiteLLM name it so too.
 */
export function makersIdOf(id: string): { maker: Maker; model: string } | null {
  const slash = id.indexOf("/");
  const maker = id.slice(0, slash);
  if (slash < 0 || !(maker in MAKERS)) return null;
  const model = id.slice(slash + 1);
  return { maker: maker as Maker, model: maker === "anthropic" ? model.replaceAll(".", "-") : model };
}

/** The models models.dev lists of `maker`, by their makers' IDs. */
function modelsDevOf(modelsDev: unknown, maker: Maker): Record<string, Record<string, unknown>> {
  const listed = isObject(modelsDev) && isObject(modelsDev[maker]) ? modelsDev[maker].models : null;
  return isObject(listed) ? (Object.fromEntries(Object.entries(listed).filter(([, entry]) => isObject(entry))) as Record<string, Record<string, unknown>>) : {};
}

/** LiteLLM's entry for `model` of `maker`'s, which it keys by the maker's ID, or for xAI's, with `xai/` before it. */
function liteLlmOf(liteLlm: unknown, maker: Maker, model: string): Record<string, unknown> | null {
  if (!isObject(liteLlm)) return null;
  for (const key of [model, `${maker}/${model}`]) {
    const entry = liteLlm[key];
    if (isObject(entry) && entry.litellm_provider === maker) return entry;
  }
  return null;
}

/** `amount` dollars, rounded to fractions of a cent as models.json gives them, or null for anything but an amount. */
const dollarsOf = (amount: unknown) => (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 1e4) / 1e4 : null);

/** The price `input` and `output` give, as dollars for each million tokens, or null unless both do. */
function priceOf(input: unknown, output: unknown): Price | null {
  const read = dollarsOf(input);
  const written = dollarsOf(output);
  return read === null || written === null ? null : { input: read, output: written };
}

/** What models.dev says a model costs, which it gives for each million tokens. */
const modelsDevPriceOf = (entry: Record<string, unknown> | undefined) => (isObject(entry?.cost) ? priceOf(entry.cost.input, entry.cost.output) : null);

/** What LiteLLM says a model costs, which it gives for each token. */
function liteLlmPriceOf(entry: Record<string, unknown> | null): Price | null {
  const perMillion = (perToken: unknown) => (typeof perToken === "number" ? perToken * 1e6 : null);
  return entry ? priceOf(perMillion(entry.input_cost_per_token), perMillion(entry.output_cost_per_token)) : null;
}

const samePrice = (a: Price, b: Price) => a.input === b.input && a.output === b.output;

/** `price` as the pull request says it. */
const priced = ({ input, output }: Price) => `$${input} / $${output}`;

/** Whether models.dev's `entry` is a model that reads and writes text and takes tools, as Ember's answers need. */
function takesTools(entry: Record<string, unknown>): boolean {
  const modalities = isObject(entry.modalities) ? entry.modalities : {};
  const hasText = (listed: unknown) => !Array.isArray(listed) || listed.includes("text");
  return entry.tool_call === true && hasText(modalities.input) && hasText(modalities.output);
}

/**
 * What models.dev and LiteLLM say of the models `file` lists, `modelsDev` and `liteLlm` being their
 * lists: the file with each price both give, when that's another, and the day LiteLLM gives one stopping,
 * when that's another, as long as Ember reads the model so still (`parseModelsFile`), and what changed.
 * What only one of them says, or that Ember can't read, is noted, as are the newer models of each maker
 * the file lists models of (`newerModelsOf`).
 */
export function checkModels(file: ModelsJson, modelsDev: unknown, liteLlm: unknown): Findings {
  const changes: string[] = [];
  const notes: string[] = [];
  const models = file.models.map((listed) => {
    const id = makersIdOf(listed.id);
    if (!id) return listed;
    const known = modelsDevOf(modelsDev, id.maker)[id.model];
    const lite = liteLlmOf(liteLlm, id.maker, id.model);
    if (!known && !lite) notes.push(`Neither models.dev nor LiteLLM lists ${listed.name}, \`${id.model}\` at ${MAKERS[id.maker]}.`);
    const fromModelsDev = modelsDevPriceOf(known);
    const fromLiteLlm = liteLlmPriceOf(lite);
    let model = listed;
    if (fromModelsDev && fromLiteLlm && samePrice(fromModelsDev, fromLiteLlm)) {
      if (!samePrice(fromModelsDev, listed.price)) model = changed(model, { price: fromModelsDev }, `${listed.name} costs ${priced(fromModelsDev)} now, not ${priced(listed.price)}.`);
    } else if ([fromModelsDev, fromLiteLlm].some((price) => price && !samePrice(price, listed.price))) {
      const says = (price: Price | null) => (price ? priced(price) : "nothing");
      notes.push(`${listed.name} costs ${priced(listed.price)} in models.json, but models.dev says ${says(fromModelsDev)}, and LiteLLM ${says(fromLiteLlm)}.`);
    }
    const stops = typeof lite?.deprecation_date === "string" && DAY.test(lite.deprecation_date) ? lite.deprecation_date : null;
    if (stops && stops !== listed.until) model = changed(model, { until: stops }, `${listed.name} stops running on ${stops}, LiteLLM says.`);
    else if (!stops && !listed.until && known?.status === "deprecated") notes.push(`models.dev says ${MAKERS[id.maker]} has deprecated ${listed.name}, but not when it stops running.`);
    return model;
  });

  /** `model` with `change`, saying so as `said`, unless Ember wouldn't read it so, which it notes. */
  function changed(model: FileModel, change: Partial<FileModel>, said: string): FileModel {
    const changedModel = { ...model, ...change };
    const read = parseModelsFile({ version: file.version, suggested: model.id, models: [changedModel] })?.models[0];
    if (!read || (change.price && !samePrice(read.price!, change.price)) || (change.until && read.until !== change.until)) {
      notes.push(`${said} But Ember wouldn't read that, so models.json says what it did.`);
      return model;
    }
    changes.push(said);
    return changedModel;
  }

  return { file: { ...file, models }, changes, notes, newer: newerModelsOf(file, modelsDev) };
}

/**
 * The models models.dev lists, of each maker `file` lists models of, that read and write text and take
 * tools, released after the newest of the maker's that the file lists, newest first: each with its
 * maker's ID for it, the day it came out, and what it costs, if models.dev says.
 */
export function newerModelsOf(file: ModelsJson, modelsDev: unknown): string[] {
  const newer: Array<{ day: string; said: string }> = [];
  for (const maker of Object.keys(MAKERS) as Maker[]) {
    const listed = new Set(file.models.flatMap(({ id }) => (makersIdOf(id)?.maker === maker ? [makersIdOf(id)!.model] : [])));
    const known = modelsDevOf(modelsDev, maker);
    const dayOf = (entry: Record<string, unknown>) => (typeof entry.release_date === "string" && DAY.test(entry.release_date) ? entry.release_date : null);
    const newest = [...listed].flatMap((model) => (known[model] && dayOf(known[model]) ? [dayOf(known[model])!] : [])).sort().at(-1);
    if (!newest) continue;
    for (const [model, entry] of Object.entries(known)) {
      const day = dayOf(entry);
      if (listed.has(model) || !day || day <= newest || !takesTools(entry) || (entry.status ?? null) !== null) continue;
      const name = typeof entry.name === "string" ? entry.name : model;
      const price = modelsDevPriceOf(entry);
      newer.push({ day, said: `${name}, \`${model}\` at ${MAKERS[maker]}, released ${day}${price ? `, at ${priced(price)}` : ""}.` });
    }
  }
  return newer.sort((a, b) => b.day.localeCompare(a.day)).map(({ said }) => said);
}

/** `value` on one line, as models.json writes each model: `{ "id": "…", "price": { "input": 1, "output": 5 }, "web": ["search"] }`. */
function oneLine(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`;
  if (isObject(value)) return `{ ${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}: ${oneLine(field)}`).join(", ")} }`;
  return JSON.stringify(value);
}

/** models.json's text for `file`: each field on a line of its own, and each model on one line. */
export function fileText(file: ModelsJson): string {
  const { models, ...fields } = file;
  const lines = Object.entries(fields).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  return `{\n${lines.join("\n")}\n  "models": [\n${models.map((model) => `    ${oneLine(model)}`).join(",\n")}\n  ]\n}\n`;
}

/** What the pull request, or the issue, says: what changed in models.json, what to look at, and the newer models. */
export function reportOf({ changes, notes, newer }: Findings): string {
  const section = (title: string, lines: string[]) => (lines.length > 0 ? [`### ${title}`, "", ...lines.map((line) => `- ${line}`), ""] : []);
  return [
    `This week's check of \`models.json\`, which every copy of Ember reads from \`main\` once a day ([docs/models.md](${EMBER}/blob/main/docs/models.md)), against [models.dev](https://models.dev)'s and [LiteLLM](https://github.com/BerriAI/litellm)'s lists of models.`,
    "",
    ...section("What this changes", changes),
    ...(changes.length > 0 ? ["Merging it changes what every copy offers within a day, without an update. GitHub doesn't run checks on a pull request a workflow opens.", ""] : []),
    ...section("To look at", notes),
    ...section("Newer models models.json doesn't list", newer),
    ...(newer.length > 0 ? ["A model is added by hand, with what it may do on the web, once it's been tried through AI Gateway.", ""] : []),
  ].join("\n");
}

/** A list read from `source`: a file, as the tests give, or else an address. */
async function readList(source: string): Promise<unknown> {
  if (!/^https?:\/\//.test(source)) return JSON.parse(readFileSync(source, "utf8")) as unknown;
  const response = await fetch(source, { headers: { "User-Agent": `Ember's models check (+${EMBER})` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${source} answered ${response.status}.`);
  return (await response.json()) as unknown;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input?: string): Result {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `command` and answers its output, or throws with what it said if it fails. */
function check(command: string, args: string[], input?: string): string {
  const result = run(command, args, input);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const git = (args: string[]) => check("git", args);
const lastLine = (output: string) => output.trim().split("\n").at(-1) ?? "";

/** What a gh listing finds, or nothing if it can't look, as when the repository has no issues. */
function listed<T>(args: string[]): T[] {
  const result = run("gh", args);
  return result.status === 0 ? (JSON.parse(result.stdout) as T[]) : [];
}

/** Says what happened, in the log and, in a workflow, its run's summary. */
function report(message: string): void {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

/** GitHub's page for opening a pull request from `branch`, with its title and description filled in. */
function openPullRequestLink(main: string, branch: string, body: string): string {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  return `${server}/${process.env.GITHUB_REPOSITORY}/compare/${main}...${branch}?expand=1&title=${encodeURIComponent(TITLE)}&body=${encodeURIComponent(body)}`;
}

interface Opened {
  number: number;
  url: string;
}

/**
 * Pushes the change in `text` to a branch named after it and opens a pull request with it, unless one is
 * open already, or, with nothing to change, opens an issue with what to look at, or edits the one open,
 * and closes the pull requests and issue earlier weeks left that this replaces. GitHub doesn't let a new
 * repository's workflows open pull requests, so then the issue links to the one to open.
 */
function publish(findings: Findings, text: string): void {
  const body = reportOf(findings);
  const pulls = listed<Opened & { headRefName: string }>(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,headRefName"]).filter(({ headRefName }) =>
    headRefName.startsWith(BRANCHES),
  );
  const issues = listed<Opened & { title: string }>(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,url,title"]).filter(({ title }) => title === ISSUE_TITLE);
  const close = (kind: "pr" | "issue", open: Opened[], reason: string) => {
    for (const { number } of open) run("gh", [kind, "close", String(number), "--comment", reason, ...(kind === "pr" ? ["--delete-branch"] : [])]);
  };
  /** Opens the issue saying `said`, or edits the one open to, answering where it is. */
  const fileIssue = (said: string) => {
    const [open, ...others] = issues;
    close("issue", others, "Another issue says what to look at.");
    if (open) {
      check("gh", ["issue", "edit", String(open.number), "--body-file", "-"], said);
      return open.url;
    }
    return lastLine(check("gh", ["issue", "create", "--title", ISSUE_TITLE, "--body-file", "-"], said));
  };

  if (findings.changes.length === 0) {
    close("pr", pulls, "models.dev and LiteLLM no longer say what this changes.");
    if (findings.notes.length === 0 && findings.newer.length === 0) {
      close("issue", issues, "models.json agrees with models.dev and LiteLLM now.");
      return report(AGREES);
    }
    return report(`Nothing in models.json changes, and ${fileIssue(body)} says what to look at.`);
  }

  const branch = `${BRANCHES}${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
  const same = pulls.find(({ headRefName }) => headRefName === branch);
  if (same) {
    check("gh", ["pr", "edit", String(same.number), "--body-file", "-"], body);
    close("pr", pulls.filter((pull) => pull !== same), `${same.url} has these changes.`);
    close("issue", issues, `${same.url} says what to look at now.`);
    return report(`${same.url} has these changes already.`);
  }
  const main = git(["symbolic-ref", "--short", "HEAD"]);
  // A branch an earlier week pushed holds this file already, as when GitHub didn't let it open the pull request.
  if (git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]) === "") {
    git(["switch", "--quiet", "-c", branch]);
    writeFileSync(FILE, text);
    git(["commit", "--quiet", "-m", TITLE, "--", FILE]);
    git(["push", "--quiet", "origin", `${branch}:refs/heads/${branch}`]);
  }
  const opened = run("gh", ["pr", "create", "--base", main, "--head", branch, "--title", TITLE, "--body-file", "-"], body);
  if (opened.status === 0) {
    const where = lastLine(opened.stdout);
    close("pr", pulls, `${where} has newer changes.`);
    close("issue", issues, `${where} says what to look at now.`);
    return report(`Opened ${where}, which updates models.json.`);
  }
  if (!PULL_REQUESTS_NOT_PERMITTED.test(opened.stderr)) throw new Error(`gh pr create failed: ${opened.stderr.trim()}`);
  close("pr", pulls, `${branch} has newer changes.`);
  const where = fileIssue(`GitHub doesn't let this repository's workflows open pull requests, so [open the one for ${branch}](${openPullRequestLink(main, branch, body)}).\n\n${body}`);
  report(`GitHub doesn't let this workflow open pull requests, so ${where} links to the one that updates models.json.`);
}

async function checkModelsFile(args: string[]): Promise<void> {
  process.chdir(git(["rev-parse", "--show-toplevel"]));
  const text = readFileSync(FILE, "utf8");
  const [modelsDev, liteLlm] = await Promise.all([readList(MODELS_DEV), readList(LITELLM)]);
  const findings = checkModels(JSON.parse(text) as ModelsJson, modelsDev, liteLlm);
  const changed = findings.changes.length > 0 ? fileText(findings.file) : text;
  if (args.includes("--publish")) return publish(findings, changed);
  if (changed !== text) writeFileSync(FILE, changed);
  const found = findings.changes.length + findings.notes.length + findings.newer.length > 0;
  report(found ? reportOf(findings) : AGREES);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await checkModelsFile(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

import { EMBER_REPOSITORY } from "@ember/protocol";
import {
  ASSISTANT_MODELS,
  isWorkersAiModel,
  modelNameOf,
  modelOf,
  offeredModelOf,
  parseModelsFile,
  searchFormatOf,
  SUGGESTED_MODEL,
  THINKING_LEVELS,
  webToolsOf,
  type ModelFormat,
  type ModelPrice,
  type ModelsFile,
  type OfferedModel,
  type OfferedModels,
  type ThinkingLevel,
} from "@ember/protocol/assistant";
import { waitUntil } from "cloudflare:workers";
import { bodyUpTo } from "../bodies";
import type { Env } from "../env";
import { isLoopback } from "../loopback";
import { VERSION } from "../version";
import { workspace } from "../workspace";
import { cloudflareApiOf, isObject, refusalOf, type GatewayRefusal } from "./gateway";

// The models Ember offers administrators, as Set up Ember AI, Add a model and the agents' pages list
// them. Anthropic's, OpenAI's and xAI's come from the models file on Ember's main branch, which every copy
// of Ember reads once a day, so that a model can be offered, or stop being, without an update
// (docs/models.md). Workers AI's come from Cloudflare's model search, `GET /accounts/{id}/ai/models/search`
// in OpenRouter's format, which lists each model's tools and reasoning efforts and takes the Workers AI
// Read permission: those that take tools, which Ember gives its own for searching the web, read once a
// day too. The Workspace keeps a copy of each, which a listing answers with at once, reading a copy a
// day old again in the background for the next. Until the file is read, and whenever it can't be, Ember
// offers the one its release shipped with.

/** Where every copy of Ember reads the models file: Ember's main branch, which keeps it at this address for good. */
export const MODELS_FILE_URL = "https://raw.githubusercontent.com/NYLLON-SOFTWARE/ember-cloudflare/main/models.json";

/** How old a copy the Workspace keeps gets before a listing reads it again, for the next. */
export const OFFERED_FRESH_MS = 24 * 60 * 60 * 1000;

/** How long after the models file couldn't be read a listing reads it again. */
export const MODELS_FILE_RETRY_MS = 60 * 60 * 1000;

/** How long Ember waits for the models file, and for each page of the model search. */
const READ_TIMEOUT_MS = 10_000;

/** The most of the models file Ember reads, many times what it lists. */
const MAX_FILE_BYTES = 64 * 1024;

/** What the Worker says it is to GitHub. */
const USER_AGENT = `Ember/${VERSION} (+${EMBER_REPOSITORY})`;

/** How many models Ember asks the model search for on each page, the most it gives. */
const PER_PAGE = 100;

/** The most pages of the model search Ember reads, a few at once: it lists a few hundred text models. */
const MAX_PAGES = 10;
const PAGES_AT_ONCE = 3;

/** The most of Workers AI's models Ember offers. */
const MAX_WORKERS_AI_MODELS = 200;

/** Why Workers AI's models aren't among those offered: Cloudflare didn't let the API token list them, or the model search didn't answer. */
export const WORKERS_AI_TOKEN_REFUSED =
  "Workers AI's models aren't listed, as Cloudflare didn't let the API token list them. Add the Workers AI Read permission to it in the Cloudflare dashboard.";
export const WORKERS_AI_UNLISTED = "Workers AI's models aren't listed, as Cloudflare's model search didn't answer. Try again in a moment.";

/**
 * The models file as the Workspace keeps it: where it was read, the file it last read there, or null
 * before it has, when it last tried, and whether it read the file then.
 */
export interface KeptModelsFile {
  url: string;
  file: ModelsFile | null;
  triedAt: number;
  read: boolean;
}

/** Workers AI's models as the Workspace keeps them: those the model search last listed for the account `accountId`, and when. */
export interface KeptWorkersAiModels {
  accountId: string;
  models: OfferedModel[];
  readAt: number;
}

/** What Ember lists Workers AI's models with: a Cloudflare account, and an API token of its. */
export interface ModelSearchKeys {
  accountId: string;
  apiToken: string;
}

/** The models file this Ember shipped with. */
const shipped = (): ModelsFile => ({ models: [...ASSISTANT_MODELS], suggested: SUGGESTED_MODEL });

/**
 * Where this Ember reads the models file: `EMBER_MODELS_URL`, when it's set, as an https address, or as
 * the browser tests' stand-in's, at a loopback one, or nowhere when it's blank, or else MODELS_FILE_URL.
 */
export function modelsFileUrlOf(env: Env): string | null {
  if (env.EMBER_MODELS_URL === undefined) return MODELS_FILE_URL;
  const url = URL.parse(env.EMBER_MODELS_URL.trim());
  return url && (url.protocol === "https:" || isLoopback(url)) ? url.href : null;
}

/**
 * The models file as the Workspace last read it, or else as this Ember shipped it, which it reads again
 * for the next listing, in the background, once the copy is a day old, or an hour after it last couldn't,
 * or, `atOnce`, now, when it hasn't been read.
 */
export async function modelsFileOf(env: Env, atOnce = false): Promise<ModelsFile> {
  const url = modelsFileUrlOf(env);
  if (url === null) return shipped();
  const found = await workspace(env).keptModelsFile();
  const kept = found?.url === url ? found : null;
  if (!kept && atOnce) return (await readAndKeepModelsFile(env, url)) ?? shipped();
  if (!kept || Date.now() - kept.triedAt >= (kept.read ? OFFERED_FRESH_MS : MODELS_FILE_RETRY_MS)) {
    waitUntil(readAndKeepModelsFile(env, url).catch((error: unknown) => console.error("Keeping the models file failed:", error)));
  }
  return kept?.file ?? shipped();
}

/** Reads the models file at `url`, which the Workspace keeps, or else keeps the one it kept, saying it couldn't, so that it tries again sooner. */
async function readAndKeepModelsFile(env: Env, url: string): Promise<ModelsFile | null> {
  const file = await readModelsFile(url);
  await workspace(env).keepModelsFile({ url, file, triedAt: Date.now(), read: file !== null });
  return file;
}

/** The models file at `url`, or null when it can't be read, or isn't one this Ember reads (`parseModelsFile`), which the log says. */
export async function readModelsFile(url: string): Promise<ModelsFile | null> {
  let text: string | null;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) {
      console.error(`The models file wasn't read, as ${url} answered ${response.status}`);
      return null;
    }
    text = await bodyUpTo(response, MAX_FILE_BYTES);
  } catch (error) {
    console.error("Reading the models file failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
  const file = text === null ? null : parseModelsFile(jsonOf(text));
  if (!file) console.error(`The models file wasn't read, as it ${text === null ? "is larger than Ember reads" : "isn't one this Ember reads"}`);
  return file;
}

/** The JSON value `text` holds, or null when it holds none. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether a listed model runs still, as it does until the day it stops running, `until`, if it has one:
 * a copy of a listing kept since the day before may list one that has stopped.
 */
const runsStill = ({ until }: OfferedModel) => until === undefined || until > new Date().toISOString().slice(0, 10);

/**
 * The models Ember offers (`OfferedModels`) through the account `keys` names: those the models file lists
 * (`modelsFileOf`), which is read now if it hasn't been, then Workers AI's, as the Workspace keeps them
 * for that account (`keptWorkersAiModelsOf`), or as the model search lists them now, `fresh`, as Set up
 * Ember AI asks with an API token typed into it, which they're kept from then, or why they aren't listed:
 * there's no API token to list them with, or the model search refused it, or didn't answer. None is
 * offered from the day it stops running (`runsStill`).
 */
export async function offeredModelsOf(env: Env, keys: { accountId: string; apiToken: string | null }, fresh: boolean, noToken: string): Promise<OfferedModels> {
  const { accountId, apiToken } = keys;
  const [file, workersAi] = await Promise.all([
    modelsFileOf(env, true),
    apiToken === null ? null : fresh ? readAndKeepWorkersAiModels(env, { accountId, apiToken }) : keptWorkersAiModelsOf(env, { accountId, apiToken }),
  ]);
  if (workersAi === null || "refusal" in workersAi) {
    if (workersAi) console.error(`Listing the models file's models alone, as Workers AI's weren't listed: ${workersAi.refusal}`);
    return stillOffered(file.models, file.suggested, workersAi?.refusal ?? noToken);
  }
  return stillOffered([...file.models, ...workersAi], file.suggested, null);
}

/**
 * The models `listed` that Ember offers, those that run still (`runsStill`), with why Workers AI's aren't
 * among them, `workersAi`, and the one Set up Ember AI starts at: `suggested`, while it runs still, or
 * else the first that does.
 */
export function stillOffered(listed: readonly OfferedModel[], suggested: string, workersAi: string | null): OfferedModels {
  const models = listed.filter(runsStill);
  const starting = models.some(({ id }) => id === suggested) ? suggested : (models[0]?.id ?? suggested);
  return { models, suggested: starting, workersAi };
}

/**
 * The model `model` as Ember offers it through the account `keys` names, or null when it doesn't: as the
 * models file lists it, or, for one of Workers AI's, as the model search last listed it for that account,
 * which is asked now when it hasn't been, but for one that has stopped running (`runsStill`).
 */
export async function offeredModel(env: Env, model: string, keys: ModelSearchKeys): Promise<OfferedModel | null> {
  const listed = isWorkersAiModel(model) ? await keptWorkersAiModelsOf(env, keys) : (await modelsFileOf(env)).models;
  const offered = "refusal" in listed ? undefined : offeredModelOf(model, listed);
  return offered && runsStill(offered) ? offered : null;
}

/**
 * Whether `model` is given the tools Ember runs (tool-calls.ts): one the models file lists, each of which
 * takes them in the format Ember asks it in. One of Workers AI's is asked in a format of its own, whose
 * only tool is Ember's for searching the web, and a model kept from before Ember offered its own may take
 * none, and would be asked every question twice, the second time without them.
 */
export async function takesEmbersTools(env: Env, model: string): Promise<boolean> {
  return !isWorkersAiModel(model) && offeredModelOf(model, (await modelsFileOf(env)).models) !== undefined;
}

/**
 * The format `model`, which took its test question in `format`, searches the web in (`searchFormatOf`)
 * through the account `keys` names, or null when it can't: when the models file says it may do nothing
 * there, or it's one of Workers AI's that the model search doesn't list, as it lists only those that
 * take tools, as Ember's for searching the web is.
 */
export async function searchingFormatOf(env: Env, keys: ModelSearchKeys, model: string, format: ModelFormat): Promise<ModelFormat | null> {
  const searchFormat = searchFormatOf(model, format);
  if (searchFormat === "workers") return (await offeredModel(env, model, keys)) ? searchFormat : null;
  return searchFormat && webToolsOf(model, searchFormat, (await modelsFileOf(env)).models).length > 0 ? searchFormat : null;
}

/**
 * Workers AI's models that the model search lists for the account `keys` names (`workersAiModelsOf`), as
 * the Workspace keeps them, which it reads again for the next listing, in the background, once they're a
 * day old, or else as it lists them now, which they're kept from, or why it couldn't.
 */
export async function keptWorkersAiModelsOf(env: Env, keys: ModelSearchKeys): Promise<OfferedModel[] | GatewayRefusal> {
  const kept = await workspace(env).keptWorkersAiModels(keys.accountId);
  if (!kept) return readAndKeepWorkersAiModels(env, keys);
  if (Date.now() - kept.readAt >= OFFERED_FRESH_MS) waitUntil(readWorkersAiModelsAgain(env, keys));
  return kept.models;
}

/** Lists Workers AI's models again with `keys` for the listings that follow, as `readAndKeepWorkersAiModels` does, saying in the log why it couldn't, since nobody's waiting to hear. */
async function readWorkersAiModelsAgain(env: Env, keys: ModelSearchKeys): Promise<void> {
  try {
    const models = await readAndKeepWorkersAiModels(env, keys);
    if ("refusal" in models) console.error(`Workers AI's models weren't listed again: ${models.refusal}`);
  } catch (error) {
    console.error("Listing Workers AI's models again failed:", error);
  }
}

/**
 * Workers AI's models as the model search lists them with `keys` (`workersAiModelsOf`), which the
 * Workspace keeps, or else, when Cloudflare refuses the API token or the account, forgets the copy it
 * kept, so that the next listing says why. A model search that didn't answer leaves the copy as it was.
 */
export async function readAndKeepWorkersAiModels(env: Env, keys: ModelSearchKeys): Promise<OfferedModel[] | GatewayRefusal> {
  const models = await workersAiModelsOf(env, keys);
  if (!("refusal" in models)) await workspace(env).keepWorkersAiModels({ accountId: keys.accountId, models, readAt: Date.now() });
  else if (models.reason === "token" || models.reason === "account") await workspace(env).forgetWorkersAiModels(keys.accountId);
  return models;
}

/**
 * Workers AI's text models that take tools (`workersAiModelOf`), as Cloudflare's model search lists them
 * for the account `keys` names, by their names, but for experimental ones, or why it couldn't list them:
 * Cloudflare didn't take the API token, or has no such account, or the search didn't answer. Its pages
 * are read, the first alone, then a few at once, until one isn't full, or lists none but those listed
 * already.
 */
export async function workersAiModelsOf(env: Env, keys: ModelSearchKeys): Promise<OfferedModel[] | GatewayRefusal> {
  const listed = new Set<string>();
  const models: OfferedModel[] = [];
  // The first page alone, as most accounts' models fit on one or a few, then a few at once.
  for (let first = 1; first <= MAX_PAGES; first += first === 1 ? 1 : PAGES_AT_ONCE) {
    const numbers = Array.from({ length: first === 1 ? 1 : Math.min(PAGES_AT_ONCE, MAX_PAGES - first + 1) }, (_, index) => first + index);
    const pages = await Promise.all(numbers.map((page) => searchPageOf(env, keys, page)));
    let unlisted = 0;
    for (const page of pages) {
      if ("refusal" in page) return page;
      for (const row of page.rows) {
        const id = isObject(row) && typeof row.id === "string" ? row.id : null;
        if (id === null || listed.has(id)) continue;
        listed.add(id);
        unlisted++;
        const model = workersAiModelOf(row);
        if (model) models.push(model);
      }
    }
    const last = pages.at(-1);
    if (unlisted === 0 || !last || "refusal" in last || last.rows.length < PER_PAGE) break;
  }
  if (listed.size === 0) return { status: 502, reason: "unanswered", refusal: WORKERS_AI_UNLISTED };
  const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return models.sort((a, b) => byName.compare(a.name, b.name)).slice(0, MAX_WORKERS_AI_MODELS);
}

/** Page `page` of the model search's text models, in OpenRouter's format, as rows, or why Cloudflare didn't answer with it. */
async function searchPageOf(env: Env, { accountId, apiToken }: ModelSearchKeys, page: number): Promise<{ rows: unknown[] } | GatewayRefusal> {
  const query = new URLSearchParams({ task: "Text Generation", format: "openrouter", hide_experimental: "true", per_page: `${PER_PAGE}`, page: `${page}` });
  let response: Response;
  try {
    response = await fetch(`${cloudflareApiOf(env)}/accounts/${accountId}/ai/models/search?${query}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Reading Cloudflare's model search failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 502, reason: "unanswered", refusal: WORKERS_AI_UNLISTED };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return searchRefusalOf(response.status, body);
  // OpenRouter's format lists them in `data`, and Cloudflare's own in `result`.
  const rows = isObject(body) ? (Array.isArray(body.data) ? body.data : Array.isArray(body.result) ? body.result : null) : null;
  return rows ? { rows } : { status: 502, reason: "unanswered", refusal: WORKERS_AI_UNLISTED };
}

/** Why Cloudflare didn't answer with the model search: the API token, which needs Workers AI Read, or the account, as Cloudflare's REST API says (`refusalOf`), or else that it didn't answer. */
function searchRefusalOf(status: number, body: unknown): GatewayRefusal {
  if (status === 401 || status === 403) return { status: 422, reason: "token", field: "apiToken", refusal: WORKERS_AI_TOKEN_REFUSED };
  const refusal = refusalOf(status, body);
  return refusal.reason === "account" ? refusal : { status: 502, reason: "unanswered", refusal: WORKERS_AI_UNLISTED };
}

/**
 * The model the model search's `row` lists, in OpenRouter's format, if Ember offers it: one of Workers
 * AI's that reads and writes text and takes tools, so that it can take Ember's for searching the web,
 * called by its name, or else its ID's last part, with what it costs, the levels of thinking it takes
 * (`thinkingLevelsIn`), and the day Cloudflare plans to stop running it, if it plans one.
 */
export function workersAiModelOf(row: unknown): OfferedModel | null {
  if (!isObject(row) || typeof row.id !== "string" || !isWorkersAiModel(row.id) || modelOf(row.id) !== row.id) return null;
  const features: unknown[] = Array.isArray(row.supported_features) ? row.supported_features : [];
  if (!features.includes("tools") || !takesText(row.input_modalities) || !takesText(row.output_modalities)) return null;
  const { id } = row;
  const price = priceIn(row.pricing);
  const thinkingLevels = thinkingLevelsIn(isObject(row.reasoning) ? row.reasoning : features.includes("reasoning") ? undefined : null);
  const until = dayIn(row.deprecation_date);
  const name = modelNameOf(row.name) ?? id.slice(id.lastIndexOf("/") + 1);
  return { id, name, format: "workers", ...(price && { price }), ...(thinkingLevels && { thinkingLevels }), ...(until && { until }) };
}

/** Whether the model search's `modalities` for a model's input or output have text among them, as they do when it doesn't list them. */
const takesText = (modalities: unknown) => !Array.isArray(modalities) || modalities.includes("text");

/**
 * The levels of thinking a model takes whose reasoning the model search says is `reasoning`: those whose
 * reasoning efforts, as Ember asks for them, "none" for Off, the model supports, as Cloudflare's REST API
 * takes any and turns those it doesn't into others, as GLM 5.2 turns Low and Medium into High, which
 * would be more than they are, though High counts when it's turned into the most, and Off doesn't for a
 * model whose reasoning is mandatory. A model that doesn't reason, `null`, takes none, and one whose
 * efforts it doesn't say, `undefined`, is asked at each, as one added before Ember read the search was.
 */
export function thinkingLevelsIn(reasoning: Record<string, unknown> | null | undefined): ThinkingLevel[] | undefined {
  if (reasoning === null) return [];
  const efforts: unknown[] = Array.isArray(reasoning?.supported_efforts) ? reasoning.supported_efforts : [];
  if (!reasoning || efforts.length === 0) return undefined;
  const turnedInto = isObject(reasoning.normalizes_to) ? reasoning.normalizes_to : {};
  const takes = (level: ThinkingLevel) => {
    if (level === "off") return reasoning.mandatory !== true && efforts.includes("none");
    return efforts.includes(level) || (level === "high" && (turnedInto.high === "xhigh" || turnedInto.high === "max"));
  };
  return THINKING_LEVELS.filter(takes);
}

/**
 * What a model costs, as the model search's `pricing` says, in US dollars for each token read (`prompt`)
 * and written (`completion`), for each million, or undefined unless it says both.
 */
function priceIn(pricing: unknown): ModelPrice | undefined {
  if (!isObject(pricing)) return undefined;
  const perMillion = (value: unknown) => {
    const perToken = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
    return Number.isFinite(perToken) && perToken >= 0 ? Math.round(perToken * 1e10) / 1e4 : undefined;
  };
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  return input === undefined || output === undefined ? undefined : { input, output };
}

/** The day `value` starts with, as YYYY-MM-DD, or undefined when it doesn't start with one. */
const dayIn = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) ? value.slice(0, 10) : undefined);

import shippedModelsFile from "../../../models.json" with { type: "json" };
import { ASSISTANT_ID } from "./index.ts";
import { parseTemplate } from "./prompts.ts";

// Ember AI, which answers as @ember through Cloudflare's AI Gateway, as administrators set it up on the
// AI assistant tab of workspace settings through `/api/account/assistant`.

/**
 * The API formats Ember asks a model in: the providers' own, which AI Gateway's endpoint for each
 * provider passes on as they are, Anthropic's Messages, OpenAI's Responses and xAI's Responses, each the
 * provider's whole API, where Grok can search the web too, Workers AI's, which is Chat Completions on
 * Cloudflare's REST API with Ember's own tool for searching the web, and the three that REST API takes a
 * model's requests in, at `/ai/v1/messages`, `/ai/v1/responses` and `/ai/v1/chat/completions`, which
 * Ember asks only a model kept from before it offered just its own list in, in the one it took then.
 */
export const MODEL_FORMATS = ["messages", "responses", "chat", "xai", "anthropic", "openai", "workers"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

/** The formats of the providers' own APIs, which AI Gateway's endpoint for each provider passes on. */
export const PROVIDER_FORMATS = ["anthropic", "openai", "xai"] as const satisfies readonly ModelFormat[];
export type ProviderFormat = (typeof PROVIDER_FORMATS)[number];

/** Whether `format` is a provider's own, asked through AI Gateway's endpoint for that provider rather than Cloudflare's REST API. */
export const isProviderFormat = (format: ModelFormat): format is ProviderFormat => (PROVIDER_FORMATS as readonly ModelFormat[]).includes(format);

/**
 * A model @ember can answer with, as Ember offers it, or as it was kept before Ember stopped offering it:
 * its ID, what to call it, the format AI Gateway takes its requests in, and what it costs, for one Ember
 * offers.
 */
export interface AssistantModel {
  id: string;
  name: string;
  format: ModelFormat;
  price?: ModelPrice;
  /**
   * The levels of thinking it takes, as Cloudflare's model search lists them for one of Workers AI's, or
   * else as asking it at each found when an administrator added it, since nothing else says reliably:
   * left out for one Ember hasn't asked at each, which is asked at any.
   */
  thinkingLevels?: ThinkingLevel[];
}

/** What a model costs through AI Gateway, in US dollars for each million tokens it reads and writes. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * A model Ember offers, as Set up Ember AI, Add a model and the agents' pages list it: with what it may
 * do on the web, when that's less than its format has tools for (`WEB_TOOLS_IN`), and, for one that its
 * maker, or Cloudflare for Workers AI's, plans to stop running, the day it does, as YYYY-MM-DD.
 */
export interface OfferedModel extends AssistantModel {
  webTools?: WebTool[];
  until?: string;
}

/**
 * The models Ember offers an administrator, as `POST /api/account/assistant/offered` answers: those the
 * models file lists (`parseModelsFile`), then Workers AI's that take Ember's tool for searching the web,
 * as Cloudflare's model search lists them for the account, the one Set up Ember AI starts at, and why
 * Workers AI's aren't among them, when they aren't.
 */
export interface OfferedModels {
  models: OfferedModel[];
  suggested: string;
  workersAi: string | null;
}

/**
 * The models file, models.json in Ember's repository, which every copy of Ember reads from its main
 * branch once a day, so that a model can be offered, or stop being, without an update: Anthropic's,
 * OpenAI's and xAI's, each asked in its provider's own format through AI Gateway's endpoint for that
 * provider, with what AI Gateway's credits pay for it, at its provider's prices, and what it may do on
 * the web, and the one Set up Ember AI starts at.
 */
export interface ModelsFile {
  models: OfferedModel[];
  suggested: string;
}

/** The version of the models file this Ember reads: it reads none written for another. */
export const MODELS_FILE_VERSION = 1;

/** The most models Ember reads from the models file. */
const MAX_FILE_MODELS = 50;

/** The most a million tokens can cost, read or written, as the models file says, in US dollars. */
const MAX_PRICE = 1_000;

/**
 * The models file `data` gives, or null when it can't be one: its version isn't this Ember's, or it lists
 * no model Ember can offer. It can't say anything but what's offered: each model is named by its ID, which
 * starts with its provider's, Anthropic's, OpenAI's or xAI's, and gives the format it's asked in, so that
 * the file names no address, and it has a name, a price, and what it may do on the web, of what that
 * format has tools for, and may have the day its maker stops running it, as YYYY-MM-DD. A model that
 * isn't all of that is left out, as is any field Ember doesn't know, so that a later Ember's file still
 * lists what this one can offer. The model it starts at is the one it suggests, while it lists it, or
 * else its first.
 */
export function parseModelsFile(data: unknown): ModelsFile | null {
  const file = objectIn(data);
  if (file.version !== MODELS_FILE_VERSION || !Array.isArray(file.models)) return null;
  const listed = new Map<string, OfferedModel>();
  for (const entry of file.models.slice(0, MAX_FILE_MODELS)) {
    const model = fileModelOf(entry);
    if (model && !listed.has(model.id)) listed.set(model.id, model);
  }
  const [first] = listed.keys();
  if (first === undefined) return null;
  const suggested = typeof file.suggested === "string" && listed.has(file.suggested) ? file.suggested : first;
  return { models: [...listed.values()], suggested };
}

/** The model an entry of the models file lists, or null when it isn't one Ember can offer (`parseModelsFile`). */
function fileModelOf(entry: unknown): OfferedModel | null {
  const given = objectIn(entry);
  const id = typeof given.id === "string" ? modelOf(given.id) : null;
  const format = id === null ? null : offeredFormatOf(id);
  const name = modelNameOf(given.name);
  const price = priceOf(given.price);
  if (id === null || format === null || name === null || price === null || !Array.isArray(given.web)) return null;
  const may: unknown[] = given.web;
  // What it may do on the web is of what the format it searches in has tools for.
  const searching = WEB_TOOLS_IN[searchFormatOf(id, format) ?? format];
  const webTools = searching.filter((tool) => may.includes(tool));
  const until = typeof given.until === "string" && DAY.test(given.until) ? given.until : null;
  return { id, name, format, price, ...(webTools.length < searching.length && { webTools }), ...(until && { until }) };
}

/**
 * The format Ember asks a model the models file lists in: its provider's own, or Chat Completions,
 * through Cloudflare's REST API, for Grok, as AI Gateway's credits don't pay for it at its xAI endpoint,
 * where it searches with Ember's own tool, or null for anyone else's.
 */
const offeredFormatOf = (id: string): ModelFormat | null => providerFormatOf(id) ?? (isXaiModel(id) ? "chat" : null);

/** A day, as the models file writes the one a model stops running on. */
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** The price `data` gives, or null when it isn't one: what a million tokens read and written cost, neither below nothing nor above `MAX_PRICE`. */
function priceOf(data: unknown): ModelPrice | null {
  const { input, output } = objectIn(data);
  const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE;
  return amount(input) && amount(output) ? { input: input as number, output: output as number } : null;
}

/** The model with the ID `model` of those `offered`, if it's one of them. */
export const offeredModelOf = (model: string, offered: readonly OfferedModel[]) => offered.find(({ id }) => id === model);

/** Whether `model` is one of Workers AI's, which Cloudflare runs itself, rather than another company's. */
export const isWorkersAiModel = (model: string) => model.startsWith("@cf/");

/**
 * Whether Ember no longer offers `model`, as the Worker lists the models it does, `offered`: it isn't
 * among them, and isn't one of Workers AI's while those couldn't be listed, `workersAi` saying why, as
 * Ember may offer it still.
 */
export const noLongerOffered = (model: string, offered: readonly OfferedModel[], workersAi: string | null) =>
  !offeredModelOf(model, offered) && !(isWorkersAiModel(model) && workersAi !== null);

/** Whether `model` is one of xAI's, Grok, which searches the web with Ember's own tool in Chat Completions. */
export const isXaiModel = (model: string) => model.startsWith("xai/");

/**
 * The format of `model`'s provider's own API, which Ember asks it in through AI Gateway's endpoint for
 * that provider, where the gateway's credits pay: Anthropic's Messages for Claude and OpenAI's Responses
 * for GPT, or null for anyone else's model, Grok among them, which Ember asks through Cloudflare's REST
 * API.
 */
export function providerFormatOf(model: string): ProviderFormat | null {
  if (model.startsWith("anthropic/")) return "anthropic";
  return model.startsWith("openai/") ? "openai" : null;
}

/** What to call `model`: its name in `models`, or else in the models file this Ember shipped with, or else its ID. */
export const modelName = (model: string, models: readonly AssistantModel[] = []) =>
  (models.find(({ id }) => id === model) ?? ASSISTANT_MODELS.find(({ id }) => id === model))?.name ?? model;

/** The most models administrators can let people pick from, the one @ember answers everyone else with among them. */
export const MAX_ASSISTANT_MODELS = 20;

/** The longest name Ember keeps for a model, where Cloudflare's are a few words. */
export const MAX_MODEL_NAME_LENGTH = 100;

/**
 * The model's name `text` gives, without the spaces around it, or null when it can't be one: one line of
 * text no longer than Ember keeps, without characters that show nothing or turn the text around.
 */
export function modelNameOf(text: unknown): string | null {
  const name = typeof text === "string" ? text.trim() : "";
  return name !== "" && name.length <= MAX_MODEL_NAME_LENGTH && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : null;
}

/** How much @ember thinks before it answers: not at all, a little, more, or the most. */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * About how many tokens of thinking each level allows, which a model that takes an effort instead is
 * asked for as its low, medium or high effort.
 */
export const THINKING_TOKENS: Record<ThinkingLevel, number> = { off: 0, low: 4_000, medium: 16_000, high: 32_000 };

/** How long @ember's answers are: short, medium, or long. */
export const ANSWER_LENGTHS = ["short", "medium", "long"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];

/** About how many words each length's answers keep to, which @ember is told: a long one is nearly all one message holds. */
export const ANSWER_WORDS: Record<AnswerLength, number> = { short: 150, medium: 400, long: 1_500 };

/**
 * The most tokens each length's answer may take once its model has thought: several times its words, at
 * about 1.3 tokens each, as Markdown, code and tables take more, and a model writes past what it's asked.
 */
export const ANSWER_TOKENS: Record<AnswerLength, number> = { short: 1_000, medium: 2_000, long: 6_000 };

/** The tokens of thinking an answer may take when it's asked for none, as some models think a little all the same. */
export const UNTHINKING_TOKENS = 2_000;

/**
 * The most characters of a conversation @ember and the agents read: the newest messages that fit, so
 * that one long conversation costs no more than about 10,000 tokens.
 */
export const MAX_CONVERSATION_LENGTH = 40_000;

/** How much @ember thinks, and how long it answers. */
export interface AnswerLevels {
  thinking: ThinkingLevel;
  length: AnswerLength;
}

/** The most tokens of thinking an answer at `thinking` may take, as even one asked for none may think a little. */
export const thinkingTokensAt = (thinking: ThinkingLevel) => (thinking === "off" ? UNTHINKING_TOKENS : THINKING_TOKENS[thinking]);

/** The most tokens an answer at `levels` may take: its thinking's, which counts toward them, and then its words'. */
export const maxTokensAt = ({ thinking, length }: AnswerLevels) => thinkingTokensAt(thinking) + ANSWER_TOKENS[length];

/** Each level, as its dial names it. */
export const LEVEL_NAMES: Record<ThinkingLevel | AnswerLength, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", short: "Short", long: "Long" };

/** The levels of @ember's answers to someone who hasn't picked their own. */
export const DEFAULT_LEVELS: AnswerLevels = { thinking: "low", length: "medium" };

/** The most each dial goes to until an administrator sets less: the top, as Ember adds no limits of its own. */
export const TOP_LEVELS: AnswerLevels = { thinking: "high", length: "long" };

/** `levels`, each no higher than `most`'s. */
export function withinMost(levels: AnswerLevels, most: AnswerLevels): AnswerLevels {
  const lower = <T>(order: readonly T[], level: T, highest: T) => order[Math.min(order.indexOf(level), order.indexOf(highest))]!;
  return { thinking: lower(THINKING_LEVELS, levels.thinking, most.thinking), length: lower(ANSWER_LENGTHS, levels.length, most.length) };
}

/**
 * The level of thinking a model that takes `taken` is asked for in place of `level`: `level` when it
 * takes it, as a model Ember hasn't asked at each level (undefined) is taken to, or else the nearest
 * below it that it takes, or else above it, as one that can't think as little as `level` is asked for as
 * little as it can, or null for one that takes none, which thinks as much as it decides.
 */
export function thinkingTaken(level: ThinkingLevel, taken: readonly ThinkingLevel[] | null | undefined): ThinkingLevel | null {
  if (!taken || taken.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);
  const below = THINKING_LEVELS.slice(0, index).reverse();
  return below.find((lower) => taken.includes(lower)) ?? THINKING_LEVELS.slice(index + 1).find((higher) => taken.includes(higher)) ?? null;
}

/** A change to one of @ember's dials, or both: the most each goes to, or your own levels. */
export type AnswerLevelChanges = Partial<AnswerLevels>;

/**
 * What `PATCH /api/account/assistant` changes: the most one dial or both go to for anyone's questions,
 * which of the models people can pick @ember answers everyone else with, the instructions Ember adds to
 * @ember's own, "" for none, or what Ember adds around them, null for Ember's own.
 */
export interface AssistantChanges extends AnswerLevelChanges {
  model?: string;
  instructions?: string;
  promptTemplate?: string | null;
}

/**
 * What `PATCH /api/users/me/assistant` changes of yours: one dial or both, or the model @ember answers
 * you with, which null leaves to administrators.
 */
export interface YourAssistantChanges extends AnswerLevelChanges {
  model?: string | null;
}

/** Why a change to the levels is refused before anything's saved. */
export const LEVELS_REFUSED = "Choose a level the dial has.";

/** Why a change to a model is refused: it isn't one of the models administrators let people pick. */
export const MODEL_NOT_LISTED = "Choose one of the models an administrator added.";

/**
 * The longest instructions Ember takes, for @ember to add to its own or for an agent: about 2,500 tokens,
 * a quarter of the longest conversation it reads.
 */
export const MAX_INSTRUCTIONS_LENGTH = 10_000;

/** Why instructions are refused before anything's saved. */
export const INSTRUCTIONS_TOO_LONG = `Instructions can be at most ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`;

/**
 * The changes `data` gives, as @ember's page sends them, or why they can't be changes: they change
 * nothing, or give a level a dial doesn't have, a model that can't be one, instructions that aren't text
 * or are longer than Ember takes, or what Ember adds around them a template it doesn't take
 * (`parseTemplate`). Instructions are saved without the spaces around them, and so are templates.
 */
export function parseAssistantChanges(data: unknown): AssistantChanges | { error: string } {
  const given = objectIn(data);
  const levels = levelChangesIn(given);
  if ("error" in levels) return levels;
  const { instructions } = given;
  if (instructions !== undefined && (typeof instructions !== "string" || instructions.trim().length > MAX_INSTRUCTIONS_LENGTH)) return { error: INSTRUCTIONS_TOO_LONG };
  const template = given.promptTemplate === undefined ? undefined : parseTemplate(given.promptTemplate, ASSISTANT_ID);
  if (template && "error" in template) return template;
  const changes: AssistantChanges = {
    ...levels,
    ...(typeof instructions === "string" && { instructions: instructions.trim() }),
    ...(template && { promptTemplate: template.template }),
  };
  if (given.model === undefined) return Object.keys(changes).length > 0 ? changes : { error: LEVELS_REFUSED };
  const model = typeof given.model === "string" ? modelOf(given.model) : null;
  return model === null ? { error: MODEL_NOT_LISTED } : { ...changes, model };
}

/**
 * Your changes `data` gives, as your profile sends them, or why they can't be changes, as `parseAssistantChanges`
 * says, where a null model leaves yours to administrators. @ember's instructions aren't yours to change,
 * nor what Ember adds around them.
 */
export function parseYourAssistantChanges(data: unknown): YourAssistantChanges | { error: string } {
  const { instructions: _, promptTemplate: __, ...given } = objectIn(data);
  if (given.model !== null) return parseAssistantChanges(given);
  const levels = levelChangesIn(given);
  return "error" in levels ? levels : { ...levels, model: null };
}

/** The levels `given` changes, or why they can't be changes: a level a dial doesn't have. */
function levelChangesIn(given: Record<string, unknown>): AnswerLevelChanges | { error: string } {
  const { thinking, length } = given;
  if (thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) return { error: LEVELS_REFUSED };
  if (length !== undefined && !(ANSWER_LENGTHS as readonly unknown[]).includes(length)) return { error: LEVELS_REFUSED };
  return { ...(thinking !== undefined && { thinking: thinking as ThinkingLevel }), ...(length !== undefined && { length: length as AnswerLength }) };
}

/** `data` as an object's fields, or none when it isn't one. */
const objectIn = (data: unknown): Record<string, unknown> => (typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {});

/**
 * What @ember may do on the web while Search the web is on: search it, and read pages, the ones people
 * link to and its searches find, where AI Gateway takes its model's tool for that too.
 */
export const WEB_TOOLS = ["search", "read"] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

/** The most times @ember searches the web for one answer, as each of Anthropic's searches costs a cent. */
export const WEB_SEARCHES_PER_ANSWER = 5;

/** The most pages @ember reads for one answer, as what it reads is paid for as the conversation is. */
export const PAGES_READ_PER_ANSWER = 3;

/**
 * What a model may do on the web in each format, with the tools AI Gateway passes on in it, or, for
 * Workers AI's and Grok, in Chat Completions, Ember's own tool for searching, which Ember runs with
 * Cloudflare's Web Search API (`searchFormatOf` says which models in Chat Completions take it).
 */
export const WEB_TOOLS_IN: Record<ModelFormat, readonly WebTool[]> = {
  messages: ["search", "read"],
  responses: ["search"],
  chat: ["search"],
  xai: ["search"],
  anthropic: ["search", "read"],
  openai: ["search"],
  workers: ["search"],
};

/**
 * The format Ember asks `model` in: the one `models` list it with, or the one the models file this Ember
 * shipped with lists it in, or else its provider's own (`providerFormatOf`), or Workers AI's, for one of
 * Workers AI's, or Chat Completions, through Cloudflare's REST API, for anyone else's.
 */
export function formatOf(model: string, models: readonly AssistantModel[] = []): ModelFormat {
  const listed = models.find(({ id }) => id === model) ?? ASSISTANT_MODELS.find(({ id }) => id === model);
  return listed?.format ?? providerFormatOf(model) ?? (isWorkersAiModel(model) ? "workers" : "chat");
}

/**
 * The format `model`, which took its test question in `format`, searches the web in: that one, when it
 * has tools for the web, but Chat Completions, where Ember gives its own tool for searching only to Grok,
 * whichever format it was saved in, as AI Gateway's credits pay for that, and to Workers AI's in their own
 * format, as for one kept from before Ember gave them that, or null for a model that can't search.
 */
export function searchFormatOf(model: string, format: ModelFormat): ModelFormat | null {
  if (isXaiModel(model)) return "chat";
  if (format === "chat") return isWorkersAiModel(model) ? "workers" : null;
  return WEB_TOOLS_IN[format].length > 0 ? format : null;
}

/**
 * What `model` may do on the web in `format`, of what that format has tools for: nothing, when it doesn't
 * search in that format (`searchFormatOf`), as no one but Grok does in Chat Completions, or less, when the
 * models `offered` list it in a format it searches in the same one from, as one of Workers AI's, with
 * less, as the models file can say of one. A Grok saved in xAI's own Responses while it searched there
 * searches there still, until turning Search the web on again moves it to Chat Completions.
 */
export function webToolsOf(model: string, format: ModelFormat, offered: readonly OfferedModel[]): readonly WebTool[] {
  const searchesIn = searchFormatOf(model, format);
  if (searchesIn === null || (searchesIn !== format && format !== "xai")) return [];
  const listed = offered.find(({ id, format: listedIn }) => id === model && searchFormatOf(id, listedIn) === searchesIn);
  return listed?.webTools ?? WEB_TOOLS_IN[format];
}

/**
 * Ember AI as the AI assistant tab shows it to administrators while it's on: the Cloudflare account it
 * asks through, the model it answers anyone with who hasn't picked another, the models people can pick
 * from, that one among them, in the order they were added, the most each dial goes to for anyone's
 * questions, and what @ember does on the web: what it may while Search the web is on, nothing while it's
 * off, or null when the model that answers everyone can't: Anthropic's and OpenAI's have tools for it
 * that AI Gateway passes on, and Grok and Workers AI's take Ember's own, which searches with Cloudflare's Web
 * Search API, but others kept from before have none (`searchFormatOf`). Then the instructions Ember adds
 * to @ember's own, what Ember adds around them, and @ember's avatar.
 */
export interface AssistantSettings {
  accountId: string;
  model: string;
  models: AssistantModel[];
  most: AnswerLevels;
  webTools: WebTool[] | null;
  /** What Ember adds to @ember's own instructions, as administrators write them, or "" for nothing, which stays while Ember AI is off. */
  instructions: string;
  /** What Ember adds around them (`promptAround`), as administrators changed it, or null for Ember's own, which stays while Ember AI is off too. */
  promptTemplate: string | null;
  /** @ember's avatar, as the people directory gives it (`DirectoryUser.avatarUrl`): the picture an administrator uploaded, or Ember's flame. */
  avatarUrl: string;
  /** Whether an administrator uploaded @ember's avatar, which Use Ember's flame takes away, though one that can't be resized shows the flame. */
  avatar: boolean;
}

/**
 * What `PATCH /api/account/assistant` answers once it has saved a change, `DELETE /api/account/assistant/models`
 * a model's removal, and `PUT` and `DELETE /api/account/assistant/avatar` a change to @ember's avatar: Ember AI
 * as it is then.
 */
export interface AssistantChanged {
  assistant: AssistantSettings;
}

/**
 * @ember's answers to you while Ember AI is on, as your profile shows them: the levels of each dial,
 * yours, or where they start until you pick, no higher than the most administrators allow, which it
 * shows too, the model you picked, while it's one people can pick, even the one administrators chose
 * for everyone, or else null, when @ember answers you with whichever they choose, the one they chose,
 * and the models you can pick from, that one among them.
 */
export interface YourAssistant {
  levels: AnswerLevels;
  most: AnswerLevels;
  model: string | null;
  defaultModel: string;
  models: AssistantModel[];
}

/** What `PATCH /api/users/me/assistant` answers: your levels and model as they are then, or null while Ember AI is off. */
export interface YourAssistantChanged {
  assistant: YourAssistant | null;
}

/** What the AI assistant tab says when a change to the most each dial goes to comes while Ember AI is off. */
export const ASSISTANT_OFF = "Ember AI is off. Turn it on first.";

/** What `PUT /api/account/assistant/web_search` takes: whether @ember searches the web, as the Search the web switch says. */
export interface WebSearchChange {
  on: boolean;
}

/** The change `data` gives, as the switch sends it, or null when it doesn't say on or off. */
export function parseWebSearchChange(data: unknown): WebSearchChange | null {
  const on = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).on : undefined;
  return typeof on === "boolean" ? { on } : null;
}

/**
 * What `PUT /api/account/assistant/web_search` answers once it has changed Search the web: Ember AI as
 * it is then, and, once it's turned on, what its model said when it searched, or else null.
 */
export interface WebSearchChanged {
  assistant: AssistantSettings;
  found: string | null;
}

/** Why a change to Search the web is refused before anything's asked. */
export const WEB_SEARCH_REFUSED = "Say whether @ember searches the web.";

/** Why Search the web can't turn on for the model called `name`, which has no tool for it that AI Gateway passes on, nor Ember. */
export const cannotSearchWith = (name: string) =>
  `${name} can't search the web through AI Gateway, but the models Ember offers can. Choose one under Models or Change.`;

/** Why it didn't turn on once the model was asked: Ember AI was changed or turned off meanwhile, or Search the web was. */
export const WEB_SEARCH_CHANGED = "Ember AI changed while its model searched. Try again.";

/**
 * The Cloudflare account Ember AI asks through, as Set up Ember AI gives it: its ID, and an API token of
 * its with the AI Gateway Run permission, which AI Gateway's endpoint for each provider takes, and Workers
 * AI Read and AI Gateway Read, which Cloudflare's model search and Web Search API take, which a change can
 * leave out to keep the one Ember has.
 */
export interface AssistantKeys {
  accountId: string;
  apiToken?: string;
}

/**
 * What Set up Ember AI gives `PUT /api/account/assistant`: the account, and the ID of the model to answer
 * anyone with who hasn't picked another, one Ember offers.
 */
export interface AssistantSetup extends AssistantKeys {
  model: string;
}

/** What Add a model gives `POST /api/account/assistant/models`: the ID of a model Ember offers. */
export interface NewAssistantModel {
  model: string;
}

/**
 * What `PUT /api/account/assistant` answers once the model answered its test question, and `POST
 * /api/account/assistant/models` once the model it adds did: Ember AI as it is then, and what the model said.
 */
export interface AssistantSaved {
  assistant: AssistantSettings;
  greeting: string;
}

/** What `DELETE /api/account/assistant` answers: Ember AI is off. */
export interface AssistantForgotten {
  assistant: null;
}

/** A field of Set up Ember AI, which a refusal can be about. */
export type AssistantField = "accountId" | "apiToken" | "model";

/** The longest model ID Ember takes, where its are a few dozen characters. */
export const MAX_MODEL_LENGTH = 200;

/** The longest API token Ember takes, which goes in a header of each request to Cloudflare. */
const MAX_API_TOKEN_LENGTH = 200;

/** Why Set up Ember AI's fields are refused before Cloudflare is asked about them. */
export const ACCOUNT_ID_REFUSED = "An account ID is 32 letters and digits. Search the Cloudflare dashboard for Copy account ID to copy it.";
export const API_TOKEN_REFUSED = "Paste an API token from Account API tokens in the Cloudflare dashboard.";
export const MODEL_REFUSED = "Choose one of the models Ember offers.";

/** The Cloudflare account ID `text` gives, without the spaces around it and in small letters, or null when it can't be one: 32 hexadecimal digits. */
export function accountIdOf(text: string): string | null {
  const accountId = text.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(accountId) ? accountId : null;
}

/** The Cloudflare API token `text` gives, without the spaces around it, or null when it can't be one: tokens have no spaces, and are a few dozen characters. */
export function apiTokenOf(text: string): string | null {
  const apiToken = text.trim();
  return apiToken.length >= 20 && apiToken.length <= MAX_API_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(apiToken) ? apiToken : null;
}

/**
 * The model ID `text` gives, without the spaces around it, or null when it can't be one: they name the
 * company and then the model, as `company/model`, and Workers AI's start with `@cf/`.
 */
export function modelOf(text: string): string | null {
  const model = text.trim();
  return model.length <= MAX_MODEL_LENGTH && /^@?[\w.-]+(?:\/[\w.:@-]+)+$/.test(model) ? model : null;
}

/**
 * The account Set up Ember AI asks through, as it sends it, or why it can't be one, on the field it's
 * about. A blank API token is left out, keeping the one Ember has.
 */
export function parseAssistantKeys(data: unknown): AssistantKeys | { error: string; field: AssistantField } {
  const given = objectIn(data);
  const accountId = typeof given.accountId === "string" ? accountIdOf(given.accountId) : null;
  if (accountId === null) return { error: ACCOUNT_ID_REFUSED, field: "accountId" };
  const { apiToken: typed } = given;
  if (typed !== undefined && typeof typed !== "string") return { error: API_TOKEN_REFUSED, field: "apiToken" };
  const apiToken = typed === undefined || typed.trim() === "" ? undefined : apiTokenOf(typed);
  if (apiToken === null) return { error: API_TOKEN_REFUSED, field: "apiToken" };
  return apiToken === undefined ? { accountId } : { accountId, apiToken };
}

/**
 * What `PUT /api/account/assistant` gives Ember, as Set up Ember AI sends it, or why it can't be one, on
 * the field it's about, as `parseAssistantKeys` reads the account and `parseNewAssistantModel` the model.
 */
export function parseAssistantSetup(data: unknown): AssistantSetup | { error: string; field: AssistantField } {
  const keys = parseAssistantKeys(data);
  if ("error" in keys) return keys;
  const model = parseNewAssistantModel(data);
  return "error" in model ? model : { ...keys, ...model };
}

/**
 * The model `POST /api/account/assistant/models` adds, as Add a model sends it, or why it can't be one: it
 * has no model ID. Whether Ember offers it is the Worker's to say, as the models it offers change.
 */
export function parseNewAssistantModel(data: unknown): NewAssistantModel | { error: string; field: "model" } {
  const given = objectIn(data);
  const model = typeof given.model === "string" ? modelOf(given.model) : null;
  return model !== null ? { model } : { error: MODEL_REFUSED, field: "model" };
}

/** Why `DELETE /api/account/assistant/models` keeps a model: @ember answers everyone with it who hasn't picked another. */
export const DEFAULT_MODEL_KEPT = "@ember answers everyone with this model. Choose another for that first.";

/** Why `POST /api/account/assistant/models` adds no more. */
export const MODELS_FULL = `People can pick from at most ${MAX_ASSISTANT_MODELS} models. Remove one first.`;

/** What the AI assistant tab tells anyone but an administrator. */
export const ASSISTANT_FORBIDDEN = "Only administrators can set up Ember AI";

// Last, as reading it takes what's above.

/** The models file this Ember shipped with, which it offers until it has read the one on Ember's main branch, and whenever it can't. */
const SHIPPED = parseModelsFile(shippedModelsFile)!;

/**
 * The models the models file this Ember shipped with lists (`ModelsFile`). A model kept from before Ember
 * offered only those the file lists and Workers AI's answers still, as it was kept. Wherever one of these
 * is listed, Ember calls it by its name here, unless it's kept by another.
 */
export const ASSISTANT_MODELS: readonly OfferedModel[] = SHIPPED.models;

/** The model Set up Ember AI starts at, as the models file this Ember shipped with suggests: the one that costs least of those that both search the web and read pages. */
export const SUGGESTED_MODEL = SHIPPED.suggested;

import {
  isProviderFormat,
  PAGES_READ_PER_ANSWER,
  THINKING_LEVELS,
  thinkingTaken,
  WEB_SEARCHES_PER_ANSWER,
  WEB_TOOLS_IN,
  type AssistantField,
  type ModelFormat,
  type ProviderFormat,
  type ThinkingLevel,
  type WebTool,
} from "@ember/protocol/assistant";
import type { Env } from "../env";
import { isLoopback } from "../loopback";
import { isMessages, isObject, isResponses } from "./formats";
import {
  decided,
  goingOn,
  resultsOf,
  TOOL_CALLS_PER_ANSWER,
  toolCallsIn,
  ToolError,
  toolsIn,
  whatCallsCameTo,
  withRoom,
  writtenIn,
  type CallMade,
  type EmberTool,
  type Round,
  type ToolResult,
} from "./tool-calls";

export { isObject };

// Asking a model through Cloudflare's AI Gateway: Claude and GPT, of the models Ember offers, through the
// gateway's endpoints for Anthropic and OpenAI on gateway.ai.cloudflare.com, which pass on each provider's
// own API as it is (https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/, …/openai/),
// and Grok, Workers AI's models and those kept before Ember offered only its own as they were kept,
// through the REST API on api.cloudflare.com, in whichever of its three formats the model took
// (https://developers.cloudflare.com/ai-gateway/usage/rest-api/), which takes Grok's requests only in Chat
// Completions, where the gateway's credits pay for it as they don't at its xAI endpoint (…/grok/), which
// only a Grok saved there before is asked at still. Every request goes through the account's default
// gateway, whose logs, caching, rate limits and spend limits apply, and which Cloudflare makes on the
// account's first request. A model that may use the web is given its provider's own tools for it, which
// AI Gateway passes on and the provider runs (https://developers.cloudflare.com/ai-gateway/usage/web-search/):
// Anthropic's web search and web fetch in Messages, OpenAI's web search in Responses, and xAI's in its
// own. Chat Completions has none, so Grok, and Workers AI's models that take tools, in Workers AI's
// format, which is Chat Completions on the REST API too, are given Ember's own for searching the web, and
// Ember runs their searches with Cloudflare's Web Search API, through the same gateway
// (https://developers.cloudflare.com/web-search/how-to-use/#use-web-search-as-a-tool).
// A model in any other format may be given tools Ember runs as well (tool-calls.ts).

/** Where Cloudflare's API is. */
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Where AI Gateway's endpoints for each provider are, under an account and a gateway. */
const PROVIDER_ENDPOINTS = "https://gateway.ai.cloudflare.com/v1";

/** The gateway Ember's requests go through: in the address of each provider's endpoint, and named to Cloudflare's REST API, for a model kept from before. */
const GATEWAY_ID = "default";

/** Where each format's requests go: under the account's `ai/v1` on Cloudflare's API, or, for a provider's own, under the gateway's endpoint for that provider. */
const PATHS: Record<ModelFormat, string> = {
  messages: "messages",
  responses: "responses",
  chat: "chat/completions",
  workers: "chat/completions",
  xai: "grok/v1/responses",
  anthropic: "anthropic/v1/messages",
  openai: "openai/responses",
};

/** The version of Anthropic's API that Ember's requests to the gateway's Anthropic endpoint are written for. */
const ANTHROPIC_VERSION = "2023-06-01";

/** The most of Cloudflare's own words about a refusal that Ember passes on. */
const MAX_QUOTED_LENGTH = 200;

/** The most of a page a model reads, in tokens, about as many as the longest conversation @ember reads. */
const PAGE_TOKENS = 10_000;

/** How many times Ember lets Anthropic's model carry on a turn it paused while it searched, before taking what it said. */
const MAX_CONTINUATIONS = 2;

/** The fewest tokens a request may let its model write, in OpenAI's Responses, so the fewest an answer needs left to go on after a tool's call. */
const LEAST_TOKENS = 16;

/** The most pages an answer names as its sources. */
export const MAX_SOURCES = 10;

/** How many pages each of a Workers AI model's searches finds, and the most of what each says that it reads. */
const RESULTS_PER_SEARCH = 5;
const MAX_RESULT_LENGTH = 2_000;

/** The longest search Cloudflare's Web Search API takes. */
const MAX_QUERY_LENGTH = 1_024;

/** Ember's own tool for searching the web, which Grok and Workers AI's models take as a function, and Ember runs with Cloudflare's Web Search API (`searchedFor`). */
const WEB_SEARCH_FUNCTION = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for what's current, or what you don't know. It answers with the pages it finds, each with its title, address and what it says.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for, in a few words, as you'd type it into a search engine." } },
      required: ["query"],
    },
  },
};

/**
 * What Ember asks AI Gateway with: a Cloudflare account, an API token of its, a model and the format the
 * model takes, and the levels of thinking it takes, once Ember has asked it at each (`thinkingLevelsOf`).
 */
export interface Gateway {
  accountId: string;
  apiToken: string;
  model: string;
  format: ModelFormat;
  thinkingLevels?: ThinkingLevel[];
}

/** One turn of a conversation for a model to go on with: what someone wrote, or one of the model's own answers. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * What to ask a model: how it should answer, the conversation, oldest first, ending with what it's asked,
 * the most tokens its answer may take, its thinking among them, how much to think first, if it's told,
 * who asked, if someone did, and who answers, @ember or an agent, if either does, whom AI Gateway's logs
 * and spend limits then know each request by (custom metadata's `user_id` and `agent_id`), what it
 * may do on the web, of what its format has tools for: nothing, unless it's told, and the tools Ember
 * runs for it, if it has any.
 */
export interface Question {
  instructions: string;
  /** How it should answer when it's asked again only searching, as AI Gateway didn't take the tool for reading pages, if that's not as `instructions` says. */
  instructionsWithoutReading?: string;
  /** How it should answer when it's asked again without the web, whose tools AI Gateway didn't take, if that's not as `instructions` says. */
  instructionsWithoutWeb?: string;
  turns: Turn[];
  maxTokens: number;
  thinking?: ThinkingLevel;
  askerId?: string;
  agentId?: string;
  webTools?: readonly WebTool[];
  tools?: readonly EmberTool[];
}

/**
 * What went wrong asking a model: Cloudflare didn't take the API token, or found no such account, AI
 * Gateway's credits ran out, the model wasn't taken, AI Gateway turned the request away, the conversation
 * was longer than the model reads, AI Gateway didn't answer, the model answered with nothing, or it took
 * every token it could before it answered anything. Or the gateway's Guardrails or Data Loss Prevention,
 * which administrators turn on in AI Gateway, blocked the question, with what it read, or the answer.
 */
export type RefusalReason =
  | "token"
  | "account"
  | "credits"
  | "model"
  | "retired"
  | "busy"
  | "neurons"
  | "too long"
  | "unanswered"
  | "nothing"
  | "out of room"
  | "guardrails"
  | "guardrails answer"
  | "dlp"
  | "dlp answer";

/**
 * Why a model didn't answer, in words an administrator can act on, with what went wrong, the status to
 * answer them with and the field of Set up Ember AI it's about, if one is: `wrongFormat` when the model
 * was refused in a way another format might not be, with Cloudflare's own word on that, if it gave one,
 * which the refusal ends with, in `cloudflareSays`.
 */
export interface GatewayRefusal {
  status: number;
  reason: RefusalReason;
  refusal: string;
  field?: AssistantField;
  wrongFormat?: boolean;
  cloudflareSays?: string;
}

export const GATEWAY_UNANSWERED = "AI Gateway didn't answer. Try again in a moment.";

/** Why AI Gateway's xAI endpoint didn't take Ember AI's API token: it takes only one with AI Gateway's Run permission. */
export const XAI_TOKEN_REFUSED =
  "Ember asks Grok through AI Gateway's xAI endpoint, which didn't take Ember AI's API token. Add the AI Gateway Run permission to the token in the Cloudflare dashboard, then try again.";

/** Why nothing paid for asking Grok through AI Gateway's xAI endpoint, where a key of xAI's own, kept by the gateway, can. */
export const XAI_UNPAID =
  "AI Gateway's credits can't pay for Grok through its xAI endpoint. Add an xAI API key under Provider Keys in the default gateway's settings in AI Gateway, then try again.";

/** Why AI Gateway's endpoint for each provider didn't take Ember AI's API token, which it takes only with AI Gateway Run, or nothing paid there. */
const PROVIDER_REFUSALS: Record<ProviderFormat, { token: string; unpaid: string }> = {
  xai: { token: XAI_TOKEN_REFUSED, unpaid: XAI_UNPAID },
  anthropic: {
    token:
      "Ember asks Claude through AI Gateway's Anthropic endpoint, which didn't take Ember AI's API token. Add the AI Gateway Run permission to the token in the Cloudflare dashboard, then try again.",
    unpaid:
      "AI Gateway's credits can't pay for Claude through its Anthropic endpoint. Add an Anthropic API key under Provider Keys in the default gateway's settings in AI Gateway, then try again.",
  },
  openai: {
    token:
      "Ember asks OpenAI's models through AI Gateway's OpenAI endpoint, which didn't take Ember AI's API token. Add the AI Gateway Run permission to the token in the Cloudflare dashboard, then try again.",
    unpaid:
      "AI Gateway's credits can't pay for OpenAI's models through its OpenAI endpoint. Add an OpenAI API key under Provider Keys in the default gateway's settings in AI Gateway, then try again.",
  },
};

/** Why Cloudflare's Web Search API, which searches the web for Workers AI's models, didn't: it didn't take Ember AI's API token, nothing paid for it, or it didn't answer. */
export const SEARCH_TOKEN_REFUSED =
  "Ember searches the web for Workers AI's models with Cloudflare's Web Search API, which didn't take Ember AI's API token. Add the Workers AI Read and AI Gateway Read permissions to it in the Cloudflare dashboard, then try again.";
export const SEARCH_UNPAID =
  "AI Gateway's credits pay for Cloudflare's Web Search API, which searches the web for Workers AI's models, and there aren't enough. Top them up under Credits Available in AI Gateway, then try again.";
export const SEARCH_UNANSWERED = "Cloudflare's Web Search API didn't answer. Try again in a moment.";

export const NOTHING_ANSWERED = "The model answered with nothing. Try again, or choose another model.";
export const OUT_OF_ROOM = "The model took every token it could before it answered. Try again, or choose another model.";

/** A page a model's answer came from: its address, and its title, or "" without one. */
export interface Source {
  url: string;
  title: string;
}

/**
 * A model's answer: its text, whether it was cut short, as it took every token it could, and the pages
 * it came from, when it used the web: those it cites, then those it read, or those Ember's searches found
 * for one of Workers AI's, which can't cite them. When none of those searches found any, as Cloudflare's
 * Web Search API refused them, why it did.
 */
export interface Answered {
  text: string;
  cut?: true;
  sources?: Source[];
  searchRefused?: GatewayRefusal;
}

/**
 * An answer waiting at a call of a tool that asks first, as JSON, for its room to keep until someone
 * allows the call or doesn't: the model and format it's asked in, the question, as it was asked, without
 * its tools, which its room gives it again, the request the model answered `body` to, with its calls,
 * what those before the one that waits came to, and how far the answer had got: the calls it had made,
 * the tokens it had left, what Messages' model had said in the turns before, what Grok's searches
 * of the web with Ember's own tool had found, and, where it was kept, what each call of the rounds
 * before came to.
 */
export interface PausedAnswer {
  model: string;
  format: ModelFormat;
  question: Omit<Question, "tools">;
  request: Record<string, unknown>;
  body: Record<string, unknown>;
  results: ToolResult[];
  called: number;
  tokensLeft: number;
  saidBefore: unknown[];
  searches?: WebSearches;
  made?: CallMade[];
}

/** What an answer's searches of the web with Ember's own tool have come to: the pages each found, and why one was refused, if one was. */
interface WebSearches {
  found: Source[][];
  refused?: GatewayRefusal;
}

/** A model's call of a tool that asks first, which waits to be allowed, and its answer as it waits. */
export interface Asking {
  asks: NonNullable<Round["asks"]>;
  paused: PausedAnswer;
}

/** What asking a model comes to: its answer, why it didn't answer, or the call its answer waits at. */
type Asked = Answered | GatewayRefusal | Asking;

/**
 * What the model `gateway` names answers `question` in its format, or why it didn't, waiting at most
 * `timeoutMs` for it all. The model is told to think as much as the question asks, or as near to that as
 * the levels it takes allow, or not told, when it takes none (`thinkingTaken`). One that doesn't take
 * being told how much to think all the same, as a model Ember hasn't asked at each level might not, is
 * asked again without that, and then, as Search the web tries the web's tools when it's turned on,
 * without the one for reading pages, which AI Gateway may not have for every model, then without them,
 * told it can't use them, and last without the tools Ember runs, which every model Ember gives them
 * takes as far as its provider says. One refused only once it has called one of those isn't asked again
 * here: `askOnce` has it answer without them, told what its calls came to, in what's left of the
 * answer's tokens. None of the question's tools may ask first: nothing here waits for a call to be
 * allowed (`askWaiting`).
 */
export async function ask(env: Env, gateway: Gateway, question: Question, timeoutMs: number): Promise<Answered | GatewayRefusal> {
  return unasked(await askWaiting(env, gateway, question, timeoutMs));
}

/**
 * What the model `gateway` names answers `question`, as `ask` asks it, or the call of a tool that asks
 * first its answer waits at, which `goOn` goes on from once someone allows it or doesn't.
 */
export async function askWaiting(env: Env, gateway: Gateway, question: Question, timeoutMs: number): Promise<Asked> {
  const signal = AbortSignal.timeout(timeoutMs);
  let asked = withThinkingTaken(question, gateway.thinkingLevels);
  let answered = await answering(env, gateway, asked, signal);
  if (isWrongFormat(answered) && asked.thinking !== undefined) {
    console.error(`Asking ${gateway.model} again without a thinking level, which it didn't take: ${answered.refusal}`);
    const { thinking: _, ...unthinking } = asked;
    asked = unthinking;
    answered = await answering(env, gateway, asked, signal);
  }
  const searching = asked.webTools?.filter((tool) => tool !== "read") ?? [];
  if (isWrongFormat(answered) && asked.webTools?.includes("read") && toolsFor(gateway.format, searching).length > 0) {
    console.error(`Asking ${gateway.model} to search again without reading pages, as AI Gateway didn't take that: ${answered.refusal}`);
    asked = { ...asked, instructions: asked.instructionsWithoutReading ?? asked.instructions, webTools: searching };
    answered = await answering(env, gateway, asked, signal);
  }
  if (isWrongFormat(answered) && toolsFor(gateway.format, asked.webTools).length > 0) {
    console.error(`Asking ${gateway.model} again without the web, whose tools AI Gateway didn't take: ${answered.refusal}`);
    asked = { ...asked, instructions: asked.instructionsWithoutWeb ?? asked.instructions, webTools: [] };
    answered = await answering(env, gateway, asked, signal);
  }
  if (!isWrongFormat(answered) || !asked.tools || asked.tools.length === 0) return answered;
  console.error(`Asking ${gateway.model} again without Ember's tools, which it didn't take: ${answered.refusal}`);
  return answering(env, gateway, { ...asked, tools: [] }, signal);
}

/**
 * What the model `gateway` names answers once the call its answer `paused` at is `allowed` or isn't,
 * with `tools`, the question's as they are by then, waiting at most `timeoutMs`: its answer, why it
 * didn't, or the next call it waits at. The gateway has to name the model the answer was asked of.
 */
export async function goOn(env: Env, gateway: Gateway, tools: readonly EmberTool[], paused: PausedAnswer, allowed: boolean, timeoutMs: number): Promise<Asked> {
  const waiting = toolCallsIn(paused.format, paused.body)[paused.results.length];
  const results = waiting ? [...paused.results, await decided(tools, waiting, allowed)] : paused.results;
  return answering(env, gateway, { ...paused.question, tools }, AbortSignal.timeout(timeoutMs), { ...paused, results });
}

/** `answered`, which is an answer or why there's none, as no tool of its question's asks first. */
function unasked(answered: Asked): Answered | GatewayRefusal {
  if (!("asks" in answered)) return answered;
  throw new Error(`${answered.asks.name} asks first, in an answer nothing waits for`);
}

/** `question`, asking for the level of thinking a model that takes `taken` is asked for in place of its own (`thinkingTaken`), or for none. */
function withThinkingTaken(question: Question, taken: readonly ThinkingLevel[] | undefined): Question {
  const { thinking, ...unthinking } = question;
  const level = thinking && thinkingTaken(thinking, taken);
  return level ? { ...unthinking, thinking: level } : unthinking;
}

/**
 * The levels of thinking the model `gateway` names takes in its format, as it answers `question` at each,
 * all at once, waiting at most `timeoutMs`: each but those it's refused at as a request it can't take
 * (`wrongFormat`), as AI Gateway refuses what the model's provider doesn't, as xAI refuses any level for
 * Grok 4.20 Reasoning, which Cloudflare's catalog lists Low and High for, so that only asking says. One
 * it doesn't answer at for another reason, as when AI Gateway is busy, counts as one it takes, since
 * asking at it is then as it was before Ember asked at each, and `ask` asks again without it if it's
 * refused.
 */
export async function thinkingLevelsOf(env: Env, gateway: Gateway, question: Question, timeoutMs: number): Promise<ThinkingLevel[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const answers = await Promise.all(THINKING_LEVELS.map((thinking) => askOnce(env, gateway, { ...question, thinking }, signal)));
  const refusals = answers.map((answered) => (isWrongFormat(answered) ? answered : null));
  const first = refusals.find((refusal) => refusal !== null);
  if (first) console.log(`${gateway.model} isn't told to think at ${THINKING_LEVELS.filter((_, index) => refusals[index]).join(", ")}, which it refused: ${first.cloudflareSays ?? first.refusal}`);
  return THINKING_LEVELS.filter((_, index) => !refusals[index]);
}

/**
 * What the model `gateway` names answers `question`, asked as it is, until `signal` says it's waited long
 * enough: once, unless it calls tools Ember runs, when it's asked again with what each call came to, for
 * as many calls as an answer may make, and then told to answer. All its turns share the answer's tokens,
 * and its provider's tools the uses an answer allows, and one that calls a tool with too few tokens left
 * to go on took every token it could. One that's refused going on from a call answers without Ember's
 * tools, told what its calls came to (`withoutTools`). None of the question's tools may ask first, as
 * for `ask`.
 */
export async function askOnce(env: Env, gateway: Gateway, question: Question, signal: AbortSignal): Promise<Answered | GatewayRefusal> {
  return unasked(await answering(env, gateway, question, signal));
}

/**
 * What `askOnce` answers, or the call of a tool that asks first the answer waits at, going on `from`
 * where an answer paused, if it did: with the round of calls it waited in, as far as they're done.
 */
async function answering(env: Env, gateway: Gateway, question: Question, signal: AbortSignal, from?: PausedAnswer): Promise<Asked> {
  if (gateway.format === "workers") return askWorkersAi(env, gateway, question, signal);
  const { format } = gateway;
  const web = searchingInChat(env, gateway, question, signal, from?.searches);
  const tools = [...(question.tools ?? []), ...(web ? [web.tool] : [])];
  const answered = (said: unknown) => (web ? web.sourced(answeredIn(format, said)) : answeredIn(format, said));
  const saidBefore = [...(from?.saidBefore ?? [])];
  let request = from?.request ?? requestOf(gateway, question);
  let tokensLeft = from?.tokensLeft ?? question.maxTokens;
  let called = from?.called ?? 0;
  const made = [...(from?.made ?? [])];
  let round = from && { body: from.body, done: from.results };
  for (;;) {
    if (!round) {
      const turn = await turnOf(env, gateway, question, request, tokensLeft, signal);
      if ("refused" in turn) {
        if (!(called > 0 && turn.refused.wrongFormat)) return turn.refused;
        const unaided = await withoutTools(env, gateway, question, request, made, turn.tokensLeft, turn.refused, signal);
        return web ? web.sourced(unaided) : unaided;
      }
      tokensLeft = turn.tokensLeft;
      const calls = called < TOOL_CALLS_PER_ANSWER ? toolCallsIn(format, turn.body) : [];
      // Messages' sources are in what the model said in any turn, and its answer in what it said after its last call.
      const said = isMessages(format) && isObject(turn.body) ? { ...turn.body, content: [...saidBefore, ...listOf(turn.body.content)] } : turn.body;
      if (tools.length === 0 || calls.length === 0 || !isObject(turn.body)) return answered(said);
      if (tokensLeft < LEAST_TOKENS) return { status: 502, reason: "out of room", refusal: OUT_OF_ROOM, field: "model" };
      round = { body: turn.body, done: [] };
    }
    const { body } = round;
    const calls = toolCallsIn(format, body);
    const { results, asks } = await resultsOf(tools, calls, TOOL_CALLS_PER_ANSWER - called, round.done);
    if (asks) {
      const { tools: _, ...asked } = question;
      return { asks, paused: { model: gateway.model, format, question: asked, request, body, results, called, tokensLeft, saidBefore, made, ...(web && { searches: web.searches() }) } };
    }
    called += calls.length;
    made.push(...calls.map(({ name, input }, index) => ({ name, input, text: results[index]!.text, failed: results[index]!.failed })));
    request = withRoom(format, goingOn(format, sparing(format, request, body), body, results), tokensLeft, called >= TOOL_CALLS_PER_ANSWER);
    saidBefore.push(...listOf(body.content));
    round = undefined;
  }
}

/**
 * Ember's own tool for searching the web, as one of the tools it runs, for a model in Chat Completions,
 * Grok, that may search the web for `question`, what an answer comes to with the pages its searches
 * found (`withSearches`), as it can't cite them, and those searches, which an answer that waits keeps;
 * or null for one in any other format, or that may not. An answer that waited goes on from its searches
 * `before`.
 */
function searchingInChat(
  env: Env,
  gateway: Gateway,
  question: Question,
  signal: AbortSignal,
  before?: WebSearches,
): { tool: EmberTool; sourced: (answered: Answered | GatewayRefusal) => Answered | GatewayRefusal; searches: () => WebSearches } | null {
  if (gateway.format !== "chat" || toolsFor(gateway.format, question.webTools).length === 0) return null;
  const found: Source[][] = [...(before?.found ?? [])];
  let searchRefused: GatewayRefusal | undefined = before?.refused;
  const { name, description, parameters } = WEB_SEARCH_FUNCTION.function;
  const tool: EmberTool = {
    name,
    description,
    takes: parameters,
    async run({ query }) {
      const asked = typeof query === "string" ? query.trim().slice(0, MAX_QUERY_LENGTH) : "";
      if (asked === "") throw new ToolError("Say what to search for.");
      const result = await searchedFor(env, gateway, question, asked, signal);
      if ("refusal" in result) {
        searchRefused ??= result;
        console.error(`${gateway.model}'s search of the web failed: ${result.refusal}`);
        throw new ToolError(SEARCH_FAILED);
      }
      found.push(result);
      return whatWasFound(result);
    },
  };
  return { tool, sourced: (answered) => withSearches(answered, found, searchRefused), searches: () => ({ found, ...(searchRefused && { refused: searchRefused }) }) };
}

/** What a model is told when Cloudflare's Web Search API refused its search. */
const SEARCH_FAILED = "The search failed, so you can't search the web now. Answer without it, and say that you couldn't search.";

/** What a model reads of the pages a search of the web found, `result`. */
const whatWasFound = (result: (Source & { text: string })[]) =>
  result.length > 0 ? result.map(({ url, title, text }, n) => `${n + 1}. ${title || url}\n${url}\n${text}`).join("\n\n") : "The search found nothing.";

/**
 * What the model `gateway` names answers `question` without Ember's tools, once it was `refused` going on
 * from a call of one, as a request it can't take. It took the question with everything else it asks, so
 * that's asked as it was, with what each call its answer `made` came to after the conversation, as text,
 * since those calls happened all the same, and only once more, with what the answer has left:
 * `tokensLeft` of its tokens, and of its provider's tools the uses `request`, the one refused, left them.
 * `ask` asking it again other ways would spend the answer's tokens and calls over, and lose it thinking
 * and the web for nothing.
 */
async function withoutTools(
  env: Env,
  gateway: Gateway,
  question: Question,
  request: Record<string, unknown>,
  made: readonly CallMade[],
  tokensLeft: number,
  refused: GatewayRefusal,
  signal: AbortSignal,
): Promise<Answered | GatewayRefusal> {
  console.error(`Asking ${gateway.model} again without Ember's tools, as it was refused going on from a call of one: ${refused.refusal}`);
  const turns: Turn[] = [...question.turns, { role: "user", text: whatCallsCameTo(made) }];
  // Ember's own tool for searching the web, in Chat Completions, is one of the tools it runs too.
  const asked = { ...question, turns, tools: [], maxTokens: tokensLeft, ...(gateway.format === "chat" && { webTools: [] }) };
  const turn = await turnOf(env, gateway, asked, withUsesOf(gateway.format, requestOf(gateway, asked), request), tokensLeft, signal);
  if (!("refused" in turn)) return answeredIn(gateway.format, turn.body);
  const { wrongFormat: _, ...unanswered } = turn.refused;
  return unanswered;
}

/**
 * `fresh`, a request in `format` that asks again what `request` went on from, leaving its provider's tools
 * only the uses `request` left them (`sparing`), and telling the model to use none if `request` did.
 */
function withUsesOf(format: ModelFormat, fresh: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  const told = request.tool_choice !== undefined && { tool_choice: request.tool_choice };
  if (isMessages(format)) {
    const left = new Map(listOf(request.tools).filter(isObject).map((tool) => [tool.name, tool.max_uses]));
    const tools = listOf(fresh.tools).filter(isObject).map((tool) => (typeof left.get(tool.name) === "number" ? { ...tool, max_uses: left.get(tool.name) } : tool));
    return tools.length > 0 ? { ...fresh, tools, ...told } : fresh;
  }
  const cap = format === "xai" ? "max_turns" : "max_tool_calls";
  return isResponses(format) && typeof fresh[cap] === "number" && typeof request[cap] === "number" ? { ...fresh, [cap]: request[cap], ...told } : fresh;
}

/**
 * One turn of the model `gateway` names, asked `request`, with `tokensLeft` of its answer's tokens: what
 * it answers, and the tokens left after it. Anthropic's model may pause a turn while it searches, in
 * Messages, which Ember carries on while the turn has tokens left, so its answer is all the turn said.
 * One that paused with none left took every token it could. A turn that's refused says so with the tokens
 * left then, as the parts of it before the refusal wrote some.
 */
async function turnOf(
  env: Env,
  gateway: Gateway,
  question: Question,
  request: Record<string, unknown>,
  tokensLeft: number,
  signal: AbortSignal,
): Promise<{ body: unknown; tokensLeft: number } | { refused: GatewayRefusal; tokensLeft: number }> {
  let said: unknown[] = [];
  for (let continued = 0; ; continued++) {
    const answered = await send(env, gateway, question, continued === 0 ? request : carryingOn(request, said, tokensLeft), signal);
    if ("refusal" in answered) return { refused: answered, tokensLeft };
    tokensLeft -= writtenIn(gateway.format, answered.body);
    if (!isMessages(gateway.format) || !isObject(answered.body)) return { body: answered.body, tokensLeft };
    // Each part of a turn says what's new since the last, which is sent back as it is to carry on.
    said = [...said, ...listOf(answered.body.content)];
    const paused = answered.body.stop_reason === "pause_turn";
    if (paused && tokensLeft < 1) return { body: { ...answered.body, content: said, stop_reason: "max_tokens" }, tokensLeft };
    if (!paused || continued === MAX_CONTINUATIONS) return { body: { ...answered.body, content: said }, tokensLeft };
  }
}

/**
 * `request`, to Messages, carrying on the turn its model paused once it had `said` what it did, which goes
 * back as it is. Each request may write as many tokens as its `max_tokens`, so that's lowered to what the
 * turn has left, `tokensLeft` of its tokens, and its provider's tools are left the uses the turn hasn't
 * made (`usesLeft`).
 */
function carryingOn(request: Record<string, unknown>, said: unknown[], tokensLeft: number): Record<string, unknown> {
  return { ...request, max_tokens: tokensLeft, messages: [...(request.messages as unknown[]), { role: "assistant", content: said }], ...usesLeft(request, said) };
}

/**
 * What `request`, to Messages, asks of its tools once its model has `said` what it did: each request may
 * use a tool of its provider's as many times as its `max_uses`, so that's lowered by the uses made, and
 * once one is used up, which stays among the tools as the answer used it, the model is told to use no
 * tool and answer with what it found.
 */
function usesLeft(request: Record<string, unknown>, said: readonly unknown[]): Record<string, unknown> {
  const usesOf = (name: unknown) => said.filter((block) => isObject(block) && block.type === "server_tool_use" && block.name === name).length;
  const tools = listOf(request.tools).filter(isObject).map((tool) => ({ tool, left: typeof tool.max_uses === "number" ? tool.max_uses - usesOf(tool.name) : null }));
  return {
    ...(tools.length > 0 && { tools: tools.map(({ tool, left }) => (left === null ? tool : { ...tool, max_uses: Math.max(1, left) })) }),
    ...(tools.some(({ left }) => left !== null && left < 1) && { tool_choice: { type: "none" } }),
  };
}

/**
 * `request`, in `format`, leaving its provider's tools the uses its answer has left once a turn answered
 * `body`, for the turn that goes on from a call of Ember's tools: Messages' tools by their `max_uses`,
 * and the web searches of OpenAI's Responses, and xAI's, by the cap each puts on a request's. Once they're
 * used up, the model is told to call no tool and answer.
 */
function sparing(format: ModelFormat, request: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  if (isMessages(format)) return { ...request, ...usesLeft(request, listOf(body.content)) };
  const cap = format === "xai" ? "max_turns" : "max_tool_calls";
  const allowed = request[cap];
  if (!isResponses(format) || typeof allowed !== "number") return request;
  const left = allowed - listOf(body.output).filter((item) => isObject(item) && item.type === "web_search_call").length;
  return { ...request, [cap]: Math.max(1, left), ...(left < 1 && { tool_choice: "none" }) };
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * What the model `gateway` names answers `question` in Workers AI's format, until `signal` says it's waited
 * long enough: Chat Completions, where it may call Ember's tool for searching the web, each time as many
 * times as it likes, which Ember runs (`searchedFor`) and answers it with what was found, until it answers
 * in words, has taken every token the answer may, thinking among them, or has searched as much as an
 * answer may, when each search it asks for after that is answered with that it can't, and it's asked once
 * more. Its sources are the pages its searches found, as it can't cite them.
 */
async function askWorkersAi(env: Env, gateway: Gateway, question: Question, signal: AbortSignal): Promise<Answered | GatewayRefusal> {
  const request = requestOf(gateway, question);
  const messages = [...(request.messages as unknown[])];
  const found: Source[][] = [];
  let searchRefused: GatewayRefusal | undefined;
  let tokensLeft = question.maxTokens;
  const mayCall = toolsFor(gateway.format, question.webTools).length > 0;
  for (let searched = 0; ; ) {
    const answered = await send(env, gateway, question, { ...request, messages, max_completion_tokens: tokensLeft }, signal);
    if ("refusal" in answered) return answered;
    const message = messageIn(answered.body);
    const calls = (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map(toolCallOf);
    tokensLeft -= completionTokensIn(answered.body);
    if (calls.length === 0 || searched > WEB_SEARCHES_PER_ANSWER || tokensLeft < 1) {
      const said = answeredIn(gateway.format, answered.body);
      return withSearches(calls.length > 0 && tokensLeft < 1 ? cutShort(said) : said, found, searchRefused);
    }
    const content = typeof message?.content === "string" ? message.content : "";
    messages.push({ role: "assistant", content, tool_calls: calls.map(({ id, name, query }) => ({ id, type: "function", function: { name, arguments: JSON.stringify({ query }) } })) });
    // A model given no tool may call one all the same, which Ember doesn't run.
    const searches = calls.map(({ name, query }) => (mayCall && name === WEB_SEARCH_FUNCTION.function.name && query !== "" ? query : null));
    const results = await Promise.all(
      searches.map((query, index) => (query !== null && searched + index < WEB_SEARCHES_PER_ANSWER ? searchedFor(env, gateway, question, query, signal) : null)),
    );
    const said = results.map((result, index) => {
      if (!mayCall) return "You can't search the web for this answer. Answer without it.";
      if (calls[index]!.name !== WEB_SEARCH_FUNCTION.function.name) return "There's no tool by that name. Search the web, or answer.";
      if (searches[index] === null) return "Say what to search for.";
      if (result === null) return "You've searched as much as you may for this answer. Answer with what you've found.";
      if ("refusal" in result) {
        searchRefused ??= result;
        console.error(`${gateway.model}'s search of the web failed: ${result.refusal}`);
        return SEARCH_FAILED;
      }
      found.push(result);
      return whatWasFound(result);
    });
    // Each turn of calls counts as a search at least, so that calls of no search still end.
    searched += searches.filter((query) => query !== null).length || 1;
    messages.push(...calls.map(({ id }, index) => ({ role: "tool", tool_call_id: id, content: said[index] })));
  }
}

/** `answered` once the answer ran out of tokens as it called a tool, which its finish doesn't say: cut short, or out of room, with nothing said. */
function cutShort(answered: Answered | GatewayRefusal): Answered | GatewayRefusal {
  if (!("refusal" in answered)) return { ...answered, cut: true };
  return answered.reason === "nothing" ? { status: 502, reason: "out of room", refusal: OUT_OF_ROOM, field: "model" } : answered;
}

/** The message a Chat Completions answer `body` gives, if it gives one. */
function messageIn(body: unknown): Record<string, unknown> | null {
  const [choice] = isObject(body) && Array.isArray(body.choices) ? body.choices : [];
  return isObject(choice) && isObject(choice.message) ? choice.message : null;
}

/**
 * The call of a tool `call` makes, as Chat Completions writes it: its ID, or one it's given, the tool's
 * name, and what it's to search for, if it's Ember's for searching the web, or "" when it doesn't say.
 */
function toolCallOf(call: unknown, index: number): { id: string; name: string; query: string } {
  const given = isObject(call) ? call : {};
  const called = isObject(given.function) ? given.function : given;
  const asked = typeof called.arguments === "string" ? jsonIn(called.arguments) : called.arguments;
  const query = isObject(asked) && typeof asked.query === "string" ? asked.query.trim().slice(0, MAX_QUERY_LENGTH) : "";
  return { id: typeof given.id === "string" && given.id !== "" ? given.id : `call_${index}`, name: typeof called.name === "string" ? called.name : "", query };
}

/** The JSON value `text` holds, or null when it holds none. */
function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** How many tokens a Chat Completions answer `body` says its model wrote, thinking among them. */
const completionTokensIn = (body: unknown) => (isObject(body) && isObject(body.usage) && typeof body.usage.completion_tokens === "number" ? body.usage.completion_tokens : 0);

/**
 * `answered`, a Workers AI model's answer, or Grok's, with the pages its searches, `found`, found, the first of each
 * search's, then the second of each, and so on, each once, no more than an answer names, or else, when
 * none found any as Cloudflare's Web Search API refused them, why, `searchRefused`.
 */
function withSearches(answered: Answered | GatewayRefusal, found: Source[][], searchRefused: GatewayRefusal | undefined): Answered | GatewayRefusal {
  if ("refusal" in answered) return answered;
  const named = new Set<string>();
  const most = Math.max(0, ...found.map((results) => results.length));
  const sources = Array.from({ length: most }, (_, rank) => found.flatMap((results) => results[rank] ?? [])).flat();
  const unnamed = sources.filter(({ url }) => !named.has(url) && named.add(url)).slice(0, MAX_SOURCES).map(({ url, title }) => ({ url, title }));
  if (unnamed.length > 0) return { ...answered, sources: unnamed };
  return searchRefused ? { ...answered, searchRefused } : answered;
}

/**
 * The pages Cloudflare's Web Search API finds for `query`, through the default gateway of the account
 * `gateway` names, whose credits pay for it, as `question` was asked, with what each says, cut to what a
 * model reads, or why it didn't.
 */
async function searchedFor(env: Env, { accountId, apiToken }: Gateway, question: Question, query: string, signal: AbortSignal): Promise<(Source & { text: string })[] | GatewayRefusal> {
  let response: Response;
  try {
    response = await fetch(`${cloudflareApiOf(env)}/accounts/${accountId}/ai/websearch/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", ...metadataOf(question) },
      body: JSON.stringify({ query, limit: RESULTS_PER_SEARCH, options: { gateway: { id: GATEWAY_ID } } }),
      signal,
    });
  } catch (error) {
    console.error("Searching the web with Cloudflare's Web Search API failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 502, reason: "unanswered", refusal: SEARCH_UNANSWERED };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return webSearchRefusalOf(response.status, body);
  const result = isObject(body) && isObject(body.result) ? body.result : body;
  const items = isObject(result) && Array.isArray(result.items) ? result.items.filter(isObject) : null;
  if (!items) return { status: 502, reason: "unanswered", refusal: SEARCH_UNANSWERED };
  return items.slice(0, RESULTS_PER_SEARCH).flatMap(({ url, title, description }) => {
    const source = sourceOf(url, title);
    const text = typeof description === "string" ? description.trim() : "";
    return source ? [{ ...source, text: text.length > MAX_RESULT_LENGTH ? `${text.slice(0, MAX_RESULT_LENGTH - 1).trimEnd()}…` : text }] : [];
  });
}

/**
 * Why Cloudflare's Web Search API refused a search with `status`, from its `body`: Ember AI's API token,
 * which it takes only with Workers AI Read and AI Gateway Read, nothing paying for it, as AI Gateway's
 * credits do, or it turning requests away, or else that it didn't answer, with Cloudflare's own words.
 */
function webSearchRefusalOf(status: number, body: unknown): GatewayRefusal {
  const { codes, message } = errorIn(body);
  const said = (lead: string) => (message ? `${lead} Cloudflare says: ${quoted(message)}` : lead);
  if (status === 401 || status === 403) return { status: 422, reason: "token", field: "apiToken", refusal: said(SEARCH_TOKEN_REFUSED) };
  if (status === 402 || codes.includes(2049) || codes.includes(2044)) return { status: 422, reason: "credits", refusal: said(SEARCH_UNPAID) };
  if (status === 429) return { status: 429, reason: "busy", refusal: said("AI Gateway is turning requests away for now, or a spend limit was reached. Try again later.") };
  return { status: 502, reason: "unanswered", refusal: said(SEARCH_UNANSWERED) };
}

/** Whether `answered` is a refusal that a model asked another way might not give. */
const isWrongFormat = (answered: Answered | GatewayRefusal | Asking): answered is GatewayRefusal => "refusal" in answered && answered.wrongFormat === true;

/** What AI Gateway answers `request`, which asks `question` of the model `gateway` names, or why it refused, by `signal`. */
async function send(env: Env, gateway: Gateway, question: Question, request: Record<string, unknown>, signal: AbortSignal): Promise<{ body: unknown } | GatewayRefusal> {
  const provider = isProviderFormat(gateway.format) ? gateway.format : null;
  let response: Response;
  try {
    response = await fetch(addressOf(env, gateway), {
      method: "POST",
      headers: {
        // A provider's endpoint would take a token in Authorization as the provider's own key, and pass it on.
        ...(provider ? { "cf-aig-authorization": `Bearer ${gateway.apiToken}` } : { Authorization: `Bearer ${gateway.apiToken}`, "cf-aig-gateway-id": GATEWAY_ID }),
        ...(provider === "anthropic" && { "anthropic-version": ANTHROPIC_VERSION }),
        "Content-Type": "application/json",
        ...metadataOf(question),
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    console.error("Asking AI Gateway failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 502, reason: "unanswered", refusal: GATEWAY_UNANSWERED };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { body };
  return provider ? providerRefusalOf(provider, response.status, body) : refusalOf(response.status, body);
}

/** Where a request asking the model `gateway` names in its format goes: Cloudflare's REST API, or the default gateway's endpoint for the model's provider. */
function addressOf(env: Env, { accountId, format }: Gateway): string {
  return isProviderFormat(format) ? `${providerEndpointsOf(env)}/${accountId}/${GATEWAY_ID}/${PATHS[format]}` : `${cloudflareApiOf(env)}/accounts/${accountId}/ai/v1/${PATHS[format]}`;
}

/** The custom metadata AI Gateway keeps of a request asking `question`: who asked and who answers, of those it names, if it names either. */
function metadataOf({ askerId, agentId }: Question): Record<string, string> {
  const metadata = { ...(askerId !== undefined && { user_id: askerId }), ...(agentId !== undefined && { agent_id: agentId }) };
  return Object.keys(metadata).length > 0 ? { "cf-aig-metadata": JSON.stringify(metadata) } : {};
}

/** The answer `body` gives in `format`, or why it's none: the model said nothing, or took every token it could first. */
function answeredIn(format: ModelFormat, body: unknown): Answered | GatewayRefusal {
  const text = answerIn(format, body)?.trim();
  const cut = ranOutIn(format, body);
  const sources = sourcesIn(format, body);
  if (text) return { text, ...(cut && { cut: true as const }), ...(sources.length > 0 && { sources }) };
  return cut ? { status: 502, reason: "out of room", refusal: OUT_OF_ROOM, field: "model" } : { status: 502, reason: "nothing", refusal: NOTHING_ANSWERED, field: "model" };
}

/** Where Cloudflare's API is: the browser tests' stand-in, which `AI_GATEWAY_URL` names at a loopback address, or Cloudflare's own. */
export function cloudflareApiOf(env: Env): string {
  return standInOf(env) ?? CLOUDFLARE_API;
}

/** Where AI Gateway's endpoints for each provider are: the browser tests' stand-in, under `/v1`, or Cloudflare's own. */
function providerEndpointsOf(env: Env): string {
  const standIn = standInOf(env);
  return standIn ? `${standIn}/v1` : PROVIDER_ENDPOINTS;
}

/** The origin of the browser tests' stand-in for Cloudflare, which `AI_GATEWAY_URL` names at a loopback address, or null without one. */
function standInOf(env: Env): string | null {
  const standIn = URL.parse(env.AI_GATEWAY_URL?.trim() ?? "");
  return standIn && isLoopback(standIn) ? standIn.origin : null;
}

/**
 * The body of a request asking `question` in `gateway`'s format, telling the model how much to think as
 * the format does: Anthropic's adaptive thinking at an effort, whose lowest is as little as their models
 * think, OpenAI's reasoning effort, which xAI's Responses takes too, or Chat Completions'
 * `reasoning_effort`, "none" for no thinking, as Workers AI's format is. A model that may use the web is
 * given the format's tools for what it may do there, and any model the tools Ember runs for it, after
 * those. A provider's own format names the model as the provider does (`modelIn`), and OpenAI's and
 * xAI's ask the provider not to keep the conversation, which each keeps for 30 days unless it's told not
 * to, so a model given Ember's tools there is asked for its thinking in a form Ember can send back with
 * what a call came to.
 */
function requestOf({ model, format }: Gateway, { instructions, turns, maxTokens, thinking, webTools, tools: embers = [] }: Question): Record<string, unknown> {
  const effort = thinking === "off" ? "none" : thinking;
  const tools = toolsFor(format, webTools);
  const withTools = tools.length + embers.length > 0 && { tools: [...tools, ...toolsIn(format, embers)] };
  const named = modelIn(format, model);
  if (isMessages(format)) {
    const messages = alternating(turns).map(({ role, text }) => ({ role, content: text }));
    const thinks = effort && { thinking: { type: "adaptive" }, output_config: { effort: effort === "none" ? "low" : effort } };
    return { model: named, max_tokens: maxTokens, system: instructions, messages, ...thinks, ...withTools };
  }
  if (isResponses(format)) {
    const input = turns.map(({ role, text }) => ({ role, content: text }));
    const unkept = format !== "responses" && { store: false, ...(embers.length > 0 && { include: ["reasoning.encrypted_content"] }) };
    const asked = { model: named, max_output_tokens: maxTokens, instructions, input, ...(effort && { reasoning: { effort } }), ...withTools, ...unkept };
    // OpenAI's web search is its only built-in tool, so its calls of built-in tools are its searches.
    if (format !== "xai") return { ...asked, ...(tools.length > 0 && { max_tool_calls: WEB_SEARCHES_PER_ANSWER }) };
    // xAI caps the turns its tools take, each of which may search more than once unless they take one at a time.
    return { ...asked, ...(tools.length > 0 && { max_turns: WEB_SEARCHES_PER_ANSWER, parallel_tool_calls: false }) };
  }
  return {
    model,
    max_completion_tokens: maxTokens,
    messages: [{ role: "system", content: instructions }, ...turns.map(({ role, text }) => ({ role, content: text }))],
    ...(effort && { reasoning_effort: effort }),
    ...withTools,
  };
}

/**
 * `model`, by Cloudflare's ID for it, as `format` names it: as Anthropic does, without `anthropic/` and
 * with dashes for its dots, `claude-sonnet-5-5` for `anthropic/claude-sonnet-5.5`, as OpenAI and xAI do,
 * without their `openai/` and `xai/`, or as Cloudflare's REST API does, by that ID.
 */
export function modelIn(format: ModelFormat, model: string): string {
  const without = (prefix: string) => (model.startsWith(prefix) ? model.slice(prefix.length) : model);
  if (format === "anthropic") return without("anthropic/").replaceAll(".", "-");
  if (format === "openai") return without("openai/");
  return format === "xai" ? without("xai/") : model;
}

/**
 * The tools that let a model in `format` do on the web what `webTools` says it may, of what the format
 * has tools for: Anthropic's basic web search and web fetch, which every Claude model takes, each used no
 * more than an answer allows, or OpenAI's web search, or xAI's, which has its name, or Ember's own, in
 * Chat Completions and Workers AI's format.
 */
export function toolsFor(format: ModelFormat, webTools: readonly WebTool[] = []): Record<string, unknown>[] {
  const may = (tool: WebTool) => webTools.includes(tool) && WEB_TOOLS_IN[format].includes(tool);
  if (format === "workers" || format === "chat") return may("search") ? [WEB_SEARCH_FUNCTION] : [];
  if (!isMessages(format)) return may("search") ? [{ type: "web_search" }] : [];
  return [
    ...(may("search") ? [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCHES_PER_ANSWER }] : []),
    ...(may("read") ? [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: PAGES_READ_PER_ANSWER, max_content_tokens: PAGE_TOKENS }] : []),
  ];
}

/**
 * `turns` as Anthropic's Messages takes them: starting with someone's, and taking turns, so that what
 * several people wrote in a row is one turn, a blank line apart.
 */
export function alternating(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last?.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else if (last || turn.role === "user") merged.push({ ...turn });
  }
  return merged;
}

/**
 * The text of a model's answer in `format`, leaving out its thinking, and what it said before it last
 * used a tool, which says what it'll look for, or null without any.
 */
function answerIn(format: ModelFormat, body: unknown): string | null {
  if (!isObject(body)) return null;
  if (isMessages(format)) return textOf(answeringBlocks(body.content), "text");
  if (isResponses(format)) {
    const messages = answeringMessages(body.output);
    return messages.map((message) => textOf(message.content, "output_text") ?? "").join("") || (typeof body.output_text === "string" ? body.output_text : null);
  }
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  const content = isObject(choice) && isObject(choice.message) ? choice.message.content : null;
  return typeof content === "string" ? content : textOf(content, "text");
}

/** Whether a model's answer in `format` stopped where it did because it took every token it could. */
function ranOutIn(format: ModelFormat, body: unknown): boolean {
  if (!isObject(body)) return false;
  if (isMessages(format)) return body.stop_reason === "max_tokens";
  if (isResponses(format)) return body.status === "incomplete" && isObject(body.incomplete_details) && body.incomplete_details.reason === "max_output_tokens";
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  return isObject(choice) && choice.finish_reason === "length";
}

/** The text of the parts of `content` whose type is `type`, joined, or null without any. */
function textOf(content: unknown, type: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part) => isObject(part) && part.type === type && typeof part.text === "string").map((part) => part.text as string);
  return texts.length > 0 ? texts.join("") : null;
}

/** The blocks of a Messages answer's `content` after its last use of a tool, and what came of it, or all of them without one. */
function answeringBlocks(content: unknown): Record<string, unknown>[] {
  const blocks = Array.isArray(content) ? content.filter(isObject) : [];
  const lastTool = blocks.findLastIndex(({ type }) => typeof type === "string" && /tool_(?:use|result)$/.test(type));
  return blocks.slice(lastTool + 1);
}

/** The messages of a Responses answer's `output` after its last call of a tool, or all of them without one. */
function answeringMessages(output: unknown): Record<string, unknown>[] {
  const items = Array.isArray(output) ? output.filter(isObject) : [];
  const lastCall = items.findLastIndex(({ type }) => typeof type === "string" && type.endsWith("_call"));
  return items.slice(lastCall + 1).filter(({ type }) => type === "message");
}

/**
 * The pages a model's answer in `format` came from, each once, in the order it came to them, no more
 * than an answer names: the search results its words cite, then the pages it read, as Anthropic's
 * Messages has them, or the pages its words cite in OpenAI's Responses, or xAI's.
 */
function sourcesIn(format: ModelFormat, body: unknown): Source[] {
  if (!isObject(body)) return [];
  const sources = isMessages(format) ? messagesSources(body.content) : isResponses(format) ? responsesSources(body.output) : [];
  const named = new Set<string>();
  const unnamed = ({ url }: Source) => {
    if (named.has(url)) return false;
    named.add(url);
    return true;
  };
  return sources.filter(unnamed).slice(0, MAX_SOURCES);
}

/** The search results the answer in a Messages `content` cites, then the pages its model read. */
function messagesSources(content: unknown): Source[] {
  const blocks = Array.isArray(content) ? content.filter(isObject) : [];
  const cited = answeringBlocks(blocks)
    .flatMap(({ citations }) => (Array.isArray(citations) ? citations.filter(isObject) : []))
    .map(({ url, title }) => sourceOf(url, title));
  const read = blocks.map((block) => {
    const result = block.type === "web_fetch_tool_result" && isObject(block.content) ? block.content : null;
    return result?.type === "web_fetch_result" ? sourceOf(result.url, isObject(result.content) ? result.content.title : null) : null;
  });
  return [...cited, ...read].filter((source) => source !== null);
}

/**
 * The pages the answer in a Responses `output` cites, by their titles, but for the numbers xAI titles
 * them by, which the answer shows its citations as, and which name no page.
 */
function responsesSources(output: unknown): Source[] {
  const titleOf = (title: unknown) => (typeof title === "string" && /^\d+$/.test(title.trim()) ? null : title);
  return answeringMessages(output)
    .flatMap(({ content }) => (Array.isArray(content) ? content.filter(isObject) : []))
    .flatMap(({ annotations }) => (Array.isArray(annotations) ? annotations.filter(isObject) : []))
    .map((annotation) => (annotation.type === "url_citation" ? sourceOf(annotation.url, titleOf(annotation.title)) : null))
    .filter((source) => source !== null);
}

/** A source at `url` titled `title`, or null when `url` isn't an address. */
const sourceOf = (url: unknown, title: unknown): Source | null =>
  typeof url === "string" && url.trim() !== "" ? { url: url.trim(), title: typeof title === "string" ? title.trim() : "" } : null;

/**
 * Why AI Gateway refused a request with `status`, from its `body`, which is Cloudflare's, with errors and
 * their codes, or the format's own, with an error, and says in words what to do, with Cloudflare's own.
 */
export function refusalOf(status: number, body: unknown): GatewayRefusal {
  const { codes, message } = errorIn(body);
  const said = (lead: string) => (message ? `${lead} Cloudflare says: ${quoted(message)}` : lead);
  if (status === 401 || (status === 403 && codes.includes(10000))) {
    const refusal = said("Cloudflare didn't take that API token for this account. Check the account ID, and that the token has the Workers AI Read permission.");
    return { status: 422, reason: "token", field: "apiToken", refusal };
  }
  if (isUnroutable(codes, message)) {
    return { status: 422, reason: "account", field: "accountId", refusal: said("Cloudflare has no account with that ID that the token can reach.") };
  }
  const blocked = BLOCKS.find(({ code }) => codes.includes(code));
  if (blocked) return { status: 422, reason: blocked.reason, refusal: said(blocked.refusal) };
  const unrun = WORKERS_AI_REFUSALS.find(({ code }) => codes.includes(code));
  if (unrun) return { status: unrun.status, reason: unrun.reason, ...(unrun.field && { field: unrun.field }), refusal: said(unrun.refusal) };
  if (status === 402) {
    const refusal = said("This model is paid for with AI Gateway's credits, and there aren't enough. Top them up under Credits Available in AI Gateway.");
    return { status: 422, reason: "credits", refusal };
  }
  if (status === 403) return { status: 422, reason: "model", field: "model", refusal: said("Cloudflare won't run that model for this account.") };
  if (status === 413) return { status: 422, reason: "too long", refusal: said("The model can't read that much at once.") };
  if (status === 400 || status === 404 || status === 422) {
    return { status: 422, reason: "model", field: "model", refusal: said("AI Gateway didn't take that model."), wrongFormat: true, ...(message && { cloudflareSays: quoted(message) }) };
  }
  if (status === 429) return { status: 429, reason: "busy", refusal: said("AI Gateway is turning requests away for now, or a spend limit was reached. Try again later.") };
  return { status: 502, reason: "unanswered", refusal: said(GATEWAY_UNANSWERED) };
}

/**
 * Why AI Gateway's endpoint for the provider whose format is `format` refused a request with `status`, as
 * Cloudflare's REST API would (`refusalOf`), but for an API token it doesn't take, as it takes only one
 * with AI Gateway Run, which the REST API doesn't need, and nothing paying for the request, as AI
 * Gateway's credits don't when Unified Billing isn't there for it (2049) or the gateway asks for a
 * provider's own key (2044).
 */
function providerRefusalOf(format: ProviderFormat, status: number, body: unknown): GatewayRefusal {
  const { codes, message } = errorIn(body);
  const said = (lead: string) => (message ? `${lead} Cloudflare says: ${quoted(message)}` : lead);
  const { token, unpaid } = PROVIDER_REFUSALS[format];
  if (codes.includes(2049) || codes.includes(2044) || isUnkeyed(body)) return { status: 422, reason: "credits", refusal: said(unpaid) };
  if (status === 401 || (status === 403 && codes.includes(10000))) return { status: 422, reason: "token", field: "apiToken", refusal: said(token) };
  return refusalOf(status, body);
}

/**
 * Whether the provider itself refused a request AI Gateway passed on with no key of the provider's, as
 * xAI does when the gateway's credits don't pay for Grok at its endpoint, which took the API token:
 * `{"code":"unauthenticated:no-credentials","error":"No credentials presented."}`.
 */
const isUnkeyed = (body: unknown) => isObject(body) && body.code === "unauthenticated:no-credentials";

/**
 * Whether Cloudflare's API couldn't route a request to the account, as for an ID it has no account
 * with: 7000, "No route for that URI", or 7003, "Could not route to /client/v4/accounts/…, perhaps your
 * object identifier is invalid?". AI Gateway answers 7003 too, as its code for a request it or the
 * model's provider refuses as invalid, "Model execution failed (User Input Error): …", as xAI refuses a
 * thinking level for a model that doesn't take one, which is the model's doing, not the account's.
 */
const isUnroutable = (codes: number[], message: string | null) => codes.includes(7000) || (codes.includes(7003) && /^Could not route to /.test(message ?? ""));

/**
 * What Workers AI won't run a model for, by the code of the error Cloudflare's REST API answers with: a
 * model it runs only for accounts on Workers Paid, or whose AI Gateway's credits pay for Workers AI, as
 * they do once the gateway's Workers AI Billing is Unified billing (5035), one it no longer runs (5028),
 * the Neurons it runs models on free each day used up on Workers Free (3036), which start again at
 * 00:00 UTC, and no room to run the model just then (3040).
 */
/** How AI Gateway's credits come to pay for Workers AI's models, in the Cloudflare dashboard. */
const UNIFIED_BILLING = "choose Unified billing under Workers AI Billing in the default gateway's settings in AI Gateway";

const WORKERS_AI_REFUSALS: ReadonlyArray<GatewayRefusal & { code: number }> = [
  {
    code: 5035,
    status: 422,
    reason: "model",
    field: "model",
    refusal: `Cloudflare runs this model only for accounts on Workers Paid, or whose AI Gateway's credits pay for Workers AI. Choose another, move the account to Workers Paid, or ${UNIFIED_BILLING}.`,
  },
  { code: 5028, status: 422, reason: "retired", field: "model", refusal: "Cloudflare no longer runs this model. Choose another." },
  {
    code: 3036,
    status: 429,
    reason: "neurons",
    refusal: `The account has used the 10,000 Neurons Workers AI runs models on free each day, which start again at midnight UTC. To go on before then, move it to Workers Paid, or ${UNIFIED_BILLING}, so that AI Gateway's credits pay.`,
  },
  { code: 3040, status: 429, reason: "busy", refusal: "Workers AI has no room to run this model just now. Try again in a moment." },
];

/**
 * What the gateway's Guardrails and Data Loss Prevention block, by the code of the error AI Gateway
 * answers with, which Guardrails send with a 424: the request, which holds the conversation the model was
 * to read as well as the question, or the model's answer. Asking again, or in another format, would be
 * blocked the same, so nothing is.
 */
const BLOCKS: ReadonlyArray<{ code: number; reason: RefusalReason; refusal: string }> = [
  { code: 2016, reason: "guardrails", refusal: "AI Gateway's Guardrails blocked the question. Change what they block in AI Gateway." },
  { code: 2017, reason: "guardrails answer", refusal: "AI Gateway's Guardrails blocked the model's answer. Change what they block in AI Gateway." },
  { code: 2029, reason: "dlp", refusal: "AI Gateway's Data Loss Prevention blocked the question. Change its policies in AI Gateway." },
  { code: 2030, reason: "dlp answer", refusal: "AI Gateway's Data Loss Prevention blocked the model's answer. Change its policies in AI Gateway." },
];

/**
 * The codes and the first message of the errors in a refusal's body, in any of the shapes AI Gateway
 * answers with: Cloudflare's API's `errors`, the provider endpoints' `error` list, or a format's own `error`.
 */
function errorIn(body: unknown): { codes: number[]; message: string | null } {
  if (!isObject(body)) return { codes: [], message: null };
  const errors = (Array.isArray(body.errors) ? body.errors : Array.isArray(body.error) ? body.error : []).filter(isObject);
  const codes = errors.map(({ code }) => code).filter((code): code is number => typeof code === "number");
  const error = isObject(body.error) ? body.error.message : body.error;
  const message = [errors[0]?.message, error, body.message].find((text): text is string => typeof text === "string" && text.trim() !== "");
  return { codes, message: message?.trim() ?? null };
}

/** `message` cut to what Ember passes on. */
const quoted = (message: string) => (message.length > MAX_QUOTED_LENGTH ? `${message.slice(0, MAX_QUOTED_LENGTH - 1).trimEnd()}…` : message);

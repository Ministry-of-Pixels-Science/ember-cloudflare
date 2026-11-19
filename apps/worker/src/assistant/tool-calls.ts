import type { ModelFormat } from "@ember/protocol/assistant";
import { isMessages, isObject, isResponses } from "./formats";

// Tools Ember runs for a model. A model is given each tool's name, what it does and what it takes, and may
// answer with calls of them in place of an answer; Ember runs each and asks the model again, with what it
// said and what each call came to, until it answers. Each format writes all of that its own way:
// Anthropic's Messages (https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), OpenAI's
// Responses, which xAI's has too (https://developers.openai.com/api/docs/guides/function-calling), and
// Chat Completions, which Cloudflare's REST API takes Grok's requests in. Workers AI's models, asked in a
// format of their own, are given none of them (`takesEmbersTools`), and Grok, in Chat Completions, is given
// Ember's own for searching the web among them, while it may search (gateway.ts).

/** The most calls of Ember's tools one answer makes, as the model reads the conversation again after each round of them. */
export const TOOL_CALLS_PER_ANSWER = 20;

/** What a model is told of a call an answer has no calls left for. */
export const NO_CALLS_LEFT = "Not run: this answer has made all the tool calls it may. Answer with what you have.";

/**
 * A tool Ember runs: its name, what it does and when to use it, in words its model reads, the JSON Schema
 * of the object it takes, and what a call with `input` comes to, as the model reads it, or as AI Gateway's
 * logs mustn't keep it (`Unlogged`). One that throws a `ToolError` tells the model why; any other failure
 * tells it only that the tool failed. One that asks first runs no call until someone allows it: its
 * answer waits at each (`resultsOf`).
 */
export interface EmberTool {
  name: string;
  description: string;
  takes: Record<string, unknown>;
  asksFirst?: true;
  /** Why a call with `input` isn't one to ask anyone to allow, in words for the model, if it isn't. */
  unaskable?(input: Record<string, unknown>): string | null;
  run(input: Record<string, unknown>): Promise<string | Unlogged>;
}

/**
 * What a call came to that AI Gateway's logs mustn't keep, nor anything else of its answer from then on:
 * what was said in a DM or a private room, as the room's search finds once a room an answer began in the
 * open is made private.
 */
export interface Unlogged {
  text: string;
  unlogged: true;
}

/** Why a tool can't do what it's called for, in words for the model that called it. */
export class ToolError extends Error {}

/** A model's call of a tool: the id its answer names it by, the tool's name, and what it's called with, an object, or the JSON of one. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** What a call came to: what the model reads of it, whether that says the call failed, and whether AI Gateway's logs mustn't keep it (`Unlogged`). */
export interface ToolResult {
  id: string;
  text: string;
  failed: boolean;
  unlogged?: true;
}

/** A call an answer has made: the tool's name, what the model called it with, and what the call came to, as the model read it, and whether that says it failed. */
export interface CallMade {
  name: string;
  input: unknown;
  text: string;
  failed: boolean;
}

/** What a model that's asked again without Ember's tools reads after the conversation, before what the calls its answer made of them came to. */
export const CALLS_MADE =
  "(You called tools to answer this, and can't call them now. What each call came to follows, and anything a call did is done. Answer with that, and say what the calls did.)";

/**
 * What a model that's asked again without Ember's tools reads of the calls its answer `made` of them,
 * which stand, so that it doesn't answer as if a call that did something hadn't. A call that failed
 * says so, as Messages' `is_error` did, since an app may fail one with no word of why.
 */
export function whatCallsCameTo(made: readonly CallMade[]): string {
  const each = made.map(({ name, input, text, failed }, n) => {
    const called = typeof input === "string" ? input : JSON.stringify(input ?? {});
    return `Call ${n + 1}: ${name} with ${called}${failed ? ", which failed" : ""}\n${text}`;
  });
  return [CALLS_MADE, ...each].join("\n\n");
}

/** `tools` as a request in `format` lists them. */
export function toolsIn(format: ModelFormat, tools: readonly EmberTool[]): Record<string, unknown>[] {
  return tools.map(({ name, description, takes }) => {
    if (isMessages(format)) return { name, description, input_schema: takes };
    return isResponses(format) ? { type: "function", name, description, parameters: takes } : { type: "function", function: { name, description, parameters: takes } };
  });
}

/**
 * The calls of Ember's tools the model's answer `body` makes in `format`, when it stopped to make them:
 * none for one cut short, whose last call may be half written, or for a tool its provider runs.
 */
export function toolCallsIn(format: ModelFormat, body: unknown): ToolCall[] {
  if (!isObject(body)) return [];
  if (isMessages(format)) {
    const blocks = body.stop_reason === "tool_use" && Array.isArray(body.content) ? body.content.filter(isObject) : [];
    return blocks.flatMap((block) => (block.type === "tool_use" ? callOf(block.id, block.name, block.input) : []));
  }
  if (isResponses(format)) {
    const items = body.status === "completed" && Array.isArray(body.output) ? body.output.filter(isObject) : [];
    return items.flatMap((item) => (item.type === "function_call" ? callOf(item.call_id, item.name, item.arguments) : []));
  }
  const message = messageIn(body);
  const calls = message && !isCutShort(body) && Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
  return calls.flatMap((call) => (isObject(call.function) ? callOf(call.id, call.function.name, call.function.arguments) : []));
}

const callOf = (id: unknown, name: unknown, input: unknown): ToolCall[] => (typeof id === "string" && typeof name === "string" ? [{ id, name, input }] : []);

/** The message a Chat Completions answer `body` gives, or null without one. */
function messageIn(body: Record<string, unknown>): Record<string, unknown> | null {
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  return isObject(choice) && isObject(choice.message) ? choice.message : null;
}

/** Whether a Chat Completions answer `body` stopped because it took every token it could. */
function isCutShort(body: Record<string, unknown>): boolean {
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  return isObject(choice) && choice.finish_reason === "length";
}

/** What a model is told of a call nobody allowed. */
export const CALL_DECLINED = "Not run: the person you're answering was asked to allow this call, and didn't. Answer without it, and say that it wasn't allowed.";

/** How far a round of calls got: what each came to, in order, as far as the one that waits to be allowed, if one does, with what it's called with as an object. */
export interface Round {
  results: ToolResult[];
  asks?: ToolCall & { input: Record<string, unknown> };
}

/**
 * What each of `calls` comes to, in order, run one after another, going on from those `before` it that
 * are done: what its tool among `tools` answers, or, for the model to read, that no tool has that name,
 * that what it's called with isn't an object, why its tool couldn't do it, or that it failed, which is
 * logged. Only the first `left` are run: the rest are told the answer has no calls left. The round stops
 * at a call of a tool that asks first, which waits to be `decided`.
 */
export async function resultsOf(tools: readonly EmberTool[], calls: readonly ToolCall[], left: number, before: readonly ToolResult[] = []): Promise<Round> {
  const results = [...before];
  for (const [index, { id, name, input }] of calls.entries()) {
    if (index < results.length) continue;
    const refused = (text: string): ToolResult => ({ id, text, failed: true });
    const tool = tools.find((tool) => tool.name === name);
    const taken = inputOf(input);
    if (index >= left) results.push(refused(NO_CALLS_LEFT));
    else if (!tool) results.push(refused(`There's no tool called ${name}.`));
    else if (!taken) results.push(refused(`${name} takes a JSON object.`));
    else if (tool.asksFirst && tool.unaskable?.(taken)) results.push(refused(tool.unaskable(taken)!));
    else if (tool.asksFirst) return { results, asks: { id, name, input: taken } };
    else results.push(await ran(tool, id, taken));
  }
  return { results };
}

/**
 * What the call `asks`, which waited to be allowed, comes to: what its tool among `tools` answers once
 * it's `allowed`, or that it wasn't, or that the tool is gone since.
 */
export async function decided(tools: readonly EmberTool[], { id, name, input }: ToolCall, allowed: boolean): Promise<ToolResult> {
  const tool = tools.find((tool) => tool.name === name);
  if (!allowed) return { id, text: CALL_DECLINED, failed: true };
  return tool ? ran(tool, id, inputOf(input) ?? {}) : { id, text: `There's no tool called ${name} any more.`, failed: true };
}

/** What the call `id` of `tool` with `input` comes to. */
const ran = (tool: EmberTool, id: string, input: Record<string, unknown>): Promise<ToolResult> =>
  tool.run(input).then(
    (said) => (typeof said === "string" ? { id, text: said, failed: false } : { id, text: said.text, failed: false, unlogged: true }),
    (error: unknown) => ({ id, text: whyFailed(tool.name, error), failed: true }),
  );

/** What a tool is called with, `input`, as an object, read from JSON if it's that, or null when it's no object. */
function inputOf(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "string") return isObject(input) ? input : null;
  try {
    const parsed: unknown = JSON.parse(input.trim() === "" ? "{}" : input);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function whyFailed(name: string, error: unknown): string {
  if (error instanceof ToolError) return error.message;
  console.error(`Ember's tool ${name} failed:`, error);
  return `${name} failed. Answer without it.`;
}

/**
 * `request`, in `format`, going on after its model answered `body` with calls of tools: what it asked,
 * then what the model said, as it said it, its thinking too, which each provider asks to have back, and
 * what each call came to, `results`.
 */
export function goingOn(format: ModelFormat, request: Record<string, unknown>, body: Record<string, unknown>, results: readonly ToolResult[]): Record<string, unknown> {
  if (isMessages(format)) {
    const told = results.map(({ id, text, failed }) => ({ type: "tool_result", tool_use_id: id, content: text, ...(failed && { is_error: true }) }));
    return { ...request, messages: [...listOf(request.messages), { role: "assistant", content: body.content }, { role: "user", content: told }] };
  }
  if (isResponses(format)) {
    const told = results.map(({ id, text }) => ({ type: "function_call_output", call_id: id, output: text }));
    return { ...request, input: [...listOf(request.input), ...listOf(body.output), ...told] };
  }
  const told = results.map(({ id, text }) => ({ role: "tool", tool_call_id: id, content: text }));
  return { ...request, messages: [...listOf(request.messages), messageIn(body), ...told] };
}

/** `request`, in `format`, whose model may write `tokens` tokens more, and, once its answer has no calls left, `answering`, is told to call no tool and answer. */
export function withRoom(format: ModelFormat, request: Record<string, unknown>, tokens: number, answering: boolean): Record<string, unknown> {
  const room = isMessages(format) ? { max_tokens: tokens } : isResponses(format) ? { max_output_tokens: tokens } : { max_completion_tokens: tokens };
  return { ...request, ...room, ...(answering && { tool_choice: isMessages(format) ? { type: "none" } : "none" }) };
}

/** How many tokens the answer `body` says its model wrote in `format`, thinking among them. */
export function writtenIn(format: ModelFormat, body: unknown): number {
  const usage = isObject(body) && isObject(body.usage) ? body.usage : {};
  const written = isMessages(format) || isResponses(format) ? usage.output_tokens : usage.completion_tokens;
  return typeof written === "number" ? written : 0;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

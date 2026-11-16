import { Client, InsufficientScopeError, ProtocolError, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { MAX_MESSAGE_HTML_LENGTH } from "@ember/protocol";
import { MAX_APP_TOOLS, MAX_TOOL_DESCRIPTION_LENGTH, type AppRefused } from "@ember/protocol/apps";
import { toHex } from "../encoding";
import { isLoopback } from "../loopback";
import { checkHost, GuardError, resolveOverHttps } from "../unfurl/guard";
import { VERSION } from "../version";
import { scopesOf } from "./scopes";

// Asking an app, an MCP server an administrator connected, over Streamable HTTP, with the Model Context
// Protocol's own client (https://github.com/modelcontextprotocol/typescript-sdk), pinned to one version.
// Ember gives it the way out: every request goes to the address the administrator gave, a name that
// resolves only to public addresses, or this machine's, and a redirect isn't followed, so a server can't
// send Ember, or the token, anywhere else. Only JSON comes back, and none of a server's code runs here.
// Every request, the lookups of the name among them, ends at one deadline, as the client doesn't pass
// its own to all of them, and the answers together may be only so long, as the client reads each whole.

/** How long reading an app's tools may take, from connecting to the last page of them. */
export const READ_DEADLINE_MS = 20_000;
/** How long a call of an app's tool may take, from connecting to its result. */
export const CALL_DEADLINE_MS = 60_000;

/** The most characters of a tool's name, as the protocol recommends. */
const MAX_TOOL_NAME_LENGTH = 128;
/** The most characters of the JSON Schema of what a tool takes that Ember keeps: a tool with more is left out. */
export const MAX_TOOL_SCHEMA_LENGTH = 8_000;
/** The most pages of tools Ember asks an app for. */
const MAX_PAGES = 10;
/** The most bytes Ember reads of what's answered while it reads an app's tools or calls one, all the answers together. */
export const MAX_READ_BYTES = 4_000_000;
/** The most characters of a call's result a model is given. */
export const MAX_RESULT_LENGTH = 8_000;

/**
 * What Ember tells a server it takes besides the protocol's own: Slack's Block Kit in a call's result
 * (https://docs.slack.dev/ai/slackbot-mcp-client/returning-rich-responses), by the name Slack's client
 * gives it, as a server built for that one sends its cards only to a client that says so.
 */
export const BLOCK_KIT = { name: "io.slack/block-kit", mimeType: "application/vnd.slack.blocks+json" };

/** A tool as Ember keeps it: as its page shows it, with the JSON Schema of what it takes, and a fingerprint of all that. */
export interface ReadTool {
  name: string;
  title: string | null;
  description: string;
  takes: Record<string, unknown>;
  fingerprint: string;
}

/** What reading an app found: what its server calls itself, its tools, and how many more it has than Ember keeps. */
export interface ReadApp {
  serverName: string | null;
  tools: ReadTool[];
  toolsLeftOut: number;
}

/** What a call of an app's tool came to: what a model reads of it, and whether that says the call failed. */
export interface CalledTool {
  text: string;
  failed: boolean;
  /** Whether the tool was never called: the server couldn't be asked, or no longer lists the tool as it was picked. */
  unmade?: true;
  /** Whether the server no longer lists the tool as it was picked, so that its tools want reading again. */
  changed?: true;
  /** The scopes the server asked for, when it refused the call as more than Ember's sign-in to it allows. */
  scope?: string;
  /** The Block Kit blocks the server answered with beside its text, as JSON, for the room to show as the tool's card. */
  blocks?: string;
}

/** Why an app's tools couldn't be read, with the scopes its server asked for, when it refused that as more than Ember's sign-in to it allows. */
export type UnreadApp = AppRefused & { scope?: string };

/** What Ember sends an app's server to be let in: a token an administrator gave, or the one a sign-in to it gave, `signedIn`. */
export interface Key {
  token: string;
  signedIn?: true;
}

/** What an app is asked through: the Worker's `fetch`, or a fake in tests. */
export type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** What asking an app is held to: when it ends, and how many bytes of answers may still be read. */
export interface Held {
  deadline: AbortSignal;
  bytesLeft: number;
}

/**
 * The tools of the app at `url`, asked with `key`, if it takes one: what its server calls itself and
 * each tool it lists, up to as many as Ember keeps, or why Ember couldn't read them, in words for the
 * administrator who's connecting it, on the field it's about. A server with no tools Ember can use is
 * no app to connect, but a connected app's, read `again`, may have come to have none.
 */
export async function readApp(url: string, key: Key | null, again = false, send: Send = fetch): Promise<ReadApp | UnreadApp> {
  const address = new URL(url);
  const held: Held = { deadline: AbortSignal.timeout(READ_DEADLINE_MS), bytesLeft: MAX_READ_BYTES };
  const within = heldTo(held, send);
  const guarded = await guardedHost(address, within, held);
  if (guarded) return guarded;
  try {
    return await connected(address, key, within, held, async (client) => {
      const { listed, more } = await listedTools(client, held.deadline);
      const tools = await keptTools(listed);
      if (tools.length === 0 && !again) return { error: `${address.host} answered, but it has no tools Ember can use.`, field: "url" };
      return { serverName: client.getServerVersion()?.name?.slice(0, 100) ?? null, tools, toolsLeftOut: listed.length - tools.length + (more ? 1 : 0) };
    });
  } catch (error) {
    return whyNot("Reading the tools of", address, key, error, held);
  }
}

/**
 * What calling `tool` of the app at `url` with `input` came to, asked with `key`, if it takes one, as
 * a model reads it. The server is asked for the tool first, and it's called only while it's the one an
 * administrator looked at, by its fingerprint: a server can change what a tool says it does.
 */
export async function callApp(url: string, key: Key | null, tool: Pick<ReadTool, "name" | "fingerprint">, input: Record<string, unknown>, send: Send = fetch): Promise<CalledTool> {
  const address = new URL(url);
  const held: Held = { deadline: AbortSignal.timeout(CALL_DEADLINE_MS), bytesLeft: MAX_READ_BYTES };
  const within = heldTo(held, send);
  const guarded = await guardedHost(address, within, held);
  if (guarded) return notRun(guarded.error);
  let called = false;
  try {
    return await connected(address, key, within, held, async (client) => {
      const listed = await toolNamed(client, tool.name, held.deadline);
      if (!listed) return { ...notRun(`${address.host} no longer has a tool named ${tool.name}.`), changed: true };
      if (listed.fingerprint !== tool.fingerprint) return { ...notRun(`${tool.name} has changed since an administrator looked at it.`), changed: true };
      called = true;
      // The client's own `callTool` reads every page of the server's tools to check a result against its tool's schema, which Ember doesn't keep.
      return resultOf(await client.request({ method: "tools/call", params: { name: tool.name, arguments: input } }, { signal: held.deadline }));
    });
  } catch (error) {
    // What a server says of a call it refused is the model's to read, as a result is.
    if (called && error instanceof ProtocolError) return { text: `${tool.name} refused the call: ${cut(error.message, 500)}`, failed: true };
    const { error: why, scope } = whyNot("Calling a tool of", address, key, error, held);
    // A server that refuses a call as more than it allows whoever asks hasn't run it.
    if (error instanceof InsufficientScopeError) return { ...notRun(why), ...(scope !== undefined && { scope }) };
    return called ? { text: `${tool.name} didn't answer, and may have run all the same: ${why}`, failed: true } : notRun(why);
  }
}

const notRun = (why: string): CalledTool => ({ text: `Not run: ${why}`, failed: true, unmade: true });

/** What `ask` comes to, asked of a client connected to the server at `address`, with `key`, if it takes one: the connection is closed after. */
async function connected<T>(address: URL, key: Key | null, send: Send, held: Held, ask: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(address, {
    fetch: send,
    // Workers' fetch has no "error": a redirect comes back as it is, which is no answer.
    requestInit: { redirect: "manual" },
    ...(key !== null && { authProvider: { token: async () => key.token } }),
  });
  const client = new Client({ name: "Ember", version: VERSION }, { capabilities: { extensions: { [BLOCK_KIT.name]: { mimeTypes: [BLOCK_KIT.mimeType] } } } });
  try {
    await client.connect(transport, { signal: held.deadline });
    return await ask(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * `send`, held: each request ends at the deadline, and what's read of each answer comes out of the bytes
 * left, past which reading it fails.
 */
export function heldTo(held: Held, send: Send): Send {
  return async (input, init) => {
    const response = await send(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, held.deadline]) : held.deadline });
    if (!response.body) return response;
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        held.bytesLeft -= chunk.byteLength;
        if (held.bytesLeft < 0) controller.error(new TypeError("The answer is longer than Ember reads."));
        else controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(counted), response);
  };
}

/**
 * The tools `client`'s server lists, a page at a time, each asked for by itself, as the client's own walk
 * through them all would read every page a server has: up to as many pages as Ember asks for, and whether
 * the server has more.
 */
async function listedTools(client: Client, signal: AbortSignal): Promise<{ listed: unknown[]; more: boolean }> {
  const listed: unknown[] = [];
  let more = false;
  for await (const page of pagesOfTools(client, signal)) {
    listed.push(...page.tools);
    more = page.more;
  }
  return { listed, more };
}

/** The tool `client`'s server lists by `name`, as Ember keeps it, or null: one it doesn't list in the pages Ember asks for, or can't use. */
async function toolNamed(client: Client, name: string, signal: AbortSignal): Promise<ReadTool | null> {
  for await (const { tools } of pagesOfTools(client, signal)) {
    const listed = tools.find((tool) => typeof tool === "object" && tool !== null && (tool as { name?: unknown }).name === name);
    if (listed) return readTool(listed);
  }
  return null;
}

/** Each page of the tools `client`'s server lists, up to as many as Ember asks for, with whether the server has more after it. */
async function* pagesOfTools(client: Client, signal: AbortSignal): AsyncGenerator<{ tools: unknown[]; more: boolean }> {
  if (!client.getServerCapabilities()?.tools) return;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // The client reads every page when it's asked for the first, so that one is asked for as any request is.
    const { tools, nextCursor } = cursor === undefined ? await client.request({ method: "tools/list" }, { signal }) : await client.listTools({ cursor }, { signal });
    cursor = nextCursor;
    yield { tools, more: cursor !== undefined };
    if (cursor === undefined) return;
  }
}

/** The first of `listed` Ember can use, as it keeps them, up to as many as it keeps of an app: the rest aren't read. */
async function keptTools(listed: readonly unknown[]): Promise<ReadTool[]> {
  const kept: ReadTool[] = [];
  for (const tool of listed) {
    if (kept.length === MAX_APP_TOOLS) break;
    const read = await readTool(tool);
    if (read) kept.push(read);
  }
  return kept;
}

/**
 * Why Ember won't ask the host of `address`, if it won't: its name has to resolve, and only to public
 * addresses, unless it's this machine, within what asking it is held to.
 */
async function guardedHost(address: URL, send: Send, held: Held): Promise<AppRefused | null> {
  if (isLoopback(address)) return null;
  try {
    await checkHost(address.hostname, (host) => resolveOverHttps(host, (request) => send(request)));
    return null;
  } catch (error) {
    if (held.deadline.aborted) return { error: tookTooLong(address.host), field: "url" };
    if (!(error instanceof GuardError)) throw error;
    return { error: `Ember couldn't find ${address.host} on the Internet. Check the address.`, field: "url" };
  }
}

export const tookTooLong = (host: string) => `${host} took too long to answer.`;
export const saidTooMuch = (host: string) => `${host} answered with more than Ember reads.`;

/**
 * A tool as an app lists it, `listed`, as Ember keeps it, or null for one it can't use: without a name
 * the protocol allows, or taking more than Ember keeps. Its description is cut to what Ember keeps.
 */
async function readTool(listed: unknown): Promise<ReadTool | null> {
  if (typeof listed !== "object" || listed === null) return null;
  const { name, title, description, inputSchema } = listed as Record<string, unknown>;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name) || name.length > MAX_TOOL_NAME_LENGTH) return null;
  const takes = typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema) ? (inputSchema as Record<string, unknown>) : { type: "object" };
  if (JSON.stringify(takes).length > MAX_TOOL_SCHEMA_LENGTH) return null;
  const described = typeof description === "string" ? description.trim() : "";
  const tool = {
    name,
    title: typeof title === "string" && title.trim() !== "" ? title.trim().slice(0, 100) : null,
    description: described.length > MAX_TOOL_DESCRIPTION_LENGTH ? `${described.slice(0, MAX_TOOL_DESCRIPTION_LENGTH - 1).trimEnd()}…` : described,
    takes,
  };
  return { ...tool, fingerprint: await fingerprintOf(tool) };
}

/**
 * A fingerprint of a tool as Ember keeps it: SHA-256 of its name, title, description and what it takes,
 * with every object's keys in order, so that it changes when what a model is told of the tool does.
 */
export async function fingerprintOf(tool: Omit<ReadTool, "fingerprint">): Promise<string> {
  const text = JSON.stringify(inOrder([tool.name, tool.title, tool.description, tool.takes]));
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** `value` with every object's keys sorted, all the way down. */
function inOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inOrder);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inside]) => [key, inOrder(inside)]));
}

/**
 * Why Ember couldn't do `what` it was doing with the app at `address`, asked with `key`, from what went
 * wrong within what asking it was held to, or at its end. Only the kind of failure is logged: a server writes what its answers say,
 * which the client quotes in its errors, and could write the token there.
 */
function whyNot(what: "Reading the tools of" | "Calling a tool of", address: URL, key: Key | null, error: unknown, held: Held): UnreadApp {
  const { host } = address;
  const status = error instanceof SdkHttpError ? error.status : null;
  const kind = error instanceof SdkError ? `${error.name} ${error.code}` : error instanceof Error ? error.name : typeof error;
  console.error(`${what} the app at ${host} failed${status === null ? "" : ` with ${status}`}: ${kind}`);
  if (held.bytesLeft < 0) return { error: saidTooMuch(host), field: "url" };
  if (held.deadline.aborted) return { error: tookTooLong(host), field: "url" };
  // A token that opens the server but not what was asked of it: the client has no status for that refusal.
  if (error instanceof InsufficientScopeError) {
    if (!key?.signedIn) return { error: `${host} took that token, but says it doesn't allow this. Give one that does.`, field: "token" };
    // What it says would allow it is asked for at the next sign-in.
    const scope = scopesOf(error.requiredScope);
    return { error: `${host} took Ember's sign-in, but says it doesn't allow this.${scope === null ? "" : " Sign in to it again to allow it."}`, field: "token", ...(scope !== null && { scope }) };
  }
  if (error instanceof UnauthorizedError || status === 401 || status === 403) {
    if (key === null) return { error: `${host} asks for a sign-in. Sign in to it, or give a token for it, if it has one.`, field: "token", signIn: true };
    if (key.signedIn) return { error: `${host} didn't take Ember's sign-in. Sign in to it again.`, field: "token" };
    // A server that takes no token it's given may have come to sign people in, which the form then offers to try.
    return { error: `${host} didn't take that token.`, field: "token", ...(status !== 403 && { signIn: true as const }) };
  }
  if (status !== null && status >= 300 && status < 400) return { error: `${host} sends that address on to another, which Ember doesn't follow. Give the address it ends at.`, field: "url" };
  if (status === 404 || status === 405) return { error: `${host} has no MCP server at that address. Check the address, which often ends in /mcp.`, field: "url" };
  if (status !== null) return { error: `${host} answered ${status}. Try again in a moment.`, field: "url" };
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return { error: tookTooLong(host), field: "url" };
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { error: tookTooLong(host), field: "url" };
  if (error instanceof TypeError) return { error: `Ember couldn't reach ${host}. Check the address.`, field: "url" };
  return { error: `${host} didn't answer as an MCP server does. Check the address, which often ends in /mcp.`, field: "url" };
}

/**
 * What a model reads of `result`, a server's answer to a call: its text, with anything else it holds
 * named, or what it gives as data when it has no text, cut to as much as a model is given, and the
 * Block Kit blocks of one that didn't fail, as Slack's client finds them, in `_meta.slack.blocks`.
 */
function resultOf(result: unknown): CalledTool {
  const { content, structuredContent, isError, _meta } = (isObject(result) ? result : {}) as Record<string, unknown>;
  const parts = (Array.isArray(content) ? content : []).map(partOf).filter((part) => part !== "");
  const text = parts.length > 0 ? parts.join("\n\n") : structuredContent === undefined ? "" : JSON.stringify(structuredContent);
  const blocks = isError === true ? undefined : blocksIn(_meta);
  return { text: text === "" ? "(The tool answered with nothing.)" : cut(text, MAX_RESULT_LENGTH), failed: isError === true, ...(blocks !== undefined && { blocks }) };
}

/** The Block Kit blocks a result's `meta` holds, as JSON, or undefined when it holds none, or more than a message could keep. */
function blocksIn(meta: unknown): string | undefined {
  const slack = isObject(meta) ? meta.slack : undefined;
  const blocks = isObject(slack) ? slack.blocks : undefined;
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const written = JSON.stringify(blocks);
  return written.length > MAX_MESSAGE_HTML_LENGTH ? undefined : written;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a model reads of `block`, one piece of a call's result. */
function partOf(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const { type, text, uri, resource } = block as Record<string, unknown>;
  if (type === "text") return typeof text === "string" ? text.trim() : "";
  if (type === "resource_link") return typeof uri === "string" ? `(A link: ${uri})` : "";
  if (type === "resource" && typeof resource === "object" && resource !== null && typeof (resource as { text?: unknown }).text === "string") return (resource as { text: string }).text.trim();
  return type === "image" ? "(A picture, which Ember doesn't pass on.)" : "(Something other than text, which Ember doesn't pass on.)";
}

/** `text`, cut to `length` characters, saying so. */
const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}\n(Cut here: the rest is longer than Ember passes on.)` : text);

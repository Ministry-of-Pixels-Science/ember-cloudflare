import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for an app's MCP server, which the apps spec connects: it speaks the Model Context Protocol
// over Streamable HTTP as far as Ember asks it (apps/worker/src/apps/mcp.ts), answering `initialize`
// with what it calls itself, taking the notification that follows, listing its tools, and answering a
// call of one with `calledWith`, and with the Block Kit blocks a spec has it answer with, as a server
// built for Slack's client does, to whoever sends its token. It serves on this machine, where Ember
// asks an app over http. Started to sign people in, it takes no token of its own: it's its own OAuth
// authorization server, as the protocol has one found, which registers whoever asks, shows a page to
// allow or deny them, and gives short-lived access tokens with a token to get the next one with. A
// call of a tool can be made to take a scope, which the tokens then have to allow, and the
// authorization server takes back the tokens it's sent to revoke.

/** What the server calls itself. */
export const SERVER_NAME = "Tracker";

/** The token the server takes, as a bearer token. */
export const MCP_TOKEN = "e2e-mcp-token";

/** What the server answers a call of `name` with `given`, as text. */
export const calledWith = (name: string, given: unknown) => `${name} ran with ${JSON.stringify(given)}`;

/** A tool as the server lists it. */
export interface ListedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools the server lists at first. */
export const TOOLS: ListedTool[] = [
  { name: "search_issues", title: "Search issues", description: "Finds issues by their words.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "create_issue", description: "Opens an issue in a project.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
];

export interface FakeMcp {
  /** Where the server is. */
  url: string;
  /** The tools it lists, which a spec may change. */
  tools: ListedTool[];
  /** The JSON-RPC methods it was asked, in order. */
  asked: string[];
  /** The calls of its tools it ran, in order: each tool's name and what it was called with. */
  calls: Array<{ name: string; arguments: unknown }>;
  /** The Block Kit blocks it answers a call of `name` with `given` with, beside its text, when a spec has it answer with any. */
  blocks: ((name: string, given: unknown) => unknown[] | undefined) | null;
  /** Its sign-in, when it signs people in rather than taking its token. */
  signIn: FakeSignIn | null;
  close: () => Promise<void>;
}

/** What the server's authorization server asks whoever is sent to it, over its Allow and Deny. */
export const ALLOW_HEADING = "Allow Ember to use Tracker?";

/** The one client a fake authorization server gives tokens to, which an administrator registered there: its ID, and the secret it proves itself with. */
export interface FakeClient {
  id: string;
  secret: string;
}

/**
 * A fake server's sign-in: the access token it takes now and the token that gets the next one, neither
 * once it's `end`ed, the one client its authorization server knows, or null for one that registers
 * whoever asks, the scopes its tokens `allows`, as whoever signed in last was sent asking for them,
 * the scope a call of a tool `needs`, if it needs one, and the tokens that were `revoked` there.
 */
export interface FakeSignIn {
  access: string | null;
  refresh: string | null;
  client: FakeClient | null;
  allows: string[];
  needs: string | null;
  revoked: string[];
  /** The codes it sent a browser back with, each with what the browser was sent to it with. */
  codes: Map<string, URLSearchParams>;
  /** How many times it gave tokens for a code, and for a token that gets the next one. */
  exchanged: number;
  refreshed: number;
  /** Ends the sign-in, as when it's taken back at the service: its tokens stop working. */
  end: () => void;
}

/** How long the fake's access tokens last, in seconds: so short that Ember gets another before each use. */
const ACCESS_LASTS = 30;

interface Message {
  id?: number;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

/** What the server answers `message` with, as JSON-RPC, or nothing for a notification. */
function resultOf(mcp: FakeMcp, message: Message): unknown {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: "1.0.0" } };
  if (message.method === "tools/list") return { tools: mcp.tools };
  if (message.method !== "tools/call" || typeof message.params?.name !== "string") return undefined;
  const { name, arguments: given } = message.params;
  mcp.calls.push({ name, arguments: given });
  const blocks = mcp.blocks?.(name, given);
  return { content: [{ type: "text", text: calledWith(name, given) }], ...(blocks && { _meta: { slack: { blocks } } }) };
}

type Reply = (status: number, body?: unknown, headers?: Record<string, string>) => void;

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

/** The tokens the authorization server gives next, which end the ones it gave last. */
function nextTokens(signIn: FakeSignIn) {
  signIn.access = `access-${randomUUID()}`;
  signIn.refresh = `refresh-${randomUUID()}`;
  return { access_token: signIn.access, token_type: "Bearer", expires_in: ACCESS_LASTS, refresh_token: signIn.refresh };
}

/**
 * What the token endpoint answers `form`: tokens for a code it sent a browser back with, proven with
 * its verifier, or for the token it gave last to get another with, and only to its one client, proven
 * by `authorization`, when it has one.
 */
function tokensFor(signIn: FakeSignIn, form: URLSearchParams, authorization: string | undefined, reply: Reply): void {
  const { client } = signIn;
  if (client && authorization !== `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`) return reply(401, { error: "invalid_client" });
  if (form.get("grant_type") === "refresh_token") {
    if (signIn.refresh === null || form.get("refresh_token") !== signIn.refresh) return reply(400, { error: "invalid_grant" });
    signIn.refreshed += 1;
    return reply(200, nextTokens(signIn));
  }
  const code = form.get("code") ?? "";
  const sent = signIn.codes.get(code);
  signIn.codes.delete(code);
  const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
  if (!sent || sent.get("code_challenge") !== challenge || sent.get("redirect_uri") !== form.get("redirect_uri")) return reply(400, { error: "invalid_grant" });
  signIn.exchanged += 1;
  signIn.allows = (sent.get("scope") ?? "").split(" ").filter((scope) => scope !== "");
  reply(200, nextTokens(signIn));
}

/** Takes back the token `form` names, at the revocation endpoint: it's no good from then on. */
function revoke(signIn: FakeSignIn, form: URLSearchParams, reply: Reply): void {
  const token = form.get("token") ?? "";
  signIn.revoked.push(token);
  if (token === signIn.access) signIn.access = null;
  if (token === signIn.refresh) signIn.refresh = null;
  reply(200);
}

/** What the allow page says of the scopes whoever is sent to it asks for, when they ask for any. */
export const asksFor = (scope: string) => `It asks for: ${scope}`;

/** The page the authorization server shows whoever is sent to it with `query`: a link that allows Ember, back to it with a code, and one that denies it. */
function allowPage(signIn: FakeSignIn, query: URLSearchParams): string {
  const back = (answer: Record<string, string>) => {
    const to = new URL(query.get("redirect_uri") ?? "http://localhost/");
    for (const [name, value] of Object.entries({ ...answer, state: query.get("state") ?? "" })) to.searchParams.set(name, value);
    return to.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  };
  const code = `code-${randomUUID()}`;
  signIn.codes.set(code, query);
  const scope = query.get("scope");
  const asks = scope === null ? "" : `<p>${asksFor(scope).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`;
  return `<!doctype html><title>${SERVER_NAME}</title><h1>${ALLOW_HEADING}</h1>${asks}<p><a href="${back({ code })}">Allow</a> <a href="${back({ error: "access_denied" })}">Deny</a></p>`;
}

/** What the server says of its sign-in at `origin`, as OAuth has an authorization server describe itself: one that registers whoever asks, unless it knows one `client` alone. */
const describedAt = (origin: string, client: FakeClient | null) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  revocation_endpoint: `${origin}/revoke`,
  ...(client === null && { registration_endpoint: `${origin}/register` }),
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: client === null ? ["none"] : ["client_secret_basic"],
});

/** Answers what's asked of the server's sign-in at `url`, as the protocol finds an authorization server and OAuth asks one: whether that's what was asked. */
async function answerSignIn(signIn: FakeSignIn, url: URL, request: IncomingMessage, response: ServerResponse, reply: Reply): Promise<boolean> {
  const { origin, pathname } = url;
  if (pathname === "/.well-known/oauth-protected-resource/mcp") reply(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
  else if (pathname === "/.well-known/oauth-authorization-server") reply(200, describedAt(origin, signIn.client));
  else if (pathname === "/register" && request.method === "POST" && signIn.client === null) reply(201, { ...(JSON.parse(await bodyOf(request)) as object), client_id: "ember-e2e" });
  else if (pathname === "/token" && request.method === "POST") tokensFor(signIn, new URLSearchParams(await bodyOf(request)), request.headers.authorization, reply);
  else if (pathname === "/revoke" && request.method === "POST") revoke(signIn, new URLSearchParams(await bodyOf(request)), reply);
  else if (pathname === "/authorize") response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(allowPage(signIn, url.searchParams));
  else return false;
  return true;
}

async function answer(mcp: FakeMcp, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply: Reply = (status, body, headers = {}) => {
    response.writeHead(status, { ...(body !== undefined && { "Content-Type": "application/json" }), ...headers });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const url = new URL(request.url ?? "/", mcp.url);
  if (mcp.signIn && (await answerSignIn(mcp.signIn, url, request, response, reply))) return;
  if (url.pathname !== "/mcp") return reply(404, { error: "Not found" });
  const takes = mcp.signIn ? mcp.signIn.access : MCP_TOKEN;
  if (takes === null || request.headers.authorization !== `Bearer ${takes}`) {
    const challenge = mcp.signIn ? `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"` : "Bearer";
    return reply(401, { error: "Unauthorized" }, { "WWW-Authenticate": challenge });
  }
  // It keeps no stream open for what it would send on its own.
  if (request.method !== "POST") return reply(405);
  const message = JSON.parse(await bodyOf(request)) as Message;
  mcp.asked.push(message.method);
  if (message.id === undefined) return reply(202);
  const needs = message.method === "tools/call" ? (mcp.signIn?.needs ?? null) : null;
  if (needs !== null && !mcp.signIn?.allows.includes(needs)) return reply(403, { error: "Forbidden" }, { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${needs}"` });
  const result = resultOf(mcp, message);
  if (result === undefined) return reply(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  reply(200, { jsonrpc: "2.0", id: message.id, result });
}

/**
 * Starts the server on a port of its own, on this machine: one that takes its token, or one that
 * `signsIn` whoever its authorization server allows, which registers whoever asks, or knows the one
 * `client` an administrator registered there.
 */
export async function startFakeMcp({ signsIn = false, client = null as FakeClient | null } = {}): Promise<FakeMcp> {
  const signIn: FakeSignIn = { access: null, refresh: null, client, allows: [], needs: null, revoked: [], codes: new Map(), exchanged: 0, refreshed: 0, end: () => void Object.assign(signIn, { access: null, refresh: null }) };
  const mcp: FakeMcp = { url: "", tools: [...TOOLS], asked: [], calls: [], blocks: null, signIn: signsIn ? signIn : null, close: async () => {} };
  const server = createServer((request, response) => {
    answer(mcp, request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mcp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  mcp.close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return mcp;
}
